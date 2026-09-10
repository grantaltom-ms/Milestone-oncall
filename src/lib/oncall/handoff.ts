/**
 * The rotation changes hands on a day boundary, never at an arbitrary time, so
 * the dashboard only asks a coordinator which days someone covers. This turns
 * those days into the exact instants the calendar stores, and back again.
 */

/** Every shift starts and ends at 8:00 AM local time. */
export const HANDOFF_HOUR = 8;

/** A week of coverage: pick a Monday and the shift runs through Sunday. */
export const SHIFT_DAYS = 7;

/** The weekday the rotation normally changes hands (0 = Sunday). */
const HANDOFF_WEEKDAY = 1;

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` for a Date, read in the viewer's own time zone. */
export function toDayInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * `2026-09-14` → the local instant that day hands off. Built field by field on
 * purpose: `new Date("2026-09-14")` is read as UTC midnight, which is the
 * evening before in Seattle — a whole day wrong.
 */
export function handoffAt(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, HANDOFF_HOUR, 0, 0, 0);
}

/** Day arithmetic that survives a daylight-saving change. */
export function addDays(day: string, days: number): string {
  const date = handoffAt(day);
  date.setDate(date.getDate() + days);
  return toDayInput(date);
}

/**
 * The next day the rotation changes hands. A Monday before 8:00 AM is still
 * itself, because that handoff has not happened yet.
 */
export function nextHandoffDay(from = new Date()): string {
  const date = new Date(from);
  const wait = (HANDOFF_WEEKDAY - date.getDay() + 7) % 7;
  const alreadyPassed = wait === 0 && from.getHours() >= HANDOFF_HOUR;
  date.setDate(date.getDate() + (alreadyPassed ? 7 : wait));
  return toDayInput(date);
}

/**
 * The days a coordinator picked → the instants that go on the calendar.
 * `lastDay` is inclusive, so Mon through Sun becomes Monday 8:00 AM to the
 * following Monday 8:00 AM — the handoff everyone already works to.
 */
export function shiftWindow(firstDay: string, lastDay: string): { start: Date; end: Date } {
  return { start: handoffAt(firstDay), end: handoffAt(addDays(lastDay, 1)) };
}

/**
 * A calendar shift → the two days the form should show. The end instant is the
 * handoff *out*, so the last day covered is the day before it: a shift ending
 * Monday 8:00 AM belongs to Sunday, not to the Monday morning it ends on.
 *
 * A shift typed straight into Google Calendar can end at any hour, and one
 * short enough would come back inside out; those get clamped to a single day,
 * which is what saving the form would make of them anyway.
 */
export function daysForShift(startISO: string, endISO: string): { firstDay: string; lastDay: string } {
  const firstDay = toDayInput(new Date(startISO));
  const back = new Date(endISO);
  back.setDate(back.getDate() - 1);
  const lastDay = toDayInput(back);
  // `YYYY-MM-DD` sorts the same way the calendar does.
  return { firstDay, lastDay: lastDay < firstDay ? firstDay : lastDay };
}

/** Whole days a first/last day pair covers; 0 or less means the pair is backwards. */
export function shiftLengthDays(firstDay: string, lastDay: string): number {
  const { start, end } = shiftWindow(firstDay, lastDay);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Where the next shift should begin so the rotation has no gap: the day the
 * last shift on the calendar hands off, or the next Monday if there are none.
 */
export function nextOpenDay(ends: string[], from = new Date()): string {
  const latest = ends.reduce((max, end) => Math.max(max, new Date(end).getTime()), 0);
  if (!latest || latest <= from.getTime()) return nextHandoffDay(from);
  return toDayInput(new Date(latest));
}
