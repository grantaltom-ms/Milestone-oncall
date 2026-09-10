import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { getAccessToken, lookupOnCall, READ_SCOPE, resetGoogleTokenCache } from "@/lib/oncall/calendar";
import type { GoogleConfig } from "@/lib/oncall/config";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const google: GoogleConfig = {
  serviceAccountEmail: "oncall@milestone.iam.gserviceaccount.com",
  privateKey,
  calendarId: "maintenance@milestoneprop.com",
  tokenUrl: "https://oauth.test/token",
  apiBase: "https://cal.test",
};

const NOW = new Date("2026-09-12T04:30:00Z"); // Fri 9:30pm Seattle

type CalendarItem = Record<string, unknown>;

/** Stands in for Google: hands out tokens and returns whatever shifts a test set. */
function mockGoogle(options: {
  items?: CalendarItem[];
  tokenStatus?: number;
  eventsStatus?: number;
  expiresIn?: number;
}) {
  const calls: { url: string; body?: string }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: init?.body ? String(init.body) : undefined });

    if (url.startsWith(google.tokenUrl)) {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return new Response("no", { status: options.tokenStatus });
      }
      return Response.json({
        access_token: `token-${calls.filter((c) => c.url.startsWith(google.tokenUrl)).length}`,
        expires_in: options.expiresIn ?? 3600,
      });
    }
    if (options.eventsStatus && options.eventsStatus !== 200) {
      return new Response("nope", { status: options.eventsStatus });
    }
    return Response.json({ items: options.items ?? [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

const decodeJwtPart = (part: string) =>
  JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

beforeEach(() => resetGoogleTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("getAccessToken", () => {
  it("signs a service-account JWT Google can actually verify", async () => {
    const { calls } = mockGoogle({});
    await getAccessToken(google, READ_SCOPE, NOW);

    const assertion = new URLSearchParams(calls[0].body).get("assertion")!;
    const [header, claims, signature] = assertion.split(".");

    expect(decodeJwtPart(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeJwtPart(claims)).toMatchObject({
      iss: google.serviceAccountEmail,
      scope: "https://www.googleapis.com/auth/calendar.readonly",
      aud: google.tokenUrl,
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 3600,
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${claims}`),
        createPublicKey(publicKey),
        Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64")
      )
    ).toBe(true);
  });

  it("reuses one token across a busy night, then refreshes it when it expires", async () => {
    const { calls } = mockGoogle({ items: [{ summary: "Mike", location: "206-555-0134" }], expiresIn: 3600 });

    // Three calls in the same hour: one token, three calendar reads.
    for (let minute = 0; minute < 3; minute++) {
      await lookupOnCall(google, new Date(NOW.getTime() + minute * 60_000));
    }
    expect(calls.filter((c) => c.url.startsWith(google.tokenUrl))).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith(google.apiBase))).toHaveLength(3);

    // A call an hour later needs a fresh token.
    await lookupOnCall(google, new Date(NOW.getTime() + 3600_000));
    expect(calls.filter((c) => c.url.startsWith(google.tokenUrl))).toHaveLength(2);
  });

  it("reports a rejected service account instead of hanging up on the tenant", async () => {
    mockGoogle({ tokenStatus: 401 });
    const result = await lookupOnCall(google, NOW);
    expect(result).toMatchObject({ found: false, reason: "auth_failed" });
  });
});

describe("lookupOnCall", () => {
  it("asks Google only for shifts covering this exact moment", async () => {
    const { calls } = mockGoogle({ items: [{ summary: "Mike", location: "206-555-0134" }] });
    await lookupOnCall(google, NOW);

    const url = new URL(calls[1].url);
    expect(url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(google.calendarId)}/events`);
    expect(url.searchParams.get("timeMin")).toBe(NOW.toISOString());
    expect(url.searchParams.get("timeMax")).toBe(new Date(NOW.getTime() + 1000).toISOString());
    expect(url.searchParams.get("singleEvents")).toBe("true"); // expands a repeating weekly shift
  });

  it("reads the phone number from wherever the manager put it", async () => {
    mockGoogle({ items: [{ summary: "Mike Alvarez on call", location: "(206) 555-0134" }] });
    await expect(lookupOnCall(google, NOW)).resolves.toMatchObject({
      found: true,
      name: "Mike Alvarez on call",
      phone: "+12065550134",
    });

    resetGoogleTokenCache();
    mockGoogle({ items: [{ summary: "Dana Kim", description: "cell 206.555.0175, radio 4" }] });
    await expect(lookupOnCall(google, NOW)).resolves.toMatchObject({ found: true, phone: "+12065550175" });

    resetGoogleTokenCache();
    mockGoogle({ items: [{ summary: "Luis Ortega — 2065550188" }] });
    await expect(lookupOnCall(google, NOW)).resolves.toMatchObject({
      found: true,
      name: "Luis Ortega",
      phone: "+12065550188",
    });
  });

  it("prefers location over description when both carry a number", async () => {
    mockGoogle({
      items: [{ summary: "On call", location: "206-555-0134", description: "office 206-555-0100" }],
    });
    await expect(lookupOnCall(google, NOW)).resolves.toMatchObject({ phone: "+12065550134" });
  });

  it("skips a cancelled shift and uses the one that is still on", async () => {
    mockGoogle({
      items: [
        { summary: "Mike", location: "206-555-0134", status: "cancelled" },
        { summary: "Dana", location: "206-555-0175" },
      ],
    });
    await expect(lookupOnCall(google, NOW)).resolves.toMatchObject({ found: true, phone: "+12065550175" });
  });

  it("says exactly what is wrong when nobody is on the calendar", async () => {
    mockGoogle({ items: [] });
    await expect(lookupOnCall(google, NOW)).resolves.toEqual({ found: false, reason: "no_event" });
  });

  it("names the shift that forgot a phone number, so it can be fixed", async () => {
    mockGoogle({ items: [{ summary: "Mike on call" }] });
    await expect(lookupOnCall(google, NOW)).resolves.toEqual({
      found: false,
      reason: "event_without_phone",
      detail: "Mike on call",
    });
  });

  it("treats a Google outage as a routing problem, not a crash", async () => {
    mockGoogle({ eventsStatus: 503 });
    await expect(lookupOnCall(google, NOW)).resolves.toMatchObject({
      found: false,
      reason: "calendar_error",
      detail: "HTTP 503",
    });
  });
});
