import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeCall, summaryText, type CallSummary } from "@/lib/oncall/summary";

/**
 * Turning a transcript into the note somebody pastes into a work order.
 *
 * The summary is a convenience sitting on top of the transcript, so every
 * failure path here has the same answer: say so, and let the call be filed
 * with the words but no summary. Nobody loses anything they had before.
 */

const CONFIG = { apiKey: "sk-ant-test", model: "claude-opus-5", baseUrl: "https://claude.test" };

const TRANSCRIPT = [
  "Resident: There's water coming through the ceiling in the back bedroom.",
  "Milestone: Is it still running? Can you shut the valve under the kitchen sink?",
  "Resident: Yes, I'll do that now.",
  "Milestone: I can be there within the hour.",
].join("\n");

const FILED: CallSummary = {
  summary: "Resident reported water through the back bedroom ceiling. Technician talked them through shutting the valve under the kitchen sink and said he would attend.",
  urgency: "emergency",
  promised: "onsite within the hour",
  followUp: "check the unit above for the source",
};

let requests: { url: string; body: Record<string, unknown> }[] = [];
let reply: () => Response;

const message = (content: unknown[], stopReason = "tool_use") =>
  Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 400, output_tokens: 120 },
  });

beforeEach(() => {
  requests = [];
  reply = () =>
    message([{ type: "tool_use", id: "toolu_1", name: "file_call_summary", input: FILED }]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const raw = init?.body ?? (input instanceof Request ? await input.text() : "");
      requests.push({ url, body: JSON.parse(String(raw || "{}")) });
      return reply();
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("summarizing a call", () => {
  it("returns what the model filed, and which model filed it", async () => {
    const result = await summarizeCall(CONFIG, TRANSCRIPT);
    expect(result).toEqual({ ok: true, summary: FILED, model: "claude-opus-5" });
  });

  it("tells the model which unit called, so the summary can name the address", async () => {
    await summarizeCall(CONFIG, TRANSCRIPT, {
      propertyName: "Willow Lake Apartments",
      unit: "V-12",
      tenantName: "Kovacs, Nadia",
    });

    const sent = String((requests[0].body.messages as { content: string }[])[0].content);
    expect(sent).toContain("Willow Lake Apartments, unit V-12");
    expect(sent).toContain("Kovacs, Nadia");
    expect(sent).toContain(TRANSCRIPT);
  });

  it("says plainly when the unit is unknown instead of leaving it out", async () => {
    await summarizeCall(CONFIG, TRANSCRIPT);
    const sent = String((requests[0].body.messages as { content: string }[])[0].content);
    expect(sent).toContain("not matched in the tenant directory");
  });

  it("asks for a schema the model cannot wander outside of", async () => {
    await summarizeCall(CONFIG, TRANSCRIPT);
    const tool = (requests[0].body.tools as Record<string, unknown>[])[0];
    expect(tool.strict).toBe(true);
    const schema = tool.input_schema as { required: string[]; additionalProperties: boolean };
    expect(schema.required).toEqual(["summary", "urgency", "promised", "followUp"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("tells the model not to invent what nobody said", async () => {
    await summarizeCall(CONFIG, TRANSCRIPT);
    const system = String(requests[0].body.system);
    expect(system).toContain("Report only what was said");
    expect(system).toContain("Transcription is imperfect");
  });

  it("does not call out at all for an empty transcript", async () => {
    expect(await summarizeCall(CONFIG, "   ")).toEqual({ ok: false, error: "empty transcript" });
    expect(requests).toHaveLength(0);
  });

  it("reports a refusal instead of storing a half-answer", async () => {
    reply = () => message([{ type: "text", text: "I can't help with that." }], "refusal");
    const result = await summarizeCall(CONFIG, TRANSCRIPT);
    expect(result).toMatchObject({ ok: false });
    expect(result).toHaveProperty("error", expect.stringContaining("declined"));
  });

  it("reports an answer with no summary in it", async () => {
    reply = () => message([{ type: "text", text: "Here you go" }], "end_turn");
    expect(await summarizeCall(CONFIG, TRANSCRIPT)).toMatchObject({ ok: false });
  });

  it("reports an API error rather than throwing into the webhook", async () => {
    reply = () => Response.json({ error: { message: "overloaded" } }, { status: 529 });
    const result = await summarizeCall(CONFIG, TRANSCRIPT);
    expect(result).toMatchObject({ ok: false });
    expect(result).toHaveProperty("error", expect.stringContaining("529"));
  });

  it("survives the network being down", async () => {
    reply = () => {
      throw new Error("ECONNRESET");
    };
    expect(await summarizeCall(CONFIG, TRANSCRIPT)).toMatchObject({ ok: false });
  });
});

describe("what gets stored", () => {
  it("leads with the sentences and keeps the rest labelled", () => {
    const text = summaryText(FILED);
    expect(text.startsWith(FILED.summary)).toBe(true);
    expect(text).toContain("Urgency: emergency");
    expect(text).toContain("Promised: onsite within the hour");
    expect(text).toContain("Follow-up: check the unit above for the source");
  });

  it("leaves out the lines there is nothing to say for", () => {
    const text = summaryText({ ...FILED, promised: "", followUp: "  " });
    expect(text).toContain("Urgency: emergency");
    expect(text).not.toContain("Promised:");
    expect(text).not.toContain("Follow-up:");
  });
});
