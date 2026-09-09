import { createSign } from "node:crypto";
import type { GoogleConfig } from "./config";
import { findPhoneIn } from "./phone";

/**
 * Reads "who is on call right now" straight from a Google Calendar.
 *
 * Talks to Google over plain `fetch` with a service-account JWT rather than the
 * `googleapis` package: two HTTPS calls do not justify a 50 MB dependency in a
 * serverless function that has 15 seconds to answer a ringing phone.
 *
 * A shift is an ordinary calendar event whose title, location or description
 * contains the technician's phone number, e.g.
 *   "Mike Alvarez — on call"  /  location: 206-555-0134
 */

const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TOKEN_TIMEOUT_MS = 4000;
const EVENTS_TIMEOUT_MS = 4000;
/** Refresh a minute early: a token that expires mid-call is a dropped call. */
const EXPIRY_SKEW_SECONDS = 60;

export type OnCallLookup =
  | { found: true; name: string; phone: string; eventSummary: string }
  | {
      found: false;
      reason: "no_event" | "event_without_phone" | "auth_failed" | "calendar_error";
      detail?: string;
    };

type CachedToken = { key: string; token: string; expiresAt: number };
let cachedToken: CachedToken | null = null;

/** Test hook — clears the in-memory access token between cases. */
export function resetGoogleTokenCache() {
  cachedToken = null;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signedAssertion(google: GoogleConfig, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: google.serviceAccountEmail,
      scope: SCOPE,
      aud: google.tokenUrl,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    })
  );
  const signature = base64url(
    createSign("RSA-SHA256").update(`${header}.${claims}`).sign(google.privateKey)
  );
  return `${header}.${claims}.${signature}`;
}

export async function getAccessToken(google: GoogleConfig, now: Date = new Date()): Promise<string> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const key = `${google.serviceAccountEmail}|${google.tokenUrl}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > nowSeconds) {
    return cachedToken.token;
  }

  const response = await fetch(google.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedAssertion(google, nowSeconds),
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Google token request failed (${response.status})`);
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google token response had no access_token");

  cachedToken = {
    key,
    token: body.access_token,
    expiresAt: nowSeconds + (body.expires_in ?? 3600) - EXPIRY_SKEW_SECONDS,
  };
  return cachedToken.token;
}

type CalendarEvent = {
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
};

/** Strips the phone number out of a title so "Mike — 206-555-0134" reads as "Mike". */
function techName(event: CalendarEvent): string {
  const summary = (event.summary ?? "").replace(/\+?\d[\d().\-\s]{6,}\d/g, "").trim();
  return summary.replace(/[\s—–-]+$/, "").trim() || "the on-call technician";
}

export async function lookupOnCall(google: GoogleConfig, now: Date = new Date()): Promise<OnCallLookup> {
  let token: string;
  try {
    token = await getAccessToken(google, now);
  } catch (error) {
    return { found: false, reason: "auth_failed", detail: String(error) };
  }

  // Google returns every event overlapping [timeMin, timeMax), so a one-second
  // window asks exactly "whose shift covers this instant?".
  const url = new URL(
    `/calendar/v3/calendars/${encodeURIComponent(google.calendarId)}/events`,
    google.apiBase
  );
  url.searchParams.set("timeMin", new Date(now.getTime()).toISOString());
  url.searchParams.set("timeMax", new Date(now.getTime() + 1000).toISOString());
  url.searchParams.set("singleEvents", "true"); // expand repeating weekly shifts
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "10");

  let events: CalendarEvent[];
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(EVENTS_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { found: false, reason: "calendar_error", detail: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as { items?: CalendarEvent[] };
    events = body.items ?? [];
  } catch (error) {
    return { found: false, reason: "calendar_error", detail: String(error) };
  }

  const live = events.filter((event) => event.status !== "cancelled");
  if (live.length === 0) return { found: false, reason: "no_event" };

  for (const event of live) {
    // Location first: it is the field a manager is most likely to fill with
    // only a phone number, so it is the least ambiguous.
    const phone =
      findPhoneIn(event.location) ?? findPhoneIn(event.description) ?? findPhoneIn(event.summary);
    if (phone) {
      return { found: true, name: techName(event), phone, eventSummary: event.summary ?? "" };
    }
  }

  return {
    found: false,
    reason: "event_without_phone",
    detail: live[0].summary ?? "(untitled event)",
  };
}
