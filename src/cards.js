const { config, FIELD, STATUS } = require("./config");
const { closureType, text, versionOf, CONFIRMATION_WAIT_MS } = require("./domain");
const { formatDateTime, parseDateTime } = require("./time");

function plain(value, fallback = "-") {
  return text(value) || fallback;
}

function dateTime(value, fallback = "-") {
  const parsed = parseDateTime(value);
  return parsed ? formatDateTime(parsed) : fallback;
}

function title(content, template = "blue") {
  return { template, title: { tag: "plain_text", content } };
}

function detailUrl(recordId) {
  if (!config.bitableUrl) return "";
  const separator = config.bitableUrl.includes("?") ? "&" : "?";
  return `${config.bitableUrl}${separator}record=${encodeURIComponent(recordId)}`;
}

function summary(recordId, fields) {
  return [
    `**工单号**：${plain(fields[FIELD.ticketNo])}`,
    `**状态**：${plain(fields[FIELD.status])}`,
    `**报修人**：${plain(fields[FIELD.reporter])}`,
    `**联系电话**：${plain(fields[FIELD.phone])}`,
    `**报修时间**：${dateTime(fields[FIELD.submittedAt])}`,
    `**故障类型**：${plain(fields[FIELD.issueType])}`,
    `**故障设备**：${plain(fields[FIELD.device])}`,
    `**故障现象**：${plain(fields[FIELD.description])}`,
    `**报修附件**：${plain(fields[FIELD.attachment])}`,
    `**优先级**：${plain(fields[FIELD.priority])}`,
    `**SLA截止时间**：${dateTime(fields[FIELD.slaDueAt])}`,
    fields[FIELD.slaBreachedEver] === "是" ? "**SLA状态**：已发生超时" : "",
    detailUrl(recordId) ? `[查看工单详情](${detailUrl(recordId)})` : ""
  ].filter(Boolean).join("\n");
}

function dateTimeInput(name, label, initialValue = "", placeholder = "请选择具体日期和时间") {
  const parsed = parseDateTime(initialValue);
  const normalized = parsed ? formatDateTime(parsed).replace(/:\d{2}$/, "") : "";
  return {
    tag: "picker_datetime",
    name,
    label: { tag: "plain_text", content: label },
    label_position: "left",
    placeholder: { tag: "plain_text", content: placeholder },
    ...(normalized ? { initial_datetime: normalized } : {})
  };
}

function textInput(name, label, placeholder, maxLength = 500) {
  return {
    tag: "input",
    name,
    label: { tag: "plain_text", content: label },
    label_position: "left",
    placeholder: { tag: "plain_text", content: placeholder },
    max_length: maxLength
  };
}

function newTicket(recordId, fields) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: title(`新 IT 工单：${plain(fields[FIELD.ticketNo])}`, "blue"),
    elements: [
      { tag: "markdown", content: summary(recordId, fields) },
      {
        tag: "form",
        name: "accept_form",
        elements: [
          dateTimeInput("promised_at", "预计完成时间（选填）", "", "不选则默认为接单后 30 分钟"),
          textInput("progress", "接单说明", "例如：先远程排查，必要时现场处理", 200),
          {
            tag: "button",
            name: "accept",
            action_type: "form_submit",
            type: "primary",
            text: { tag: "plain_text", content: "接单" },
            value: { action: "accept", record_id: recordId, version: versionOf(fields) }
          }
        ]
      },
      {
        tag: "form",
        name: "reject_form",
        elements: [
          textInput("reason", "拒绝原因", "必填，例如：重复工单或不属于 IT 服务范围", 300),
          {
            tag: "button",
            name: "reject",
            action_type: "form_submit",
            type: "danger",
            text: { tag: "plain_text", content: "拒绝并关闭" },
            value: { action: "reject", record_id: recordId, version: versionOf(fields) }
          }
        ]
      }
    ]
  };
}

