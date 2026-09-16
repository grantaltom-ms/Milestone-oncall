import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import config from "./oncall.config.json";
import { computeTwilioSignature } from "../../src/lib/oncall/twilio";

/**
 * The whole point of the feature, end to end against the production build: a
 * resident calls, the technician is told which unit before they answer, the
 * conversation is recorded, and the next morning somebody listens back and
 * copies a note into AppFolio.
 *
 * Google Calendar, Twilio (SMS and recording media) and Supabase are all the
 * local stand-in from oncall-server.mjs, so this costs nothing and cannot
 * reach a real resident.
 */

const APP = "http://localhost:3000";
const MOCK = `http://127.0.0.1:${config.mockPort}/_mock/state`;
const RECORDING_SID = "RE0123456789abcdef0123456789abcdef";

const TENANT_ROW = {
  phone10: config.tenant.replace(/\D/g, "").slice(-10),
  property_name: "Willow Lake Apartments",
  unit: "V - 12",
  tenant_name: "Kovacs, Nadia",
  match_rank: 0,
};

async function setUp(request: APIRequestContext, state: Record<string, unknown> = {}) {
  await request.post(MOCK, {
    data: {
      reset: true,
      calendarStatus: 200,
      items: [{ summary: config.techA.name, location: config.techA.phone }],
      directory: [TENANT_ROW],
      callLog: [],
      ...state,
    },
  });
}

async function mockState(request: APIRequestContext) {
  return (await request.get(MOCK)).json();
}

/**
 * The text goes out after the TwiML does — the directory lookup behind it must
 * never hold up a ringing phone — so it lands in the stand-in a moment after
 * the webhook has already answered.
 */
async function textsSent(request: APIRequestContext, count: number) {
  await expect.poll(async () => (await mockState(request)).sms.length).toBe(count);
  return (await mockState(request)).sms;
}

/** One signed Twilio webhook, exactly as Twilio would send it. */
async function twilioPost(
  request: APIRequestContext,
  path: string,
  params: Record<string, string> = {}
) {
  const url = `${APP}${path}`;
  const form = { CallSid: "CA-e2e", From: config.tenant, To: config.mainLine, ...params };
  const response = await request.post(url, {
    headers: { "x-twilio-signature": computeTwilioSignature(url, form, config.authToken) },
    form,
  });
  return { response, body: await response.text() };
}

/** The recording callback Twilio fires when a recorded conversation ends. */
async function finishRecording(request: APIRequestContext, seconds = "252") {
  return twilioPost(
    request,
    `/api/twilio/recording?from=${encodeURIComponent(config.tenant)}`,
    {
      RecordingSid: RECORDING_SID,
      RecordingUrl: `https://api.twilio.com/recordings/${RECORDING_SID}`,
      RecordingDuration: seconds,
      RecordingStatus: "completed",
    }
  );
}

async function signIn(page: Page) {
  await page.goto(`${APP}/calls`);
  await page.getByLabel("Password").fill(config.dashboardPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "After-hours call log" })).toBeVisible();
}

test.describe("which unit is calling", () => {
  test("the technician is told the unit before the phone stops ringing", async ({ request }) => {
    await setUp(request);

    const { body: xml } = await twilioPost(request, "/api/twilio/voice");

    expect(xml).toContain(`<Number>${config.techA.phone}</Number>`);
    // Recording is on in this environment, so the caller is told first.
    expect(xml).toContain("This call will be recorded");
    expect(xml).toContain('record="record-from-answer-dual"');

    const sms = await textsSent(request, 1);
    expect(sms[0].to).toBe(config.techA.phone);
    expect(sms[0].body).toContain("Willow Lake #V-12, Nadia Kovacs");
    expect(sms[0].body).toContain("Callback: (206) 555-9876");
    // One SMS segment, still, with the unit on it.
    expect(sms[0].body.length).toBeLessThanOrEqual(160);
  });

  test("an unknown number is called unknown rather than guessed at", async ({ request }) => {
    await setUp(request, { directory: [] });
    await twilioPost(request, "/api/twilio/voice");
    const sms = await textsSent(request, 1);
    expect(sms[0].body).toContain("Number not in the tenant directory.");
    expect(sms[0].body).toContain("Callback: (206) 555-9876");
  });

  test("a directory that is down costs a line of text, not the call", async ({ request }) => {
    // No `directory` key at all in the stand-in would still answer; this points
    // the app at a Supabase that returns nothing useful for this number.
    await setUp(request, { directory: [{ ...TENANT_ROW, phone10: "0000000000" }] });
    const { body: xml } = await twilioPost(request, "/api/twilio/voice");
    expect(xml).toContain(`<Number>${config.techA.phone}</Number>`);
    const sms = await textsSent(request, 1);
    expect(sms[0].body).toContain("Callback: (206) 555-9876");
  });
});

