import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { POST } from "@/app/api/twilio/voice/route";
import { resetGoogleTokenCache } from "@/lib/oncall/calendar";
import { computeTwilioSignature } from "@/lib/oncall/twilio";

/**
 * The whole after-hours call, end to end through the webhook Twilio actually
 * calls: who gets dialed, what caller ID they see, who gets texted, and what
 * happens on each unanswered ring.
 */

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const AUTH_TOKEN = "test-auth-token";
const MAIN_LINE = "+12065550100";
const OFFICE = "+12065550111";
const BACKUP = "+12065550199";
const TENANT = "+12065559876";
const MIKE = { summary: "Mike Alvarez", location: "206-555-0134" };
const MIKE_PHONE = "+12065550134";
const DANA = { summary: "Dana Kim", location: "206-555-0175" };
const DANA_PHONE = "+12065550175";

let calendarItems: Record<string, unknown>[] | "down" = [MIKE];
let sentSms: { to: string; from: string; body: string }[] = [];
let tokenRequests = 0;

function stubNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("oauth.test")) {
        tokenRequests++;
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.includes("cal.test")) {
        if (calendarItems === "down") return new Response("boom", { status: 500 });
        return Response.json({ items: calendarItems });
      }
      if (url.includes("twilio.test")) {
        const form = new URLSearchParams(String(init?.body));
        sentSms.push({
          to: form.get("To") ?? "",
          from: form.get("From") ?? "",
          body: form.get("Body") ?? "",
        });
        return Response.json({ sid: "SM1" }, { status: 201 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    })
  );
}

function call(path: string, params: Record<string, string> = {}, options: { signature?: string } = {}) {
  const url = `https://milestone.test${path}`;
  const body = { CallSid: "CA-test", From: TENANT, To: MAIN_LINE, ...params };
  return POST(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-host": "milestone.test",
        "x-forwarded-proto": "https",
        "x-twilio-signature": options.signature ?? computeTwilioSignature(url, body, AUTH_TOKEN),
      },
      body: new URLSearchParams(body),
    })
  );
}

const xmlOf = (response: Response) => response.text();

beforeEach(() => {
  calendarItems = [MIKE];
  sentSms = [];
  tokenRequests = 0;
  resetGoogleTokenCache();
  stubNetwork();
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  vi.stubEnv("TWILIO_API_BASE", "https://twilio.test");
  vi.stubEnv("TWILIO_MAIN_LINE", MAIN_LINE);
  vi.stubEnv("ONCALL_OFFICE_PHONE", OFFICE);
  vi.stubEnv("ONCALL_BACKUP_PHONE", BACKUP);
  vi.stubEnv("ONCALL_ALWAYS", "true"); // pin the clock out of the way; hours are covered in oncall-window
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", "oncall@milestone.iam.gserviceaccount.com");
  vi.stubEnv("GOOGLE_PRIVATE_KEY", privateKey.replace(/\n/g, "\\n"));
  vi.stubEnv("GOOGLE_CALENDAR_ID", "maintenance@milestoneprop.com");
  vi.stubEnv("GOOGLE_OAUTH_TOKEN_URL", "https://oauth.test/token");
  vi.stubEnv("GOOGLE_CALENDAR_API_BASE", "https://cal.test");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/twilio/voice — the first ring", () => {
  it("dials the on-call tech showing the office number, not the tenant's", async () => {
    const xml = await xmlOf(await call("/api/twilio/voice"));
    expect(xml).toContain(`<Number>${MIKE_PHONE}</Number>`);
    expect(xml).toContain(`callerId="${MAIN_LINE}"`);
    expect(xml).not.toContain(TENANT); // the tenant's number never reaches the handset
    expect(xml).toContain('action="/api/twilio/voice?stage=tech&amp;attempt=2"');
    expect(xml).toContain('timeout="25"');
  });

  it("texts the tech the number that is calling, since the caller ID cannot carry it", async () => {
    await call("/api/twilio/voice");
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0]).toMatchObject({ to: MIKE_PHONE, from: MAIN_LINE });
    expect(sentSms[0].body).toContain("(206) 555-9876");
  });

  it("still connects a blocked caller, and says so in the text", async () => {
    const xml = await xmlOf(await call("/api/twilio/voice", { From: "anonymous" }));
    expect(xml).toContain(`<Number>${MIKE_PHONE}</Number>`);
    // No number to quote, so the text must say what to do instead of pointing
    // at one that is not there.
    expect(sentSms[0].body).toContain("came through blocked");
    expect(sentSms[0].body).toContain("Get a callback number on the call");
  });

  it("uses the number the tenant dialed as caller ID when the main line is not configured", async () => {
    vi.stubEnv("TWILIO_MAIN_LINE", "");
    const xml = await xmlOf(await call("/api/twilio/voice"));
    expect(xml).toContain(`callerId="${MAIN_LINE}"`); // the To parameter is that same office line
  });
});