function processing(recordId, fields) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: title(`工单处理中：${plain(fields[FIELD.ticketNo])}`, "green"),
    elements: [
      { tag: "markdown", content: summary(recordId, fields) },
      {
        tag: "markdown",
        content: [
          `**处理人**：${plain(fields[FIELD.assignee])}`,
          `**接单时间**：${dateTime(fields[FIELD.acceptedAt])}`,
          `**预计完成时间**：${dateTime(fields[FIELD.promisedAt])}`,
          `**当前进展**：${plain(fields[FIELD.progress])}`,
          `**返工次数**：${plain(fields[FIELD.reworkCount], "0")}`
        ].join("\n")
      },
      {
        tag: "form",
        name: "progress_form",
        elements: [
          textInput("progress", "当前进展", "必填，说明已完成事项和下一步"),
          {
            tag: "button",
            name: "update_progress",
            action_type: "form_submit",
            text: { tag: "plain_text", content: "更新进展" },
            value: { action: "update_progress", record_id: recordId, version: versionOf(fields) }
          }
        ]
      },
      {
        tag: "form",
        name: "extend_form",
        elements: [
          dateTimeInput("promised_at", "延期后的预计完成时间（必填）", fields[FIELD.promisedAt]),
          {
            tag: "button",
            name: "extend",
            action_type: "form_submit",
            text: { tag: "plain_text", content: "延期" },
            value: { action: "extend", record_id: recordId, version: versionOf(fields) }
          }
        ]
      },
      {
        tag: "form",
        name: "complete_form",
        elements: [
          textInput("resolution", "处理结果", "必填，说明处理动作和最终结果"),
          {
            tag: "button",
            name: "complete",
            action_type: "form_submit",
            type: "primary",
            text: { tag: "plain_text", content: "提交处理结果" },
            value: { action: "complete", record_id: recordId, version: versionOf(fields) }
          }
        ]
      }
    ]
  };
}

function confirmationPolicy(fields) {
  const completed = parseDateTime(fields[FIELD.completedAt]);
  const deadline = completed ? `反馈截止时间：${formatDateTime(new Date(completed.getTime() + CONFIRMATION_WAIT_MS))}。` : "";
  return `${deadline}提交处理结果后 6 小时内未反馈，系统将自动关闭工单，默认已处理完毕。故障未恢复请及时反馈。`;
}

function confirming(recordId, fields) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: title(`等待用户确认：${plain(fields[FIELD.ticketNo])}`, "orange"),
    elements: [
      { tag: "markdown", content: summary(recordId, fields) },
      { tag: "markdown", content: `**处理结果**：${plain(fields[FIELD.resolution])}\n等待报修人确认故障是否恢复。\n${confirmationPolicy(fields)}` }
    ]
  };
}

function reporterConfirmation(recordId, fields) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: title(`请确认故障是否恢复：${plain(fields[FIELD.ticketNo])}`, "green"),
    elements: [
      { tag: "markdown", content: summary(recordId, fields) },
      { tag: "markdown", content: `**处理结果**：${plain(fields[FIELD.resolution])}\n${confirmationPolicy(fields)}` },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "故障已恢复" },
            value: { action: "reporter_confirm", record_id: recordId, version: versionOf(fields) }
          },
          {
            tag: "button",
            type: "danger",
            text: { tag: "plain_text", content: "故障未恢复" },
            value: { action: "reporter_reopen", record_id: recordId, version: versionOf(fields) }
          }
        ]
      }
    ]
  };
}

function closed(recordId, fields) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: title(`工单已关闭：${plain(fields[FIELD.ticketNo])}`, "grey"),
    elements: [
      { tag: "markdown", content: summary(recordId, fields) },
      {
        tag: "markdown",
        content: `**关闭结果**：${domainClosureLabel(fields)}\n**关闭时间**：${dateTime(fields[FIELD.closedAt])}\n**处理结果**：${plain(fields[FIELD.resolution])}`
      }
    ]
  };
}

function domainClosureLabel(fields) {
  if (closureType(fields) === "超时自动关闭") return "6 小时内用户未反馈，系统自动关闭，默认工单已处理完毕";
  return closureType(fields) === "IT拒绝关闭" ? "IT 拒绝关闭" : "用户确认关闭";
}

function overdue(recordId, fields) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: title(`SLA 已超时：${plain(fields[FIELD.ticketNo])}`, "red"),
    elements: [
      { tag: "markdown", content: summary(recordId, { ...fields, [FIELD.slaBreachedEver]: "是" }) },
      { tag: "markdown", content: "请处理人尽快更新进展或提交处理结果。系统只发送一次首次超时提醒。" }
    ]
  };
}

function error(message) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: title("操作未完成", "red"),
    elements: [{ tag: "markdown", content: plain(message, "操作失败，请稍后重试。") }]
  };
}

function reporterResult(recordId, fields, heading, message, template = "blue") {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: title(`${heading}：${plain(fields[FIELD.ticketNo])}`, template),
    elements: [
      { tag: "markdown", content: summary(recordId, fields) },
      { tag: "markdown", content: message }
    ]
  };
}

function cardFor(recordId, fields) {
  const status = text(fields[FIELD.status]);
  if (status === STATUS.pending) return newTicket(recordId, fields);
  if (status === STATUS.processing) return processing(recordId, fields);
  if (status === STATUS.confirming) return confirming(recordId, fields);
  return closed(recordId, fields);
}

module.exports = { newTicket, processing, confirming, reporterConfirmation, reporterResult, closed, overdue, error, cardFor };
