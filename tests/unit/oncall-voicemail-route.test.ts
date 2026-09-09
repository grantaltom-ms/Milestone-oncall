import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST } from "@/app/api/twilio/voicemail/route";
import { computeTwilioSignature } from "@/lib/oncall/twilio";

const AUTH_TOKEN = "test-auth-token";
let sentSms: { to: string; body: string }[] = [];

function callback(params: Record<string, string>, options: { signature?: string } = {}) {
  const url = "https://milestone.test/api/twilio/voicemail";
  const body = {
    CallSid: "CA-test",
    From: "+12065559876",
    RecordingUrl: "https://api.twilio.com/recordings/RE123",
    RecordingDuration: "42",
    ...params,
  };
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

beforeEach(() => {
  sentSms = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      sentSms.push({ to: form.get("To") ?? "", body: form.get("Body") ?? "" });
      return Response.json({ sid: "SM1" }, { status: 201 });
    })
  );
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  vi.stubEnv("TWILIO_API_BASE", "https://twilio.test");
  vi.stubEnv("TWILIO_MAIN_LINE", "+12065550100");
  vi.stubEnv("ONCALL_BACKUP_PHONE", "+12065550199");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/twilio/voicemail", () => {
  it("texts the backup manager a link the moment a message is left", async () => {
    const response = await callback({});
    expect(response.status).toBe(204);
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0].to).toBe("+12065550199");
    expect(sentSms[0].body).toContain("(206) 555-9876");
    expect(sentSms[0].body).toContain("https://api.twilio.com/recordings/RE123");
  });

  it("texts everyone on the notify list instead, when there is one", async () => {
    vi.stubEnv("ONCALL_VOICEMAIL_NOTIFY", "206-555-0134, (206) 555-0199");
    await callback({});
    expect(sentSms.map((sms) => sms.to)).toEqual(["+12065550134", "+12065550199"]);
  });

  it("ignores a one-second hang-up so nobody is woken for nothing", async () => {
    await callback({ RecordingDuration: "1" });
    expect(sentSms).toHaveLength(0);
  });

  it("rejects a callback that is not signed by Twilio", async () => {
    const response = await callback({}, { signature: "forged" });
    expect(response.status).toBe(403);
    expect(sentSms).toHaveLength(0);
  });
});
