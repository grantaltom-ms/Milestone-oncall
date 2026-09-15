import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/twilio/recording/route";
import { computeTwilioSignature } from "@/lib/oncall/twilio";

/**
 * The webhook Twilio posts once a recorded conversation ends. Everything it
 * does happens after the last person hung up, so unlike the voice route it is
 * allowed to be slow — but it is still handling a link to a recording of a
 * resident, so an unsigned request gets nothing.
 */

const AUTH_TOKEN = "test-auth-token";
const TENANT = "+12065559876";

let logged: Record<string, unknown>[] = [];
let logUrls: string[] = [];
let directoryRows: Record<string, unknown>[] = [];

function callback(
  params: Record<string, string> = {},
  options: { signature?: string; from?: string | null } = {}
) {
  const from = options.from === undefined ? TENANT : options.from;
  const url = `https://milestone.test/api/twilio/recording${from ? `?from=${encodeURIComponent(from)}` : ""}`;
  const body = {
    CallSid: "CA-test",
    RecordingSid: "RE0123456789abcdef0123456789abcdef",
    RecordingUrl: "https://api.twilio.com/recordings/RE0123456789abcdef0123456789abcdef",
    RecordingDuration: "252",
    RecordingStatus: "completed",
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
  logged = [];
  logUrls = [];
  directoryRows = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("oncall_caller_lookup")) return Response.json(directoryRows);
      if (url.includes("oncall_calls")) {
        logUrls.push(url);
        logged.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 201 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    })
  );
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
  vi.stubEnv("SUPABASE_URL", "https://db.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/twilio/recording", () => {
  it("files the call under the unit it came from", async () => {
    directoryRows = [
      { property_name: "Willow Lake Apartments", unit: "V - 12", tenant_name: "Kovacs, Nadia" },
    ];

    const response = await callback();

    expect(response.status).toBe(204);
    expect(logged[0]).toMatchObject({
      call_sid: "CA-test",
      recording_sid: "RE0123456789abcdef0123456789abcdef",
      recording_seconds: 252,
      kind: "call",
      caller_phone: TENANT,
      property_name: "Willow Lake Apartments",
      unit: "V - 12",
      tenant_name: "Kovacs, Nadia",
      match_count: 1,
    });
  });

  it("keeps the count but names no unit when the number covers several", async () => {
    // Guessing a unit here would send somebody to the wrong door tomorrow.
    directoryRows = [
      { property_name: "Willow Lake Apartments", unit: "V - 12", tenant_name: "Kovacs, Nadia" },
      { property_name: "Iron Ridge Apartments", unit: "4", tenant_name: "Lee, Sam" },
    ];
    await callback();
    expect(logged[0]).toMatchObject({ property_name: null, unit: null, match_count: 2 });
  });

  it("logs an unknown number as a call with no match", async () => {
    await callback();
    expect(logged[0]).toMatchObject({ caller_phone: TENANT, match_count: 0, property_name: null });
  });

  it("survives a caller ID that never reached the callback", async () => {
    await callback({}, { from: null });
    expect(logged[0]).toMatchObject({ caller_phone: null, match_count: 0 });
  });

  it("ignores a one-second recording, which is a hang-up", async () => {
    await callback({ RecordingDuration: "1" });
    expect(logged).toHaveLength(0);
  });

  it("lets Twilio retry without leaving two rows behind", async () => {
    await callback();
    await callback();
    // Both were accepted; the table merges them on the recording id.
    expect(logged).toHaveLength(2);
    expect(logUrls[0]).toContain("on_conflict=recording_sid");
  });

  it("refuses a callback that is not signed by Twilio", async () => {
    const response = await callback({}, { signature: "forged" });
    expect(response.status).toBe(403);
    expect(logged).toHaveLength(0);
  });

  it("refuses a callback when there is no auth token to check it against", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const response = await callback();
    expect(response.status).toBe(503);
    expect(logged).toHaveLength(0);
  });

  it("answers Twilio cleanly when there is nowhere to file the call", async () => {
    // The recording still exists in Twilio; a 500 here would only make Twilio
    // retry a write that has no table to land in.
    vi.stubEnv("SUPABASE_URL", "");
    const response = await callback();
    expect(response.status).toBe(204);
    expect(logged).toHaveLength(0);
  });
});
