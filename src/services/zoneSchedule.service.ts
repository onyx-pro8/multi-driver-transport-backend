import type { TransportMode } from "../models/transportMode.model";
import type { SchedulePattern } from "../models/zoneSchedule.model";
import { SCHEDULE_PATTERNS } from "../models/zoneSchedule.model";

/** YYYY-MM-DD */
export type OperationDate = string;

export interface ZoneScheduleFields {
  transport_mode: string;
  /** @deprecated use operation_start_date / operation_end_date */
  operation_date?: OperationDate | null;
  operation_start_date?: OperationDate | null;
  operation_end_date?: OperationDate | null;
  schedule_pattern?: SchedulePattern | string | null;
  /** 0 = Sunday … 6 = Saturday */
  weekday_start?: number | null;
  weekday_end?: number | null;
  /** 1–31 */
  month_day_start?: number | null;
  month_day_end?: number | null;
  operating_start_time?: string | null;
  operating_end_time?: string | null;
  departure_time?: string | null;
  arrival_time?: string | null;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateToYmd(d: Date): OperationDate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isHubTransportMode(mode: string): boolean {
  return mode === "air" || mode === "sea";
}

export function parseScheduleTime(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(trimmed);
  return match ? `${match[1]}:${match[2]}` : null;
}

/** Parse YYYY-MM-DD from API input or a node-pg DATE column (JavaScript Date). */
export function parseOperationDate(value: string | Date | null | undefined): OperationDate | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return dateToYmd(value);
  }
  const trimmed = String(value).trim();
  const datePart = trimmed.slice(0, 10);
  if (!ISO_DATE.test(datePart)) return null;
  const [y, m, day] = datePart.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() !== y || d.getMonth() + 1 !== m || d.getDate() !== day) return null;
  return datePart;
}

export function parseSchedulePattern(value: string | null | undefined): SchedulePattern {
  const v = String(value ?? "daily").trim().toLowerCase();
  return (SCHEDULE_PATTERNS as readonly string[]).includes(v) ? (v as SchedulePattern) : "daily";
}

