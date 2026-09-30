const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WORK_PERIODS = Object.freeze([
  [8 * 60, 12 * 60],
  [13 * 60, 17 * 60]
]);

function pad(value) {
  return String(value).padStart(2, "0");
}

function shanghaiParts(input = new Date()) {
  const shifted = new Date(input.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
    weekday: shifted.getUTCDay()
  };
}

function formatDateTime(input = new Date()) {
  const value = shanghaiParts(input);
  return `${value.year}-${pad(value.month)}-${pad(value.day)} ${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}`;
}

function formatTicketDate(input = new Date()) {
  const value = shanghaiParts(input);
  return `${value.year}${pad(value.month)}${pad(value.day)}`;
}

function normalizeDateTimeText(value) {
  let text = String(value).trim();
  text = text
    .replace(/[年\/.]/g, "-")
    .replace(/[月]/g, "-")
    .replace(/[日号]/g, " ")
    .replace(/[时点]/g, ":")
    .replace(/分/g, "")
    .replace(/秒/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i);
  if (!match) return text;
  const [, year, month, day, hour = "00", minute = "00", second = "00", timezone = ""] = match;
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}${timezone ? ` ${timezone}` : ""}`;
}

function parseDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return new Date(value > 100000000000 ? value : value * 1000);
  if (typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["datetime", "date_time", "dateTime", "timestamp", "value", "date", "text", "content"]) {
      const parsed = parseDateTime(value[key]);
      if (parsed) return parsed;
    }
    return null;
  }
  const text = normalizeDateTimeText(value);
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    return new Date(text.length === 13 ? numeric : numeric * 1000);
  }
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00", timezone] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const utcCandidate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (
    utcCandidate.getUTCFullYear() !== parts[0] ||
    utcCandidate.getUTCMonth() !== parts[1] - 1 ||
    utcCandidate.getUTCDate() !== parts[2] ||
    utcCandidate.getUTCHours() !== parts[3] ||
    utcCandidate.getUTCMinutes() !== parts[4]
  ) return null;
  let offsetMinutes = 8 * 60;
  if (timezone && timezone.toUpperCase() === "Z") offsetMinutes = 0;
  if (timezone && timezone.toUpperCase() !== "Z") {
    const zone = timezone.match(/^([+-])(\d{2}):?(\d{2})$/);
    if (!zone) return null;
    offsetMinutes = (Number(zone[2]) * 60 + Number(zone[3])) * (zone[1] === "+" ? 1 : -1);
  }
  return new Date(utcCandidate.getTime() - offsetMinutes * 60 * 1000);
}

function dateKey(input = new Date()) {
  const value = shanghaiParts(input);
  return `${value.year}-${pad(value.month)}-${pad(value.day)}`;
}

function shanghaiDate(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - SHANGHAI_OFFSET_MS);
}

function minuteOfDay(value) {
  return value.hour * 60 + value.minute;
}

function holidaySet(holidays = []) {
  return holidays instanceof Set ? holidays : new Set(holidays || []);
}

function isBusinessDay(input, holidays = []) {
  const value = shanghaiParts(input);
  if (value.weekday === 0 || value.weekday === 6) return false;
  return !holidaySet(holidays).has(dateKey(input));
}

function nextShanghaiDayAtEight(input) {
  const value = shanghaiParts(new Date(input.getTime() + DAY_MS));
  return shanghaiDate(value.year, value.month, value.day, 8);
}

function nextBusinessInstant(input, holidays = []) {
  let cursor = new Date(input.getTime());
  const blockedDates = holidaySet(holidays);
  for (let guard = 0; guard < 370; guard += 1) {
    const value = shanghaiParts(cursor);
    if (!isBusinessDay(cursor, blockedDates)) {
      cursor = nextShanghaiDayAtEight(cursor);
      continue;
    }
    const minute = minuteOfDay(value);
    if (minute < WORK_PERIODS[0][0]) {
      return shanghaiDate(value.year, value.month, value.day, 8);
    }
    if (minute < WORK_PERIODS[0][1]) return cursor;
    if (minute < WORK_PERIODS[1][0]) {
      return shanghaiDate(value.year, value.month, value.day, 13);
    }
    if (minute < WORK_PERIODS[1][1]) return cursor;
    cursor = nextShanghaiDayAtEight(cursor);
  }
  throw new Error("Unable to find the next SLA business time within one year");
}

function currentPeriodEnd(input) {
  const value = shanghaiParts(input);
  const minute = minuteOfDay(value);
  const endHour = minute < WORK_PERIODS[0][1] ? 12 : 17;
  return shanghaiDate(value.year, value.month, value.day, endHour);
}

function addBusinessHours(input, hours, holidays = []) {
  const numericHours = Number(hours);
  if (!Number.isFinite(numericHours) || numericHours < 0) throw new Error("SLA hours must be a non-negative number");
  let remaining = numericHours * HOUR_MS;
  let cursor = nextBusinessInstant(input, holidays);
  if (remaining === 0) return cursor;
  for (let guard = 0; guard < 1000 && remaining > 0; guard += 1) {
    const end = currentPeriodEnd(cursor);
    const available = Math.max(0, end.getTime() - cursor.getTime());
    if (remaining <= available) return new Date(cursor.getTime() + remaining);
    remaining -= available;
    cursor = nextBusinessInstant(end, holidays);
  }
  throw new Error("Unable to calculate SLA deadline");
}

module.exports = {
  formatDateTime,
  formatTicketDate,
  parseDateTime,
  addBusinessHours,
  dateKey,
  isBusinessDay,
  nextBusinessInstant,
  shanghaiParts
};
