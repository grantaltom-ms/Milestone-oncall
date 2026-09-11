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

    await firstDay.fill("2026-09-14");
    // A week is filled in for you, and the exact window is spelled out.
    await expect(lastDay).toHaveValue("2026-09-20");
    await expect(page.getByText(/On call from Mon, Sep 14, 8:00 AM to Mon, Sep 21, 8:00 AM/)).toBeVisible();
    await expect(page.getByText(/7 days/)).toBeVisible();

    await page.getByLabel("Technician").selectOption({ label: config.techA.name });
    await page.getByRole("button", { name: "Add shift" }).click();

    // The form rolling on to the next week is the signal the save went through.
    await expect(firstDay).toHaveValue("2026-09-21");
    await expect(page.getByText(config.techA.phone)).toBeVisible();
    const events = await calendarEvents(request);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe(config.techA.name);
    // Monday 8:00 AM Pacific through the following Monday 8:00 AM.
    expect(new Date(events[0].start.dateTime).toISOString()).toBe("2026-09-14T15:00:00.000Z");
    expect(new Date(events[0].end.dateTime).toISOString()).toBe("2026-09-21T15:00:00.000Z");
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

    await page.getByLabel("First day").fill("2026-09-14");
    await page.getByLabel("Technician").selectOption({ label: config.techA.name });
    await page.getByRole("button", { name: "Add shift" }).click();
    await expect(page.getByLabel("First day")).toHaveValue("2026-09-21");

    await page.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("heading", { name: "Edit shift" })).toBeVisible();
    // The shift ends Monday 8:00 AM; the last day it covers is the Sunday.
    await expect(page.getByLabel("First day")).toHaveValue("2026-09-14");
    await expect(page.getByLabel("Last day")).toHaveValue("2026-09-20");

    // Hand the last two days to someone else by shortening it.
    await page.getByLabel("Last day").fill("2026-09-18");
    await page.getByRole("button", { name: "Save changes" }).click();
    // Back to "Add a shift" means the edit was accepted and the list reloaded.
    await expect(page.getByRole("heading", { name: "Add a shift" })).toBeVisible();

    const events = await calendarEvents(request);
    expect(events).toHaveLength(1);
    expect(new Date(events[0].end.dateTime).toISOString()).toBe("2026-09-19T15:00:00.000Z");
  });
});
