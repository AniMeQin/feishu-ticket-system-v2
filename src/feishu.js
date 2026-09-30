const { config } = require("./config");

const API = "https://open.feishu.cn/open-apis";
let tokenCache = { token: "", expiresAt: 0 };

class FeishuApiError extends Error {
  constructor(status, data = {}, requestId = "") {
    const apiCode = Number(data.code) || 0;
    // Keep diagnostic metadata, never the response body or request credentials.
    let detail = String(data.msg || "request failed").split(/ErrorValue:/i)[0]
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
    for (const secret of [config.appSecret, config.verificationToken, config.encryptKey, tokenCache.token]) {
      if (secret) detail = detail.split(secret).join("[redacted]");
    }
    super(`Feishu HTTP ${status} code=${apiCode}: ${detail}`);
    this.name = "FeishuApiError";
    this.code = "FEISHU_API_ERROR";
    this.status = status;
    this.apiCode = apiCode;
    this.requestId = String(data.error?.log_id || requestId).slice(0, 128);
    this.retryable = status === 429 || status >= 500 || apiCode === 230020;
  }
}

class FeishuTimeoutError extends Error {
  constructor(message = "Feishu request timed out") {
    super(message);
    this.name = "FeishuTimeoutError";
    this.code = "FEISHU_TIMEOUT";
  }
}

function requestTimeoutMs(timeoutMs, deadlineAt) {
  const configured = Number(timeoutMs);
  const fallback = Number.isFinite(configured) && configured > 0 ? configured : 8000;
  if (!deadlineAt) return fallback;
  const remaining = Number(deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new FeishuTimeoutError();
  return Math.max(1, Math.min(fallback, remaining));
}

async function requestJson(url, options = {}) {
  const { timeoutMs, deadlineAt, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs(timeoutMs, deadlineAt));
  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (!response.ok) throw new FeishuApiError(response.status, { msg: "non-JSON error response" });
      throw error;
    }
    if (!response.ok || (data.code !== undefined && data.code !== 0)) {
      throw new FeishuApiError(response.status, data, response.headers.get("x-tt-logid") || "");
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted || error.name === "AbortError") throw new FeishuTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function tenantToken(options = {}) {
  if (tokenCache.token && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  if (!config.appId || !config.appSecret) throw new Error("Feishu app credentials are not configured");
  const data = await requestJson(`${API}/auth/v3/tenant_access_token/internal`, {
    timeoutMs: options.timeoutMs,
    deadlineAt: options.deadlineAt,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret })
  });
  if (data.code !== 0 || !data.tenant_access_token) throw new Error("Unable to obtain Feishu tenant token");
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expire || 7200) - 300) * 1000
  };
  return tokenCache.token;
}

async function api(path, options = {}) {
  const token = await tenantToken(options);
  const data = await requestJson(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  return data.data || {};
}

function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  return search.toString() ? `?${search.toString()}` : "";
}

async function getRecord(tableId, recordId, options = {}) {
  const data = await api(
    `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records/${encodeURIComponent(recordId)}`,
    options
  );
  return data.record || null;
}

async function updateRecord(tableId, recordId, fields, params = {}, requestOptions = {}) {
  const data = await api(
    `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records/${encodeURIComponent(recordId)}${query(params)}`,
    { ...requestOptions, method: "PUT", body: JSON.stringify({ fields }) }
  );
  return data.record || null;
}

async function createRecord(tableId, fields, params = {}) {
  const data = await api(`/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records${query(params)}`, {
    method: "POST",
    body: JSON.stringify({ fields })
  });
  return data.record || null;
}

async function listAllRecords(tableId, pageSize = 200) {
  const records = [];
  let pageToken = "";
  do {
    const data = await api(
      `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records${query({ page_size: pageSize, page_token: pageToken })}`
    );
    records.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token || "" : "";
  } while (pageToken);
  return records;
}

async function getUserByOpenId(openId) {
  if (!openId) return null;
  const data = await api(
    `/contact/v3/users/${encodeURIComponent(openId)}${query({
      user_id_type: "open_id",
      department_id_type: "open_department_id"
    })}`
  );
  return data.user || null;
}

async function sendCard(receiveIdType, receiveId, card, uuid = "") {
  const body = {
    receive_id: receiveId,
    msg_type: "interactive",
    content: JSON.stringify(card)
  };
  if (uuid) body.uuid = uuid;
  const data = await api(`/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  return data.message_id || "";
}

function sendCardToChat(chatId, card, uuid = "") {
  return sendCard("chat_id", chatId, card, uuid);
}

function sendCardToUser(openId, card, uuid = "") {
  return sendCard("open_id", openId, card, uuid);
}

async function updateCard(messageId, card) {
  if (!messageId) return null;
  return api(`/im/v1/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ content: JSON.stringify(card) })
  });
}

async function getMessage(messageId) {
  const data = await api(`/im/v1/messages/${encodeURIComponent(messageId)}`);
  return (data.items || [])[0] || null;
}

module.exports = {
  FeishuTimeoutError,
  FeishuApiError,
  requestJson,
  getRecord,
  updateRecord,
  createRecord,
  listAllRecords,
  getUserByOpenId,
  sendCardToChat,
  sendCardToUser,
  updateCard,
  getMessage
};
