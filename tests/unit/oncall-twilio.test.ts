import { describe, it, expect, vi, afterEach } from "vitest";
import {
  candidateUrls,
  computeTwilioSignature,
  isValidTwilioRequest,
  readTwilioParams,
  sendSms,
} from "@/lib/oncall/twilio";
import { dial, escapeXml, record, say, twiml } from "@/lib/oncall/twiml";

afterEach(() => vi.unstubAllGlobals());

const TWILIO_EXAMPLE = {
  url: "https://mycompany.com/myapp.php?foo=1&bar=2",
  params: {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675309",
    Digits: "1234",
    From: "+14158675309",
    To: "+18005551212",
  },
  authToken: "12345",
};

describe("computeTwilioSignature", () => {
  it("matches the documented algorithm: the URL plus every parameter, sorted by name", () => {
    // Frozen vector — if this changes, real Twilio calls start returning 403.
    expect(
      computeTwilioSignature(TWILIO_EXAMPLE.url, TWILIO_EXAMPLE.params, TWILIO_EXAMPLE.authToken)
    ).toBe("RSOYDt4T1cUTdK1PDd93/VVr8B8=");
  });

  it("changes if the URL, any parameter, or the token changes", () => {
    const base = computeTwilioSignature(TWILIO_EXAMPLE.url, TWILIO_EXAMPLE.params, TWILIO_EXAMPLE.authToken);
    expect(computeTwilioSignature(`${TWILIO_EXAMPLE.url}&x=1`, TWILIO_EXAMPLE.params, TWILIO_EXAMPLE.authToken)).not.toBe(base);
    expect(computeTwilioSignature(TWILIO_EXAMPLE.url, { ...TWILIO_EXAMPLE.params, Digits: "9999" }, TWILIO_EXAMPLE.authToken)).not.toBe(base);
    expect(computeTwilioSignature(TWILIO_EXAMPLE.url, TWILIO_EXAMPLE.params, "54321")).not.toBe(base);
  });

  it("does not care what order the parameters arrive in", () => {
    const reversed = Object.fromEntries(Object.entries(TWILIO_EXAMPLE.params).reverse());
    expect(computeTwilioSignature(TWILIO_EXAMPLE.url, reversed, TWILIO_EXAMPLE.authToken)).toBe(
      computeTwilioSignature(TWILIO_EXAMPLE.url, TWILIO_EXAMPLE.params, TWILIO_EXAMPLE.authToken)
    );
  });
});

describe("isValidTwilioRequest", () => {
  const { url, params, authToken } = TWILIO_EXAMPLE;
  const good = computeTwilioSignature(url, params, authToken);

  it("accepts a genuine request and rejects everything else", () => {
    expect(isValidTwilioRequest([url], params, good, authToken)).toBe(true);
    expect(isValidTwilioRequest([url], params, null, authToken)).toBe(false);
    expect(isValidTwilioRequest([url], params, "not-a-signature", authToken)).toBe(false);
    expect(isValidTwilioRequest([url], { ...params, To: "+15005550006" }, good, authToken)).toBe(false);
    expect(isValidTwilioRequest(["https://evil.test/myapp.php"], params, good, authToken)).toBe(false);
  });

  it("accepts the request when any candidate URL matches", () => {
    expect(isValidTwilioRequest(["https://wrong.test/x", url], params, good, authToken)).toBe(true);
  });
});

describe("candidateUrls", () => {
  it("rebuilds the public https URL that Twilio actually signed", () => {
    const request = new Request("http://10.0.0.5:3000/api/twilio/voice?stage=backup", {
      headers: { "x-forwarded-host": "milestone.vercel.app", "x-forwarded-proto": "https" },
    });
    const urls = candidateUrls(request, "https://oncall.milestoneprop.com");
    expect(urls).toContain("https://milestone.vercel.app/api/twilio/voice?stage=backup");
    expect(urls).toContain("https://oncall.milestoneprop.com/api/twilio/voice?stage=backup");
    expect(urls).toContain("http://10.0.0.5:3000/api/twilio/voice?stage=backup");
  });
});

describe("readTwilioParams", () => {
  it("reads a Twilio form post, and survives a body that is not one", async () => {
    const form = new Request("https://x.test/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: "+12065550134", CallSid: "CA1" }),
    });
    await expect(readTwilioParams(form)).resolves.toEqual({ From: "+12065550134", CallSid: "CA1" });

    const junk = new Request("https://x.test/", { method: "POST", body: "not-a-form" });
    await expect(readTwilioParams(junk)).resolves.toEqual({});
  });
});

describe("sendSms", () => {
  const twilio = { accountSid: "AC123", authToken: "secret", apiBase: "https://api.test" };

  it("posts the message with basic auth", async () => {
    const fetchMock = vi.fn(async () => Response.json({ sid: "SM1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendSms(twilio, { to: "+12065550134", from: "+12065550100", body: "call from (206) 555-0199" })
    ).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/2010-04-01/Accounts/AC123/Messages.json");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("AC123:secret").toString("base64")}`
    );
    expect(String(init.body)).toBe(
      new URLSearchParams({
        To: "+12065550134",
        From: "+12065550100",
        Body: "call from (206) 555-0199",
      }).toString()
    );
  });

  it("never throws — a failed text must not drop the call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    await expect(sendSms(twilio, { to: "+1", from: "+2", body: "x" })).resolves.toMatchObject({ ok: false });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(sendSms(twilio, { to: "+1", from: "+2", body: "x" })).resolves.toMatchObject({ ok: false });
  });
});

describe("TwiML", () => {
  it("escapes anything a caller or calendar could inject", () => {
    expect(escapeXml(`Mike & "Dana" <on call>`)).toBe("Mike &amp; &quot;Dana&quot; &lt;on call&gt;");
    expect(say(`Unit 4 & 5`)).toBe("<Say>Unit 4 &amp; 5</Say>");
    expect(
      dial({ to: '+1206"evil', callerId: "+12065550100", timeoutSeconds: 25, action: "/a?b=1&c=2" })
    ).toContain('action="/a?b=1&amp;c=2"');
  });

  it("dials with the office caller ID, a ring timeout, and a next step", () => {
    const xml = twiml(
      dial({ to: "+12065550134", callerId: "+12065550100", timeoutSeconds: 25, action: "/api/twilio/voice?stage=backup" })
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Dial callerId="+12065550100" timeout="25" action="/api/twilio/voice?stage=backup" method="POST" answerOnBridge="true">' +
        "<Number>+12065550134</Number></Dial></Response>"
    );
  });

  it("always gives Record an action, so the greeting cannot loop forever", () => {
    expect(record({ action: "/api/twilio/voice?stage=goodbye" })).toContain(
      'action="/api/twilio/voice?stage=goodbye"'
    );
  });
});
