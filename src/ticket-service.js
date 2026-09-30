const crypto = require("crypto");
const { config, FIELD, STATUS } = require("./config");
const domain = require("./domain");
const cards = require("./cards");
// The production-only historical evidence file is deliberately kept out of Git.
let legacyBounds = {};
try {
  legacyBounds = require("./legacy-confirmation-bounds.json");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const { formatDateTime, parseDateTime } = require("./time");

function stableUuid(prefix, value) {
  const digest = crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

function firstPerson(value) {
  const person = Array.isArray(value) ? value[0] : value;
  if (!person || typeof person !== "object") return {};
  const id = person.open_id || person.openId || person.id || person.user_id || person.userId || "";
  return {
    openId: String(id).startsWith("ou_") ? id : "",
    name: person.name || person.display_name || person.text || ""
  };
}

function reporterFromRecord(record) {
  const fields = record.fields || {};
  const explicitOpenId = domain.text(fields[FIELD.reporterOpenId]);
  const reporter = firstPerson(fields[FIELD.reporter]);
  const submitter = firstPerson(fields[FIELD.submittedBy]);
  const creator = firstPerson(record.created_by || record.createdBy);
  const actualSubmitter = submitter.openId ? submitter : creator;
  if (!actualSubmitter.openId) {
    throw new domain.DomainError("REPORTER_REQUIRED", "无法识别表单提交人，工单暂不创建。请确认表单记录包含提交人信息。");
  }
  const reporterOpenId = explicitOpenId || reporter.openId;
  if (reporterOpenId && reporterOpenId !== actualSubmitter.openId) {
    throw new domain.DomainError("REPORTER_MISMATCH", "报修人必须与当前表单提交人一致，禁止代他人报修。");
  }
  return {
    openId: actualSubmitter.openId,
    name: reporter.name || actualSubmitter.name
  };
}

function hasReportPayload(record) {
  const fields = record.fields || {};
  return [
    FIELD.reporter,
    FIELD.phone,
    FIELD.issueType,
    FIELD.device,
    FIELD.description,
    FIELD.attachment,
    FIELD.priority
  ].some((name) => domain.text(fields[name]));
}

function reportPayloadSignature(record) {
  const fields = (record && record.fields) || {};
  return JSON.stringify([
    FIELD.reporter,
    FIELD.phone,
    FIELD.issueType,
    FIELD.device,
    FIELD.description,
    FIELD.attachment,
    FIELD.priority
  ].map((name) => domain.text(fields[name])));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(error) {
  return Boolean(error && (
    error.code === "FEISHU_TIMEOUT" ||
    error.code === "ABORT_ERR" ||
    error.name === "AbortError" ||
    error.name === "FeishuTimeoutError"
  ));
}

function updateMatches(fields = {}, update = {}) {
  return Object.entries(update).every(([name, expected]) => {
    if (name === FIELD.assignee) return true;
    if (name === FIELD.version) return domain.versionOf(fields) === Number(expected);
    return domain.text(fields[name]) === domain.text(expected);
  });
}

function recentClosed(fields, now = Date.now(), windowMs = 24 * 60 * 60 * 1000) {
  const closedAt = parseDateTime(fields[FIELD.closedAt]);
  if (!closedAt) return false;
  const ageMs = now - closedAt.getTime();
  return ageMs >= -60 * 1000 && ageMs <= windowMs;
}

async function loadReporterProfile(feishu, reporter) {
  if (!reporter.openId || typeof feishu.getUserByOpenId !== "function") return {};
  try {
    return (await feishu.getUserByOpenId(reporter.openId)) || {};
  } catch (error) {
    console.warn(`reporter profile failed: ${error.message}`);
    return {};
  }
}

class TicketService {
  constructor(repository, feishu, options = {}) {
    this.repository = repository;
    this.feishu = feishu;
    this.legacyBounds = options.legacyBounds || legacyBounds;
    this.roles = { itOpenIds: config.itOpenIds, adminOpenIds: config.adminOpenIds };
    this.policy = { defaultPriority: config.defaultPriority, slaHours: config.slaHours, slaHolidays: config.slaHolidays };
    this.recordSettleIntervalMs = config.recordSettleIntervalMs;
    this.retryDelaysMs = config.retryDelaysMs;
    this.sleep = sleep;
    this.actionReadbackDelayMs = 450;
    this.actionReadbackIntervalMs = 40;
    this.actionLocks = new Map();
    this.pendingWrites = new Map();
  }

  async retryOperation(operation, context = {}) {
    let lastError;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        return await operation(attempt);
      } catch (error) {
        lastError = error;
        if (error.retryable === false || attempt >= this.retryDelaysMs.length) break;
        const delayMs = this.retryDelaysMs[attempt];
        console.warn(JSON.stringify({
          type: "retry_scheduled",
          attempt: attempt + 1,
          delayMs,
          recordId: context.recordId || "",
          operation: context.operation || "unknown",
          apiCode: error.apiCode || 0,
          requestId: error.requestId || "",
          message: error.message
        }));
        await this.sleep(delayMs);
      }
    }
    throw lastError;
  }

  async settledNewRecord(recordId, initialRecord) {
    let latest = initialRecord;
    let previousSignature = reportPayloadSignature(initialRecord);
    let stableReads = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.sleep(this.recordSettleIntervalMs);
      const refreshed = await this.repository.get(recordId);
      if (!refreshed) break;
      const signature = reportPayloadSignature(refreshed);
      stableReads = signature === previousSignature ? stableReads + 1 : 0;
      latest = refreshed;
      previousSignature = signature;
      if (stableReads >= 2 && hasReportPayload(latest)) break;
    }
    return latest;
  }

  async latestFields(recordId, fallbackFields) {
    try {
      const refreshed = await this.repository.get(recordId);
      return refreshed && refreshed.fields ? refreshed.fields : fallbackFields;
    } catch (error) {
      console.warn(`record refresh failed: recordId=${recordId} message=${error.message}`);
      return fallbackFields;
    }
  }

  logTicketEvent(recordId, before, after, actor, action, detail = "") {
    const merged = { ...(before || {}), ...(after || {}) };
    console.log(JSON.stringify({
      type: "ticket_event",
      recordId,
      ticketNo: domain.text(merged[FIELD.ticketNo]),
      action,
      actorOpenId: domain.actorId(actor),
      actorName: domain.actorName(actor),
      fromStatus: domain.text(before && before[FIELD.status]),
      toStatus: domain.text(merged[FIELD.status]),
      detail: domain.text(detail),
      at: new Date().toISOString()
    }));
  }

  async safeEvent(recordId, before, after, actor, action, detail = "") {
    this.logTicketEvent(recordId, before, after, actor, action, detail);
    try {
      await this.repository.appendEvent(recordId, before, after, actor, action, detail);
    } catch (error) {
      console.error(`event log failed: action=${action} recordId=${recordId} message=${error.message}`);
    }
  }

  actionDetail(actionName, before, update, input) {
    const previousPromisedAt = parseDateTime(before[FIELD.promisedAt]);
    const nextPromisedAt = parseDateTime(update[FIELD.promisedAt]);
    return actionName === "extend"
      ? `预计完成时间：${previousPromisedAt ? formatDateTime(previousPromisedAt) : "-"} → ${nextPromisedAt ? formatDateTime(nextPromisedAt) : "-"}`
      : domain.text(input.progress || input.resolution || input.reason);
  }

  async initialize(recordId, actor = { name: "系统" }) {
    let record = await this.retryOperation(
      () => this.repository.get(recordId),
      { recordId, operation: "get_ticket_for_initialize" }
    );
    if (!record) return { skipped: true, reason: "record missing" };
    if (!domain.text((record.fields || {})[FIELD.ticketNo])) {
      record = await this.settledNewRecord(recordId, record);
    }
    if (!hasReportPayload(record)) return { skipped: true, reason: "record empty after settling" };
    const before = record.fields || {};
    let fields = before;
    let initialized = false;
    let identityRepaired = false;
    const reporter = reporterFromRecord(record);
    const profile = await loadReporterProfile(this.feishu, reporter);
    const reporterOpenId = reporter.openId || profile.open_id || "";
    const identityUpdate = {
      ...(reporterOpenId && !domain.text(before[FIELD.reporterOpenId]) ? {
        [FIELD.reporter]: [{ id: reporterOpenId }],
        [FIELD.reporterOpenId]: reporterOpenId
      } : {}),
      ...(!domain.text(before[FIELD.phone]) && domain.text(profile.mobile)
        ? { [FIELD.phone]: domain.text(profile.mobile) }
        : {})
    };
    if (!domain.text(before[FIELD.ticketNo])) {
      const update = {
        ...domain.initialFields(record, this.policy),
        ...identityUpdate
      };
      const updatedRecord = await this.retryOperation(
        () => this.repository.update(recordId, update),
        { recordId, operation: "initialize_ticket" }
      );
      const fallbackFields = updatedRecord && updatedRecord.fields ? updatedRecord.fields : { ...before, ...update };
      fields = await this.latestFields(recordId, fallbackFields);
      initialized = true;
      await this.safeEvent(recordId, before, update, actor, "创建工单");
    } else if (Object.keys(identityUpdate).length) {
      const updatedRecord = await this.retryOperation(
        () => this.repository.update(recordId, identityUpdate),
        { recordId, operation: "repair_reporter_identity" }
      );
      const fallbackFields = updatedRecord && updatedRecord.fields ? updatedRecord.fields : { ...before, ...identityUpdate };
      fields = await this.latestFields(recordId, fallbackFields);
      identityRepaired = true;
      await this.safeEvent(recordId, before, identityUpdate, actor, "补全报修人信息");
    }
    const reporterName = domain.text(fields[FIELD.reporter]) || domain.text(profile.name) || domain.text(reporter.name);
    if (reporterName && !domain.text(fields[FIELD.reporter])) {
      fields = { ...fields, [FIELD.reporter]: reporterName };
    }
    if (identityRepaired) {
      const groupMessageId = domain.text(fields[FIELD.groupMessageId]);
      if (groupMessageId) await this.feishu.updateCard(groupMessageId, cards.cardFor(recordId, fields));
    }
    if (domain.text(fields[FIELD.status]) === STATUS.pending && !domain.text(fields[FIELD.groupMessageId])) {
      const messageId = await this.retryOperation(
        () => this.feishu.sendCardToChat(
          config.itChatId,
          cards.newTicket(recordId, fields),
          stableUuid("ticket", recordId)
        ),
        { recordId, operation: "send_new_ticket_card" }
      );
      if (messageId) {
        await this.repository.update(recordId, { [FIELD.groupMessageId]: messageId });
        fields = { ...fields, [FIELD.groupMessageId]: messageId };
      }
    }
    return { initialized, identityRepaired, recordId, ticketNo: fields[FIELD.ticketNo] };
  }

  actionRequestOptions(deadlineAt, maxMs, reserveMs = 0) {
    const now = Date.now();
    const remainingMs = Number(deadlineAt) - now - reserveMs;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw new domain.DomainError("ACTION_TIMEOUT", "暂未确认工单已更新，请以最新卡片和多维表格状态为准；状态未变化时再重试。");
    }
    return { deadlineAt: now + Math.min(maxMs, remainingMs) };
  }

  logActionPhase(options, phase, extra = {}) {
    console.log(JSON.stringify({
      type: "card_action",
      phase,
      eventId: options.eventId || "",
      action: options.actionName,
      recordId: options.recordId,
      durationMs: Date.now() - options.startedAt,
      ...extra
    }));
  }

  waitForWriteOrProbe(writePromise, delayMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve({ kind: "probe" });
      }, Math.max(0, delayMs));
      writePromise.then((outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  async confirmActionUpdate(recordId, update, options) {
    this.logActionPhase(options, "readback_started", { whileWritePending: true });
    let lastRecord = null;
    let lastError = null;
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        lastRecord = await this.repository.get(
          recordId,
          this.actionRequestOptions(options.deadlineAt, 1050, 100)
        );
        if (lastRecord && updateMatches(lastRecord.fields, update)) {
          return { kind: "confirmed", source: "readback", record: lastRecord };
        }
      } catch (error) {
        lastError = error;
        if (!isTimeoutError(error) && error.code !== "ACTION_TIMEOUT") {
          return { kind: "readback_error", error };
        }
        break;
      }
      const remainingMs = Number(options.deadlineAt) - Date.now() - 150;
      if (attempt >= maxAttempts || remainingMs <= 0) break;
      await this.sleep(Math.min(this.actionReadbackIntervalMs, remainingMs));
    }
    return { kind: "readback_unconfirmed", record: lastRecord, error: lastError };
  }

  async persistActionUpdate(recordId, update, options) {
    // Do not begin a write when there is no useful callback budget left.
    if (options.deadlineAt - Date.now() < 300) {
      throw new domain.DomainError("ACTION_NOT_SUBMITTED", "读取工单耗时较长，本次操作尚未提交，请稍后重试。");
    }
    this.pendingWrites.set(recordId, { update, expiresAt: Date.now() + 60000 });
    const writePromise = Promise.resolve()
      .then(() => this.repository.update(
        recordId,
        update,
        this.actionRequestOptions(options.deadlineAt, config.cardCallbackBudgetMs, 100)
      ))
      .then((record) => {
        if (record && updateMatches(record.fields, update)) {
          return { kind: "confirmed", source: "write_response", record };
        }
        this.logActionPhase(options, "write_unconfirmed", { code: "WRITE_MISMATCH" });
        return { kind: "write_mismatch", record };
      })
      .catch((error) => {
        this.logActionPhase(options, "write_unconfirmed", {
          code: error.code || error.name || "WRITE_ERROR"
        });
        return { kind: "write_error", error };
      });

    const availableBeforeReadback = Number(options.deadlineAt) - Date.now() - 1150;
    const probeDelayMs = Math.min(this.actionReadbackDelayMs, Math.max(0, availableBeforeReadback));
    const first = await this.waitForWriteOrProbe(writePromise, probeDelayMs);
    if (first.kind === "confirmed") {
      this.pendingWrites.delete(recordId);
      return first;
    }
    if (first.error?.retryable === false) {
      this.pendingWrites.delete(recordId);
      throw first.error;
    }

    const readbackPromise = this.confirmActionUpdate(recordId, update, options);
    let writeOutcome = first.kind === "probe" ? null : first;
    let readbackOutcome = null;
    if (!writeOutcome) {
      const next = await Promise.race([writePromise, readbackPromise]);
      if (next.kind === "confirmed") {
        this.pendingWrites.delete(recordId);
        return next;
      }
      if (next.kind.startsWith("write_")) {
        writeOutcome = next;
        readbackOutcome = await readbackPromise;
      } else {
        readbackOutcome = next;
        writeOutcome = await writePromise;
      }
    } else {
      readbackOutcome = await readbackPromise;
    }
    if (writeOutcome.kind === "confirmed" || readbackOutcome.kind === "confirmed") {
      this.pendingWrites.delete(recordId);
      return writeOutcome.kind === "confirmed" ? writeOutcome : readbackOutcome;
    }

    const writeError = writeOutcome.error;
    if (writeError?.retryable === false) {
      this.pendingWrites.delete(recordId);
      throw writeError;
    }
    // A lost response (including a server error) does not prove the write failed.
    throw new domain.DomainError("WRITE_UNCONFIRMED", "操作结果尚未确认，可能已经生效。请勿连续点击；稍后查看最新卡片或多维表格状态。");
  }

  async action(actionName, recordId, actor, input = {}, options = {}) {
    for (const [id, pending] of this.pendingWrites) {
      if (pending.expiresAt <= Date.now()) this.pendingWrites.delete(id);
    }
    if (this.actionLocks.has(recordId)) {
      throw new domain.DomainError("ACTION_IN_PROGRESS", "该工单操作正在处理中，请勿重复点击。");
    }
    const actionOptions = {
      ...options,
      actionName,
      recordId,
      startedAt: Date.now(),
      deadlineAt: options.deadlineAt || Date.now() + config.cardCallbackBudgetMs
    };
    const task = this.performAction(actionName, recordId, actor, input, actionOptions);
    this.actionLocks.set(recordId, task);
    try {
      return await task;
    } finally {
      if (this.actionLocks.get(recordId) === task) this.actionLocks.delete(recordId);
    }
  }

  async performAction(actionName, recordId, actor, input = {}, options = {}) {
    let record;
    try {
      record = await this.repository.get(
        recordId,
        this.actionRequestOptions(options.deadlineAt, config.cardCallbackBudgetMs, 900)
      );
    } catch (error) {
      if (isTimeoutError(error) || error.code === "ACTION_TIMEOUT") {
        throw new domain.DomainError("ACTION_NOT_SUBMITTED", "读取工单超时，本次操作尚未提交，请稍后重试。");
      }
      throw error;
    }
    if (!record) throw new domain.DomainError("NOT_FOUND", "工单不存在。");
    const before = record.fields || {};
    const pending = this.pendingWrites.get(recordId);
    if (pending) {
      if (domain.versionOf(before) >= domain.versionOf(pending.update) || pending.expiresAt <= Date.now()) {
        this.pendingWrites.delete(recordId);
      } else {
        throw new domain.DomainError("WRITE_UNCONFIRMED", "上次操作结果仍待确认，请勿重复提交；稍后查看多维表格状态。");
      }
    }
    this.logActionPhase(options, "record_loaded", {
      status: domain.text(before[FIELD.status]),
      version: domain.versionOf(before)
    });
    let update;
    let actionLabel;
    try {
      if (actionName === "accept") {
        update = domain.accept(before, actor, input, this.roles);
        actionLabel = "接单";
      } else if (actionName === "reject") {
        update = domain.reject(before, actor, input, this.roles);
        actionLabel = "拒绝并关闭";
      } else if (actionName === "update_progress") {
        update = domain.updateProgress(before, actor, input, this.roles);
        actionLabel = "更新进展";
      } else if (actionName === "extend") {
        update = domain.extend(before, actor, input, this.roles);
        actionLabel = "延期";
      } else if (actionName === "complete") {
        update = domain.complete(before, actor, input, this.roles);
        actionLabel = "提交处理结果";
      } else if (actionName === "reporter_confirm") {
        update = domain.reporterConfirm(before, actor, input);
        actionLabel = "用户确认恢复";
      } else if (actionName === "reporter_reopen") {
        update = domain.reporterReopen(before, actor, input);
        actionLabel = "用户反馈未恢复";
      } else {
        throw new domain.DomainError("UNKNOWN_ACTION", "不支持的工单操作。");
      }
    } catch (error) {
      if (error instanceof domain.DomainError && error.code === "STALE_CARD") {
        const result = {
          card: cards.cardFor(recordId, before),
          message: "已刷新为工单的最新状态，请按当前卡片继续操作。",
          status: domain.text(before[FIELD.status]),
          version: domain.versionOf(before)
        };
        this.logActionPhase(options, "stale_card_refreshed", {
          status: result.status,
          version: result.version
        });
        return result;
      }
      throw error;
    }

    const confirmationResult = await this.persistActionUpdate(recordId, update, options);
    const confirmedRecord = confirmationResult.record;
    const confirmation = confirmationResult.source;

    const persisted = { ...before, ...(confirmedRecord.fields || {}) };
    this.logActionPhase(options, confirmation === "readback" ? "readback_confirmed" : "record_updated", {
      status: domain.text(persisted[FIELD.status]),
      version: domain.versionOf(persisted)
    });
    this.logTicketEvent(
      recordId,
      before,
      update,
      actor,
      actionLabel,
      this.actionDetail(actionName, before, update, input)
    );

    if (["reporter_confirm", "reporter_reopen"].includes(actionName)) {
      if (actionName === "reporter_reopen") {
        const result = {
          card: cards.reporterResult(recordId, persisted, "已退回继续处理", "IT 将继续处理该工单。", "orange"),
          message: "已退回 IT 继续处理。",
          status: domain.text(persisted[FIELD.status]),
          version: domain.versionOf(persisted)
        };
        this.logActionPhase(options, "card_ready", { status: result.status, version: result.version });
        return result;
      }
    }

    const result = {
      card: cards.cardFor(recordId, persisted),
      message: `${actionLabel}成功。`,
      status: domain.text(persisted[FIELD.status]),
      version: domain.versionOf(persisted)
    };
    this.logActionPhase(options, "card_ready", { status: result.status, version: result.version });
    return result;
  }

  async repairReporterConfirmation(record, result) {
    const fields = record.fields || {};
    if (
      domain.text(fields[FIELD.status]) !== STATUS.confirming ||
      !domain.text(fields[FIELD.reporterOpenId]) ||
      domain.text(fields[FIELD.reporterMessageId])
    ) {
      return false;
    }

    const messageId = await this.retryOperation(
      () => this.feishu.sendCardToUser(
        domain.text(fields[FIELD.reporterOpenId]),
        cards.reporterConfirmation(record.record_id, fields),
        stableUuid(`confirm-${domain.versionOf(fields)}`, record.record_id)
      ),
      { recordId: record.record_id, operation: "repair_reporter_confirmation" }
    );
    if (!messageId) return false;

    await this.repository.update(record.record_id, { [FIELD.reporterMessageId]: messageId });
    fields[FIELD.reporterMessageId] = messageId;
    result.repaired += 1;
    return true;
  }

  syncError(recordId, operation, error, result) {
    const detail = {
      recordId, operation, message: error.message,
      code: error.code || "UNEXPECTED_ERROR",
      apiCode: error.apiCode || 0, requestId: error.requestId || ""
    };
    result.failed += 1;
    result.errors.push(detail);
    console.error(JSON.stringify({ type: "sync_failed", ...detail }));
  }

  async refreshCard(record, field, card, operation, result) {
    const fields = record.fields || {};
    const messageId = domain.text(fields[field]);
    try {
      await this.retryOperation(() => this.feishu.updateCard(messageId, card), {
        recordId: record.record_id, operation
      });
    } catch (error) {
      // PATCH cannot repair a non-shared card in place, or a card older than
      // 14 days. Verify the legacy config before replacing an active card.
      // Never recreate a recalled/deleted message or bypass a permission error.
      if (domain.text(fields[FIELD.status]) === STATUS.closed && domain.closureType(fields) !== "超时自动关闭") throw error;
      let replace = error.apiCode === 230031;
      if (!replace && [230001, 230099].includes(error.apiCode) && this.feishu.getMessage) {
        const message = await this.feishu.getMessage(messageId);
        if (message?.msg_type === "interactive" && !message.deleted) {
          try {
            const original = JSON.parse(message.body?.content || "null");
            replace = Boolean(original && (!original.schema || original.schema === "1.0") &&
              original.config && original.config.update_multi !== true);
          } catch (_) { /* Unknown card representation: retain the original failure. */ }
        }
      }
      if (!replace) throw error;
      const uuid = stableUuid("renew", `${record.record_id}:${messageId}`);
      const replacementId = await this.retryOperation(() => field === FIELD.groupMessageId
        ? this.feishu.sendCardToChat(config.itChatId, card, uuid)
        : this.feishu.sendCardToUser(domain.text(fields[FIELD.reporterOpenId]), card, uuid), {
        recordId: record.record_id, operation: "replace_unpatchable_card"
      });
      if (!replacementId) throw new Error("Card replacement returned no message ID");
      await this.repository.update(record.record_id, { [field]: replacementId });
      fields[field] = replacementId;
      result.repaired += 1;
      console.log(JSON.stringify({ type: "card_replaced", recordId: record.record_id, operation, apiCode: error.apiCode }));
    }
  }

  async sync(options = {}) {
    const requestedRecordId = domain.text(
      typeof options === "string" ? options : options.recordId || options.record_id
    );
    let records;
    if (requestedRecordId) {
      const record = await this.retryOperation(
        () => this.repository.get(requestedRecordId),
        { recordId: requestedRecordId, operation: "get_ticket_for_targeted_sync" }
      );
      records = record ? [record] : [];
    } else {
      records = await this.retryOperation(
        () => this.repository.listAll(),
        { operation: "list_tickets_for_sync" }
      );
    }
    const result = {
      mode: requestedRecordId ? "targeted" : "full",
      recordId: requestedRecordId,
      scanned: records.length,
      initialized: 0,
      repaired: 0,
      refreshed: 0,
      refreshedClosed: 0,
      refreshedReporterClosed: 0,
      skippedClosed: 0,
      failed: 0,
      errors: []
    };

    // User confirmation is the only cross-message notification on the
    // completion path. Send it before refreshing historical or group cards so
    // full-scan compensation cannot delay the terminal user's notification.
    for (const record of records) {
      try {
        await this.repairReporterConfirmation(record, result);
      } catch (error) {
        this.syncError(record.record_id, "repair_reporter_confirmation", error, result);
      }
    }

    for (const record of records) {
      try {
        const fields = record.fields || {};
        const status = domain.text(fields[FIELD.status]);
        if (status === STATUS.closed) {
          const groupMessageId = domain.text(fields[FIELD.groupMessageId]);
          const reporterMessageId = domain.text(fields[FIELD.reporterMessageId]);
          let closedCardsRefreshed = 0;
          if (recentClosed(fields)) {
            for (const [field, messageId, counter, operation] of [
              [FIELD.groupMessageId, groupMessageId, "refreshedClosed", "refresh_recent_closed_group_card"],
              [FIELD.reporterMessageId, reporterMessageId, "refreshedReporterClosed", "refresh_recent_closed_reporter_card"]
            ]) {
              if (!messageId) continue;
              try {
                await this.refreshCard(record, field, cards.closed(record.record_id, fields), operation, result);
                result.refreshed += 1;
                result[counter] += 1;
                closedCardsRefreshed += 1;
              } catch (error) {
                this.syncError(record.record_id, operation, error, result);
              }
            }
          }
          if (!closedCardsRefreshed) result.skippedClosed += 1;
          if (
            domain.closureType(fields) === "IT拒绝关闭" &&
            domain.text(fields[FIELD.reporterOpenId]) &&
            !domain.text(fields[FIELD.reporterMessageId])
          ) {
            const messageId = await this.retryOperation(
              () => this.feishu.sendCardToUser(
                domain.text(fields[FIELD.reporterOpenId]),
                cards.reporterResult(
                  record.record_id,
                  fields,
                  "工单已被拒绝",
                  `**拒绝原因**：${domain.text(fields[FIELD.resolution])}`,
                  "red"
                ),
                stableUuid(`reject-${domain.versionOf(fields)}`, record.record_id)
              ),
              { recordId: record.record_id, operation: "repair_rejection_notice" }
            );
            if (messageId) await this.repository.update(record.record_id, { [FIELD.reporterMessageId]: messageId });
            result.repaired += 1;
          }
          continue;
        }
        if (!domain.text(fields[FIELD.ticketNo]) || !domain.text(fields[FIELD.reporterOpenId])) {
          const initialized = await this.initialize(record.record_id);
          if (initialized.initialized) result.initialized += 1;
          if (initialized.identityRepaired) result.repaired += 1;
          continue;
        }
        if (
          [STATUS.pending, STATUS.processing, STATUS.confirming].includes(status) &&
          !domain.text(fields[FIELD.groupMessageId])
        ) {
          const messageId = await this.retryOperation(
            () => this.feishu.sendCardToChat(
              config.itChatId,
              cards.cardFor(record.record_id, fields),
              stableUuid(`repair-${domain.versionOf(fields)}`, record.record_id)
            ),
            { recordId: record.record_id, operation: "repair_group_card" }
          );
          if (messageId) await this.repository.update(record.record_id, { [FIELD.groupMessageId]: messageId });
          result.repaired += 1;
        } else if (
          [STATUS.pending, STATUS.processing, STATUS.confirming].includes(status) &&
          domain.text(fields[FIELD.groupMessageId])
        ) {
          await this.refreshCard(record, FIELD.groupMessageId, cards.cardFor(record.record_id, fields),
            "refresh_active_group_card", result);
          result.refreshed += 1;
        }
      } catch (error) {
        this.syncError(record.record_id, "sync_ticket", error, result);
      }
    }
    return result;
  }

  async legacyCompletionBound(record) {
    const fields = record.fields || {};
    // Only first-completion legacy records qualify. Reopened tickets must have
    // an actual timestamp from the new completion path; never guess their age.
    if (domain.versionOf(fields) !== 3 || domain.number(fields[FIELD.reworkCount]) !== 0) return null;
    const messageId = domain.text(fields[FIELD.reporterMessageId]);
    const ticketNo = domain.text(fields[FIELD.ticketNo]);
    const verified = this.legacyBounds[record.record_id];
    if (verified && verified.version === domain.versionOf(fields) && verified.ticketNo === ticketNo &&
        verified.reporterMessageId === messageId) {
      return { date: parseDateTime(verified.completedBefore), source: verified.source };
    }
    if (!messageId || !ticketNo || !this.feishu.getMessage) return null;
    const message = await this.feishu.getMessage(messageId);
    const content = message?.body?.content || "";
    if (message?.message_id !== messageId || message.msg_type !== "interactive" || message.deleted ||
        !content.includes(ticketNo) || !content.includes("故障已恢复") || !content.includes("故障未恢复")) return null;
    const sentAt = parseDateTime(message.create_time);
    return sentAt && Number.isFinite(sentAt.getTime()) ? { date: sentAt, source: "confirmation_message_upper_bound" } : null;
  }

  async autoCloseDue(options = {}) {
    const deadlineAt = options.deadlineAt || Date.now() + 80000;
    const records = options.records || await this.repository.listAll();
    const now = options.now || new Date();
    const result = { scanned: records.length, closed: 0, notDue: 0, missingTime: 0,
      changed: 0, busy: 0, deferred: 0, failed: 0, notificationFailed: 0, errors: [], details: [] };
    let attempted = 0;
    for (const candidate of records) {
      const before = candidate.fields || {};
      if (domain.text(before[FIELD.status]) !== STATUS.confirming) continue;
      if (attempted >= 5 || Date.now() > deadlineAt - 20000) { result.deferred += 1; continue; }
      const id = candidate.record_id;
      if (this.actionLocks.has(id) || (this.pendingWrites.get(id)?.expiresAt || 0) > Date.now()) {
        result.busy += 1; continue;
      }
      const lock = {};
      this.actionLocks.set(id, lock);
      try {
        const hasActual = Boolean(domain.text(before[FIELD.completedAt]));
        const timing = hasActual
          ? { date: parseDateTime(before[FIELD.completedAt]), source: "completed_at" }
          : await this.legacyCompletionBound(candidate);
        const bound = timing?.date;
        if (!bound || !Number.isFinite(bound.getTime())) { result.missingTime += 1; continue; }
        if (!domain.autoClose(before, now, bound)) { result.notDue += 1; continue; }
        // Re-read after any message lookup. A user's feedback or a new cycle
        // observed here takes precedence over the scheduled close.
        const fresh = await this.repository.get(id, { deadlineAt });
        const fields = fresh?.fields || {};
        if (domain.versionOf(fields) !== domain.versionOf(before) ||
            domain.text(fields[FIELD.completedAt]) !== domain.text(before[FIELD.completedAt]) ||
            domain.text(fields[FIELD.reporterMessageId]) !== domain.text(before[FIELD.reporterMessageId])) {
          result.changed += 1; continue;
        }
        const update = domain.autoClose(fields, now, bound);
        if (!update) { result.changed += 1; continue; }
        attempted += 1;
        this.pendingWrites.set(id, { update, expiresAt: Date.now() + 60000 });
        let updated;
        let writeError;
        try { updated = await this.repository.update(id, update, { deadlineAt }); }
        catch (error) { writeError = error; }
        if (!updated || !updateMatches(updated.fields, update)) {
          updated = await this.repository.get(id, { deadlineAt });
        }
        if (!updated || !updateMatches(updated.fields, update)) {
          if (writeError?.retryable === false) this.pendingWrites.delete(id);
          throw writeError || new domain.DomainError("WRITE_UNCONFIRMED", "自动关闭结果待核实，未重复写入");
        }
        this.pendingWrites.delete(id);
        result.closed += 1;
        const evidence = { recordId: id, version: domain.versionOf(update),
          timeSource: timing.source,
          completedBefore: bound.getTime(), closedAt: now.getTime() };
        result.details.push(evidence);
        console.log(JSON.stringify({ type: "ticket_auto_closed", ...evidence }));
        await this.safeEvent(id, fields, update, { name: "系统" }, "超时自动关闭", "6小时内未反馈，默认工单已处理完毕");
        // A notification failure must never undo a successfully closed ticket.
        try {
          const synced = await this.sync({ recordId: id });
          result.notificationFailed += synced.failed;
          result.errors.push(...synced.errors);
        } catch (error) {
          result.notificationFailed += 1;
          result.errors.push({ recordId: id, operation: "notify_auto_close", code: error.code || "UNEXPECTED_ERROR" });
        }
      } catch (error) {
        this.syncError(id, "auto_close", error, result);
      } finally {
        if (this.actionLocks.get(id) === lock) this.actionLocks.delete(id);
      }
    }
    return result;
  }

  async checkSla() {
    const deadlineAt = Date.now() + 80000;
    const records = await this.retryOperation(
      () => this.repository.listAll(),
      { operation: "list_tickets_for_sla" }
    );
    const result = { scanned: records.length, breached: 0, alerted: 0, failed: 0 };
    result.autoClose = await this.autoCloseDue({ records, deadlineAt });
    for (const record of records) {
      try {
        const before = record.fields || {};
        const update = domain.markBreached(before);
        let fields = before;
        if (update) {
          await this.retryOperation(
            () => this.repository.update(record.record_id, update),
            { recordId: record.record_id, operation: "mark_sla_breached" }
          );
          fields = { ...before, ...update };
          result.breached += 1;
          await this.safeEvent(record.record_id, before, update, { name: "SLA任务" }, "SLA首次超时");
        }
        if (
          domain.text(fields[FIELD.slaBreachedEver]) === "是" &&
          !domain.text(fields[FIELD.slaAlertedAt]) &&
          [STATUS.pending, STATUS.processing].includes(domain.text(fields[FIELD.status]))
        ) {
          await this.retryOperation(
            () => this.feishu.sendCardToChat(
              config.itChatId,
              cards.overdue(record.record_id, fields),
              stableUuid("sla", record.record_id)
            ),
            { recordId: record.record_id, operation: "send_sla_alert" }
          );
          await this.repository.update(record.record_id, { [FIELD.slaAlertedAt]: Date.now() });
          result.alerted += 1;
        }
      } catch (error) {
        result.failed += 1;
        console.error(`sla check failed: recordId=${record.record_id} message=${error.message}`);
      }
    }
    return result;
  }
}

module.exports = { TicketService, stableUuid, hasReportPayload };
