import { getOnCallConfig, type OnCallConfig } from "@/lib/oncall/config";
import { formatUS, toE164 } from "@/lib/oncall/phone";
import { resolveDestination } from "@/lib/oncall/routing";
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
 * instead, since the caller ID no longer carries it.
 */

type Stage = "tech" | "backup" | "voicemail" | "goodbye";

const ANSWERED = new Set(["completed", "answered"]);

function log(entry: Record<string, unknown>) {
  console.log(JSON.stringify({ event: "oncall", ...entry }));
}

function stageUrl(stage: Stage, attempt?: number): string {
  const query = attempt ? `?stage=${stage}&attempt=${attempt}` : `?stage=${stage}`;
  return `/api/twilio/voice${query}`;
}

function voicemail(config: OnCallConfig): string {
  return twiml(
    say(
      `You have reached the ${config.companyName} after hours maintenance line. ` +
        "No one is available to take your call. Please leave your name, property, unit number, " +
        "and a description of the problem after the tone, and someone will call you back. " +
        "If this is a life threatening emergency, hang up and dial 9 1 1."
    ),
    record({ action: stageUrl("goodbye") })
  );
}

/**
 * The message texted to whoever is about to be rung. The number goes on its own
 * labelled line: this is read one-handed at 2am, and "call them back on this
 * number" in a text sent *from* the office line is exactly the wrong number to
 * reach the resident on. A line of its own also makes it tappable.
 *
 * Exported for tests — the wording is the product here, not an implementation
 * detail, and it is the one thing in the system a technician actually reads.
 */
export function incomingCallMessage(companyName: string, callerNumber: string | null): string {
  const opening = `${companyName} after-hours: maintenance call ringing you now.`;
  return callerNumber
    ? `${opening}\nResident callback: ${formatUS(callerNumber)}\nYour screen shows the office line, not the resident's.`
    : `${opening}\nResident's number came through blocked. Get a callback number on the call.`;
}

/**
 * Texts the person we are about to ring, because the caller ID they see is the
 * office line rather than the tenant's number.
 */
async function textIncomingCaller(
  config: OnCallConfig,
  to: string,
  callerNumber: string | null
): Promise<void> {
  const sender = smsSender(config);
  if (!sender) return;

  const body = incomingCallMessage(config.companyName, callerNumber);
  const result = await sendSms(sender.twilio, { to, from: sender.from, body });
  if (!result.ok) log({ stage: "sms", ok: false, to, error: result.error });
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
        : voicemail(config)
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
    return twimlResponse(voicemail(config));
  }

  if (stage === "backup") {
    if (!config.backupPhone) {
      log({ stage, callSid, note: "no_backup_configured" });
      return twimlResponse(voicemail(config));
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
    return twimlResponse(voicemail(config));
  }

  const { phone } = decision.destination;
  const isTech = decision.destination.kind === "tech";
  const nextAction =
    isTech && attempt < config.techAttempts
      ? stageUrl("tech", attempt + 1)
      : stageUrl(decision.destination.kind === "backup" ? "voicemail" : "backup");

  // Only text on the first attempt — a second buzz for the same call is noise.
  if (attempt === 1) await textIncomingCaller(config, phone, callerNumber);

  return twimlResponse(
    twiml(dial({ to: phone, callerId, timeoutSeconds: config.dialTimeoutSeconds, action: nextAction }))
  );
}
