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

/**
 * Two scopes, deliberately. The phone line only ever reads, so the token it
 * holds cannot alter the rotation even if it leaked; the scheduling dashboard
 * asks separately for a write-capable token. They are cached independently.
 */
export const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
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

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

/** Test hook — clears the in-memory access tokens between cases. */
export function resetGoogleTokenCache() {
  tokenCache.clear();
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signedAssertion(google: GoogleConfig, scope: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: google.serviceAccountEmail,
      scope,
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

export async function getAccessToken(
  google: GoogleConfig,
  scope: string = READ_SCOPE,
  now: Date = new Date()
): Promise<string> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  // Scope is part of the key: a read token must never be handed to a writer.
  const key = `${google.serviceAccountEmail}|${google.tokenUrl}|${scope}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > nowSeconds) return cached.token;

  const response = await fetch(google.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedAssertion(google, scope, nowSeconds),
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Google token request failed (${response.status})`);
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google token response had no access_token");

  tokenCache.set(key, {
    token: body.access_token,
    expiresAt: nowSeconds + (body.expires_in ?? 3600) - EXPIRY_SKEW_SECONDS,
  });
  return body.access_token;
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
    token = await getAccessToken(google, READ_SCOPE, now);
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

/* ------------------------------------------------------------------------- *
 * Managing shifts
 *
 * The scheduling dashboard writes the same shape the router reads: the
 * technician's name is the event title and their number is the location. That
 * keeps the calendar the single source of truth — a shift added from the
 * dashboard and one typed into Google Calendar on a phone are the same thing,
 * and either can be edited from either place.
 * ------------------------------------------------------------------------- */

export type Shift = {
  id: string;
  techName: string;
  /** E.164, or null when the event was hand-written without a usable number. */
  phone: string | null;
  /** ISO 8601 with offset. */
  start: string;
  end: string;
};

export type ShiftInput = {
  techName: string;
  phone: string;
  start: string;
  end: string;
};

export class CalendarWriteError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "CalendarWriteError";
  }
}

function eventsUrl(google: GoogleConfig, suffix = ""): URL {
  return new URL(
    `/calendar/v3/calendars/${encodeURIComponent(google.calendarId)}/events${suffix}`,
    google.apiBase
  );
}

type ApiEvent = CalendarEvent & {
  id?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

function toShift(event: ApiEvent): Shift {
  return {
    id: event.id ?? "",
    techName: techName(event),
    phone:
      findPhoneIn(event.location) ?? findPhoneIn(event.description) ?? findPhoneIn(event.summary),
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
  };
}

async function calendarFetch(
  google: GoogleConfig,
  scope: string,
  url: URL,
  init: RequestInit = {}
): Promise<unknown> {
  let token: string;
  try {
    token = await getAccessToken(google, scope);
  } catch (error) {
    throw new CalendarWriteError(`Google rejected the service account: ${error}`, 502);
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(EVENTS_TIMEOUT_MS),
  });

  if (!response.ok) {
    // 403 here almost always means the calendar is shared read-only. Say so,
    // rather than making someone read Google's generic message.
    const hint =
      response.status === 403
        ? "Google refused the change. The calendar is most likely shared with the service account as " +
          '"See all event details" — it needs "Make changes to events".'
        : `Google Calendar returned HTTP ${response.status}.`;
    throw new CalendarWriteError(hint, response.status);
  }

  return response.status === 204 ? null : await response.json();
}

/** Every shift overlapping the window, earliest first. */
export async function listShifts(
  google: GoogleConfig,
  fromISO: string,
  toISO: string
): Promise<Shift[]> {
  const url = eventsUrl(google);
  url.searchParams.set("timeMin", fromISO);
  url.searchParams.set("timeMax", toISO);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "250");

  const body = (await calendarFetch(google, READ_SCOPE, url)) as { items?: ApiEvent[] };
  return (body.items ?? []).filter((event) => event.status !== "cancelled").map(toShift);
}

export async function createShift(google: GoogleConfig, shift: ShiftInput): Promise<Shift> {
  const created = (await calendarFetch(google, WRITE_SCOPE, eventsUrl(google), {
    method: "POST",
    body: JSON.stringify({
      summary: shift.techName,
      location: shift.phone,
      description: "On-call shift. The phone line reads the title as the name and the location as the number.",
      start: { dateTime: shift.start },
      end: { dateTime: shift.end },
      transparency: "transparent",
    }),
  })) as ApiEvent;
  return toShift(created);
}

export async function updateShift(
  google: GoogleConfig,
  id: string,
  shift: ShiftInput
): Promise<Shift> {
  const updated = (await calendarFetch(
    google,
    WRITE_SCOPE,
    eventsUrl(google, `/${encodeURIComponent(id)}`),
    {
      method: "PATCH",
      body: JSON.stringify({
        summary: shift.techName,
        location: shift.phone,
        start: { dateTime: shift.start },
        end: { dateTime: shift.end },
      }),
    }
  )) as ApiEvent;
  return toShift(updated);
}

export async function deleteShift(google: GoogleConfig, id: string): Promise<void> {
  await calendarFetch(google, WRITE_SCOPE, eventsUrl(google, `/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
}
