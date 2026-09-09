import { getOnCallConfig } from "@/lib/oncall/config";
import { formatUS, toE164 } from "@/lib/oncall/phone";
import {
  candidateUrls,
  isValidTwilioRequest,
  readTwilioParams,
  sendSms,
  smsSender,
} from "@/lib/oncall/twilio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Twilio posts here once an after-hours voicemail finishes recording. It texts
 * the link to whoever is on the notify list so a message left at 2am is not
 * discovered at 9am — a voicemail nobody is told about is the same as a
 * dropped call.
 */
export async function POST(request: Request) {
  const config = getOnCallConfig();
  const params = await readTwilioParams(request);

  if (config.twilio) {
    const valid = isValidTwilioRequest(
      candidateUrls(request, config.publicBaseUrl),
      params,
      request.headers.get("x-twilio-signature"),
      config.twilio.authToken
    );
    if (!valid) return new Response("Invalid Twilio signature", { status: 403 });
  } else if (!config.allowUnsigned) {
    return new Response("Not configured", { status: 503 });
  }

  const recipients = config.voicemailNotify.length
    ? config.voicemailNotify
    : config.backupPhone
      ? [config.backupPhone]
      : [];

  const seconds = Number.parseInt(params.RecordingDuration ?? "0", 10) || 0;
  const from = toE164(params.From);
  const sender = smsSender(config);

  if (recipients.length && sender && seconds >= 2) {
    const body =
      `${config.companyName} after-hours voicemail from ${from ? formatUS(from) : "an unknown number"} ` +
      `(${seconds}s): ${params.RecordingUrl ?? "recording unavailable"}`;
    await Promise.all(
      recipients.map((to) => sendSms(sender.twilio, { to, from: sender.from, body }))
    );
  }

  console.log(
    JSON.stringify({
      event: "oncall",
      stage: "voicemail_recorded",
      callSid: params.CallSid ?? "",
      seconds,
      notified: seconds >= 2 ? recipients.length : 0,
    })
  );

  return new Response(null, { status: 204 });
}
