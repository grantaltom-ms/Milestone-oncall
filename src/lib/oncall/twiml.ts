/**
 * TwiML is the little XML script Twilio asks for each time something happens on
 * a call ("who do I ring next?"). Built by hand here rather than with the
 * `twilio` SDK — these are four verbs, and the SDK would be the heaviest
 * dependency in the project.
 */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attrs(pairs: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(pairs)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join("");
}

export function twiml(...verbs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join("")}</Response>`;
}

export function say(text: string): string {
  return `<Say>${escapeXml(text)}</Say>`;
}

export function hangup(): string {
  return "<Hangup/>";
}

export function dial(options: {
  to: string;
  callerId: string | null;
  timeoutSeconds: number;
  action: string;
}): string {
  // answerOnBridge keeps the tenant hearing a real ringing tone instead of
  // silence, and stops Twilio billing the leg as answered before anyone picks up.
  const dialAttrs = attrs({
    callerId: options.callerId,
    timeout: options.timeoutSeconds,
    action: options.action,
    method: "POST",
    answerOnBridge: "true",
  });
  return `<Dial${dialAttrs}><Number>${escapeXml(options.to)}</Number></Dial>`;
}

export function record(options: { action: string; maxLengthSeconds?: number }): string {
  return `<Record${attrs({
    action: options.action,
    method: "POST",
    maxLength: options.maxLengthSeconds ?? 180,
    playBeep: "true",
    trim: "trim-silence",
    // Without an explicit action Twilio re-requests the current URL and the
    // greeting plays forever.
    recordingStatusCallback: "/api/twilio/voicemail",
    recordingStatusCallbackEvent: "completed",
  })}/>`;
}

export function twimlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" },
  });
}
