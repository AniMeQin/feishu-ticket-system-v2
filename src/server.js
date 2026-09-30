const crypto = require("crypto");
const http = require("http");
const { config, readiness } = require("./config");
const { DomainError, text } = require("./domain");
const cards = require("./cards");
const feishu = require("./feishu");
const { TicketRepository } = require("./repository");
const { TicketService } = require("./ticket-service");

const VERSION = "1.1.13-lite";
const seenEvents = new Map();

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validFeishuToken(body, expected = config.verificationToken) {
  const token = body && (body.token || (body.header && body.header.token));
  return Boolean(expected && token && safeEqual(token, expected));
}

function isCardActionCallback(body = {}) {
  const eventType = body.header && body.header.event_type;
  return eventType === "card.action.trigger" || body.type === "message_action";
}

function validJobAuthorization(header, expected = config.internalJobToken) {
  const value = String(header || "");
  return Boolean(expected && value.startsWith("Bearer ") && safeEqual(value.slice(7), expected));
}

function validSignature(rawBody, headers, encryptKey = config.encryptKey, now = Date.now()) {
  if (!encryptKey) return false;
  const timestamp = String(headers["x-lark-request-timestamp"] || "");
  const nonce = String(headers["x-lark-request-nonce"] || "");
  const signature = String(headers["x-lark-signature"] || "");
  const timestampMs = Number(timestamp) * 1000;
  if (!timestamp || !nonce || !signature || !Number.isFinite(timestampMs)) return false;
  if (Math.abs(now - timestampMs) > 5 * 60 * 1000) return false;
  const calculated = crypto.createHash("sha256").update(timestamp + nonce + encryptKey + rawBody).digest("hex");
  return safeEqual(calculated, signature);
}

function decryptEvent(encrypted, encryptKey = config.encryptKey) {
  const packed = Buffer.from(String(encrypted || ""), "base64");
  if (packed.length <= 16) throw new Error("invalid encrypted event");
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const iv = packed.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(packed.subarray(16)), decipher.final()]).toString("utf8");
  return JSON.parse(decrypted);
}

function beginEvent(eventId, now = Date.now()) {
  if (!eventId) return "";
  for (const [id, entry] of seenEvents) {
    if (now - entry.updatedAt > (entry.status === "processing" ? 60000 : 300000)) seenEvents.delete(id);
  }
  const existing = seenEvents.get(eventId);
  if (existing) return existing.status;
  seenEvents.set(eventId, { status: "processing", updatedAt: now });
  if (seenEvents.size > 1000) seenEvents.delete(seenEvents.keys().next().value);
  return "";
}

function completeEvent(eventId, now = Date.now(), response) {
  if (!eventId) return;
  seenEvents.set(eventId, { status: "completed", updatedAt: now, response });
}

function releaseEvent(eventId) {
  if (eventId) seenEvents.delete(eventId);
}

function cardResponse(message, card, toastType = "info") {
  const response = { toast: { type: toastType, content: message } };
  if (card) response.card = { type: "raw", data: card };
  return response;
}

function json(status, body) {
  return { status, body };
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new DomainError("BODY_TOO_LARGE", "请求内容过大。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new DomainError("INVALID_JSON", "请求内容不是有效 JSON。");
  }
}

async function readOptionalJson(req) {
  if (!req || typeof req[Symbol.asyncIterator] !== "function") return {};
  return parseJson(await readRaw(req));
}

function normalizeFormValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) return value.map(normalizeFormValue).find(Boolean) || "";
  if (typeof value === "object") {
    for (const key of ["value", "datetime", "date", "text", "content"]) {
      const normalized = normalizeFormValue(value[key]);
      if (normalized) return normalized;
    }
  }
  return "";
}

function normalizeDateTimeFormValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object" || Array.isArray(value)) return normalizeFormValue(value);
  for (const key of ["datetime", "date_time", "dateTime", "timestamp", "value", "date", "text", "content"]) {
    const normalized = normalizeFormValue(value[key]);
    if (normalized) return normalized;
  }
  return "";
}

const CARD_ACTIONS = new Set([
  "accept",
  "reject",
  "update_progress",
  "extend",
  "complete",
  "reporter_confirm",
  "reporter_reopen"
]);

function normalizeActionName(action, value) {
  for (const candidate of [action && action.name, action && action.tag, value && value.action]) {
    const name = normalizeFormValue(candidate);
    if (CARD_ACTIONS.has(name)) return name;
  }
  return "";
}

function extractActor(body) {
  const event = body.event || {};
  const actor = event.operator || body.operator || {};
  return {
    open_id: actor.open_id || actor.openId || (actor.operator_id && actor.operator_id.open_id) || "",
    name: actor.name || actor.display_name || actor.displayName || ""
  };
}

