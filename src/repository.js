const { config, EVENT_FIELD, FIELD } = require("./config");
const { actorId, actorName, text } = require("./domain");
const { formatDateTime } = require("./time");

class TicketRepository {
  constructor(feishu) {
    this.feishu = feishu;
  }

  requireConfig() {
    if (!config.bitableAppToken || !config.ticketTableId) throw new Error("Ticket table is not configured");
  }

  get(recordId, requestOptions = {}) {
    this.requireConfig();
    return this.feishu.getRecord(config.ticketTableId, recordId, requestOptions);
  }

  update(recordId, fields, requestOptions = {}) {
    this.requireConfig();
    const usesPerson = [FIELD.reporter, FIELD.assignee].some(
      (name) => Array.isArray(fields[name]) && fields[name].length > 0
    );
    return this.feishu.updateRecord(
      config.ticketTableId,
      recordId,
      fields,
      usesPerson ? { user_id_type: "open_id" } : {},
      requestOptions
    );
  }

  listAll() {
    this.requireConfig();
    return this.feishu.listAllRecords(config.ticketTableId);
  }

  async appendEvent(recordId, before, after, actor, action, detail = "") {
    if (!config.eventTableId) return null;
    const merged = { ...(before || {}), ...(after || {}) };
    return this.feishu.createRecord(config.eventTableId, {
      [EVENT_FIELD.ticketNo]: text(merged[FIELD.ticketNo]),
      [EVENT_FIELD.recordId]: recordId,
      [EVENT_FIELD.action]: action,
      [EVENT_FIELD.actorOpenId]: actorId(actor),
      [EVENT_FIELD.actorName]: actorName(actor),
      [EVENT_FIELD.fromStatus]: text(before && before[FIELD.status]),
      [EVENT_FIELD.toStatus]: text(merged[FIELD.status]),
      [EVENT_FIELD.detail]: detail,
      [EVENT_FIELD.createdAt]: formatDateTime()
    });
  }
}

module.exports = { TicketRepository };
