import {
  getOnCallConfig,
  INTELLIGENCE_CONFIGURATION_PREFIX,
  INTELLIGENCE_SERVICE_SID_PATTERN,
  TWILIO_AUTH_TOKEN_LENGTH,
  type OnCallConfig,
} from "@/lib/oncall/config";
import { maskPhone } from "@/lib/oncall/phone";
import { resolveDestination } from "@/lib/oncall/routing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * How far a recorded call actually gets: audio, then words, then a note a
 * person can paste. Reported as one word so "did my change land?" has an
 * answer that does not require placing a real call to find out.
 */
function transcriptionState(config: OnCallConfig): string {
  const sid = config.intelligenceServiceSid;
  if (!sid) return "off";
  if (!INTELLIGENCE_SERVICE_SID_PATTERN.test(sid)) return "misconfigured";
  if (!config.recordCalls) return "no_recordings";
  return config.anthropic ? "summarized" : "transcript_only";
}

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

  // Transcription is a chain — audio, a Service to send it to, a key to write up
  // what comes back — and every link of it fails quietly on its own.
  const serviceSid = config.intelligenceServiceSid;
  if (serviceSid && !INTELLIGENCE_SERVICE_SID_PATTERN.test(serviceSid)) {
    warnings.push(
      (serviceSid.startsWith(INTELLIGENCE_CONFIGURATION_PREFIX)
        ? "TWILIO_INTELLIGENCE_SERVICE_SID holds an Intelligence Configuration ID from the newer Conversation Intelligence. This app speaks to Conversation Intelligence (classic), a separate product with its own console section and its own Services. "
        : "TWILIO_INTELLIGENCE_SERVICE_SID is not shaped like a Service SID. ") +
        'A classic Service SID is "GA" followed by 32 hex characters, created under Conversation Intelligence (classic) → Services. No call is transcribed until this is corrected.'
    );
  }
  if (config.recordCalls && !serviceSid) {
    warnings.push(
      "TWILIO_INTELLIGENCE_SERVICE_SID is not set — calls are recorded but never transcribed, so the call log holds audio somebody still has to sit and listen to."
    );
  }
  if (serviceSid && !config.recordCalls) {
    warnings.push(
      "ONCALL_RECORD_CALLS is off — there is no audio for the Intelligence Service to work from, so no transcript is ever requested."
    );
  }
  if (serviceSid && config.recordCalls && !config.anthropic) {
    warnings.push(
      "ANTHROPIC_API_KEY is not set — calls are transcribed but not summarized, so the call log shows the whole transcript and no note to paste."
    );
  }

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
    transcription: transcriptionState(config),
    caller_id: authorized ? config.mainLine : maskPhone(config.mainLine),
    warnings,
  });
}