test.describe("the morning after", () => {
  test("a recorded call turns into a note somebody can paste into AppFolio", async ({
    page,
    request,
    context,
  }) => {
    await setUp(request);
    await twilioPost(request, "/api/twilio/voice");
    const { response } = await finishRecording(request);
    expect(response.status()).toBe(204);

    // Filed under the unit, not under a bare phone number.
    const { callLog } = await mockState(request);
    expect(callLog).toHaveLength(1);
    expect(callLog[0]).toMatchObject({
      recording_sid: RECORDING_SID,
      unit: "V - 12",
      property_name: "Willow Lake Apartments",
      match_count: 1,
      kind: "call",
    });

    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
    await signIn(page);

    await expect(page.getByText("Willow Lake Apartments #V - 12 — Nadia Kovacs")).toBeVisible();
    await expect(page.locator("audio")).toHaveAttribute(
      "src",
      `/api/calls/${RECORDING_SID}/audio`
    );

    await page.getByRole("button", { name: "Copy note" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

    const note = await page.evaluate(() => navigator.clipboard.readText());
    expect(note).toContain("Willow Lake Apartments #V - 12");
    expect(note).toContain("From (206) 555-9876");
    expect(note).toContain("4 min 12 sec");
    expect(note).toContain(`/api/calls/${RECORDING_SID}/audio`);
    // The lines a person still has to think about are left empty on purpose.
    expect(note).toContain("Action taken:");
  });

  test("a recording plays back only for someone with the password", async ({ request, page }) => {
    await setUp(request);
    await finishRecording(request);

    // No session: no audio, and nothing that hints at the Twilio credentials.
    const anonymous = await request.get(`${APP}/api/calls/${RECORDING_SID}/audio`);
    expect(anonymous.status()).toBe(401);

    await signIn(page);
    const played = await page.request.get(`${APP}/api/calls/${RECORDING_SID}/audio`);
    expect(played.status()).toBe(200);
    expect(played.headers()["content-type"]).toContain("audio/mpeg");
    expect(played.headers()["cache-control"]).toContain("no-store");
  });

  test("refuses anything that is not a recording id", async ({ page }) => {
    await signIn(page);
    const response = await page.request.get(`${APP}/api/calls/not-a-sid/audio`);
    expect(response.status()).toBe(400);
  });

  test("a hang-up on the beep is not logged as an incident", async ({ request }) => {
    await setUp(request);
    await finishRecording(request, "1");
    const { callLog } = await mockState(request);
    expect(callLog).toHaveLength(0);
  });

  test("a voicemail lands in the log with its unit too", async ({ request }) => {
    await setUp(request);
    await twilioPost(request, `/api/twilio/voicemail?from=${encodeURIComponent(config.tenant)}`, {
      RecordingSid: "RE9999999999999999999999999999abcd",
      RecordingUrl: "https://api.twilio.com/recordings/RE9999",
      RecordingDuration: "31",
    });

    const sms = await textsSent(request, 1);
    const { callLog } = await mockState(request);
    expect(callLog[0]).toMatchObject({ kind: "voicemail", unit: "V - 12" });
    // And the text that wakes the manager says where it came from.
    expect(sms[0].body).toContain("Willow Lake Apartments #V - 12");
  });
});
