import type { TwilioConfig } from "./config";

/**
 * Twilio Conversational Intelligence: the recording Twilio already holds,
 * turned into words.
 *
 * Chosen over a dedicated transcription vendor for one reason — the audio
 * never leaves Twilio. At this call volume the price difference is a couple of
 * dollars a month, and a second company holding recordings of residents is a
 * thing that is easy to add and tedious to unwind.
 *
 * Two calls: ask for a transcript when the recording lands, then read it back
 * when Twilio says it is ready. Everything here runs after the call has ended,
 * so none of it is on the path of a ringing phone.
 */

const API_BASE = "https://intelligence.twilio.com/v2";
const TIMEOUT_MS = 10_000;

/** Twilio's identifiers, checked before either is put in a URL. */
export const RECORDING_SID = /^RE[0-9a-f]{32}$/i;
export const TRANSCRIPT_SID = /^GT[0-9a-f]{32}$/i;
export const SERVICE_SID = /^GA[0-9a-f]{32}$/i;

/** A transcript is only worth reading once Twilio says it finished. */
export const COMPLETED = "completed";

export type TranscriptRequest = { ok: true; transcriptSid: string } | { ok: false; error: string };

export type TranscriptDetail = {
  status: string;
  /** What we passed on creation — the recording SID, which is how we find our row. */
  customerKey: string | null;
  durationSeconds: number | null;
};

function auth(twilio: TwilioConfig): string {
  return `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64")}`;
}

function base(twilio: TwilioConfig): string {
  // Overridable so the end-to-end tests can point at a local stand-in.
  return twilio.intelligenceBase ?? API_BASE;
}

/**
 * Asks Twilio to transcribe a recording it already has.
 *
 * `CustomerKey` comes back on the webhook and on the transcript itself, so the
 * recording SID travels with the job and the finished transcript can find its
 * way back to the right call without us keeping any state in between.
 */
export async function requestTranscript(
  twilio: TwilioConfig,
  serviceSid: string,
  recordingSid: string
): Promise<TranscriptRequest> {
  if (!SERVICE_SID.test(serviceSid)) return { ok: false, error: "not an Intelligence Service SID" };
  if (!RECORDING_SID.test(recordingSid)) return { ok: false, error: "not a recording SID" };

  try {
    const response = await fetch(`${base(twilio)}/Transcripts`, {
      method: "POST",
      headers: {
        authorization: auth(twilio),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        ServiceSid: serviceSid,
        Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }),
        CustomerKey: recordingSid,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };

    const body = (await response.json()) as { sid?: string };
    return body.sid
      ? { ok: true, transcriptSid: body.sid }
      : { ok: false, error: "no transcript sid in the response" };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * The transcript's own record. Read before the sentences because this is where
 * `customer_key` comes from: the webhook carries one too, but the webhook is
 * not documented as signed, so the only `customer_key` worth trusting is the
 * one Twilio hands back over an authenticated request.
 */
export async function fetchTranscript(
  twilio: TwilioConfig,
  transcriptSid: string
): Promise<TranscriptDetail | null> {
  if (!TRANSCRIPT_SID.test(transcriptSid)) return null;

  try {
    const response = await fetch(`${base(twilio)}/Transcripts/${transcriptSid}`, {
      headers: { authorization: auth(twilio) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      status?: string;
      customer_key?: string | null;
      duration?: number | null;
    };
    return {
      status: body.status ?? "",
      customerKey: body.customer_key ?? null,
      durationSeconds: typeof body.duration === "number" ? body.duration : null,
    };
  } catch {
    return null;
  }
}

type Sentence = {
  transcript?: string;
  media_channel?: number;
  sentence_index?: number;
};

/**
 * A dual-channel recording puts each party on their own track, so who said
 * what needs no guessing: channel 1 is the leg that called in, channel 2 the
 * leg we dialed.
 */
function speaker(channel: number | undefined): string {
  if (channel === 1) return "Resident";
  if (channel === 2) return "Milestone";
  return "Speaker";
}

/**
 * The words, as one block of speaker-labelled text — the form both a person
 * and a model read best. Returns null when there is nothing usable, which is
 * treated the same as never having asked.
 */
export async function fetchSentences(
  twilio: TwilioConfig,
  transcriptSid: string
): Promise<string | null> {
  if (!TRANSCRIPT_SID.test(transcriptSid)) return null;

  const url = new URL(`${base(twilio)}/Transcripts/${transcriptSid}/Sentences`);
  // A 15-minute call is a few hundred sentences; one page covers any call this
  // line will ever take, and a second page of a 2am leak report is not a thing.
  url.searchParams.set("PageSize", "1000");

  try {
    const response = await fetch(url, {
      headers: { authorization: auth(twilio) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { sentences?: Sentence[] };
    const lines = (body.sentences ?? [])
      .slice()
      .sort((a, b) => (a.sentence_index ?? 0) - (b.sentence_index ?? 0))
      .map((sentence) => {
        const text = sentence.transcript?.trim();
        return text ? `${speaker(sentence.media_channel)}: ${text}` : null;
      })
      .filter((line): line is string => line !== null);

    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  }
}
