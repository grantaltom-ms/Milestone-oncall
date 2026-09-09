import { createHmac, timingSafeEqual } from "node:crypto";
import type { OnCallConfig, TwilioConfig } from "./config";

/** Twilio waits ~15s for TwiML; a text message must never be what makes it late. */
const SMS_TIMEOUT_MS = 2500;

/**
 * Twilio signs every webhook with the account's auth token: the signature is an
 * HMAC-SHA1 of the exact URL it called plus every POST parameter, sorted by
 * name and concatenated. Recomputing it proves the request really came from
 * Twilio and not from someone probing the endpoint for technicians' cell
 * numbers.
 */
export function computeTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(payload, "utf-8")).digest("base64");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Vercel terminates TLS in front of the function, so `request.url` can arrive
 * as http://, or with an internal host — neither matches what Twilio signed.
 * Rebuild the public URL from the forwarded headers, and also try the
 * explicitly configured base URL if there is one.
 */
export function candidateUrls(request: Request, publicBaseUrl: string | null): string[] {
  const requested = new URL(request.url);
  const urls = new Set<string>();

  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) {
    urls.add(`${forwardedProto}://${forwardedHost}${requested.pathname}${requested.search}`);
  }
  if (publicBaseUrl) {
    urls.add(`${publicBaseUrl}${requested.pathname}${requested.search}`);
  }
  urls.add(request.url);
  return [...urls];
}

export function isValidTwilioRequest(
  urls: string[],
  params: Record<string, string>,
  signature: string | null,
  authToken: string
): boolean {
  if (!signature) return false;
  return urls.some((url) => safeEqual(computeTwilioSignature(url, params, authToken), signature));
}

export async function sendSms(
  twilio: TwilioConfig,
  message: { to: string; from: string; body: string }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${twilio.apiBase}/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: message.to, From: message.from, Body: message.body }),
        signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    // A failed text must never take the call down with it.
    return { ok: false, error: String(error) };
  }
}

/** Reads a Twilio webhook body into a plain object (Twilio always posts a form). */
export async function readTwilioParams(request: Request): Promise<Record<string, string>> {
  const form = await request.formData().catch(() => null);
  if (!form) return {};
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
}

export function smsSender(config: OnCallConfig): { twilio: TwilioConfig; from: string } | null {
  if (!config.twilio || !config.smsFrom) return null;
  return { twilio: config.twilio, from: config.smsFrom };
}
