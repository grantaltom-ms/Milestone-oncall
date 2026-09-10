import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The scheduling dashboard is behind a single shared password, kept in
 * ONCALL_DASHBOARD_PASSWORD. Signing in mints a cookie that is an expiry plus
 * an HMAC of that expiry keyed by the password — so the cookie cannot be forged
 * without the password, cannot be extended by editing it, and needs nothing
 * stored server-side.
 *
 * The password itself is never placed in the cookie, and changing it in the
 * environment invalidates every session immediately.
 */

export const SESSION_COOKIE = "oncall_schedule_session";
export const SESSION_HOURS = 12;

function sign(payload: string, password: string): string {
  return createHmac("sha256", password).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createSessionToken(password: string, now: Date = new Date()): string {
  const expiresAt = now.getTime() + SESSION_HOURS * 3_600_000;
  return `${expiresAt}.${sign(String(expiresAt), password)}`;
}

export function isValidSessionToken(
  token: string | undefined,
  password: string,
  now: Date = new Date()
): boolean {
  if (!token) return false;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return false;

  const expiresAt = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(sign(expiresAt, password), signature)) return false;

  const expiry = Number.parseInt(expiresAt, 10);
  return Number.isFinite(expiry) && expiry > now.getTime();
}

/** Constant-time password check, so a wrong guess reveals nothing by timing. */
export function isCorrectPassword(attempt: string, password: string): boolean {
  return safeEqual(sign(attempt, "login-check"), sign(password, "login-check"));
}