function timeToMinutes(time: string): number | null {
  const match = HH_MM.exec(time.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Inclusive range on a circular 0..max scale (weekdays, month days). */
export function isInCircularRange(value: number, start: number, end: number, max: number): boolean {
  if (start <= end) return value >= start && value <= end;
  return value >= start || value <= end;
}

export function normalizeOperationDateRange(
  zone: ZoneScheduleFields
): { start: OperationDate; end: OperationDate } | null {
  const start = parseOperationDate(zone.operation_start_date ?? zone.operation_date);
  const end = parseOperationDate(zone.operation_end_date ?? zone.operation_date ?? zone.operation_start_date);
  if (!start || !end) return null;
  if (start > end) return null;
  return { start, end };
}

/** Start/end HH:MM for the zone's daily operational window. */
export function getZoneOperatingTimes(zone: ZoneScheduleFields): {
  startTime: string | null;
  endTime: string | null;
} {
  if (isHubTransportMode(zone.transport_mode)) {
    return {
      startTime: parseScheduleTime(zone.departure_time),
      endTime: parseScheduleTime(zone.arrival_time),
    };
  }
  return {
    startTime: parseScheduleTime(zone.operating_start_time),
    endTime: parseScheduleTime(zone.operating_end_time),
  };
}

export function hasCompleteZoneSchedule(zone: ZoneScheduleFields): boolean {
  if (!normalizeOperationDateRange(zone)) return false;
  const { startTime, endTime } = getZoneOperatingTimes(zone);
  if (!startTime || !endTime) return false;

  const pattern = parseSchedulePattern(zone.schedule_pattern);
  if (pattern === "weekly") {
    const ws = zone.weekday_start;
    const we = zone.weekday_end;
    if (ws == null || we == null || ws < 0 || ws > 6 || we < 0 || we > 6) return false;
  }
  if (pattern === "monthly") {
    const ms = zone.month_day_start;
    const me = zone.month_day_end;
    if (ms == null || me == null || ms < 1 || ms > 31 || me < 1 || me > 31) return false;
  }
  return true;
}

function isDateWithinRange(ymd: OperationDate, start: OperationDate, end: OperationDate): boolean {
  return ymd >= start && ymd <= end;
}

function isTimeWithinDailyWindow(now: Date, startTime: string, endTime: string): boolean {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  if (startMin == null || endMin == null) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (endMin > startMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Overnight window (e.g. 22:00–06:00)
  return nowMin >= startMin || nowMin < endMin;
}

function matchesDayPattern(zone: ZoneScheduleFields, now: Date): boolean {
  const pattern = parseSchedulePattern(zone.schedule_pattern);
  if (pattern === "daily") return true;
  if (pattern === "weekly") {
    const ws = zone.weekday_start;
    const we = zone.weekday_end;
    if (ws == null || we == null) return false;
    return isInCircularRange(now.getDay(), ws, we, 6);
  }
  const ms = zone.month_day_start;
  const me = zone.month_day_end;
  if (ms == null || me == null) return false;
  return isInCircularRange(now.getDate(), ms, me, 31);
}

/** True when the zone has a complete schedule and `now` falls within it. */
export function isZoneScheduleActive(
  zone: ZoneScheduleFields,
  now: Date = new Date()
): boolean {
  if (!hasCompleteZoneSchedule(zone)) return false;
  const range = normalizeOperationDateRange(zone)!;
  const today = dateToYmd(now);
  if (!isDateWithinRange(today, range.start, range.end)) return false;
  if (!matchesDayPattern(zone, now)) return false;
  const { startTime, endTime } = getZoneOperatingTimes(zone)!;
  return isTimeWithinDailyWindow(now, startTime!, endTime!);
}

export function assertCompleteZoneSchedule(zone: ZoneScheduleFields): void {
  const range = normalizeOperationDateRange(zone);
  if (!range) {
    throw new Error("operation_start_date and operation_end_date are required (YYYY-MM-DD)");
  }
  const mode = zone.transport_mode;
  if (isHubTransportMode(mode)) {
    if (!parseScheduleTime(zone.departure_time)) {
      throw new Error("departure_time is required for air/sea routes (HH:MM)");
    }
    if (!parseScheduleTime(zone.arrival_time)) {
      throw new Error("arrival_time is required for air/sea routes (HH:MM)");
    }
  } else {
    if (!parseScheduleTime(zone.operating_start_time)) {
      throw new Error("operating_start_time is required for land zones (HH:MM)");
    }
    if (!parseScheduleTime(zone.operating_end_time)) {
      throw new Error("operating_end_time is required for land zones (HH:MM)");
    }
  }
  const pattern = parseSchedulePattern(zone.schedule_pattern);
  if (pattern === "weekly") {
    const ws = zone.weekday_start;
    const we = zone.weekday_end;
    if (ws == null || we == null || ws < 0 || ws > 6 || we < 0 || we > 6) {
      throw new Error("weekday_start and weekday_end are required for weekly schedules (0–6)");
    }
  }
  if (pattern === "monthly") {
    const ms = zone.month_day_start;
    const me = zone.month_day_end;
    if (ms == null || me == null || ms < 1 || ms > 31 || me < 1 || me > 31) {
      throw new Error("month_day_start and month_day_end are required for monthly schedules (1–31)");
    }
  }
}

export function formatZoneScheduleSummary(zone: ZoneScheduleFields): string | null {
  const range = normalizeOperationDateRange(zone);
  if (!range) return null;
  const { startTime, endTime } = getZoneOperatingTimes(zone);
  if (!startTime || !endTime) return null;

  const datePart =
    range.start === range.end ? range.start : `${range.start} → ${range.end}`;
  const timePart = `${startTime}–${endTime}`;
  const pattern = parseSchedulePattern(zone.schedule_pattern);

  const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let repeatPart = "every day";
  if (pattern === "weekly" && zone.weekday_start != null && zone.weekday_end != null) {
    const ws = WEEKDAY_LABELS[zone.weekday_start] ?? String(zone.weekday_start);
    const we = WEEKDAY_LABELS[zone.weekday_end] ?? String(zone.weekday_end);
    repeatPart = ws === we ? `on ${ws}` : `${ws}–${we}`;
  } else if (pattern === "monthly" && zone.month_day_start != null && zone.month_day_end != null) {
    repeatPart =
      zone.month_day_start === zone.month_day_end
        ? `day ${zone.month_day_start}`
        : `days ${zone.month_day_start}–${zone.month_day_end}`;
  }

  return `${datePart} · ${repeatPart} · ${timePart}`;
}

export type ZoneScheduleInactiveReason =
  | "no_schedule"
  | "outside_dates"
  | "outside_weekday"
  | "outside_month_day"
  | "outside_hours";

/** Human-readable explanation when a zone is not active at `now`. */
export function describeZoneScheduleInactiveReason(
  zone: ZoneScheduleFields,
  now: Date = new Date(),
): { reason: ZoneScheduleInactiveReason; label: string } | null {
  if (!hasCompleteZoneSchedule(zone)) {
    return { reason: "no_schedule", label: "No operating schedule configured" };
  }
  if (isZoneScheduleActive(zone, now)) return null;

  const range = normalizeOperationDateRange(zone)!;
  const today = dateToYmd(now);
  if (!isDateWithinRange(today, range.start, range.end)) {
    const datePart =
      range.start === range.end ? range.start : `${range.start} – ${range.end}`;
    return {
      reason: "outside_dates",
      label: `Outside operating dates (${datePart})`,
    };
  }

  if (!matchesDayPattern(zone, now)) {
    const pattern = parseSchedulePattern(zone.schedule_pattern);
    const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    if (pattern === "weekly") {
      const ws = zone.weekday_start;
      const we = zone.weekday_end;
      if (ws != null && we != null) {
        const wsLabel = WEEKDAY_LABELS[ws] ?? String(ws);
        const weLabel = WEEKDAY_LABELS[we] ?? String(we);
        const days = ws === we ? wsLabel : `${wsLabel}–${weLabel}`;
        return {
          reason: "outside_weekday",
          label: `Not operating today — runs ${days}`,
        };
      }
      return { reason: "outside_weekday", label: "Not operating on this day of the week" };
    }
    return {
      reason: "outside_month_day",
      label: "Not operating on this day of the month",
    };
  }

  const summary = formatZoneScheduleSummary(zone);
  return {
    reason: "outside_hours",
    label: summary
      ? `Not available now — outside operating hours (${summary})`
      : "Not available now — outside operating hours",
  };
}

export function normalizeTransportModeForSchedule(mode: string): TransportMode {
  const m = String(mode ?? "land").toLowerCase();
  return m === "air" || m === "sea" ? (m as TransportMode) : "land";
}

/** Build schedule fields from a DB row or API object (shared by services). */
export function buildZoneScheduleFields(parts: {
  transport_mode: string;
  operation_date?: string | null;
  operation_start_date?: string | null;
  operation_end_date?: string | null;
  schedule_pattern?: string | null;
  weekday_start?: number | null;
  weekday_end?: number | null;
  month_day_start?: number | null;
  month_day_end?: number | null;
  operating_start_time?: string | null;
  operating_end_time?: string | null;
  departure_time?: string | null;
  arrival_time?: string | null;
}): ZoneScheduleFields {
  return {
    transport_mode: parts.transport_mode,
    operation_date: parts.operation_date ?? null,
    operation_start_date: parts.operation_start_date ?? null,
    operation_end_date: parts.operation_end_date ?? null,
    schedule_pattern: parts.schedule_pattern ?? null,
    weekday_start: parts.weekday_start ?? null,
    weekday_end: parts.weekday_end ?? null,
    month_day_start: parts.month_day_start ?? null,
    month_day_end: parts.month_day_end ?? null,
    operating_start_time: parts.operating_start_time ?? null,
    operating_end_time: parts.operating_end_time ?? null,
    departure_time: parts.departure_time ?? null,
    arrival_time: parts.arrival_time ?? null,
  };
}

function parseSmallInt(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/** Parse schedule-related columns from a driver_zones row. */
export function parseScheduleFromRow(row: Record<string, unknown>): {
  operation_date: string | null;
  operation_start_date: string | null;
  operation_end_date: string | null;
  schedule_pattern: SchedulePattern;
  weekday_start: number | null;
  weekday_end: number | null;
  month_day_start: number | null;
  month_day_end: number | null;
  operating_start_time: string | null;
  operating_end_time: string | null;
  departure_time: string | null;
  arrival_time: string | null;
} {
  const legacyDate =
    row.operation_date == null
      ? null
      : parseOperationDate(row.operation_date as string | Date);
  const start =
    row.operation_start_date == null
      ? legacyDate
      : parseOperationDate(row.operation_start_date as string | Date);
  const end =
    row.operation_end_date == null
      ? legacyDate ?? start
      : parseOperationDate(row.operation_end_date as string | Date);

  return {
    operation_date: legacyDate ?? start,
    operation_start_date: start,
    operation_end_date: end,
    schedule_pattern: parseSchedulePattern(
      row.schedule_pattern == null ? null : String(row.schedule_pattern)
    ),
    weekday_start: parseSmallInt(row.weekday_start),
    weekday_end: parseSmallInt(row.weekday_end),
    month_day_start: parseSmallInt(row.month_day_start),
    month_day_end: parseSmallInt(row.month_day_end),
    operating_start_time:
      row.operating_start_time == null
        ? null
        : parseScheduleTime(String(row.operating_start_time)),
    operating_end_time:
      row.operating_end_time == null
        ? null
        : parseScheduleTime(String(row.operating_end_time)),
    departure_time: row.departure_time == null ? null : String(row.departure_time),
    arrival_time: row.arrival_time == null ? null : String(row.arrival_time),
  };
}
