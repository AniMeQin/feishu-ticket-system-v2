const { FIELD, STATUS } = require("./config");
const { addBusinessHours, formatTicketDate, parseDateTime } = require("./time");

class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

function text(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(", ");
  if (typeof value === "object") {
    for (const key of ["name", "text", "display_name", "value", "content"]) {
      const normalized = text(value[key]);
      if (normalized) return normalized;
    }
  }
  return "";
}

function number(value, fallback = 0) {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function actorId(actor = {}) {
  return text(actor.open_id || actor.openId || actor.id);
}

function actorName(actor = {}) {
  return text(actor.name || actor.display_name || actor.displayName) || actorId(actor) || "未知用户";
}

function versionOf(fields = {}) {
  return Math.max(0, number(fields[FIELD.version], 0));
}

function nextVersion(fields = {}) {
  return versionOf(fields) + 1;
}

function requireStatus(fields, allowed) {
  const current = text(fields[FIELD.status]);
  if (!allowed.includes(current)) {
    throw new DomainError("INVALID_STATE", `工单当前状态为「${current || "未知"}」，不能执行此操作。`);
  }
  return current;
}

function requireActor(actor) {
  const openId = actorId(actor);
  if (!openId) throw new DomainError("ACTOR_REQUIRED", "无法识别当前操作人。");
  return openId;
}

function requireItActor(actor, roles) {
  const openId = requireActor(actor);
  if (!roles.itOpenIds.includes(openId) && !roles.adminOpenIds.includes(openId)) {
    throw new DomainError("FORBIDDEN", "你不在 IT 处理人员名单中，不能操作工单。");
  }
  return openId;
}

function requireAssignee(fields, actor, roles) {
  const openId = requireItActor(actor, roles);
  const assigneeOpenId = text(fields[FIELD.assigneeOpenId]);
  if (assigneeOpenId && assigneeOpenId !== openId && !roles.adminOpenIds.includes(openId)) {
    throw new DomainError("FORBIDDEN", "该工单已由其他处理人接单。");
  }
  return openId;
}

function requireReporter(fields, actor) {
  const openId = requireActor(actor);
  const reporterOpenId = text(fields[FIELD.reporterOpenId]);
  if (!reporterOpenId || reporterOpenId !== openId) {
    throw new DomainError("FORBIDDEN", "只有该工单的报修人可以确认处理结果。");
  }
  return openId;
}

function requireExpectedVersion(fields, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === "") return;
  if (number(expectedVersion, -1) !== versionOf(fields)) {
    throw new DomainError("STALE_CARD", "这是一张旧卡片，请使用最新卡片操作。");
  }
}

