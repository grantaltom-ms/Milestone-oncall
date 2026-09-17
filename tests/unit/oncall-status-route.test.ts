import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GET } from "@/app/api/oncall/status/route";
import { resetGoogleTokenCache } from "@/lib/oncall/calendar";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let calendarItems: Record<string, unknown>[] = [{ summary: "Mike Alvarez", location: "206-555-0134" }];

const status = (query = "", headers: Record<string, string> = {}) =>
  GET(new Request(`https://milestone.test/api/oncall/status${query}`, { headers }));

beforeEach(() => {
  calendarItems = [{ summary: "Mike Alvarez", location: "206-555-0134" }];
  resetGoogleTokenCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("oauth.test")) return Response.json({ access_token: "t", expires_in: 3600 });
      return Response.json({ items: calendarItems });
    })
  );
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
  vi.stubEnv("TWILIO_MAIN_LINE", "+12065550100");
  vi.stubEnv("ONCALL_BACKUP_PHONE", "+12065550199");
  vi.stubEnv("ONCALL_ALWAYS", "true");
  vi.stubEnv("ONCALL_API_KEY", "s3cret");
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", "oncall@milestone.iam.gserviceaccount.com");
  vi.stubEnv("GOOGLE_PRIVATE_KEY", privateKey.replace(/\n/g, "\\n"));
  vi.stubEnv("GOOGLE_CALENDAR_ID", "maintenance@milestoneprop.com");
  vi.stubEnv("GOOGLE_OAUTH_TOKEN_URL", "https://oauth.test/token");
  vi.stubEnv("GOOGLE_CALENDAR_API_BASE", "https://cal.test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/oncall/status", () => {
  it("names who is on call, but hides the number from anyone without the key", async () => {
    const body = await (await status()).json();
    expect(body).toMatchObject({
      on_call_found: true,
      tech_name: "Mike Alvarez",
      tech_phone_last4: "•••-0134",
      destination: "tech",
      reason: "calendar",
    });
    expect(body.tech_phone).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("2065550134");
  });

  it("gives the full number to a caller holding the key, by header or query", async () => {
    expect((await (await status("?key=s3cret")).json()).tech_phone).toBe("+12065550134");
    expect((await (await status("", { "x-api-key": "s3cret" })).json()).tech_phone).toBe("+12065550134");
    expect((await (await status("?key=wrong")).json()).tech_phone).toBeUndefined();
  });

  it("flags a shift that was added without a phone number", async () => {
    calendarItems = [{ summary: "Mike on call" }];
    const body = await (await status("?key=s3cret")).json();
    expect(body).toMatchObject({ on_call_found: false, destination: "backup", reason: "event_without_phone" });
    expect(body.warnings.join(" ")).toContain("Mike on call");
  });

  it("calls out a SID pasted into the auth token field, the way it actually happens", async () => {
    // Assembled rather than written out: a literal SID here is a real credential
    // shape, and secret scanning rightly refuses to let one into the repository.
    vi.stubEnv("TWILIO_AUTH_TOKEN", `AC${"0123456789abcdef".repeat(2)}`); // 34 chars: a SID
    const warnings: string[] = (await (await status()).json()).warnings;
    expect(warnings.join(" ")).toContain('looks like a Twilio SID (it starts with "AC")');
    expect(warnings.join(" ")).toContain("32 hex characters with no letter prefix");
  });

  it("flags a token of the wrong length even when it is not a SID", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "too-short");
    const warnings: string[] = (await (await status()).json()).warnings;
    expect(warnings.join(" ")).toContain("is 9 characters; a Twilio auth token is 32");
  });

  it("says nothing about a token of the right length", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "a".repeat(32));
    const warnings: string[] = (await (await status()).json()).warnings;
    expect(warnings.join(" ")).not.toContain("auth token is 32");
  });

  it("lists the settings that still need filling in", async () => {
    vi.stubEnv("TWILIO_MAIN_LINE", "");
    vi.stubEnv("ONCALL_BACKUP_PHONE", "");
    const warnings: string[] = (await (await status()).json()).warnings;
    expect(warnings.join(" ")).toContain("TWILIO_MAIN_LINE");
    expect(warnings.join(" ")).toContain("ONCALL_BACKUP_PHONE");
  });
});