function extractAction(body) {
  const event = body.event || body;
  const action = event.action || body.action || {};
  const value = typeof action.value === "string" ? parseJson(action.value) : action.value || {};
  const form = action.form_value || action.formValue || event.form_value || event.formValue || {};
  return {
    name: normalizeActionName(action, value),
    tag: normalizeFormValue(action.tag),
    recordId: value.record_id || value.recordId || "",
    input: {
      version: value.version,
      promisedAt: normalizeDateTimeFormValue(form.promised_at || value.promised_at),
      progress: normalizeFormValue(form.progress || value.progress),
      resolution: normalizeFormValue(form.resolution || value.resolution),
      reason: normalizeFormValue(form.reason || value.reason)
    }
  };
}

function extractRecordIds(body) {
  const event = body.event || {};
  const ids = new Set();
  for (const value of [event.record_id, event.recordId, event.record && event.record.record_id]) {
    if (value) ids.add(value);
  }
  for (const action of event.action_list || event.actions || []) {
    if (action.action === "record_added" && action.record_id) ids.add(action.record_id);
  }
  return Array.from(ids);
}

function createHandler(service) {
  return async function handle(req) {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json(200, {
        code: 0,
        msg: "ok",
        version: VERSION,
        commit: config.appCommit,
        slaCalendarYears: [2026],
        ...readiness(),
        time: new Date().toISOString()
      });
    }

    if (req.method === "POST" && ["/jobs/sync", "/jobs/sla", "/jobs/auto-close"].includes(url.pathname)) {
      if (!validJobAuthorization(req.headers.authorization)) return json(401, { code: 401, msg: "unauthorized" });
      const job = url.pathname.split("/").pop();
      const input = job === "sync" ? await readOptionalJson(req) : {};
      const recordId = job === "sync"
        ? text(url.searchParams.get("record_id") || input.record_id || input.recordId)
        : "";
      const startedAt = Date.now();
      console.log(JSON.stringify({
        type: "scheduled_job",
        phase: "received",
        job,
        mode: recordId ? "targeted" : "full",
        recordId
      }));
      try {
        const result = job === "sync"
          ? await service.sync(recordId ? { recordId } : {})
          : job === "auto-close" ? await service.autoCloseDue() : await service.checkSla();
        console.log(JSON.stringify({
          type: "scheduled_job",
          phase: "completed",
          job,
          durationMs: Date.now() - startedAt,
          result
        }));
        return json(200, { code: 0, msg: "ok", data: result });
      } catch (error) {
        console.error(JSON.stringify({
          type: "scheduled_job",
          phase: "failed",
          job,
          durationMs: Date.now() - startedAt,
          code: error.code || "UNEXPECTED_ERROR",
          message: error.message
        }));
        throw error;
      }
    }

    if (req.method === "POST" && url.pathname === "/feishu/events") {
      const requestStartedAt = Date.now();
      const raw = await readRaw(req);
      const envelope = parseJson(raw);
      const signatureValid = validSignature(raw, req.headers);
      let body;
      try {
        body = envelope.encrypt ? decryptEvent(envelope.encrypt) : envelope;
      } catch (error) {
        console.warn(`callback rejected: decrypt failed encrypted=${Boolean(envelope.encrypt)} signatureValid=${signatureValid} message=${error.message}`);
        return json(401, { code: 401, msg: "invalid callback payload" });
      }
      if (!validFeishuToken(body)) {
        console.warn(`callback rejected: invalid verification token encrypted=${Boolean(envelope.encrypt)} signatureValid=${signatureValid}`);
        return json(401, { code: 401, msg: "invalid verification token" });
      }
      if (!signatureValid) {
        const timestampMs = Number(req.headers["x-lark-request-timestamp"]) * 1000;
        const hasHeaders = ["x-lark-request-timestamp", "x-lark-request-nonce", "x-lark-signature"]
          .every((name) => Boolean(req.headers[name]));
        console.warn(JSON.stringify({
          type: "callback_auth", method: "verification_token", encrypted: Boolean(envelope.encrypt),
          signatureReason: !hasHeaders ? "missing_headers" : !Number.isFinite(timestampMs) ? "invalid_timestamp"
            : Math.abs(Date.now() - timestampMs) > 300000 ? "timestamp_out_of_window" : "digest_mismatch",
          eventType: body.header?.event_type || body.type || "",
          // No signature, token, nonce, encrypted body or business content is logged.
          timestampSkewMs: hasHeaders && Number.isFinite(timestampMs) ? Date.now() - timestampMs : null
        }));
      }
      const eventType = body.header && body.header.event_type;

      if (body.type === "url_verification" || body.challenge) return json(200, { challenge: body.challenge });
      const eventId = body.header && body.header.event_id;
      const eventStatus = beginEvent(eventId);
      if (eventStatus) {
        const response = seenEvents.get(eventId)?.response;
        return json(200, response || (isCardActionCallback(body)
          ? cardResponse("该操作正在处理，请勿重复点击。", null, "warning")
          : { code: 0, msg: eventStatus === "completed" ? "duplicate ignored" : "event processing" }));
      }

      if (eventType === "card.action.trigger" || body.type === "message_action") {
        const parsed = extractAction(body);
        const actionStartedAt = Date.now();
        // A date/time picker can emit its own callback while the user is only
        // editing a form. Never treat that interaction as the form button.
        // Returning an empty response keeps the current card unchanged and
        // lets the user submit once with the explicit button.
        if (parsed.tag && parsed.tag !== "button") {
          completeEvent(eventId);
          console.log(JSON.stringify({
            type: "card_action",
            phase: "input_ignored",
            eventId: eventId || "",
            tag: parsed.tag,
            name: parsed.name || ""
          }));
          return json(200, {});
        }
        if (!parsed.name || !parsed.recordId) {
          completeEvent(eventId);
          return json(200, cardResponse("卡片参数不完整。", null, "error"));
        }
        console.log(JSON.stringify({
          type: "card_action",
          phase: "received",
          eventId: eventId || "",
          action: parsed.name,
          recordId: parsed.recordId,
          durationMs: 0
        }));
        try {
          const result = await service.action(
            parsed.name,
            parsed.recordId,
            extractActor(body),
            parsed.input,
            {
              deadlineAt: requestStartedAt + config.cardCallbackBudgetMs,
              eventId: eventId || ""
            }
          );
          const response = cardResponse(result.message, result.card, "success");
          completeEvent(eventId, Date.now(), response);
          console.log(JSON.stringify({
            type: "card_action",
            phase: "response_sent",
            eventId: eventId || "",
            action: parsed.name,
            recordId: parsed.recordId,
            status: result.status || "",
            version: result.version || 0,
            durationMs: Date.now() - actionStartedAt
          }));
          return json(200, response);
        } catch (error) {
          const message = error instanceof DomainError ? error.message : "系统处理失败，请稍后重试。";
          const uncertain = error.code === "WRITE_UNCONFIRMED";
          const response = cardResponse(message, null,
            uncertain || error.code === "ACTION_IN_PROGRESS" ? "warning" : "error");
          const shouldRelease = !(error instanceof DomainError) ||
            ["ACTION_TIMEOUT", "ACTION_NOT_SUBMITTED", "WRITE_UNCONFIRMED", "ACTION_IN_PROGRESS"].includes(error.code);
          if (shouldRelease) releaseEvent(eventId);
          else completeEvent(eventId, Date.now(), response);
          console.error(JSON.stringify({
            type: "card_action",
            phase: uncertain ? "unconfirmed" : "failed",
            eventId: eventId || "",
            action: parsed.name,
            recordId: parsed.recordId,
            code: error.code || "UNEXPECTED_ERROR",
            apiCode: error.apiCode || 0,
            requestId: error.requestId || "",
            message: error.message,
            durationMs: Date.now() - actionStartedAt
          }));
          return json(200, response);
        }
      }

      try {
        const initialized = [];
        for (const recordId of extractRecordIds(body)) initialized.push(await service.initialize(recordId, extractActor(body)));
        completeEvent(eventId);
        return json(200, { code: 0, msg: "ok", initialized });
      } catch (error) {
        releaseEvent(eventId);
        throw error;
      }
    }

    return json(404, { code: 404, msg: "not found" });
  };
}

function send(res, result) {
  const payload = JSON.stringify(result.body);
  res.writeHead(result.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(payload);
}

function createServer(service = new TicketService(new TicketRepository(feishu), feishu)) {
  const handler = createHandler(service);
  return http.createServer(async (req, res) => {
    try {
      send(res, await handler(req));
    } catch (error) {
      if (error instanceof DomainError) return send(res, json(400, { code: 400, msg: error.message }));
      console.error(error);
      return send(res, json(500, { code: 500, msg: "internal error" }));
    }
  });
}

function start() {
  const state = readiness();
  if (!state.ready) throw new Error(`Missing required configuration: ${state.missing.join(", ")}`);
  const server = createServer();
  server.listen(config.port, () => console.log(`feishu-ticket-system-lite listening on ${config.port}`));
  return server;
}

if (require.main === module) start();

module.exports = {
  VERSION,
  safeEqual,
  validFeishuToken,
  validJobAuthorization,
  validSignature,
  decryptEvent,
  isCardActionCallback,
  beginEvent,
  completeEvent,
  releaseEvent,
  cardResponse,
  extractAction,
  createHandler,
  createServer,
  start
};
