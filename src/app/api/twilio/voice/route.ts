import { background } from "@/lib/oncall/background";
import { getOnCallConfig, type OnCallConfig } from "@/lib/oncall/config";
import { incomingCallMessage } from "@/lib/oncall/message";
import { toE164 } from "@/lib/oncall/phone";
import { resolveDestination } from "@/lib/oncall/routing";
import { lookupCaller, type CallerLookup } from "@/lib/oncall/tenants";
import {
  candidateUrls,
  isValidTwilioRequest,
  readTwilioParams,
  sendSms,
  signatureDiagnostics,
  smsSender,
} from "@/lib/oncall/twilio";
import { dial, hangup, record, say, twiml, twimlResponse } from "@/lib/oncall/twiml";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The after-hours maintenance line.
 *
 * Point the Twilio phone number's "A call comes in" webhook at
 * POST /api/twilio/voice and Twilio drives the whole escalation itself by
 * re-calling this route with a `stage`:
 *
 *   tech (attempt 1) → tech (attempt 2) → backup manager → voicemail → goodbye
 *
 * Every leg dials out with the office number as the caller ID, so a technician
 * sees the same number every single time and can set an Emergency Bypass /
 * Priority rule for it. The tenant's real number is texted to the technician
 * instead, along with the unit it belongs to, since the caller ID no longer
 * carries either.
 */

type Stage = "tech" | "backup" | "voicemail" | "goodbye";

const ANSWERED = new Set(["completed", "answered"]);

/** Both sides, on separate channels, starting only once somebody picks up. */
const RECORD_MODE = "record-from-answer-dual";

/**
 * Washington is an all-party consent state (RCW 9.73.030): everyone on a
 * recorded call has to be told. This plays to the resident before anything is
 * dialed; technicians are told in writing when they join the rotation. Nothing
 * is recorded at all unless ONCALL_RECORD_CALLS is turned on.
 */
const RECORDING_NOTICE = "This call will be recorded for maintenance records.";

function log(entry: Record<string, unknown>) {
  console.log(JSON.stringify({ event: "oncall", ...entry }));
}

function stageUrl(stage: Stage, attempt?: number): string {
  const query = attempt ? `?stage=${stage}&attempt=${attempt}` : `?stage=${stage}`;
  return `/api/twilio/voice${query}`;
}

/**
 * Twilio's recording callback carries the call SID and nothing about who was
 * on the call, so the caller ID rides along in the URL. Twilio signs the whole
 * URL, query string included, which is what keeps it from being forged.
 */
function withCaller(path: string, callerNumber: string | null): string {
  return callerNumber ? `${path}?from=${encodeURIComponent(callerNumber)}` : path;
}

/** The recording attributes for a `<Dial>`, or nothing at all when recording is off. */
function recordingFor(config: OnCallConfig, callerNumber: string | null) {
  if (!config.recordCalls) return {};
  return { record: RECORD_MODE, recordingStatusCallback: withCaller("/api/twilio/recording", callerNumber) };
}

function voicemail(config: OnCallConfig, callerNumber: string | null): string {
  return twiml(
    say(
      `You have reached the ${config.companyName} after hours maintenance line. ` +
        "No one is available to take your call. Please leave your name, property, unit number, " +
        "and a description of the problem after the tone, and someone will call you back. " +
        "If this is a life threatening emergency, hang up and dial 9 1 1."
    ),
    record({
      action: stageUrl("goodbye"),
      recordingStatusCallback: withCaller("/api/twilio/voicemail", callerNumber),
    })
  );
}

/** Who is calling, from the tenant directory — or null when there is nothing to ask. */
async function whoIsCalling(
  config: OnCallConfig,
  callerNumber: string | null
): Promise<CallerLookup | null> {
  if (!config.supabase || !config.callerLookup || !callerNumber) return null;
  return lookupCaller(config.supabase, callerNumber);
}

/**
 * Texts the person we are about to ring, because the caller ID they see is the
 * office line rather than the tenant's number.
 *
 * All of it — the directory lookup and the text itself — happens after the
 * TwiML has gone back to Twilio. Neither is worth a second of hold music, and
 * a directory that is slow or down must not delay a ringing phone.
 */
async function textIncomingCaller(
  config: OnCallConfig,
  to: string,
  callerNumber: string | null
): Promise<void> {
  const sender = smsSender(config);
  if (!sender) return;

  await background(async () => {
    const lookup = await whoIsCalling(config, callerNumber);
    if (lookup?.error) log({ stage: "lookup", ok: false, error: lookup.error });
    else if (lookup) log({ stage: "lookup", ok: true, matched: lookup.matches.length });

    const body = incomingCallMessage(config.companyName, callerNumber, lookup);
    const result = await sendSms(sender.twilio, { to, from: sender.from, body });
    if (!result.ok) log({ stage: "sms", ok: false, to, error: result.error });
  });
}

