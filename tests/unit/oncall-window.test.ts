import { describe, it, expect } from "vitest";
import { getOnCallConfig, type OnCallConfig } from "@/lib/oncall/config";
import { isOnCallWindow, localTime } from "@/lib/oncall/window";

/** Config with Grant's answers baked in: after 5pm weekdays, all weekend. */
function config(overrides: Partial<OnCallConfig> = {}): OnCallConfig {
  return { ...getOnCallConfig(), ...overrides };
}

/** A Seattle wall-clock time expressed as the UTC instant it happens at. */
const PDT = (iso: string) => new Date(`${iso}-07:00`); // summer
const PST = (iso: string) => new Date(`${iso}-08:00`); // winter

describe("isOnCallWindow", () => {
  it("hands weekday evenings and nights to the on-call tech", () => {
    expect(isOnCallWindow(PDT("2026-09-09T17:00:00"), config())).toBe(true); // Wed 5:00pm
    expect(isOnCallWindow(PDT("2026-09-09T22:30:00"), config())).toBe(true); // Wed 10:30pm
    expect(isOnCallWindow(PDT("2026-09-10T02:00:00"), config())).toBe(true); // Thu 2:00am
    expect(isOnCallWindow(PDT("2026-09-10T07:59:00"), config())).toBe(true); // Thu 7:59am
  });

  it("hands weekday business hours to the office", () => {
    expect(isOnCallWindow(PDT("2026-09-09T08:00:00"), config())).toBe(false); // Wed 8:00am
    expect(isOnCallWindow(PDT("2026-09-09T12:15:00"), config())).toBe(false); // Wed noon
    expect(isOnCallWindow(PDT("2026-09-09T16:59:00"), config())).toBe(false); // Wed 4:59pm
  });

  it("covers the whole weekend, daytime included", () => {
    expect(isOnCallWindow(PDT("2026-09-12T11:00:00"), config())).toBe(true); // Sat 11am
    expect(isOnCallWindow(PDT("2026-09-13T14:30:00"), config())).toBe(true); // Sun 2:30pm
  });

  it("can be told weekends work like weekdays", () => {
    const officeWeekend = config({ weekendAllDay: false });
    expect(isOnCallWindow(PDT("2026-09-12T11:00:00"), officeWeekend)).toBe(false); // Sat 11am
    expect(isOnCallWindow(PDT("2026-09-12T19:00:00"), officeWeekend)).toBe(true); // Sat 7pm
  });

  it("holds the 5pm line through the daylight-saving change", () => {
    // Same wall clock either side of the November change, 8 weeks apart.
    expect(isOnCallWindow(PDT("2026-10-30T17:05:00"), config())).toBe(true);
    expect(isOnCallWindow(PST("2026-12-11T17:05:00"), config())).toBe(true);
    expect(isOnCallWindow(PST("2026-12-11T16:55:00"), config())).toBe(false);
  });

  it("ignores the clock entirely when the rotation runs 24/7", () => {
    expect(isOnCallWindow(PDT("2026-09-09T12:15:00"), config({ alwaysOnCall: true }))).toBe(true);
  });

  it("falls back to Seattle time if the timezone is misspelled", () => {
    const broken = config({ timezone: "America/Seatle" });
    expect(localTime(PDT("2026-09-09T17:00:00"), broken.timezone).timezone).toBe("America/Los_Angeles");
    expect(isOnCallWindow(PDT("2026-09-09T17:00:00"), broken)).toBe(true);
  });

  it("labels the local time the way a person reads it", () => {
    expect(localTime(PDT("2026-09-12T21:40:00"), "America/Los_Angeles").label).toBe("Sat 9:40 PM");
  });
});
