const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { config, FIELD: F, STATUS: S } = require("../src/config");
const { TicketService } = require("../src/ticket-service");
const { FeishuApiError, FeishuTimeoutError, requestJson } = require("../src/feishu");
const { DomainError, accept, extend } = require("../src/domain");
const { formatDateTime } = require("../src/time");
const cards = require("../src/cards");
const { createHandler, beginEvent, completeEvent, releaseEvent } = require("../src/server");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const actor = { open_id: "ou_it", name: "IT" };
const input = () => ({ version: 1, promisedAt: Date.now() + 7200000 });

function fixture(overrides = {}) {
  let fields = {
    [F.ticketNo]: "IT-TEST", [F.status]: S.pending, [F.version]: 1,
    [F.reporterOpenId]: "ou_reporter", [F.groupMessageId]: "om_group", ...overrides
  };
  const writes = [];
  const repository = {
    get: async () => ({ record_id: "rec_test", fields: { ...fields } }),
    update: async (id, update) => {
      writes.push(update);
      fields = { ...fields, ...update };
      return { record_id: id, fields: { ...fields } };
    },
    listAll: async () => [await repository.get()],
    appendEvent: async () => {}
  };
  const feishu = { updateCard: async () => {}, sendCardToUser: async () => "om_user" };
  const service = new TicketService(repository, feishu);
  service.roles = { itOpenIds: ["ou_it"], adminOpenIds: [] };
  service.actionReadbackDelayMs = 10;
  service.actionReadbackIntervalMs = 1;
  service.retryDelaysMs = [0, 0];
  return { repository, feishu, service, writes, fields: () => fields };
}

test("accept, complete and reporter confirmation persist one transition each", async () => {
  const f = fixture();
  assert.equal((await f.service.action("accept", "rec_test", actor, input())).status, S.processing);
  assert.equal((await f.service.action("complete", "rec_test", actor, { version: 2, resolution: "已修复" })).status, S.confirming);
  assert.equal((await f.service.action("reporter_confirm", "rec_test", { open_id: "ou_reporter" }, { version: 3 })).status, S.closed);
  assert.equal(f.writes.length, 3);
  assert.equal(f.fields()[F.version], 4);
});

test("a 1.4 second record read can still complete within the callback budget", async () => {
  const f = fixture();
  const get = f.repository.get;
  f.repository.get = async (id, options) => {
    const remaining = options.deadlineAt - Date.now();
    await delay(Math.min(1400, remaining));
    if (remaining < 1400) throw new FeishuTimeoutError();
    return get(id);
  };
  const started = Date.now();
  const result = await f.service.action("accept", "rec_test", actor, input());
  assert.equal(result.status, S.processing);
  assert.ok(Date.now() - started < 2850);
  assert.equal(f.writes.length, 1);
});

test("read timeout performs no write and says not submitted", async () => {
  const f = fixture();
  f.repository.get = async () => { throw new FeishuTimeoutError(); };
  await assert.rejects(f.service.action("accept", "rec_test", actor, input()), { code: "ACTION_NOT_SUBMITTED" });
  assert.equal(f.writes.length, 0);
});

test("an exhausted callback budget never starts a write", async () => {
  const f = fixture();
  await assert.rejects(f.service.action("accept", "rec_test", actor, input(), {
    deadlineAt: Date.now() + 200
  }), { code: "ACTION_NOT_SUBMITTED" });
  assert.equal(f.writes.length, 0);
});

test("lost write acknowledgement is reconciled by readback without another write", async () => {
  const f = fixture();
  const update = f.repository.update;
  f.repository.update = async (...args) => { await update(...args); throw new FeishuTimeoutError(); };
  assert.equal((await f.service.action("accept", "rec_test", actor, input())).status, S.processing);
  assert.equal(f.writes.length, 1);
  const refreshed = await f.service.action("accept", "rec_test", actor, input());
  assert.equal(refreshed.version, 2);
  assert.equal(f.writes.length, 1);
});

