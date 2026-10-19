import { test, expect, type APIRequestContext } from "@playwright/test";
import config from "./oncall.config.json";

/**
 * The scheduling form, clicked through in a real browser. The rest of the
 * suite drives the API; this covers the part a coordinator actually touches —
 * that picking two days, and nothing else, produces the 8:00 AM handoff the
 * whole rotation is built on.
 */

const APP = "http://localhost:3000";
const MOCK = `http://127.0.0.1:${config.mockPort}/_mock/state`;

// Pinned so "8:00 AM" means the same thing here as it does in Seattle.
test.use({ timezoneId: "America/Los_Angeles" });

async function resetMock(request: APIRequestContext) {
  await request.post(MOCK, {
    data: {
      reset: true,
      calendarStatus: 200,
      items: [],
      techs: [
        { id: 1, name: config.techA.name, phone: config.techA.phone, active: true },
        { id: 2, name: config.techB.name, phone: config.techB.phone, active: true },
      ],
    },
  });
}

type MockEvent = { summary: string; start: { dateTime: string }; end: { dateTime: string } };

async function calendarEvents(request: APIRequestContext): Promise<MockEvent[]> {
  const { items } = await (await request.get(MOCK)).json();
  return [...items].sort((a: MockEvent, b: MockEvent) =>
    a.start.dateTime.localeCompare(b.start.dateTime)
  );
}

/**
 * Days are worked out from today rather than written down: the dashboard only
 * lists shifts from a week ago onward, so a date typed into a test stops being
 * listed the week after it passes, and the test fails for no reason.
 */
const seattleDay = (ms: number) =>
  new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The Monday after today, in Seattle. */
function upcomingMonday(): string {
  const today = seattleDay(Date.now());
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, ((8 - weekday) % 7) || 7);
}

/** "Mon, Sep 14" for a `YYYY-MM-DD` day. */
const longDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** An instant as Seattle wall-clock, "2026-09-14 08:00" — the handoff is 8:00 whatever the season. */
const seattleClock = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).slice(0, 16);

