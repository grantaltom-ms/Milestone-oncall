import { getOnCallConfig, TWILIO_AUTH_TOKEN_LENGTH } from "@/lib/oncall/config";
import { maskPhone } from "@/lib/oncall/phone";
import { resolveDestination } from "@/lib/oncall/routing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Who picks up if a tenant calls right now?" — the same decision the phone
 * line makes, as JSON, for a dashboard, a morning check, or a Twilio Studio
 * flow that wants the number rather than the whole call flow.
 *
 * Full phone numbers require ONCALL_API_KEY (header `x-api-key` or `?key=`);
 * without it the answer is names and masked numbers only, so an open URL can
 * never hand out a technician's cell number.
 */
export async function GET(request: Request) {
  const config = getOnCallConfig();
  const url = new URL(request.url);
  const presented = request.headers.get("x-api-key") ?? url.searchParams.get("key");
  const authorized = Boolean(config.statusApiKey) && presented === config.statusApiKey;

  const now = new Date();
  const decision = await resolveDestination(now, config);
  const destination = decision.destination;
  const phone = destination.kind === "voicemail" ? null : destination.phone;

  const warnings: string[] = [];
  if (!config.mainLine) warnings.push("TWILIO_MAIN_LINE is not set — the caller ID falls back to the number the tenant dialed.");
  if (!config.twilio) warnings.push("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set — webhook signatures cannot be verified and no texts are sent.");
  if (config.twilio && config.twilio.authToken.length !== TWILIO_AUTH_TOKEN_LENGTH) {
    // A Twilio SID is two letters plus 32 hex — exactly 34 — so a 34-character
    // "auth token" is nearly always a SID pasted into the wrong field.
    const looksLikeSid = /^[A-Z]{2}[0-9a-f]{32}$/.test(config.twilio.authToken);
    warnings.push(
      (looksLikeSid
        ? `TWILIO_AUTH_TOKEN looks like a Twilio SID (it starts with "${config.twilio.authToken.slice(0, 2)}"), not an auth token. `
        : `TWILIO_AUTH_TOKEN is ${config.twilio.authToken.length} characters; a Twilio auth token is ${TWILIO_AUTH_TOKEN_LENGTH}. `) +
        "Every call is rejected as an invalid signature until this is corrected. The auth token is 32 hex characters with no letter prefix, " +
        "revealed by the show/hide toggle next to the Account SID on the Twilio Console home page."
    );
  }
  if (!config.google) warnings.push("Google Calendar is not configured — every after-hours call goes to the backup manager.");
  if (!config.backupPhone) warnings.push("ONCALL_BACKUP_PHONE is not set — an unanswered call goes straight to voicemail.");
  if (decision.lookup && !decision.lookup.found && decision.lookup.reason === "event_without_phone") {
    warnings.push(`A shift is on the calendar but has no phone number in it: "${decision.lookup.detail}".`);
  }
  if (!config.statusApiKey) warnings.push("ONCALL_API_KEY is not set — this endpoint will never show full phone numbers.");

  return Response.json({
    checked_at: now.toISOString(),
    local_time: decision.localLabel,
    timezone: config.timezone,
    after_hours: decision.onCallWindow,
    on_call_found: destination.kind === "tech",
    tech_name: destination.kind === "tech" ? destination.name : null,
    // Named `tech_phone` because that is what the Twilio Studio template reads.
    ...(authorized ? { tech_phone: phone } : {}),
    tech_phone_last4: maskPhone(phone),
    destination: destination.kind,
    reason: decision.reason,
    caller_id: authorized ? config.mainLine : maskPhone(config.mainLine),
    warnings,
  });
}