test("unconfirmed write blocks rapid resubmission, then observes the committed version", async () => {
  const f = fixture();
  const originalUpdate = f.repository.update;
  let pending;
  let attempted = 0;
  f.repository.update = async (id, update) => {
    attempted += 1; pending = update;
    throw new FeishuTimeoutError();
  };
  await assert.rejects(f.service.action("accept", "rec_test", actor, input()), { code: "WRITE_UNCONFIRMED" });
  await assert.rejects(f.service.action("accept", "rec_test", actor, input()), { code: "WRITE_UNCONFIRMED" });
  assert.equal(attempted, 1);
  await originalUpdate("rec_test", pending);
  assert.equal((await f.service.action("accept", "rec_test", actor, input())).version, 2);
  assert.equal(attempted, 1);
});

test("same-record concurrent callbacks cannot write twice", async () => {
  const f = fixture();
  const get = f.repository.get;
  f.repository.get = async () => { await delay(20); return get(); };
  const first = f.service.action("accept", "rec_test", actor, input());
  await assert.rejects(f.service.action("accept", "rec_test", actor, input()), { code: "ACTION_IN_PROGRESS" });
  await first;
  assert.equal(f.writes.length, 1);
});

test("unauthorized and invalid input actions leave the record unchanged", async () => {
  const f = fixture();
  await assert.rejects(f.service.action("accept", "rec_test", { open_id: "ou_stranger" }, input()), { code: "FORBIDDEN" });
  for (const promisedAt of ["invalid-date", Date.now() - 60000]) {
    await assert.rejects(f.service.action("accept", "rec_test", actor, { version: 1, promisedAt }), { code: "INVALID_INPUT" });
  }
  assert.equal(f.writes.length, 0);
});

test("blank accept time defaults to 30 natural minutes after acceptance, including midnight and weekends", () => {
  const f = fixture();
  const now = new Date("2026-09-25T23:50:00+08:00");
  for (const promisedAt of [undefined, null, "", "   "]) {
    const update = accept(f.fields(), actor, { version: 1, promisedAt }, f.service.roles, now);
    assert.equal(update[F.acceptedAt], now.getTime());
    assert.equal(update[F.promisedAt], new Date("2026-09-26T00:20:00+08:00").getTime());
    assert.equal(update[F.status], S.processing);
  }
});

test("manual accept time is preserved and extension still requires a later explicit time", () => {
  const f = fixture();
  const now = new Date("2026-09-23T14:00:00+08:00");
  const promisedAt = "2026-09-23 16:45";
  const update = accept(f.fields(), actor, { version: 1, promisedAt }, f.service.roles, now);
  assert.equal(update[F.promisedAt], new Date("2026-09-23T16:45:00+08:00").getTime());
  for (const invalid of [undefined, promisedAt, "2026-09-23 15:00"]) {
    assert.throws(() => extend(update, actor, { version: 2, promisedAt: invalid }, f.service.roles, now), { code: "INVALID_INPUT" });
  }
});

test("accepting with no time persists and displays the concrete default time", async () => {
  const f = fixture();
  const result = await f.service.action("accept", "rec_test", actor, { version: 1 });
  assert.equal(result.status, S.processing);
  assert.equal(f.writes.length, 1);
  assert.equal(f.fields()[F.promisedAt] - f.fields()[F.acceptedAt], 30 * 60 * 1000);
  assert.ok(JSON.stringify(result.card).includes(formatDateTime(new Date(f.fields()[F.promisedAt]))));
});

test("HTTP 400 keeps API code/log ID and does not expose raw error values", async (t) => {
  t.mock.method(global, "fetch", async () => new Response(JSON.stringify({
    code: 230099, msg: "bad card; ErrorValue: PRIVATE CONTENT", error: { log_id: "log_test" }
  }), { status: 400 }));
  await assert.rejects(requestJson("https://example.invalid/test"), (error) => {
    assert.equal(error.apiCode, 230099);
    assert.equal(error.requestId, "log_test");
    assert.equal(error.retryable, false);
    assert.ok(!error.message.includes("PRIVATE CONTENT"));
    return true;
  });
});

test("HTTP 200 API failure is not mistaken for success; non-JSON 503 remains retryable", async (t) => {
  const mock = t.mock.method(global, "fetch", async () => new Response(JSON.stringify({ code: 230027, msg: "permission denied" })));
  await assert.rejects(requestJson("https://example.invalid/test"), { apiCode: 230027 });
  mock.mock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(requestJson("https://example.invalid/test"), { status: 503, retryable: true });
});

