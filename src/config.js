function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || value === "" ? fallback : value;
}

function envList(name) {
  return env(name)
    .split(/[\s,，;；]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function positiveNumber(name, fallback) {
  const value = Number(env(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const DEFAULT_SLA_HOLIDAYS_2026 = Object.freeze([
  "2026-01-01", "2026-01-02", "2026-01-03",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"
]);

const STATUS = Object.freeze({
  pending: "待处理",
  processing: "处理中",
  confirming: "待用户确认",
  closed: "已关闭"
});

const FIELD = Object.freeze({
  ticketNo: "工单号",
  status: "工单状态",
  version: "流程版本",
  reporter: "报修人",
  reporterOpenId: "报修人 OpenID",
  submittedBy: "提交人",
  sourceSubmittedAt: "提交时间",
  phone: "联系电话",
  submittedAt: "报修时间",
  issueType: "故障类型",
  device: "故障设备",
  description: "故障现象",
  attachment: "报修附件",
  priority: "优先级",
  slaDueAt: "SLA 截止时间",
  slaBreachedEver: "是否曾经超时",
  slaAlertedAt: "SLA 首次提醒时间",
  assignee: "处理人",
  assigneeOpenId: "处理人 OpenID",
  acceptedAt: "接单时间",
  promisedAt: "预计完成时间",
  progress: "当前进展",
  resolution: "处理结果",
  completedAt: "处理完成时间",
  closedType: "关闭类型",
  closedAt: "关闭时间",
  reworkCount: "返工次数",
  groupMessageId: "当前群卡片 ID",
  reporterMessageId: "当前用户卡片 ID"
});

const EVENT_FIELD = Object.freeze({
  ticketNo: "工单号",
  recordId: "工单记录 ID",
  action: "操作类型",
  actorOpenId: "操作人 OpenID",
  actorName: "操作人名称",
  fromStatus: "操作前状态",
  toStatus: "操作后状态",
  detail: "说明",
  createdAt: "操作时间"
});

const config = {
  port: positiveNumber("PORT", 9000),
  appId: env("FEISHU_APP_ID"),
  appSecret: env("FEISHU_APP_SECRET"),
  verificationToken: env("FEISHU_VERIFICATION_TOKEN"),
  encryptKey: env("FEISHU_ENCRYPT_KEY"),
  internalJobToken: env("FEISHU_INTERNAL_JOB_TOKEN"),
  bitableAppToken: env("FEISHU_BITABLE_APP_TOKEN"),
  ticketTableId: env("FEISHU_TICKET_TABLE_ID"),
  eventTableId: env("FEISHU_EVENT_TABLE_ID"),
  bitableUrl: env("FEISHU_BITABLE_URL"),
  itChatId: env("FEISHU_IT_CHAT_ID"),
  itOpenIds: envList("FEISHU_IT_OPEN_IDS"),
  adminOpenIds: envList("FEISHU_ADMIN_OPEN_IDS"),
  appCommit: env("APP_COMMIT", "local-build"),
  defaultPriority: env("DEFAULT_PRIORITY", "P3").toUpperCase(),
  recordSettleIntervalMs: positiveNumber("BITABLE_RECORD_SETTLE_INTERVAL_MS", 500),
  // Feishu requires card callbacks to finish within three seconds. Keep a
  // small transport margin while allowing one Bitable read plus one write.
  cardCallbackBudgetMs: Math.min(2850, positiveNumber("CARD_CALLBACK_BUDGET_MS", 2850)),
  slaHours: {
    P1: positiveNumber("SLA_P1_HOURS", 1),
    P2: positiveNumber("SLA_P2_HOURS", 2),
    P3: positiveNumber("SLA_P3_HOURS", 8),
    P4: positiveNumber("SLA_P4_HOURS", 40)
  },
  slaHolidays: Array.from(new Set([...DEFAULT_SLA_HOLIDAYS_2026, ...envList("SLA_HOLIDAYS")])),
  retryDelaysMs: [250, 750]
};

function readiness() {
  const required = {
    FEISHU_APP_ID: config.appId,
    FEISHU_APP_SECRET: config.appSecret,
    FEISHU_VERIFICATION_TOKEN: config.verificationToken,
    FEISHU_ENCRYPT_KEY: config.encryptKey,
    FEISHU_INTERNAL_JOB_TOKEN: config.internalJobToken,
    FEISHU_BITABLE_APP_TOKEN: config.bitableAppToken,
    FEISHU_TICKET_TABLE_ID: config.ticketTableId,
    FEISHU_IT_CHAT_ID: config.itChatId,
    FEISHU_IT_OPEN_IDS: config.itOpenIds.length ? "configured" : ""
  };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
  return { ready: missing.length === 0, missing };
}

module.exports = { config, readiness, FIELD, EVENT_FIELD, STATUS };