function priorityCode(input) {
  const matched = text(input)
    .normalize("NFKC")
    .toUpperCase()
    .match(/^\s*(P[1-4])(?=$|[\s([{:\-—])/);
  return matched ? matched[1] : "";
}

function normalizePriority(value, fallback = "P3") {
  return priorityCode(value) || priorityCode(fallback) || "P3";
}

function priorityLabel(priority) {
  return {
    P1: "P1（紧急）",
    P2: "P2（高优）",
    P3: "P3（普通）",
    P4: "P4（低优）"
  }[priority] || "P3（普通）";
}

function recordCreatedAt(record, now = new Date()) {
  const fields = record.fields || {};
  return parseDateTime(fields[FIELD.submittedAt]) ||
    parseDateTime(fields[FIELD.sourceSubmittedAt]) ||
    parseDateTime(record.created_time || record.createdTime) ||
    now;
}

function makeTicketNo(recordId, createdAt) {
  const suffix = String(recordId || "record").replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase().padStart(6, "0");
  return `IT-${formatTicketDate(createdAt)}-${suffix}`;
}

function initialFields(record, policy, now = new Date()) {
  const fields = record.fields || {};
  const createdAt = recordCreatedAt(record, now);
  const selectedPriority = text(fields[FIELD.priority]).trim();
  const selectedPriorityCode = priorityCode(selectedPriority);
  const priority = selectedPriorityCode || normalizePriority(policy.defaultPriority);
  const dueAt = addBusinessHours(createdAt, policy.slaHours[priority], policy.slaHolidays);
  return {
    [FIELD.ticketNo]: text(fields[FIELD.ticketNo]) || makeTicketNo(record.record_id, createdAt),
    [FIELD.status]: STATUS.pending,
    [FIELD.version]: nextVersion(fields),
    [FIELD.submittedAt]: createdAt.getTime(),
    [FIELD.priority]: selectedPriorityCode ? selectedPriority : priorityLabel(priority),
    [FIELD.slaDueAt]: dueAt.getTime(),
    [FIELD.slaBreachedEver]: text(fields[FIELD.slaBreachedEver]) || "否",
    [FIELD.reworkCount]: number(fields[FIELD.reworkCount], 0)
  };
}

function requireFutureDate(value, now, fieldLabel) {
  const parsed = parseDateTime(value);
  if (!parsed) throw new DomainError("INVALID_INPUT", `${fieldLabel}格式不正确。`);
  if (parsed.getTime() <= now.getTime()) throw new DomainError("INVALID_INPUT", `${fieldLabel}必须晚于当前时间。`);
  return parsed;
}

function accept(fields, actor, input, roles, now = new Date()) {
  requireExpectedVersion(fields, input.version);
  requireStatus(fields, [STATUS.pending]);
  const openId = requireItActor(actor, roles);
  const promisedAt = text(input.promisedAt)
    ? requireFutureDate(input.promisedAt, now, "预计完成时间")
    : new Date(now.getTime() + 30 * 60 * 1000);
  return {
    [FIELD.status]: STATUS.processing,
    [FIELD.version]: nextVersion(fields),
    [FIELD.assigneeOpenId]: openId,
    [FIELD.assignee]: [{ id: openId }],
    [FIELD.acceptedAt]: now.getTime(),
    [FIELD.promisedAt]: promisedAt.getTime(),
    [FIELD.progress]: text(input.progress) || "已接单，开始处理"
  };
}

function reject(fields, actor, input, roles, now = new Date()) {
  requireExpectedVersion(fields, input.version);
  requireStatus(fields, [STATUS.pending]);
  requireItActor(actor, roles);
  const reason = text(input.reason);
  if (!reason) throw new DomainError("INVALID_INPUT", "请填写拒绝原因。");
  return {
    [FIELD.status]: STATUS.closed,
    [FIELD.version]: nextVersion(fields),
    [FIELD.resolution]: reason,
    [FIELD.progress]: `IT拒绝：${reason}`,
    [FIELD.closedType]: "IT拒绝关闭",
    [FIELD.closedAt]: now.getTime()
  };
}

function updateProgress(fields, actor, input, roles, now = new Date()) {
  requireExpectedVersion(fields, input.version);
  requireStatus(fields, [STATUS.processing]);
  requireAssignee(fields, actor, roles);
  const progress = text(input.progress);
  if (!progress) throw new DomainError("INVALID_INPUT", "请填写当前进展。");
  const update = {
    [FIELD.version]: nextVersion(fields),
    [FIELD.progress]: progress
  };
  return update;
}

function extend(fields, actor, input, roles, now = new Date()) {
  requireExpectedVersion(fields, input.version);
  requireStatus(fields, [STATUS.processing]);
  requireAssignee(fields, actor, roles);
  if (!text(input.promisedAt)) throw new DomainError("INVALID_INPUT", "请选择新的预计完成时间。");
  const promisedAt = requireFutureDate(input.promisedAt, now, "新的预计完成时间");
  const currentPromisedAt = parseDateTime(fields[FIELD.promisedAt]);
  if (currentPromisedAt && promisedAt.getTime() <= currentPromisedAt.getTime()) {
    throw new DomainError("INVALID_INPUT", "延期后的预计完成时间必须晚于当前预计完成时间。");
  }
  return {
    [FIELD.version]: nextVersion(fields),
    [FIELD.promisedAt]: promisedAt.getTime()
  };
}

function complete(fields, actor, input, roles, now = new Date()) {
  requireExpectedVersion(fields, input.version);
  requireStatus(fields, [STATUS.processing]);
  requireAssignee(fields, actor, roles);
  const resolution = text(input.resolution);
  if (!resolution) throw new DomainError("INVALID_INPUT", "请填写处理结果。");
  const update = {
    [FIELD.status]: STATUS.confirming,
    [FIELD.version]: nextVersion(fields),
    [FIELD.resolution]: resolution,
    [FIELD.completedAt]: now.getTime(),
    [FIELD.closedType]: ""
  };
  const dueAt = parseDateTime(fields[FIELD.slaDueAt]);
  if (dueAt && now.getTime() > dueAt.getTime()) update[FIELD.slaBreachedEver] = "是";
  return update;
}

function reporterConfirm(fields, actor, input, now = new Date()) {
  requireExpectedVersion(fields, input.version);
  requireStatus(fields, [STATUS.confirming]);
  requireReporter(fields, actor);
  return {
    [FIELD.status]: STATUS.closed,
    [FIELD.version]: nextVersion(fields),
    [FIELD.closedAt]: now.getTime(),
    [FIELD.closedType]: "用户确认关闭"
  };
}

function reporterReopen(fields, actor, input) {
  requireExpectedVersion(fields, input.version);
  requireStatus(fields, [STATUS.confirming]);
  requireReporter(fields, actor);
  return {
    [FIELD.status]: STATUS.processing,
    [FIELD.version]: nextVersion(fields),
    [FIELD.reworkCount]: number(fields[FIELD.reworkCount], 0) + 1,
    [FIELD.progress]: "报修人反馈故障未恢复，继续处理",
    [FIELD.resolution]: "",
    [FIELD.closedAt]: "",
    [FIELD.completedAt]: null,
    [FIELD.closedType]: "",
    [FIELD.reporterMessageId]: ""
  };
}

function closureType(fields = {}) {
  if (text(fields[FIELD.status]) !== STATUS.closed) return "";
  const explicit = text(fields[FIELD.closedType]);
  if (["超时自动关闭", "用户确认关闭", "IT拒绝关闭"].includes(explicit)) return explicit;
  const progress = text(fields[FIELD.progress]);
  const wasAccepted = Boolean(text(fields[FIELD.acceptedAt]) || text(fields[FIELD.assigneeOpenId]));
  if (progress.startsWith("IT拒绝：") || (!wasAccepted && text(fields[FIELD.resolution]))) return "IT拒绝关闭";
  return "用户确认关闭";
}

// Six elapsed hours, including nights/weekends; independent of the SLA calendar.
const CONFIRMATION_WAIT_MS = 6 * 60 * 60 * 1000;
function autoClose(fields, now = new Date(), completedBefore = null) {
  if (text(fields[FIELD.status]) !== STATUS.confirming) return null;
  // The fallback is a verified upper bound for legacy completion, never a
  // replacement for the actual completion time stored on newer records.
  const started = parseDateTime(fields[FIELD.completedAt]) || parseDateTime(completedBefore);
  if (!started || !Number.isFinite(started.getTime()) || now.getTime() - started.getTime() < CONFIRMATION_WAIT_MS) return null;
  return {
    [FIELD.status]: STATUS.closed,
    [FIELD.version]: nextVersion(fields),
    [FIELD.closedAt]: now.getTime(),
    [FIELD.closedType]: "超时自动关闭"
  };
}

function markBreached(fields, now = new Date()) {
  const status = text(fields[FIELD.status]);
  if (![STATUS.pending, STATUS.processing].includes(status)) return null;
  if (text(fields[FIELD.slaBreachedEver]) === "是") return null;
  const dueAt = parseDateTime(fields[FIELD.slaDueAt]);
  if (!dueAt || dueAt.getTime() >= now.getTime()) return null;
  return {
    [FIELD.slaBreachedEver]: "是"
  };
}

module.exports = {
  DomainError,
  text,
  number,
  actorId,
  actorName,
  versionOf,
  initialFields,
  accept,
  reject,
  updateProgress,
  extend,
  complete,
  reporterConfirm,
  reporterReopen,
  markBreached,
  autoClose,
  CONFIRMATION_WAIT_MS,
  closureType,
  normalizePriority
};
