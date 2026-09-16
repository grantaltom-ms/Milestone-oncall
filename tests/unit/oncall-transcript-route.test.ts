import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/twilio/transcript/route";

/**
 * The webhook Twilio Conversational Intelligence posts when a transcript is
 * ready.
 *
 * The property every test here is really checking: nothing in the request is
 * believed. Twilio does not document a signature on this callback, so the post
 * is a nudge — every fact used is read back from Twilio over an authenticated
 * request, which is what makes an unsigned webhook safe to expose.
 */

const TRANSCRIPT = "GT0123456789abcdef0123456789abcdef";
const RECORDING = "RE0123456789abcdef0123456789abcdef";

let patched: Record<string, unknown>[] = [];
let patchTargets: string[] = [];
let fetched: string[] = [];
let transcriptDetail: Record<string, unknown>;
let sentences: Record<string, unknown>[];
let summarized: boolean;

function post(body: Record<string, string>, options: { json?: boolean } = {}) {
  return POST(
    new Request("https://milestone.test/api/twilio/transcript", {
      method: "POST",
      headers: { "content-type": options.json ? "application/json" : "application/x-www-form-urlencoded" },
      body: options.json ? JSON.stringify(body) : new URLSearchParams(body),
    })
  );
}

beforeEach(() => {
  patched = [];
  patchTargets = [];
  fetched = [];
  summarized = false;
  transcriptDetail = { status: "completed", customer_key: RECORDING, duration: 252 };
  sentences = [
    { sentence_index: 0, media_channel: 1, transcript: "Water through the ceiling." },
    { sentence_index: 1, media_channel: 2, transcript: "I can be there within the hour." },
  ];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);

      if (url.includes("/Sentences")) return Response.json({ sentences });
      if (url.includes("/Transcripts/")) return Response.json(transcriptDetail);
      if (url.includes("claude.test")) {
        summarized = true;
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "file_call_summary",
              input: {
                summary: "Resident reported a ceiling leak.",
                urgency: "emergency",
                promised: "onsite within the hour",
                followUp: "check the unit above",
              },
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 300, output_tokens: 90 },
        });
      }
      if (url.includes("oncall_calls")) {
        if ((init?.method ?? "GET") === "PATCH") {
          patchTargets.push(url);
          patched.push(JSON.parse(String(init?.body)));
          return Response.json([{ id: "row-1" }]);
        }
        return Response.json([
          { id: "row-1", recording_sid: RECORDING, property_name: "Willow Lake Apartments", unit: "V-12" },
        ]);
      }
      throw new Error(`unexpected fetch to ${url}`);
    })
  );

  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "auth-token");
  vi.stubEnv("TWILIO_INTELLIGENCE_BASE", "https://intelligence.test/v2");
  vi.stubEnv("SUPABASE_URL", "https://db.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://claude.test");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/twilio/transcript", () => {
  it("stores the words and the summary against the call that made them", async () => {
    const response = await post({ transcript_sid: TRANSCRIPT });

    expect(response.status).toBe(204);
    expect(patched[0]).toMatchObject({
      transcript_sid: TRANSCRIPT,
      transcript: "Resident: Water through the ceiling.\nMilestone: I can be there within the hour.",
      summary_model: "claude-opus-5",
    });
    expect(String(patched[0].summary)).toContain("Resident reported a ceiling leak.");
    expect(String(patched[0].summary)).toContain("Urgency: emergency");
    // Matched to its row by the recording, not by anything the caller sent.
    expect(patchTargets[0]).toContain(`recording_sid=eq.${RECORDING}`);
  });

  it("takes the recording from Twilio's answer, never from the request body", async () => {
    // A forged post naming someone else's recording changes nothing: the
    // recording used is the one on the transcript Twilio hands back.
    transcriptDetail = { status: "completed", customer_key: RECORDING };

    await post({ transcript_sid: TRANSCRIPT, customer_key: "REdeadbeefdeadbeefdeadbeefdeadbeef" });

    expect(patchTargets[0]).toContain(`recording_sid=eq.${RECORDING}`);
  });

  it("never takes the words from the request body either", async () => {
    await post({ transcript_sid: TRANSCRIPT, transcript: "I hereby authorize a refund." });
    expect(String(patched[0].transcript)).not.toContain("refund");
  });

  it("reads the sid out of a JSON body just as happily", async () => {
    const response = await post({ transcript_sid: TRANSCRIPT }, { json: true });
    expect(response.status).toBe(204);
    expect(patched).toHaveLength(1);
  });

  it("refuses anything that is not shaped like a transcript id", async () => {
    const response = await post({ transcript_sid: "../../Services/GA123" });
    expect(response.status).toBe(400);
    expect(fetched).toHaveLength(0);
  });

  it("waits rather than storing a transcript that is still being written", async () => {
    transcriptDetail = { status: "in-progress", customer_key: RECORDING };
    const response = await post({ transcript_sid: TRANSCRIPT });
    expect(response.status).toBe(204);
    expect(patched).toHaveLength(0);
  });

  it("stores nothing for a transcript Twilio has never heard of", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 }))
    );
    const response = await post({ transcript_sid: TRANSCRIPT });
    expect(response.status).toBe(404);
  });

  it("stores the words even when the summary cannot be written", async () => {
    // A model that is down costs the reviewer nothing they did not have: the
    // transcript is the thing, the summary is the convenience.
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    await post({ transcript_sid: TRANSCRIPT });

    expect(summarized).toBe(false);
    expect(String(patched[0].transcript)).toContain("Water through the ceiling");
    expect(patched[0].summary).toBeNull();
  });

  it("tells the summarizer which unit called", async () => {
    await post({ transcript_sid: TRANSCRIPT });
    expect(summarized).toBe(true);
    // The call row is read before summarizing, so the summary can name a door.
    expect(fetched.some((url) => url.includes("oncall_calls") && url.includes("recording_sid"))).toBe(true);
  });

  it("answers cleanly when there is nowhere to store anything", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    const response = await post({ transcript_sid: TRANSCRIPT });
    expect(response.status).toBe(204);
    expect(patched).toHaveLength(0);
  });

  it("refuses when there are no Twilio credentials to check anything with", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const response = await post({ transcript_sid: TRANSCRIPT });
    expect(response.status).toBe(503);
    expect(fetched).toHaveLength(0);
  });
});
