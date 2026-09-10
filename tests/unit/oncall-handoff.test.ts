import { describe, expect, it } from "vitest";
import {
  HANDOFF_HOUR,
  SHIFT_DAYS,
  addDays,
  handoffAt,
  daysForShift,
  nextHandoffDay,
  nextOpenDay,
  shiftLengthDays,
  shiftWindow,
  toDayInput,
} from "../../src/lib/oncall/handoff";

/**
 * The dashboard only asks for days. Everything that turns a day into the
 * instant a shift actually changes hands lives here, so this is where the
 * off-by-a-day mistakes get caught instead of at 11pm on a Sunday.
 */

/** A local wall-clock time, so tests read the way the coordinator's day does. */
function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("turning a day into an instant", () => {
  it("puts the handoff at 8:00 AM local, not UTC midnight", () => {
    const at = handoffAt("2026-09-14");
    expect(at.getFullYear()).toBe(2026);
    expect(at.getMonth()).toBe(8);
    expect(at.getDate()).toBe(14);
    expect(at.getHours()).toBe(HANDOFF_HOUR);
    expect(at.getMinutes()).toBe(0);
  });

  it("round-trips through toDayInput", () => {
    expect(toDayInput(handoffAt("2026-01-05"))).toBe("2026-01-05");
    expect(toDayInput(handoffAt("2026-12-31"))).toBe("2026-12-31");
  });

  it("pads single-digit months and days", () => {
    expect(toDayInput(local(2026, 3, 7))).toBe("2026-03-07");
  });
});

describe("day arithmetic", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-09-28", 7)).toBe("2026-10-05");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("still lands on the right day across a daylight-saving change", () => {
    // US DST ends Nov 1 2026; a naive +7 * 86,400,000ms would slip an hour and,
    // for an early-morning handoff, could slip the day.
    expect(addDays("2026-10-26", 7)).toBe("2026-11-02");
    expect(handoffAt(addDays("2026-10-26", 7)).getHours()).toBe(HANDOFF_HOUR);
    // And in spring, when the clocks go forward on Mar 8 2026.
    expect(addDays("2026-03-02", 7)).toBe("2026-03-09");
    expect(handoffAt(addDays("2026-03-02", 7)).getHours()).toBe(HANDOFF_HOUR);
  });
});

describe("the next handoff day", () => {
  it("is the coming Monday from midweek", () => {
    // Thu Sep 10 2026 → Mon Sep 14.
    expect(nextHandoffDay(local(2026, 9, 10, 14))).toBe("2026-09-14");
  });

  it("is today when it is Monday before 8:00 AM", () => {
    expect(nextHandoffDay(local(2026, 9, 14, 7, 30))).toBe("2026-09-14");
  });

  it("skips a week once Monday's handoff has happened", () => {
    expect(nextHandoffDay(local(2026, 9, 14, 8, 0))).toBe("2026-09-21");
    expect(nextHandoffDay(local(2026, 9, 14, 23, 0))).toBe("2026-09-21");
  });

  it("is tomorrow on a Sunday", () => {
    expect(nextHandoffDay(local(2026, 9, 13, 20))).toBe("2026-09-14");
  });
});

describe("the window a day pair means", () => {
  it("runs 8:00 AM to 8:00 AM, with the last day inclusive", () => {
    // Mon Sep 14 through Sun Sep 20 is the week Yurii has.
    const { start, end } = shiftWindow("2026-09-14", "2026-09-20");
    expect(toDayInput(start)).toBe("2026-09-14");
    expect(start.getHours()).toBe(HANDOFF_HOUR);
    expect(toDayInput(end)).toBe("2026-09-21");
    expect(end.getHours()).toBe(HANDOFF_HOUR);
  });

  it("covers a single day as a full 24 hours", () => {
    const { start, end } = shiftWindow("2026-09-14", "2026-09-14");
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
    expect(shiftLengthDays("2026-09-14", "2026-09-14")).toBe(1);
  });

  it("counts a default shift as a week", () => {
    expect(shiftLengthDays("2026-09-14", addDays("2026-09-14", SHIFT_DAYS - 1))).toBe(SHIFT_DAYS);
  });

  it("reports a backwards pair as zero or less so the form can refuse it", () => {
    expect(shiftLengthDays("2026-09-20", "2026-09-14")).toBeLessThanOrEqual(0);
  });

  it("still spans seven days across the autumn clock change", () => {
    // The week containing Nov 1 2026 is 25 hours longer in wall-clock terms;
    // the shift is still seven days, and still hands off at 8:00 AM.
    expect(shiftLengthDays("2026-10-26", "2026-11-01")).toBe(SHIFT_DAYS);
    expect(shiftWindow("2026-10-26", "2026-11-01").end.getHours()).toBe(HANDOFF_HOUR);
  });
});

