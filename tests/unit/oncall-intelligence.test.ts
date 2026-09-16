import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSentences, fetchTranscript, requestTranscript } from "@/lib/oncall/intelligence";

/**
 * The Conversational Intelligence client. The rule running through all of it:
 * an identifier is checked for shape before it goes anywhere near a URL, and a
 * failure is reported rather than thrown.
 */

const TWILIO = {
  accountSid: "AC-test",
  authToken: "auth-token",
  apiBase: "https://twilio.test",
  intelligenceBase: "https://intelligence.test/v2",
};

const SERVICE = "GA0123456789abcdef0123456789abcdef";
const RECORDING = "RE0123456789abcdef0123456789abcdef";
const TRANSCRIPT = "GTfedcba9876543210fedcba9876543210";

type Call = { url: string; method: string; body: string; auth: string };

let calls: Call[] = [];
let respond: (url: string) => Response;

beforeEach(() => {
  calls = [];
  respond = () => Response.json({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
        auth: String((init?.headers as Record<string, string>)?.authorization ?? ""),
      });
      return respond(url);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("asking for a transcript", () => {
  it("sends the recording as both the media source and the key to find it by", async () => {
    respond = () => Response.json({ sid: TRANSCRIPT, status: "queued" });

    const result = await requestTranscript(TWILIO, SERVICE, RECORDING);

    expect(result).toEqual({ ok: true, transcriptSid: TRANSCRIPT });
    const form = new URLSearchParams(calls[0].body);
    expect(calls[0].url).toBe("https://intelligence.test/v2/Transcripts");
    expect(form.get("ServiceSid")).toBe(SERVICE);
    expect(JSON.parse(form.get("Channel") ?? "{}")).toEqual({
      media_properties: { source_sid: RECORDING },
    });
    // The CustomerKey is what lets the finished transcript find its call again.
    expect(form.get("CustomerKey")).toBe(RECORDING);
    expect(calls[0].auth.startsWith("Basic ")).toBe(true);
  });

  it("refuses identifiers that are not what they claim to be", async () => {
    expect(await requestTranscript(TWILIO, "not-a-service", RECORDING)).toMatchObject({ ok: false });
    expect(await requestTranscript(TWILIO, SERVICE, "../../etc/passwd")).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("reports a refusal from Twilio rather than throwing", async () => {
    respond = () => new Response("nope", { status: 400 });
    expect(await requestTranscript(TWILIO, SERVICE, RECORDING)).toEqual({
      ok: false,
      error: "HTTP 400",
    });
  });

  it("survives the network being down", async () => {
    respond = () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await requestTranscript(TWILIO, SERVICE, RECORDING)).toMatchObject({ ok: false });
  });
});

describe("reading a transcript back", () => {
  it("reports the status and the recording it belongs to", async () => {
    respond = () =>
      Response.json({ sid: TRANSCRIPT, status: "completed", customer_key: RECORDING, duration: 252 });

    expect(await fetchTranscript(TWILIO, TRANSCRIPT)).toEqual({
      status: "completed",
      customerKey: RECORDING,
      durationSeconds: 252,
    });
  });

  it("will not fetch something shaped like a path traversal", async () => {
    expect(await fetchTranscript(TWILIO, "../Services")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns nothing when Twilio does not know the transcript", async () => {
    respond = () => new Response("", { status: 404 });
    expect(await fetchTranscript(TWILIO, TRANSCRIPT)).toBeNull();
  });
});

describe("the words themselves", () => {
  const sentences = (items: Record<string, unknown>[]) => () => Response.json({ sentences: items });

  it("labels each side from the channel it was recorded on", async () => {
    // Dual-channel recording means who spoke is a fact, not a guess.
    respond = sentences([
      { sentence_index: 0, media_channel: 1, transcript: "There's water coming through the ceiling." },
      { sentence_index: 1, media_channel: 2, transcript: "Is it still running now?" },
      { sentence_index: 2, media_channel: 1, transcript: "Yes, it's getting worse." },
    ]);

    expect(await fetchSentences(TWILIO, TRANSCRIPT)).toBe(
      [
        "Resident: There's water coming through the ceiling.",
        "Milestone: Is it still running now?",
        "Resident: Yes, it's getting worse.",
      ].join("\n")
    );
  });

  it("puts the call back in order, whatever order the API returned", async () => {
    respond = sentences([
      { sentence_index: 2, media_channel: 1, transcript: "third" },
      { sentence_index: 0, media_channel: 1, transcript: "first" },
      { sentence_index: 1, media_channel: 2, transcript: "second" },
    ]);
    const transcript = await fetchSentences(TWILIO, TRANSCRIPT);
    expect(transcript).toBe("Resident: first\nMilestone: second\nResident: third");
  });

  it("asks for the whole call in one page", async () => {
    respond = sentences([]);
    await fetchSentences(TWILIO, TRANSCRIPT);
    expect(new URL(calls[0].url).searchParams.get("PageSize")).toBe("1000");
  });

  it("gives back nothing rather than an empty shell when nobody spoke", async () => {
    respond = sentences([{ sentence_index: 0, media_channel: 1, transcript: "   " }]);
    expect(await fetchSentences(TWILIO, TRANSCRIPT)).toBeNull();
  });

  it("does not label a channel it was not given", async () => {
    respond = sentences([{ sentence_index: 0, transcript: "hello" }]);
    expect(await fetchSentences(TWILIO, TRANSCRIPT)).toBe("Speaker: hello");
  });
});