describe("GET /api/oncall/status, on the transcription chain", () => {
  // Assembled rather than written out, for the same reason as the auth token
  // above: a literal SID is a credential shape secret scanning objects to.
  const validServiceSid = `GA${"0123456789abcdef".repeat(2)}`;

  const warningsFrom = async (): Promise<string> =>
    ((await (await status()).json()).warnings as string[]).join(" ");

  it("catches the newer product's configuration ID pasted in place of a Service SID", async () => {
    // The trap this guard exists for: both products sit in the same console
    // under near-identical names, and the wrong ID fails silently mid-call.
    vi.stubEnv("TWILIO_INTELLIGENCE_SERVICE_SID", "intelligence_configuration_01m2p59dwwe5s9fvf1c0prge4y");
    vi.stubEnv("ONCALL_RECORD_CALLS", "true");
    const body = await (await status()).json();
    expect(body.transcription).toBe("misconfigured");
    expect(body.warnings.join(" ")).toContain("Intelligence Configuration ID from the newer");
    expect(body.warnings.join(" ")).toContain('"GA" followed by 32 hex characters');
  });

  it("flags any other malformed SID without blaming the wrong product", async () => {
    vi.stubEnv("TWILIO_INTELLIGENCE_SERVICE_SID", "GA-not-hex");
    const warnings = await warningsFrom();
    expect(warnings).toContain("not shaped like a Service SID");
    expect(warnings).not.toContain("newer Conversation Intelligence");
  });

  it("says recordings go untranscribed when the Service SID is missing", async () => {
    vi.stubEnv("ONCALL_RECORD_CALLS", "true");
    const body = await (await status()).json();
    expect(body.transcription).toBe("off");
    expect(body.warnings.join(" ")).toContain("recorded but never transcribed");
  });

  it("says a Service with recording off will never be handed any audio", async () => {
    vi.stubEnv("TWILIO_INTELLIGENCE_SERVICE_SID", validServiceSid);
    const body = await (await status()).json();
    expect(body.transcription).toBe("no_recordings");
    expect(body.warnings.join(" ")).toContain("ONCALL_RECORD_CALLS is off");
  });

  it("separates a transcript with no summary from the finished article", async () => {
    vi.stubEnv("TWILIO_INTELLIGENCE_SERVICE_SID", validServiceSid);
    vi.stubEnv("ONCALL_RECORD_CALLS", "true");
    const withoutKey = await (await status()).json();
    expect(withoutKey.transcription).toBe("transcript_only");
    expect(withoutKey.warnings.join(" ")).toContain("transcribed but not summarized");

    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const withKey = await (await status()).json();
    expect(withKey.transcription).toBe("summarized");
  });

  it("stays quiet once the whole chain is set up, and mixed case still counts", async () => {
    // Twilio prints SIDs lowercase, but a SID copied out of an email or a
    // spreadsheet often arrives upper-cased; both are the same Service.
    vi.stubEnv("TWILIO_INTELLIGENCE_SERVICE_SID", validServiceSid.toUpperCase());
    vi.stubEnv("ONCALL_RECORD_CALLS", "true");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const body = await (await status()).json();
    expect(body.transcription).toBe("summarized");
    expect(body.warnings.join(" ")).not.toContain("TWILIO_INTELLIGENCE_SERVICE_SID");
    expect(body.warnings.join(" ")).not.toContain("ONCALL_RECORD_CALLS");
    expect(body.warnings.join(" ")).not.toContain("ANTHROPIC_API_KEY");
  });
});
