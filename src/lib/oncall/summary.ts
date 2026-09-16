import Anthropic from "@anthropic-ai/sdk";

/**
 * A transcript, turned into the note that goes in an AppFolio work order.
 *
 * This is the one place in the project that uses a vendor SDK rather than
 * plain `fetch`. The reason the rest of the project avoids them — a function
 * with seconds to answer a ringing phone — does not apply here: nothing runs
 * until everyone has hung up.
 *
 * What it writes is deliberately narrow. A property manager reading this at
 * 8am wants four things: what broke, how urgent it sounded, what the resident
 * was told would happen, and what is still owed. Anything else is padding
 * between them and the work order.
 */

/** Long enough for any after-hours call; short enough that nothing rambles. */
const MAX_TOKENS = 2000;

const SYSTEM = [
  "You summarize after-hours maintenance calls for a Seattle apartment manager.",
  "You are writing for a property manager who will paste your summary into a work order the next morning.",
  "",
  "Rules:",
  "- Report only what was said. Never infer a cause, a cost, or a fix that nobody mentioned.",
  "- If something important was never established on the call — the unit, whether water is still running, whether anyone was home — say it was not established rather than guessing.",
  "- Transcription is imperfect. Where a word is clearly garbled, say what was probably meant and mark it uncertain rather than repeating nonsense.",
  "- Plain sentences. No greetings, no sign-off, no praise for the technician.",
].join("\n");

const SUMMARY_TOOL = {
  name: "file_call_summary",
  description: "File the summary of an after-hours maintenance call.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description:
          "Two to five sentences: what the resident reported, what the technician said, and how it was left. Past tense.",
      },
      urgency: {
        type: "string",
        enum: ["emergency", "same-night", "next-business-day", "informational"],
        description:
          "emergency = active flooding, gas, fire, no heat in freezing weather, a lockout, or anything the caller framed as dangerous. informational = a question or a non-issue.",
      },
      promised: {
        type: "string",
        description:
          "What the caller was told would happen, in their words if given — 'onsite within 45 minutes'. Empty string if nothing was promised.",
      },
      followUp: {
        type: "string",
        description:
          "What still has to happen, if anything: a unit to check, a vendor to call, damage to assess. Empty string if the call resolved it.",
      },
    },
    required: ["summary", "urgency", "promised", "followUp"],
    additionalProperties: false,
  },
};

export type CallSummary = {
  summary: string;
  urgency: "emergency" | "same-night" | "next-business-day" | "informational";
  promised: string;
  followUp: string;
};

export type SummaryResult =
  | { ok: true; summary: CallSummary; model: string }
  | { ok: false; error: string };

/** Where the call came from, so the summary can be specific about the unit. */
export type CallContext = {
  propertyName?: string | null;
  unit?: string | null;
  tenantName?: string | null;
};

function describe(context: CallContext): string {
  const place = [context.propertyName, context.unit ? `unit ${context.unit}` : null]
    .filter(Boolean)
    .join(", ");
  if (!place) return "The caller's unit was not matched in the tenant directory.";
  return context.tenantName
    ? `The call came from ${place} (${context.tenantName} on the lease).`
    : `The call came from ${place}.`;
}

/**
 * Never throws. A summary that cannot be written costs the reviewer nothing
 * they did not already have — the recording and the transcript are both still
 * there — so a failure is logged and the call is filed without one.
 */
export async function summarizeCall(
  config: { apiKey: string; model: string; baseUrl: string | null },
  transcript: string,
  context: CallContext = {}
): Promise<SummaryResult> {
  const words = transcript.trim();
  if (!words) return { ok: false, error: "empty transcript" };

  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });

  try {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: [SUMMARY_TOOL],
      messages: [
        {
          role: "user",
          content: `${describe(context)}\n\nTranscript:\n\n${words}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return { ok: false, error: "the model declined to summarize this call" };
    }

    const filed = response.content.find(
      (block) => block.type === "tool_use" && block.name === SUMMARY_TOOL.name
    );
    if (!filed || filed.type !== "tool_use") {
      return { ok: false, error: `no summary filed (stop_reason: ${response.stop_reason})` };
    }

    // `strict: true` guarantees the shape, but this is a parsed wire value
    // rather than something the compiler has seen.
    const input = filed.input as CallSummary;
    return { ok: true, summary: input, model: response.model };
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      return { ok: false, error: `Claude API error ${error.status}: ${error.message}` };
    }
    return { ok: false, error: String(error) };
  }
}

/** The summary as the block of text stored on the call and shown on /calls. */
export function summaryText(summary: CallSummary): string {
  const lines = [summary.summary.trim(), "", `Urgency: ${summary.urgency}`];
  if (summary.promised.trim()) lines.push(`Promised: ${summary.promised.trim()}`);
  if (summary.followUp.trim()) lines.push(`Follow-up: ${summary.followUp.trim()}`);
  return lines.join("\n");
}