export async function POST(request: Request) {
  const config = getOnCallConfig();
  const params = await readTwilioParams(request);
  const url = new URL(request.url);
  const stage = (url.searchParams.get("stage") ?? "tech") as Stage;
  const attempt = Math.min(Math.max(Number.parseInt(url.searchParams.get("attempt") ?? "1", 10) || 1, 1), 3);

  const callSid = params.CallSid ?? "";
  const callerNumber = toE164(params.From);
  // Whatever the tenant dialed *is* the office line, so it is a safe caller ID
  // even before TWILIO_MAIN_LINE is set.
  const callerId = config.mainLine ?? toE164(params.To);

  if (config.twilio) {
    const urls = candidateUrls(request, config.publicBaseUrl);
    const signature = request.headers.get("x-twilio-signature");
    if (!isValidTwilioRequest(urls, params, signature, config.twilio.authToken)) {
      log({
        stage,
        callSid,
        rejected: "bad_signature",
        diagnostics: signatureDiagnostics(urls, params, signature, config.twilio.authToken),
      });
      return new Response("Invalid Twilio signature", { status: 403 });
    }
  } else if (!config.allowUnsigned) {
    // Nothing to verify the request with: still connect the caller to a human,
    // but never read the rotation out to an unauthenticated caller.
    log({ stage, callSid, rejected: "no_auth_token", fallback: Boolean(config.backupPhone) });
    return twimlResponse(
      config.backupPhone
        ? twiml(dial({
            to: config.backupPhone,
            callerId,
            timeoutSeconds: config.dialTimeoutSeconds,
            action: stageUrl("voicemail"),
          }))
        : voicemail(config, callerNumber)
    );
  }

  // Twilio calls the `action` URL when a dialed leg ends, including when it
  // ended because the two people finished talking. `DialCallStatus` is only
  // present on those callbacks, so this must be checked before any stage —
  // otherwise a second attempt would redial a technician who already answered.
  if (params.DialCallStatus && ANSWERED.has(params.DialCallStatus)) {
    log({ stage, callSid, dialStatus: params.DialCallStatus, note: "call_completed" });
    return twimlResponse(twiml(hangup()));
  }

  if (stage === "goodbye") {
    log({ stage, callSid, recordingDuration: params.RecordingDuration });
    return twimlResponse(twiml(say("Thank you. Your message has been received. Goodbye."), hangup()));
  }

  if (stage === "voicemail") {
    log({ stage, callSid, dialStatus: params.DialCallStatus });
    return twimlResponse(voicemail(config, callerNumber));
  }

  if (stage === "backup") {
    if (!config.backupPhone) {
      log({ stage, callSid, note: "no_backup_configured" });
      return twimlResponse(voicemail(config, callerNumber));
    }
    log({ stage, callSid, to: config.backupPhone, dialStatus: params.DialCallStatus });
    await textIncomingCaller(config, config.backupPhone, callerNumber);
    return twimlResponse(
      twiml(
        say("Still trying to reach the on call technician. Please hold."),
        dial({
          to: config.backupPhone,
          callerId,
          timeoutSeconds: config.dialTimeoutSeconds,
          action: stageUrl("voicemail"),
          ...recordingFor(config, callerNumber),
        })
      )
    );
  }

  // stage === "tech"
  const decision = await resolveDestination(new Date(), config);
  log({
    stage,
    attempt,
    callSid,
    from: callerNumber ?? "blocked",
    kind: decision.destination.kind,
    reason: decision.reason,
    localTime: decision.localLabel,
    onCallWindow: decision.onCallWindow,
    detail: decision.lookup && !decision.lookup.found ? decision.lookup.detail : undefined,
  });

  if (decision.destination.kind === "voicemail") {
    return twimlResponse(voicemail(config, callerNumber));
  }

  const { phone } = decision.destination;
  const isTech = decision.destination.kind === "tech";
  const nextAction =
    isTech && attempt < config.techAttempts
      ? stageUrl("tech", attempt + 1)
      : stageUrl(decision.destination.kind === "backup" ? "voicemail" : "backup");

  // Only text on the first attempt — a second buzz for the same call is noise.
  if (attempt === 1) await textIncomingCaller(config, phone, callerNumber);

  const connect = dial({
    to: phone,
    callerId,
    timeoutSeconds: config.dialTimeoutSeconds,
    action: nextAction,
    ...recordingFor(config, callerNumber),
  });

  // The consent announcement belongs on the first leg only: it is one notice
  // per call, not one per unanswered ring.
  return twimlResponse(
    config.recordCalls && attempt === 1
      ? twiml(say(RECORDING_NOTICE), connect)
      : twiml(connect)
  );
}
