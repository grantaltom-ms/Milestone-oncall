import { logCall } from "@/lib/oncall/calls";
import { getOnCallConfig } from "@/lib/oncall/config";
import { requestTranscript } from "@/lib/oncall/intelligence";
import { toE164 } from "@/lib/oncall/phone";
import { lookupCaller } from "@/lib/oncall/tenants";
import { readTwilioParams, rejectUnverified } from "@/lib/oncall/twilio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Twilio posts here once a recorded conversation finishes, when
 * ONCALL_RECORD_CALLS is on. It writes the call to the log that /calls reads,
 * so the morning after an incident there is a recording to listen to and the
 * unit it came from, rather than a Twilio console full of bare phone numbers.
 *
 * It also asks Conversational Intelligence to transcribe the recording, if
 * that is configured. The words come back later, on /api/twilio/transcript.
 *
 * Nothing on a ringing phone depends on this route: it runs after everyone has
 * hung up, which is why it can afford to ask the directory who called.
 */

/** Below this a "recording" is a hang-up, and logging it is noise. */
const MIN_SECONDS = 2;

export async function POST(request: Request) {
  const config = getOnCallConfig();
  const params = await readTwilioParams(request);

  const rejected = rejectUnverified(request, config, params);
  if (rejected) return rejected;

  // The caller is in the URL because Twilio's recording callback does not
  // carry it; the signature check above covers the query string too.
  const caller = toE164(new URL(request.url).searchParams.get("from") ?? params.From);
  const seconds = Number.parseInt(params.RecordingDuration ?? "0", 10) || 0;
  const callSid = params.CallSid ?? "";
  const recordingSid = params.RecordingSid ?? null;

  const log = (entry: Record<string, unknown>) =>
    console.log(JSON.stringify({ event: "oncall", stage: "recorded", callSid, seconds, ...entry }));

  if (seconds < MIN_SECONDS) {
    log({ skipped: "too_short" });
    return new Response(null, { status: 204 });
  }

  if (!config.supabase) {
    // The recording still exists in Twilio; there is just nowhere to file it.
    log({ logged: false, reason: "supabase_not_configured" });
    return new Response(null, { status: 204 });
  }

  const lookup = await lookupCaller(config.supabase, caller);
  const result = await logCall(config.supabase, {
    callSid,
    recordingSid,
    recordingSeconds: seconds,
    kind: "call",
    callerPhone: caller,
    match: lookup.matches.length === 1 ? lookup.matches[0] : null,
    matchCount: lookup.matches.length,
  });

  log({ logged: result.ok, matched: lookup.matches.length, error: result.error });

  // Ask for the words. Only once the call is filed, so a transcript always has
  // a row waiting for it when it comes back minutes from now.
  if (result.ok && recordingSid && config.intelligenceServiceSid && config.twilio) {
    const asked = await requestTranscript(
      config.twilio,
      config.intelligenceServiceSid,
      recordingSid
    );
    log({
      stage: "transcribe_requested",
      ok: asked.ok,
      transcriptSid: asked.ok ? asked.transcriptSid : undefined,
      error: asked.ok ? undefined : asked.error,
    });
  }

  return new Response(null, { status: 204 });
}
