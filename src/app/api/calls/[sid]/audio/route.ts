import { getOnCallConfig } from "@/lib/oncall/config";
import { requireDashboard } from "@/lib/oncall/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Plays a recording back, through us rather than from Twilio directly.
 *
 * Twilio's media URL is either public or behind the account's own credentials,
 * and neither belongs in a browser: one would put a recording of a resident on
 * a guessable public URL, the other would put the account's auth token there.
 * So the audio is fetched server-side with those credentials and streamed on
 * to whoever holds a dashboard session — the same password that guards the
 * rotation.
 */

/** Twilio recording SIDs: RE followed by 32 hex characters, always. */
const RECORDING_SID = /^RE[0-9a-f]{32}$/i;

export async function GET(request: Request, ctx: { params: Promise<{ sid: string }> }) {
  const gate = await requireDashboard();
  if (!gate.ok) return gate.response;

  const { sid } = await ctx.params;
  if (!RECORDING_SID.test(sid)) {
    return Response.json({ error: "That is not a recording id." }, { status: 400 });
  }

  const { twilio } = getOnCallConfig();
  if (!twilio) {
    return Response.json({ error: "Twilio is not configured." }, { status: 503 });
  }

  // Built from the account and the SID rather than from anything stored, so a
  // tampered row in the log can never point this at someone else's server.
  const url = `${twilio.apiBase}/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Recordings/${sid}.mp3`;
  const range = request.headers.get("range");

  const upstream = await fetch(url, {
    headers: {
      authorization: `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64")}`,
      // Forwarded so dragging the scrub bar works instead of re-downloading.
      ...(range ? { range } : {}),
    },
  });

  if (!upstream.ok && upstream.status !== 206) {
    return Response.json(
      { error: `Twilio would not hand over that recording (HTTP ${upstream.status}).` },
      { status: upstream.status === 404 ? 404 : 502 }
    );
  }

  const headers = new Headers({
    "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
    "accept-ranges": "bytes",
    // A recording of a resident's call is never cached by a proxy or a CDN.
    "cache-control": "private, no-store",
  });
  for (const header of ["content-length", "content-range"]) {
    const value = upstream.headers.get(header);
    if (value) headers.set(header, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
