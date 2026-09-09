import { toE164 } from "./phone";

/**
 * Every knob for the after-hours maintenance line, read fresh from the
 * environment on each call so a Vercel env change takes effect on the next
 * request (and so tests can set vars without reloading modules).
 *
 * Nothing here throws: a phone line that refuses to answer because a variable
 * is missing is worse than one that falls back to the backup manager, so
 * missing/invalid values become `null` and the caller decides what to do.
 */

export const DEFAULT_TIMEZONE = "America/Los_Angeles";
export const DEFAULT_EVENING_START_HOUR = 17; // 5:00 pm
export const DEFAULT_MORNING_END_HOUR = 8; // 8:00 am
export const DEFAULT_DIAL_TIMEOUT_SECONDS = 25;
export const DEFAULT_TECH_ATTEMPTS = 2;

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com";
export const TWILIO_API_BASE = "https://api.twilio.com";
/** Twilio auth tokens are 32 hex characters; any other length is a paste error. */
export const TWILIO_AUTH_TOKEN_LENGTH = 32;

export type GoogleConfig = {
  serviceAccountEmail: string;
  privateKey: string;
  calendarId: string;
  tokenUrl: string;
  apiBase: string;
};

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  apiBase: string;
};

export type OnCallConfig = {
  /** Caller ID every technician sees, so they can set an Emergency Bypass rule for it. */
  mainLine: string | null;
  /** Where business-hours calls go. Null means the rotation answers around the clock. */
  officePhone: string | null;
  /** Last human before voicemail — a manager who is always reachable. */
  backupPhone: string | null;
  /** SMS-capable number the "who is calling" text comes from. Defaults to the main line. */
  smsFrom: string | null;
  /** Numbers texted a link when a voicemail is left. */
  voicemailNotify: string[];
  timezone: string;
  eveningStartHour: number;
  morningEndHour: number;
  /** Saturday and Sunday belong to the on-call tech all day, not just after 5pm. */
  weekendAllDay: boolean;
  /** Send every call to the rotation, day or night. */
  alwaysOnCall: boolean;
  dialTimeoutSeconds: number;
  /** How many times the on-call tech's phone rings before the backup manager does. */
  techAttempts: number;
  google: GoogleConfig | null;
  twilio: TwilioConfig | null;
  /** Company name spoken in the voicemail greeting. */
  companyName: string;
  /** e.g. https://milestone-oncall.vercel.app — used to verify Twilio's signature behind a proxy. */
  publicBaseUrl: string | null;
  /** Shared secret required before /api/oncall/status will reveal full phone numbers. */
  statusApiKey: string | null;
  /** Local/CI escape hatch: answer webhooks that carry no Twilio signature. Never set in production. */
  allowUnsigned: boolean;
};

/**
 * Reads a setting, tolerating the way secrets get pasted into a dashboard:
 * surrounding quotes come along for the ride surprisingly often, and a quoted
 * auth token fails signature checks with no clue as to why. None of these
 * values legitimately begin and end with a quote.
 */
function env(name: string): string | null {
  const value = process.env[name]?.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  return value ? value : null;
}

function envPhone(name: string): string | null {
  const raw = env(name);
  return raw ? toE164(raw) : null;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (raw === undefined || raw === null) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function envPhoneList(name: string): string[] {
  const raw = env(name);
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => toE164(part))
    .filter((phone): phone is string => phone !== null);
}

/**
 * A Google service-account key arrives as one line with literal `\n` sequences
 * (that is how Vercel, and every other dashboard, stores a multi-line secret),
 * and sometimes wrapped in quotes. Both have to become real newlines before
 * Node will accept the key.
 */
export function normalizePrivateKey(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n");
}

export function getOnCallConfig(): OnCallConfig {
  const serviceAccountEmail = env("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = env("GOOGLE_PRIVATE_KEY");
  const calendarId = env("GOOGLE_CALENDAR_ID");

  const accountSid = env("TWILIO_ACCOUNT_SID");
  const authToken = env("TWILIO_AUTH_TOKEN");

  const mainLine = envPhone("TWILIO_MAIN_LINE");

  return {
    mainLine,
    officePhone: envPhone("ONCALL_OFFICE_PHONE"),
    backupPhone: envPhone("ONCALL_BACKUP_PHONE"),
    smsFrom: envPhone("ONCALL_SMS_FROM") ?? mainLine,
    voicemailNotify: envPhoneList("ONCALL_VOICEMAIL_NOTIFY"),
    timezone: env("ONCALL_TIMEZONE") ?? DEFAULT_TIMEZONE,
    eveningStartHour: envInt("ONCALL_EVENING_START_HOUR", DEFAULT_EVENING_START_HOUR, 0, 23),
    morningEndHour: envInt("ONCALL_MORNING_END_HOUR", DEFAULT_MORNING_END_HOUR, 0, 23),
    weekendAllDay: envBool("ONCALL_WEEKEND_ALL_DAY", true),
    alwaysOnCall: envBool("ONCALL_ALWAYS", false),
    dialTimeoutSeconds: envInt("ONCALL_DIAL_TIMEOUT", DEFAULT_DIAL_TIMEOUT_SECONDS, 5, 60),
    techAttempts: envInt("ONCALL_TECH_ATTEMPTS", DEFAULT_TECH_ATTEMPTS, 1, 3),
    google:
      serviceAccountEmail && privateKey && calendarId
        ? {
            serviceAccountEmail,
            privateKey: normalizePrivateKey(privateKey),
            calendarId,
            tokenUrl: env("GOOGLE_OAUTH_TOKEN_URL") ?? GOOGLE_TOKEN_URL,
            apiBase: env("GOOGLE_CALENDAR_API_BASE") ?? GOOGLE_CALENDAR_API_BASE,
          }
        : null,
    twilio:
      accountSid && authToken
        ? { accountSid, authToken, apiBase: env("TWILIO_API_BASE") ?? TWILIO_API_BASE }
        : null,
    companyName: env("ONCALL_COMPANY_NAME") ?? "Milestone Properties",
    publicBaseUrl: env("ONCALL_PUBLIC_BASE_URL")?.replace(/\/+$/, "") ?? null,
    statusApiKey: env("ONCALL_API_KEY"),
    allowUnsigned: envBool("ONCALL_ALLOW_UNSIGNED", false),
  };
}
