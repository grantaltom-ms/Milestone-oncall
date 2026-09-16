import { attachTranscript, getCallByRecording } from "@/lib/oncall/calls";
import { getOnCallConfig } from "@/lib/oncall/config";
import {
  COMPLETED,
  fetchSentences,
  fetchTranscript,
  RECORDING_SID,
  TRANSCRIPT_SID,
} from "@/lib/oncall/intelligence";
import { summarizeCall, summaryText } from "@/lib/oncall/summary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Twilio Conversational Intelligence posts here when a transcript is ready.
 * Point the Intelligence Service's webhook at this route.
 *
 * The one thing worth understanding about this route: **it does not believe
 * anything the request says.** Twilio does not document a signature on this
 * webhook, so the payload is treated as a nudge and nothing more — the
 * transcript SID is checked for shape, and then every fact used (the status,
 * which recording it belongs to, the words themselves) is read back from
 * Twilio over an authenticated request. A forged post can therefore cause one
 * wasted API call and nothing else: it cannot attach words to a call, because
 * the words never come from the post.
 */

/** The maximum a transcript can be before it is too long to summarize sensibly. */
const MAX_TRANSCRIPT_CHARS = 100_000;

/**
 * Twilio's Intelligence webhook can be configured as a GET or a POST, and the
 * body shape is not pinned down in the docs. Since nothing here is trusted
 * anyway, read the one field needed out of whichever form it arrives in rather
 * than break on a shape that was never promised.
 */
async function transcriptSidFrom(request: Request): Promise<string> {
  const fromQuery = new URL(request.url).searchParams.get("transcript_sid");
  if (fromQuery) return fromQuery;

  const raw = (await request.text().catch(() => "")).trim();
  if (!raw) return "";

  if (raw.startsWith("{")) {
    try {
      const json = JSON.parse(raw) as Record<string, unknown>;
      return String(json.transcript_sid ?? "");
    } catch {
      return "";
    }
  }
  return new URLSearchParams(raw).get("transcript_sid") ?? "";
}

export async function POST(request: Request) {
  const config = getOnCallConfig();
  const transcriptSid = await transcriptSidFrom(request);

  const log = (entry: Record<string, unknown>) =>
    console.log(JSON.stringify({ event: "oncall", stage: "transcript", transcriptSid, ...entry }));

  if (!config.twilio) {
    log({ skipped: "twilio_not_configured" });
    return new Response("Not configured", { status: 503 });
  }
  if (!TRANSCRIPT_SID.test(transcriptSid)) {
    log({ rejected: "not_a_transcript_sid" });
    return new Response("Not a transcript id", { status: 400 });
  }

  // Everything from here is Twilio's own answer to an authenticated request.
  const detail = await fetchTranscript(config.twilio, transcriptSid);
  if (!detail) {
    log({ rejected: "transcript_not_found" });
    return new Response("Unknown transcript", { status: 404 });
  }
  if (detail.status !== COMPLETED) {
    // Queued, in progress, or failed. Twilio posts again when it completes;
    // a failure has nothing to store and nothing to retry from here.
    log({ skipped: "not_completed", status: detail.status });
    return new Response(null, { status: 204 });
  }

  // The recording this transcript belongs to — set as the CustomerKey when we
  // asked for it, and read back here rather than taken from the request body.
  const recordingSid = detail.customerKey ?? "";
  if (!RECORDING_SID.test(recordingSid)) {
    log({ rejected: "no_recording_on_transcript" });
    return new Response(null, { status: 204 });
  }

  const transcript = await fetchSentences(config.twilio, transcriptSid);
  if (!transcript) {
    log({ skipped: "no_words" });
    return new Response(null, { status: 204 });
  }

  if (!config.supabase) {
    log({ logged: false, reason: "supabase_not_configured" });
    return new Response(null, { status: 204 });
  }

  // The summary is a convenience on top of the transcript, so a model that is
  // unreachable, slow or unwilling costs the reviewer nothing they did not
  // already have. The words are stored either way.
  // The unit this came from, so the summary can name the address instead of
  // saying "the caller". Absent is fine; the summary just stays vaguer.
  const call = await getCallByRecording(config.supabase, recordingSid);

  let summary: string | null = null;
  let summaryModel: string | null = null;
  if (config.anthropic && transcript.length <= MAX_TRANSCRIPT_CHARS) {
    const written = await summarizeCall(config.anthropic, transcript, {
      propertyName: call?.propertyName,
      unit: call?.unit,
      tenantName: call?.tenantName,
    });
    if (written.ok) {
      summary = summaryText(written.summary);
      summaryModel = written.model;
      log({ summarized: true, urgency: written.summary.urgency });
    } else {
      log({ summarized: false, error: written.error });
    }
  }

  const stored = await attachTranscript(config.supabase, recordingSid, {
    transcriptSid,
    transcript,
    summary,
    summaryModel,
  });

  log({ stored: stored.ok, error: stored.error, characters: transcript.length });
  return new Response(null, { status: 204 });
}