describe("POST /api/twilio/voice — escalation", () => {
  it("rings the same tech a second time before giving up on them", async () => {
    const xml = await xmlOf(
      await call("/api/twilio/voice?stage=tech&attempt=2", { DialCallStatus: "no-answer" })
    );
    expect(xml).toContain(`<Number>${MIKE_PHONE}</Number>`);
    expect(xml).toContain('action="/api/twilio/voice?stage=backup"');
    expect(sentSms).toHaveLength(0); // no second buzz for the same call
  });

  it("moves to the backup manager, tells the tenant to hold, and texts the manager", async () => {
    const xml = await xmlOf(await call("/api/twilio/voice?stage=backup", { DialCallStatus: "no-answer" }));
    expect(xml).toContain("Still trying to reach the on call technician");
    expect(xml).toContain(`<Number>${BACKUP}</Number>`);
    expect(xml).toContain(`callerId="${MAIN_LINE}"`);
    expect(xml).toContain('action="/api/twilio/voice?stage=voicemail"');
    expect(sentSms[0]).toMatchObject({ to: BACKUP });
  });

  it("takes a voicemail last, with a 911 warning and a place for the recording to go", async () => {
    const xml = await xmlOf(await call("/api/twilio/voice?stage=voicemail", { DialCallStatus: "busy" }));
    expect(xml).toContain("Milestone Properties after hours maintenance line");
    expect(xml).toContain("dial 9 1 1");
    expect(xml).toContain("<Record");
    expect(xml).toContain('action="/api/twilio/voice?stage=goodbye"');
    expect(xml).toContain('recordingStatusCallback="/api/twilio/voicemail"');
  });

  it("hangs up politely once the message is recorded", async () => {
    const xml = await xmlOf(await call("/api/twilio/voice?stage=goodbye", { RecordingDuration: "31" }));
    expect(xml).toContain("Your message has been received");
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Dial");
  });

  it("stops escalating the moment somebody answers", async () => {
    for (const stage of ["tech&attempt=2", "backup", "voicemail"]) {
      const xml = await xmlOf(
        await call(`/api/twilio/voice?stage=${stage}`, { DialCallStatus: "completed" })
      );
      expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }
    expect(sentSms).toHaveLength(0);
  });
});

describe("POST /api/twilio/voice — when something is wrong", () => {
  it("rejects a request that is not signed by Twilio, without reading the rotation", async () => {
    const response = await call("/api/twilio/voice", {}, { signature: "forged" });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(MIKE_PHONE);
    expect(tokenRequests).toBe(0);
    expect(sentSms).toHaveLength(0);
  });

  it("connects to the backup manager when Google Calendar is unreachable", async () => {
    calendarItems = "down";
    const xml = await xmlOf(await call("/api/twilio/voice"));
    expect(xml).toContain(`<Number>${BACKUP}</Number>`);
    expect(xml).toContain('action="/api/twilio/voice?stage=voicemail"');
  });

  it("connects to the backup manager when nobody is on the calendar", async () => {
    calendarItems = [];
    expect(await xmlOf(await call("/api/twilio/voice"))).toContain(`<Number>${BACKUP}</Number>`);
  });

  it("takes a voicemail when the calendar is empty and there is no backup", async () => {
    calendarItems = [];
    vi.stubEnv("ONCALL_BACKUP_PHONE", "");
    expect(await xmlOf(await call("/api/twilio/voice"))).toContain("<Record");
  });

  it("without a Twilio auth token, rings the backup manager and never reveals the rotation", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const xml = await xmlOf(await call("/api/twilio/voice"));
    expect(xml).toContain(`<Number>${BACKUP}</Number>`);
    expect(xml).not.toContain(MIKE_PHONE);
    expect(tokenRequests).toBe(0);
  });
});

describe("POST /api/twilio/voice — a realistic night", () => {
  it("routes call after call, follows a shift change, and reuses one Google token", async () => {
    // 9:05pm — Mike's shift. Tenant calls, Mike does not pick up, backup does.
    expect(await xmlOf(await call("/api/twilio/voice"))).toContain(MIKE_PHONE);
    expect(
      await xmlOf(await call("/api/twilio/voice?stage=tech&attempt=2", { DialCallStatus: "no-answer" }))
    ).toContain(MIKE_PHONE);
    expect(
      await xmlOf(await call("/api/twilio/voice?stage=backup", { DialCallStatus: "no-answer" }))
    ).toContain(BACKUP);

    // 9:40pm — a second tenant calls while Mike is still on.
    expect(await xmlOf(await call("/api/twilio/voice", { CallSid: "CA-2" }))).toContain(MIKE_PHONE);

    // Midnight — the calendar rolls over to Dana. No redeploy, no code change.
    calendarItems = [DANA];
    const nextNight = await xmlOf(await call("/api/twilio/voice", { CallSid: "CA-3" }));
    expect(nextNight).toContain(DANA_PHONE);
    expect(nextNight).not.toContain(MIKE_PHONE);
    expect(nextNight).toContain(`callerId="${MAIN_LINE}"`); // same number every single time

    expect(tokenRequests).toBe(1); // one Google login served the whole night
    expect(sentSms.map((sms) => sms.to)).toEqual([MIKE_PHONE, BACKUP, MIKE_PHONE, DANA_PHONE]);
  });
});
