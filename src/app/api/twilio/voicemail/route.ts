import { logCall } from "@/lib/oncall/calls";
import { getOnCallConfig } from "@/lib/oncall/config";
import { formatUS, toE164 } from "@/lib/oncall/phone";
import { lookupCaller, type CallerLookup } from "@/lib/oncall/tenants";
import { readTwilioParams, rejectUnverified, sendSms, smsSender } from "@/lib/oncall/twilio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Twilio posts here once an after-hours voicemail finishes recording. It texts
 * the link to whoever is on the notify list so a message left at 2am is not
 * discovered at 9am — a voicemail nobody is told about is the same as a
 * dropped call — and files it in the call log for the morning review.
 */

/** Shorter than this and the caller hung up on the beep. */
const MIN_SECONDS = 2;

/** "Willow Lake #V-12" — enough to know whether to drive out before listening. */
function place(lookup: CallerLookup): string | null {
  if (lookup.matches.length !== 1) return null;
  const match = lookup.matches[0];
  return match.unit ? `${match.propertyName} #${match.unit}` : match.propertyName;
}

export async function POST(request: Request) {
  const config = getOnCallConfig();
  const params = await readTwilioParams(request);

  const rejected = rejectUnverified(request, config, params);
  if (rejected) return rejected;

  const recipients = config.voicemailNotify.length
    ? config.voicemailNotify
    : config.backupPhone
      ? [config.backupPhone]
      : [];

  const seconds = Number.parseInt(params.RecordingDuration ?? "0", 10) || 0;
  // Twilio's recording callback does not carry the caller, so the voice route
  // puts it in the query string; `params.From` covers the older callback shape.
  const from = toE164(new URL(request.url).searchParams.get("from") ?? params.From);
  const sender = smsSender(config);

  const lookup = config.supabase && config.callerLookup ? await lookupCaller(config.supabase, from) : null;
  const where = lookup ? place(lookup) : null;

  if (recipients.length && sender && seconds >= MIN_SECONDS) {
    const body =
      `${config.companyName} after-hours voicemail from ${from ? formatUS(from) : "an unknown number"} ` +
      `${where ? `(${where}, ${seconds}s)` : `(${seconds}s)`}: ${params.RecordingUrl ?? "recording unavailable"}` ;
    await Promise.all(
      recipients.map((to) => sendSms(sender.twilio, { to, from: sender.from, body }))
    );
  }

  if (config.supabase && seconds >= MIN_SECONDS) {
    await logCall(config.supabase, {
      callSid: params.CallSid ?? "",
      recordingSid: params.RecordingSid ?? null,
      recordingSeconds: seconds,
      kind: "voicemail",
      callerPhone: from,
      match: lookup?.matches.length === 1 ? lookup.matches[0] : null,
      matchCount: lookup?.matches.length ?? 0,
    });
  }

  console.log(
    JSON.stringify({
      event: "oncall",
      stage: "voicemail_recorded",
      callSid: params.CallSid ?? "",
      seconds,
      matched: lookup?.matches.length ?? null,
      notified: seconds >= MIN_SECONDS ? recipients.length : 0,
    })
  );

  return new Response(null, { status: 204 });
}