async function signIn(page: import("@playwright/test").Page) {
  await page.goto(`${APP}/schedule`);
  await page.getByLabel("Password").fill(config.dashboardPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Add a shift" })).toBeVisible();
}

test.describe("finding the dashboard", () => {
  test("the landing page points at the dashboard", async ({ page, request }) => {
    await resetMock(request);
    // The landing page is read-only by design, so the only way to the form is a
    // link — without one, someone typing the bare domain finds a dead end.
    await page.goto(`${APP}/`);
    const link = page.getByRole("link", { name: /scheduling dashboard/i }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("says so when it cannot reach the schedule, instead of loading forever", async ({ page, request }) => {
    await resetMock(request);
    await page.route("**/api/schedule/shifts**", (route) => route.abort());

    await page.goto(`${APP}/schedule`);
    // The failure has to resolve into something a person can act on.
    await expect(page.getByText(/Could not reach the schedule/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Loading…")).toHaveCount(0);
  });
});

test.describe("the shift form", () => {
  test("asks for days only, and writes an 8:00 AM handoff", async ({ page, request }) => {
    await resetMock(request);
    await signIn(page);

    const firstDay = page.getByLabel("First day");
    const lastDay = page.getByLabel("Last day");

    // No time boxes anywhere in the form — that is the point of the change.
    await expect(firstDay).toHaveAttribute("type", "date");
    await expect(lastDay).toHaveAttribute("type", "date");
    await expect(page.locator("input[type='datetime-local']")).toHaveCount(0);

    const monday = upcomingMonday();
    await firstDay.fill(monday);
    // A week is filled in for you, and the exact window is spelled out.
    await expect(lastDay).toHaveValue(addDays(monday, 6));
    await expect(
      page.getByText(`On call from ${longDay(monday)}, 8:00 AM to ${longDay(addDays(monday, 7))}, 8:00 AM`, { exact: false })
    ).toBeVisible();
    await expect(page.getByText(/7 days/)).toBeVisible();

    await page.getByLabel("Technician").selectOption({ label: config.techA.name });
    await page.getByRole("button", { name: "Add shift" }).click();

    // The form rolling on to the next week is the signal the save went through.
    await expect(firstDay).toHaveValue(addDays(monday, 7));
    await expect(page.getByText(config.techA.phone)).toBeVisible();
    const events = await calendarEvents(request);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe(config.techA.name);
    // Monday 8:00 AM Pacific through the following Monday 8:00 AM.
    expect(seattleClock(events[0].start.dateTime)).toBe(`${monday} 08:00`);
    expect(seattleClock(events[0].end.dateTime)).toBe(`${addDays(monday, 7)} 08:00`);
  });

  test("refuses a last day that comes before the first", async ({ page, request }) => {
    await resetMock(request);
    await signIn(page);

    await page.getByLabel("First day").fill("2026-09-14");
    await page.getByLabel("Last day").fill("2026-09-07");

    await expect(page.getByText("The last day is before the first day.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add shift" })).toBeDisabled();
    expect(await calendarEvents(request)).toHaveLength(0);
  });

  test("builds a whole rotation back to back with no gaps", async ({ page, request }) => {
    await resetMock(request);
    await signIn(page);

    // A coordinator adding several weeks in a row: set the first day once,
    // then just pick the next name and submit. The form should walk forward.
    await page.getByLabel("First day").fill("2026-09-14");
    const weeks = [
      { tech: config.techA, thenOffers: "2026-09-21" },
      { tech: config.techB, thenOffers: "2026-09-28" },
      { tech: config.techA, thenOffers: "2026-10-05" },
    ];
    for (const week of weeks) {
      await page.getByLabel("Technician").selectOption({ label: week.tech.name });
      await page.getByRole("button", { name: "Add shift" }).click();
      await expect(page.getByLabel("First day")).toHaveValue(week.thenOffers);
    }

    // Each week starts exactly where the last one ended, so the dashboard has
    // nothing to complain about.
    const events = await calendarEvents(request);
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.summary)).toEqual([
      config.techA.name,
      config.techB.name,
      config.techA.name,
    ]);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].start.dateTime).toBe(events[i - 1].end.dateTime);
    }
    expect(new Date(events[2].end.dateTime).toISOString()).toBe("2026-10-05T15:00:00.000Z");
    await expect(page.getByText("Coverage problems")).toHaveCount(0);

    // The form is already sitting on the next open week, ready for a fourth.
    await expect(page.getByLabel("First day")).toHaveValue("2026-10-05");
    await expect(page.getByLabel("Last day")).toHaveValue("2026-10-11");
  });

  test("edits a shift back into days without losing a day", async ({ page, request }) => {
    await resetMock(request);
    await signIn(page);

    const monday = upcomingMonday();
    await page.getByLabel("First day").fill(monday);
    await page.getByLabel("Technician").selectOption({ label: config.techA.name });
    await page.getByRole("button", { name: "Add shift" }).click();
    await expect(page.getByLabel("First day")).toHaveValue(addDays(monday, 7));

    await page.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("heading", { name: "Edit shift" })).toBeVisible();
    // The shift ends Monday 8:00 AM; the last day it covers is the Sunday.
    await expect(page.getByLabel("First day")).toHaveValue(monday);
    await expect(page.getByLabel("Last day")).toHaveValue(addDays(monday, 6));

    // Hand the last two days to someone else by shortening it.
    await page.getByLabel("Last day").fill(addDays(monday, 4));
    await page.getByRole("button", { name: "Save changes" }).click();
    // Back to "Add a shift" means the edit was accepted and the list reloaded.
    await expect(page.getByRole("heading", { name: "Add a shift" })).toBeVisible();

    const events = await calendarEvents(request);
    expect(events).toHaveLength(1);
    expect(seattleClock(events[0].end.dateTime)).toBe(`${addDays(monday, 5)} 08:00`);
  });

  test("one click loads the fall rotation, and a second click adds nothing", async ({ page, request }) => {
    const names = ["Bhakti Shah", "Yurii Kovalenko", "Jim Ortiz", "Angel Ruiz"];
    await request.post(MOCK, {
      data: {
        reset: true,
        calendarStatus: 200,
        items: [],
        techs: names.map((name, i) => ({ id: i + 1, name, phone: `+1206555010${i + 1}`, active: true })),
      },
    });
    await signIn(page);

    await page.getByRole("button", { name: "Add the fall rotation" }).click();
    await expect(page.getByText("Added 8 shifts; 0 were already on the calendar.")).toBeVisible();
    expect(await calendarEvents(request)).toHaveLength(8);
    await expect(page.getByText("Coverage problems")).toHaveCount(0);

    await page.getByRole("button", { name: "Add the fall rotation" }).click();
    await expect(page.getByText("Added 0 shifts; 8 were already on the calendar.")).toBeVisible();
    expect(await calendarEvents(request)).toHaveLength(8);
  });
});