test("permanent 400 is not retried; Feishu rate limit 230020 is retried", async () => {
  const f = fixture();
  let count = 0;
  await assert.rejects(f.service.retryOperation(async () => {
    count += 1; throw new FeishuApiError(400, { code: 230027 });
  }));
  assert.equal(count, 1);
  count = 0;
  assert.equal(await f.service.retryOperation(async () => {
    count += 1;
    if (count === 1) throw new FeishuApiError(400, { code: 230020 });
    return "ok";
  }), "ok");
  assert.equal(count, 2);
});

test("all outgoing card types enable shared updates; accept picker explains the submit-time default", () => {
  const fields = fixture().fields();
  for (const card of [cards.newTicket("rec_test", fields), cards.processing("rec_test", fields),
    cards.confirming("rec_test", fields), cards.closed("rec_test", fields),
    cards.reporterConfirmation("rec_test", fields), cards.reporterResult("rec_test", fields, "结果", "完成"),
    cards.overdue("rec_test", fields), cards.error("失败")]) {
    assert.equal(card.config.update_multi, true);
  }
  const picker = cards.newTicket("rec_test", fields).elements[1].elements[0];
  assert.equal(picker.initial_datetime, undefined);
  assert.equal(picker.label.content, "预计完成时间（选填）");
  assert.equal(picker.placeholder.content, "不选则默认为接单后 30 分钟");
  assert.ok(!JSON.stringify(cards.confirming("rec_test", fields)).includes("已私聊报修人确认"));
});

test("closed group-card failure does not block reporter-card refresh", async () => {
  const f = fixture({ [F.status]: S.closed, [F.closedAt]: Date.now(), [F.reporterMessageId]: "om_user" });
  const calls = [];
  f.feishu.updateCard = async (id) => {
    calls.push(id);
    if (id === "om_group") throw new FeishuApiError(400, { code: 230031 });
  };
  const result = await f.service.sync();
  assert.deepEqual(calls, ["om_group", "om_user"]);
  assert.equal(result.failed, 1);
  assert.equal(result.refreshedReporterClosed, 1);
});

test("reporter notification failure does not block group-card refresh", async () => {
  const f = fixture({ [F.status]: S.confirming });
  let refreshed = false;
  f.feishu.sendCardToUser = async () => { throw new FeishuApiError(400, { code: 230013 }); };
  f.feishu.updateCard = async () => { refreshed = true; };
  const result = await f.service.sync();
  assert.equal(result.failed, 1);
  assert.equal(refreshed, true);
});

test("confirmed legacy non-shared active card is replaced with a stable UUID and saved ID", async () => {
  const f = fixture();
  f.feishu.updateCard = async () => { throw new FeishuApiError(400, { code: 230001 }); };
  f.feishu.getMessage = async () => ({ msg_type: "interactive", body: { content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [] }) } });
  const uuids = [];
  f.feishu.sendCardToChat = async (chat, card, uuid) => { uuids.push(uuid); return "om_replacement"; };
  // Simulate a lost acknowledgement saving the new message ID.
  const update = f.repository.update;
  let failSave = true;
  f.repository.update = async (...args) => { if (failSave) throw new Error("network lost"); return update(...args); };
  assert.equal((await f.service.sync()).failed, 1);
  failSave = false;
  assert.equal((await f.service.sync()).repaired, 1);
  assert.equal(uuids[0], uuids[1]);
  assert.equal(f.fields()[F.groupMessageId], "om_replacement");
});

test("unknown card representation, permission errors and recalled cards are never blindly replaced", async () => {
  for (const code of [230001, 230027, 230011, 230110]) {
    const f = fixture();
    f.feishu.updateCard = async () => { throw new FeishuApiError(400, { code }); };
    f.feishu.getMessage = async () => ({ msg_type: "interactive", body: { content: '{"elements":[]}' } });
    let sent = 0;
    f.feishu.sendCardToChat = async () => { sent += 1; return "om_new"; };
    assert.equal((await f.service.sync()).failed, 1);
    assert.equal(sent, 0);
  }
});

