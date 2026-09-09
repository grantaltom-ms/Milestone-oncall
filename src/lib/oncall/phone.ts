/**
 * Phone numbers arrive from three places that all format them differently:
 * a Google Calendar entry a building manager typed by hand, Twilio webhook
 * parameters, and Vercel environment variables. Everything downstream expects
 * E.164 (`+12065551234`), so normalize once, here.
 */

const E164 = /^\+[1-9]\d{7,14}$/;

/** Anonymous / withheld caller IDs Twilio passes through as the `From` value. */
const ANONYMOUS = new Set(["anonymous", "unknown", "restricted", "private", "unavailable"]);

export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || ANONYMOUS.has(trimmed.toLowerCase())) return null;

  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (plus) return E164.test(`+${digits}`) ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`; // 206 555 1234
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`; // 1 206 555 1234
  return null;
}

/**
 * Finds the first phone number inside free text — a calendar entry's location,
 * description or title, e.g. "Mike Alvarez (206) 555-0134".
 */
export function findPhoneIn(text: string | null | undefined): string | null {
  if (!text) return null;
  const candidates = text.match(/\+?\d[\d().\-\s]{6,}\d/g);
  if (!candidates) return null;
  for (const candidate of candidates) {
    const phone = toE164(candidate);
    if (phone) return phone;
  }
  return null;
}

/** `+12065551234` → `(206) 555-1234`, for text messages a human reads. */
export function formatUS(phone: string | null | undefined): string {
  if (!phone) return "unknown";
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}

/** `+12065551234` → `•••-1234`, so an unauthenticated status check leaks nothing. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return `•••-${phone.slice(-4)}`;
}
