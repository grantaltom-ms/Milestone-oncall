import { DEFAULT_TIMEZONE } from "./config";
import { HANDOFF_HOUR } from "./handoff";
import type { Shift, ShiftInput } from "./calendar";
import type { Tech } from "./roster";

/**
 * A rotation written down as the people who agreed to it: a name and the first
 * and last day they cover. `loadRotation` turns that into calendar shifts, so
 * a pasted-in schedule is one click instead of eight trips through the form.
 *
 * Runs on the server, where the clock is UTC rather than Seattle. The shift
 * form's helpers in handoff.ts read the viewer's own time zone, which is right
 * in a browser and a day wrong here, so the instants are worked out against an
 * explicit zone instead.
 */

export type RotationWeek = {
  /** First name or full name; matched against the roster. */
  name: string;
  /** `YYYY-MM-DD`, inclusive. */
  firstDay: string;
  /** `YYYY-MM-DD`, inclusive — the shift runs overnight into the next morning's handoff. */
  lastDay: string;
};

/**
 * The fall 2026 rotation, Bhakti → Yurii → Jim → Angel, Monday through Sunday.
 *
 * The schedule as first written listed Yurii, Jim and Angel again on 11/02,
 * 11/09 and 11/16 — weeks that already belonged to Angel, Bhakti and nobody.
 * Those three were read as date typos for the next turns in the same order
 * (11/16, 11/23, 11/30) rather than as double coverage.
 */
export const ROTATION_FALL_2026: RotationWeek[] = [
  { name: "Bhakti", firstDay: "2026-10-12", lastDay: "2026-10-18" },
  { name: "Yurii", firstDay: "2026-10-19", lastDay: "2026-10-25" },
  { name: "Jim", firstDay: "2026-10-26", lastDay: "2026-11-01" },
  { name: "Angel", firstDay: "2026-11-02", lastDay: "2026-11-08" },
  { name: "Bhakti", firstDay: "2026-11-09", lastDay: "2026-11-15" },
  { name: "Yurii", firstDay: "2026-11-16", lastDay: "2026-11-22" },
  { name: "Jim", firstDay: "2026-11-23", lastDay: "2026-11-29" },
  { name: "Angel", firstDay: "2026-11-30", lastDay: "2026-12-06" },
];

/** Milliseconds the zone is ahead of UTC at an instant (negative in Seattle). */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(new Date(instantMs))
      .map((part) => [part.type, Number(part.value)])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** `2026-11-02` at 8:00 in the given zone, as a real instant. Daylight saving included. */
export function zonedInstant(day: string, hour: number, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, date, hour);
  const first = wall - zoneOffsetMs(wall, timeZone);
  // Near a clock change the offset at the first guess can be the wrong side.
  return new Date(wall - zoneOffsetMs(first, timeZone));
}

function nextDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

export type PlannedShift = ShiftInput & { week: RotationWeek };

export type RotationPlan = {
  toCreate: PlannedShift[];
  /** Already on the calendar exactly as written; left alone. */
  alreadyThere: PlannedShift[];
  /** Reasons nothing was written. Non-empty means the whole plan is refused. */
  problems: string[];
};

/** "Bhakti" finds "Bhakti Shah"; a full name finds itself. Anything unclear is not guessed at. */
function findTech(name: string, techs: Tech[]): { tech?: Tech; problem?: string } {
  const wanted = name.trim().toLowerCase();
  const matches = techs.filter(
    (tech) => tech.active && (tech.name.toLowerCase() === wanted || tech.name.toLowerCase().split(/\s+/)[0] === wanted)
  );
  if (matches.length === 1) return { tech: matches[0] };
  if (matches.length === 0) return { problem: `${name} is not an active technician in the roster.` };
  return { problem: `More than one active technician matches "${name}": ${matches.map((m) => m.name).join(", ")}.` };
}

/**
 * Works out what to add without touching anything. Refuses the whole plan if a
 * name cannot be matched or a week collides with someone else's shift: a
 * half-loaded rotation looks finished and leaves a gap nobody notices.
 */
export function planRotation(
  weeks: RotationWeek[],
  techs: Tech[],
  existing: Shift[],
  timeZone: string = DEFAULT_TIMEZONE
): RotationPlan {
  const plan: RotationPlan = { toCreate: [], alreadyThere: [], problems: [] };

  for (const week of weeks) {
    const { tech, problem } = findTech(week.name, techs);
    if (!tech) {
      plan.problems.push(problem!);
      continue;
    }

    const start = zonedInstant(week.firstDay, HANDOFF_HOUR, timeZone);
    const end = zonedInstant(nextDay(week.lastDay), HANDOFF_HOUR, timeZone);
    const planned: PlannedShift = {
      techName: tech.name,
      phone: tech.phone,
      start: start.toISOString(),
      end: end.toISOString(),
      week,
    };

    const overlapping = existing.filter(
      (shift) => new Date(shift.start) < end && new Date(shift.end) > start
    );
    const exact = overlapping.find(
      (shift) =>
        shift.techName === tech.name &&
        new Date(shift.start).getTime() === start.getTime() &&
        new Date(shift.end).getTime() === end.getTime()
    );
    if (exact && overlapping.length === 1) {
      plan.alreadyThere.push(planned);
    } else if (overlapping.length > 0) {
      const clash = overlapping.map((s) => `${s.techName} (${s.start} to ${s.end})`).join("; ");
      plan.problems.push(
        `${tech.name} ${week.firstDay} to ${week.lastDay} overlaps a shift already on the calendar: ${clash}.`
      );
    } else {
      plan.toCreate.push(planned);
    }
  }

  return plan;
}
