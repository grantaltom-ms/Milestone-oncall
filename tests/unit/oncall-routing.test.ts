import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { resetGoogleTokenCache } from "@/lib/oncall/calendar";
import { DEFAULT_TIMEZONE, type OnCallConfig } from "@/lib/oncall/config";
import { resolveDestination } from "@/lib/oncall/routing";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function config(overrides: Partial<OnCallConfig> = {}): OnCallConfig {
  return {
    mainLine: "+12065550100",
    officePhone: "+12065550111",
    backupPhone: "+12065550199",
    smsFrom: "+12065550100",
    voicemailNotify: [],
    timezone: DEFAULT_TIMEZONE,
    eveningStartHour: 17,
    morningEndHour: 8,
    weekendAllDay: true,
    alwaysOnCall: false,
    dialTimeoutSeconds: 25,
    techAttempts: 2,
    recordCalls: false,
    callerLookup: true,
    companyName: "Milestone Properties",
    google: {
      serviceAccountEmail: "oncall@milestone.iam.gserviceaccount.com",
      privateKey,
      calendarId: "maintenance@milestoneprop.com",
      tokenUrl: "https://oauth.test/token",
      apiBase: "https://cal.test",
    },
    twilio: { accountSid: "AC1", authToken: "secret", apiBase: "https://twilio.test" },
    publicBaseUrl: null,
    statusApiKey: null,
    supabase: null,
    dashboardPassword: null,
    allowUnsigned: false,
    ...overrides,
  };
}

function mockCalendar(items: Record<string, unknown>[] | "down") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("oauth.test")) return Response.json({ access_token: "t", expires_in: 3600 });
      if (items === "down") return new Response("boom", { status: 500 });
      return Response.json({ items });
    })
  );
}

const FRIDAY_9PM = new Date("2026-09-12T04:00:00Z"); // Fri 9:00pm Seattle
const WEDNESDAY_NOON = new Date("2026-09-09T19:00:00Z"); // Wed 12:00pm Seattle
const SUNDAY_11AM = new Date("2026-09-13T18:00:00Z"); // Sun 11:00am Seattle
const ON_CALL = [{ summary: "Mike Alvarez", location: "206-555-0134" }];

beforeEach(() => resetGoogleTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("resolveDestination", () => {
  it("sends an evening call to the technician on the calendar", async () => {
    mockCalendar(ON_CALL);
    await expect(resolveDestination(FRIDAY_9PM, config())).resolves.toMatchObject({
      destination: { kind: "tech", phone: "+12065550134", name: "Mike Alvarez" },
      onCallWindow: true,
      reason: "calendar",
    });
  });

  it("sends a weekend daytime call to the technician too", async () => {
    mockCalendar(ON_CALL);
    await expect(resolveDestination(SUNDAY_11AM, config())).resolves.toMatchObject({
      destination: { kind: "tech", phone: "+12065550134" },
    });
  });

  it("sends a midweek midday call to the office, without touching the calendar", async () => {
    mockCalendar(ON_CALL);
    const decision = await resolveDestination(WEDNESDAY_NOON, config());
    expect(decision).toMatchObject({
      destination: { kind: "office", phone: "+12065550111" },
      onCallWindow: false,
      reason: "business_hours",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the rotation during the day when there is no office line to fall back to", async () => {
    mockCalendar(ON_CALL);
    await expect(resolveDestination(WEDNESDAY_NOON, config({ officePhone: null }))).resolves.toMatchObject({
      destination: { kind: "tech", phone: "+12065550134" },
    });
  });

  it("falls back to the backup manager when nobody is on the calendar", async () => {
    mockCalendar([]);
    await expect(resolveDestination(FRIDAY_9PM, config())).resolves.toMatchObject({
      destination: { kind: "backup", phone: "+12065550199" },
      reason: "no_event",
    });
  });

  it("falls back to the backup manager when Google is down", async () => {
    mockCalendar("down");
    await expect(resolveDestination(FRIDAY_9PM, config())).resolves.toMatchObject({
      destination: { kind: "backup", phone: "+12065550199" },
      reason: "calendar_error",
    });
  });

  it("falls back to the backup manager when the calendar was never set up", async () => {
    mockCalendar(ON_CALL);
    await expect(resolveDestination(FRIDAY_9PM, config({ google: null }))).resolves.toMatchObject({
      destination: { kind: "backup", phone: "+12065550199" },
      reason: "calendar_not_configured",
    });
  });

  it("takes a voicemail only when there is no human left to ring", async () => {
    mockCalendar([]);
    await expect(resolveDestination(FRIDAY_9PM, config({ backupPhone: null }))).resolves.toMatchObject({
      destination: { kind: "voicemail" },
      reason: "no_event_no_backup",
    });
  });
});
