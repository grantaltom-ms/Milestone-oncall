import { test, expect, type APIRequestContext } from "@playwright/test";
import config from "./oncall.config.json";
import { computeTwilioSignature } from "../../src/lib/oncall/twilio";

/**
 * Drives the after-hours line the way Twilio does: a signed webhook for the
 * incoming call, then a signed request to whatever `action` URL came back,
 * over and over, against the production build. Google Calendar and Twilio's
 * SMS API are the local stand-in from oncall-server.mjs.
 */

const APP = "http://localhost:3000";
const MOCK = `http://127.0.0.1:${config.mockPort}/_mock/state`;

type MockState = {
  sms: { to: string; from: string; body: string }[];
  items: Record<string, unknown>[];
};

const shift = (tech: { name: string; phone: string }) => ({ summary: tech.name, location: tech.phone });

async function setUp(request: APIRequestContext, state: Record<string, unknown>) {
  await request.post(MOCK, { data: { reset: true, calendarStatus: 200, ...state } });
}

async function mockState(request: APIRequestContext): Promise<MockState> {
  return (await request.get(MOCK)).json();
}

/** One signed Twilio webhook, exactly as Twilio would send it. */
async function twilioCall(
  request: APIRequestContext,
  path: string,
  params: Record<string, string> = {},
  options: { signature?: string } = {}
) {
  const url = `${APP}${path}`;
  const form = { CallSid: "CA-e2e", From: config.tenant, To: config.mainLine, ...params };
  const response = await request.post(url, {
    headers: {
      "x-twilio-signature": options.signature ?? computeTwilioSignature(url, form, config.authToken),
    },
    form,
  });
  return { response, xml: await response.text() };
}

/** The URL Twilio would call next when the leg goes unanswered. */
const nextStep = (xml: string) => xml.match(/action="([^"]+)"/)?.[1].replace(/&amp;/g, "&") ?? null;

test.describe("after-hours maintenance line", () => {
  test("tenant call reaches the on-call tech with the office caller ID, and texts them the number", async ({
    request,
  }) => {
    await setUp(request, { items: [shift(config.techA)] });

    const { response, xml } = await twilioCall(request, "/api/twilio/voice");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/xml");
    expect(xml).toContain(`<Number>${config.techA.phone}</Number>`);
    expect(xml).toContain(`callerId="${config.mainLine}"`);
    expect(xml).not.toContain(config.tenant); // the handset only ever shows the office line

    const { sms } = await mockState(request);
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({ to: config.techA.phone, from: config.mainLine });
    expect(sms[0].body).toContain("(206) 555-9876");

    // Tech answers; when the call ends Twilio asks what is next and gets "nothing".
    const done = await twilioCall(request, nextStep(xml)!, { DialCallStatus: "completed" });
    expect(done.xml).toContain("<Hangup/>");
    expect(done.xml).not.toContain("<Dial");
  });

  test("nobody answers: tech twice, then the backup manager, then voicemail", async ({ request }) => {
    await setUp(request, { items: [shift(config.techA)] });

    const first = await twilioCall(request, "/api/twilio/voice");
    expect(first.xml).toContain(config.techA.phone);

    const second = await twilioCall(request, nextStep(first.xml)!, { DialCallStatus: "no-answer" });
    expect(second.xml).toContain(config.techA.phone); // same tech, second ring

    const backup = await twilioCall(request, nextStep(second.xml)!, { DialCallStatus: "no-answer" });
    expect(backup.xml).toContain(`<Number>${config.backupPhone}</Number>`);
    expect(backup.xml).toContain("Please hold");

    const voicemail = await twilioCall(request, nextStep(backup.xml)!, { DialCallStatus: "no-answer" });
    expect(voicemail.xml).toContain("<Record");
    expect(voicemail.xml).toContain("dial 9 1 1");

    // Twilio posts the finished recording; the backup manager gets a link.
    const recorded = await twilioCall(request, "/api/twilio/voicemail", {
      RecordingUrl: "https://api.twilio.com/recordings/RE-e2e",
      RecordingDuration: "37",
    });
    expect(recorded.response.status()).toBe(204);

    const { sms } = await mockState(request);
    expect(sms.map((message) => message.to)).toEqual([
      config.techA.phone, // ring one
      config.backupPhone, // escalation
      config.backupPhone, // voicemail link
    ]);
    expect(sms[2].body).toContain("https://api.twilio.com/recordings/RE-e2e");

    const goodbye = await twilioCall(request, nextStep(voicemail.xml)!, { RecordingDuration: "37" });
    expect(goodbye.xml).toContain("<Hangup/>");
  });

  test("a shift change on the calendar reroutes the next call, with no deploy", async ({ request }) => {
    await setUp(request, { items: [shift(config.techA)] });
    expect((await twilioCall(request, "/api/twilio/voice")).xml).toContain(config.techA.phone);

    await request.post(MOCK, { data: { items: [shift(config.techB)] } });

    const afterSwap = await twilioCall(request, "/api/twilio/voice", { CallSid: "CA-e2e-2" });
    expect(afterSwap.xml).toContain(config.techB.phone);
    expect(afterSwap.xml).not.toContain(config.techA.phone);
    expect(afterSwap.xml).toContain(`callerId="${config.mainLine}"`); // unchanged, call after call

    const { sms } = await mockState(request);
    expect(sms.map((message) => message.to)).toEqual([config.techA.phone, config.techB.phone]);
  });

  test("calls still reach a human when Google Calendar is down or the shift is missing", async ({
    request,
  }) => {
    await setUp(request, { items: [shift(config.techA)], calendarStatus: 503 });
    expect((await twilioCall(request, "/api/twilio/voice")).xml).toContain(
      `<Number>${config.backupPhone}</Number>`
    );

    await setUp(request, { items: [] });
    expect((await twilioCall(request, "/api/twilio/voice", { CallSid: "CA-e2e-3" })).xml).toContain(
      `<Number>${config.backupPhone}</Number>`
    );
  });

  test("an unsigned request gets nothing", async ({ request }) => {
    await setUp(request, { items: [shift(config.techA)] });
    const { response, xml } = await twilioCall(request, "/api/twilio/voice", {}, { signature: "forged" });
    expect(response.status()).toBe(403);
    expect(xml).not.toContain(config.techA.phone);
    expect((await mockState(request)).sms).toHaveLength(0);
  });

  test("the status check tells the office who is on call, and hides the number without the key", async ({
    request,
  }) => {
    await setUp(request, { items: [shift(config.techA)] });

    const open = await (await request.get(`${APP}/api/oncall/status`)).json();
    expect(open).toMatchObject({ on_call_found: true, tech_name: config.techA.name, destination: "tech" });
    expect(open.tech_phone).toBeUndefined();
    expect(open.tech_phone_last4).toBe(`•••-${config.techA.phone.slice(-4)}`);

    const keyed = await (await request.get(`${APP}/api/oncall/status?key=${config.statusKey}`)).json();
    expect(keyed.tech_phone).toBe(config.techA.phone);
  });
});