describe("reading a calendar shift back into the form", () => {
  it("shows Sunday as the last day of a Monday-to-Monday shift", () => {
    // The shift ends Monday 8:00 AM, but Monday is the next person's day.
    const { start, end } = shiftWindow("2026-09-14", "2026-09-20");
    expect(daysForShift(start.toISOString(), end.toISOString())).toEqual({
      firstDay: "2026-09-14",
      lastDay: "2026-09-20",
    });
  });

  it("round-trips every window the form can produce", () => {
    for (const [first, last] of [
      ["2026-09-14", "2026-09-20"],
      ["2026-09-14", "2026-09-14"],
      ["2026-12-28", "2027-01-03"],
      ["2026-10-26", "2026-11-01"],
      ["2026-03-02", "2026-03-08"],
    ]) {
      const { start, end } = shiftWindow(first, last);
      expect(daysForShift(start.toISOString(), end.toISOString())).toEqual({
        firstDay: first,
        lastDay: last,
      });
    }
  });

  it("normalises a shift someone typed into Google Calendar by hand", () => {
    // Friday 5pm to Sunday 5pm: the form offers Fri through Sat, and saving it
    // moves the edges to the 8:00 AM handoff everyone else works to.
    const days = daysForShift(local(2026, 9, 18, 17).toISOString(), local(2026, 9, 20, 17).toISOString());
    expect(days).toEqual({ firstDay: "2026-09-18", lastDay: "2026-09-19" });
    const { start, end } = shiftWindow(days.firstDay, days.lastDay);
    expect(start.getHours()).toBe(HANDOFF_HOUR);
    expect(end.getHours()).toBe(HANDOFF_HOUR);
  });

  it("never offers a backwards pair for a shift shorter than a day", () => {
    const days = daysForShift(local(2026, 9, 18, 17).toISOString(), local(2026, 9, 18, 23).toISOString());
    expect(days).toEqual({ firstDay: "2026-09-18", lastDay: "2026-09-18" });
    expect(shiftLengthDays(days.firstDay, days.lastDay)).toBe(1);
  });
});

describe("where the next shift should start", () => {
  it("picks up exactly where the last one hands off, so there is no gap", () => {
    const ends = [
      shiftWindow("2026-09-07", "2026-09-13").end.toISOString(),
      shiftWindow("2026-09-14", "2026-09-20").end.toISOString(),
    ];
    expect(nextOpenDay(ends, local(2026, 9, 10, 9))).toBe("2026-09-21");
  });

  it("ignores the order the calendar returned them in", () => {
    const ends = [
      shiftWindow("2026-09-14", "2026-09-20").end.toISOString(),
      shiftWindow("2026-09-07", "2026-09-13").end.toISOString(),
    ];
    expect(nextOpenDay(ends, local(2026, 9, 10, 9))).toBe("2026-09-21");
  });

  it("falls back to the next Monday when the calendar is empty", () => {
    expect(nextOpenDay([], local(2026, 9, 10, 9))).toBe("2026-09-14");
  });

  it("falls back to the next Monday when every shift is already over", () => {
    const ends = [shiftWindow("2026-08-03", "2026-08-09").end.toISOString()];
    expect(nextOpenDay(ends, local(2026, 9, 10, 9))).toBe("2026-09-14");
  });

  it("chains a whole rotation with no gaps and no overlaps", () => {
    // Add five weeks the way a coordinator would: accept the offered days,
    // pick a name, submit, repeat.
    const ends: string[] = [];
    let day = nextOpenDay(ends, local(2026, 9, 7, 6));
    for (let week = 0; week < 5; week++) {
      const last = addDays(day, SHIFT_DAYS - 1);
      const span = shiftWindow(day, last);
      if (ends.length > 0) {
        expect(span.start.toISOString()).toBe(ends[ends.length - 1]);
      }
      ends.push(span.end.toISOString());
      day = addDays(last, 1);
    }
    expect(ends).toHaveLength(5);
    expect(toDayInput(new Date(ends[4]))).toBe("2026-10-12");
  });
});