test("expired active card is replaced; closed historical cards are never resent", async () => {
  for (const status of [S.processing, S.closed]) {
    const f = fixture({ [F.status]: status, [F.closedAt]: Date.now() });
    f.feishu.updateCard = async () => { throw new FeishuApiError(400, { code: 230031 }); };
    let sent = 0;
    f.feishu.sendCardToChat = async () => { sent += 1; return "om_new"; };
    await f.service.sync();
    assert.equal(sent, status === S.processing ? 1 : 0);
  }
});

test("extend and reporter reopen retain ownership and version checks", async () => {
  const f = fixture();
  await f.service.action("accept", "rec_test", actor, input());
  await f.service.action("extend", "rec_test", actor, { version: 2, promisedAt: Date.now() + 10800000 });
  await f.service.action("complete", "rec_test", actor, { version: 3, resolution: "请复测" });
  await assert.rejects(f.service.action("reporter_reopen", "rec_test", actor, { version: 4 }), { code: "FORBIDDEN" });
  const reopened = await f.service.action("reporter_reopen", "rec_test", { open_id: "ou_reporter" }, { version: 4 });
  assert.equal(reopened.status, S.processing);
  assert.equal(f.fields()[F.version], 5);
  assert.equal(f.fields()[F.reworkCount], 1);
});

function callback(eventId, bodyOverrides = {}) {
  const body = {
    header: { event_type: "card.action.trigger", event_id: eventId, token: config.verificationToken },
    event: { operator: actor, action: { tag: "button", value: { action: "accept", record_id: "rec_test", version: 1 } } },
    ...bodyOverrides
  };
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", crypto.createHash("sha256").update(config.encryptKey).digest(), iv);
  const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify(body)), cipher.final()]).toString("base64");
  const raw = JSON.stringify({ encrypt: encrypted });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "test-nonce";
  const req = Readable.from([Buffer.from(raw)]);
  req.url = "/feishu/events";
  req.method = "POST";
  req.headers = { "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce,
    "x-lark-signature": crypto.createHash("sha256").update(timestamp + nonce + config.encryptKey + raw).digest("hex") };
  return req;
}

test("encrypted callbacks: deduplication, warning, token rejection and picker safety", async () => {
  const saved = { verificationToken: config.verificationToken, encryptKey: config.encryptKey };
  config.verificationToken = "test-verification";
  config.encryptKey = "test-encryption";
  try {
    let calls = 0;
    const handler = createHandler({ action: async () => {
      calls += 1;
      return { message: "接单成功", card: { config: { update_multi: true }, elements: [] } };
    } });
    const first = await handler(callback("test-dedup"));
    const second = await handler(callback("test-dedup"));
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
    const invalid = callback("test-invalid", { header: { token: "wrong" } });
    assert.equal((await handler(invalid)).status, 401);
    const picker = callback("test-picker", { event: { action: { tag: "picker_datetime", value: { action: "accept", record_id: "rec_test" } } } });
    assert.deepEqual((await handler(picker)).body, {});
    assert.equal(calls, 1);
    const uncertain = createHandler({ action: async () => { throw new DomainError("WRITE_UNCONFIRMED", "结果待确认"); } });
    assert.equal((await uncertain(callback("test-uncertain"))).body.toast.type, "warning");
    const notSubmitted = createHandler({ action: async () => { throw new DomainError("ACTION_NOT_SUBMITTED", "未提交"); } });
    assert.equal((await notSubmitted(callback("test-read-timeout"))).body.toast.type, "error");
  } finally {
    Object.assign(config, saved);
    for (const id of ["test-dedup", "test-invalid", "test-picker", "test-uncertain", "test-read-timeout"]) releaseEvent(id);
  }
});

test("event deduplication expires instead of remembering an event forever", () => {
  beginEvent("test-expiry", 1000);
  completeEvent("test-expiry", 1000, { ok: true });
  assert.equal(beginEvent("test-expiry", 2000), "completed");
  assert.equal(beginEvent("test-expiry", 301001), "");
  releaseEvent("test-expiry");
});
