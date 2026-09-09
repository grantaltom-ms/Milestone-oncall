import { DEFAULT_TIMEZONE, type OnCallConfig } from "./config";

/**
 * Decides whether a call belongs to the on-call rotation or to the office.
 *
 * All of this is done in the property's own timezone via `Intl`, never with
 * `getHours()`, because the server runs in UTC: at 6pm Seattle time a UTC
 * server thinks it is 1am the next day, and daylight saving would shift the
 * cutoff by an hour twice a year.
 */

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type LocalTime = {
  /** 0 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
  /** e.g. "Fri 5:12 PM" — for logs and the status page. */
  label: string;
  timezone: string;
};

function safeTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function localTime(now: Date, timezone: string): LocalTime {
  const zone = safeTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
    hour: Number.parseInt(get("hour"), 10) % 24,
    minute: Number.parseInt(get("minute"), 10),
    label: new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(now),
    timezone: zone,
  };
}

/** True when the on-call technician — not the office — should get this call. */
export function isOnCallWindow(now: Date, config: OnCallConfig): boolean {
  if (config.alwaysOnCall) return true;

  const { weekday, hour } = localTime(now, config.timezone);
  const isWeekend = weekday === 0 || weekday === 6;
  if (config.weekendAllDay && isWeekend) return true;

  // The evening shift runs past midnight, so "after 5pm" and "before 8am" are
  // two halves of the same window.
  return hour >= config.eveningStartHour || hour < config.morningEndHour;
}
