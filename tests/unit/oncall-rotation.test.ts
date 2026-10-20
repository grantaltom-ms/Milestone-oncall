import { describe, it, expect } from "vitest";
import { planRotation, ROTATION_FALL_2026, zonedInstant } from "@/lib/oncall/rotation";
import type { Shift } from "@/lib/oncall/calendar";
import type { Tech } from "@/lib/oncall/roster";

const TZ = "America/Los_Angeles";

const techs: Tech[] = [
  { id: "1", name: "Bhakti Shah", phone: "+12065550101", active: true },
  { id: "2", name: "Yurii Kovalenko", phone: "+12065550102", active: true },
  { id: "3", name: "Jim", phone: "+12065550103", active: true },
  { id: "4", name: "Angel Ruiz", phone: "+12065550104", active: true },
];

describe("zonedInstant", () => {
  it("is 8:00 AM Seattle in daylight time", () => {
    expect(zonedInstant("2026-10-12", 8, TZ).toISOString()).toBe("2026-10-12T15:00:00.000Z");
  });

  it("is 8:00 AM Seattle in standard time, after the clocks go back on 11/1", () => {
    expect(zonedInstant("2026-10-26", 8, TZ).toISOString()).toBe("2026-10-26T15:00:00.000Z");
    expect(zonedInstant("2026-11-02", 8, TZ).toISOString()).toBe("2026-11-02T16:00:00.000Z");
  });
});

describe("the fall 2026 rotation", () => {
  it("is Bhakti, Yurii, Jim, Angel in turn, one Monday-to-Sunday week each, with no gaps", () => {
    expect(ROTATION_FALL_2026.map((w) => w.name)).toEqual([
      "Bhakti", "Yurii", "Jim", "Angel", "Bhakti", "Yurii", "Jim", "Angel",
    ]);
    const plan = planRotation(ROTATION_FALL_2026, techs, [], TZ);
    expect(plan.problems).toEqual([]);
    expect(plan.toCreate).toHaveLength(8);
    plan.toCreate.forEach((shift, i) => {
      expect(new Date(shift.start).getUTCDay()).toBe(1); // Monday
      if (i > 0) expect(shift.start).toBe(plan.toCreate[i - 1].end);
    });
  });

  it("hands off at 8:00 AM Seattle on both sides of the clock change", () => {
    const { toCreate } = planRotation(ROTATION_FALL_2026, techs, [], TZ);
    const jim = toCreate[2]; // 10/26 - 11/02: starts in PDT, ends in PST
    expect(jim).toMatchObject({
      techName: "Jim",
      phone: "+12065550103",
      start: "2026-10-26T15:00:00.000Z",
      end: "2026-11-02T16:00:00.000Z",
    });
  });
});

describe("planRotation", () => {
  const written = (name: string, start: string, end: string): Shift => {
    const tech = techs.find((t) => t.name === name)!;
    return { id: `e-${start}`, techName: tech.name, phone: tech.phone, start, end };
  };

  it("leaves weeks that are already on the calendar alone", () => {
    const existing = [written("Bhakti Shah", "2026-10-12T08:00:00-07:00", "2026-10-19T08:00:00-07:00")];
    const plan = planRotation(ROTATION_FALL_2026, techs, existing, TZ);
    expect(plan.alreadyThere).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(7);
  });

  it("is idempotent: planning again after everything is created adds nothing", () => {
    const first = planRotation(ROTATION_FALL_2026, techs, [], TZ);
    const calendar = first.toCreate.map((s, i) => ({ id: String(i), ...s }));
    const second = planRotation(ROTATION_FALL_2026, techs, calendar, TZ);
    expect(second.toCreate).toEqual([]);
    expect(second.alreadyThere).toHaveLength(8);
    expect(second.problems).toEqual([]);
  });

  it("refuses everything when a name is not on the roster", () => {
    const plan = planRotation(ROTATION_FALL_2026, techs.filter((t) => t.name !== "Jim"), [], TZ);
    expect(plan.problems.join(" ")).toContain("Jim is not an active technician");
  });

  it("does not guess between two technicians with the same first name", () => {
    const twins = [...techs, { id: "5", name: "Angel Torres", phone: "+12065550105", active: true }];
    const plan = planRotation(ROTATION_FALL_2026, twins, [], TZ);
    expect(plan.problems.join(" ")).toContain('More than one active technician matches "Angel"');
  });

  it("ignores inactive technicians", () => {
    const retired = techs.map((t) => (t.name === "Jim" ? { ...t, active: false } : t));
    expect(planRotation(ROTATION_FALL_2026, retired, [], TZ).problems.join(" ")).toContain("Jim");
  });

  it("refuses to double-book over somebody else's shift", () => {
    const existing = [written("Jim", "2026-11-04T08:00:00-08:00", "2026-11-11T08:00:00-08:00")];
    const plan = planRotation(ROTATION_FALL_2026, techs, existing, TZ);
    expect(plan.problems.length).toBeGreaterThan(0);
    expect(plan.problems.join(" ")).toContain("overlaps a shift already on the calendar");
  });
});
