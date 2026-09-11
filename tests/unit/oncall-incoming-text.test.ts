import { describe, expect, it } from "vitest";
import { incomingCallMessage } from "../../src/app/api/twilio/voice/route";

/**
 * The one piece of writing in this system a technician actually reads, half
 * asleep, on a lock screen. Worth pinning down.
 */

const COMPANY = "Milestone Properties";

describe("the text sent as a technician's phone rings", () => {
  it("gives the resident's number in a form you can read and tap", () => {
    const body = incomingCallMessage(COMPANY, "+12065551234");
    expect(body).toContain("Resident callback: (206) 555-1234");
    // On its own line, so it is not buried mid-sentence.
    expect(body).toMatch(/\nResident callback: \(206\) 555-1234\n/);
  });

  it("never tells anyone to call back 'this number' ambiguously", () => {
    // The text arrives *from* the office line, so "call them back on this
    // number" reads as the sender — the one number that will not reach the
    // resident, since it routes straight back into the rotation.
    const body = incomingCallMessage(COMPANY, "+12065551234");
    expect(body).not.toContain("call the tenant back on this number");
    expect(body).toContain("not the resident's");
  });

  it("says what to do instead when the caller ID was blocked", () => {
    const body = incomingCallMessage(COMPANY, null);
    expect(body).toContain("came through blocked");
    expect(body).toContain("Get a callback number on the call");
    // The old wording pointed at a number that is not in the message at all.
    expect(body).not.toContain("this number");
  });

  it("names the company and says a call is ringing, either way", () => {
    for (const caller of ["+12065551234", null]) {
      const body = incomingCallMessage(COMPANY, caller);
      expect(body.startsWith(`${COMPANY} after-hours:`)).toBe(true);
      expect(body).toContain("ringing you now");
    }
  });

  it("stays inside a single SMS segment", () => {
    // Over 160 GSM-7 characters a carrier splits the message, and a split one
    // can arrive out of order — with the number in the half that lands second.
    for (const caller of ["+12065551234", null]) {
      expect(incomingCallMessage(COMPANY, caller).length).toBeLessThanOrEqual(160);
    }
  });

  it("uses only characters that fit a plain SMS", () => {
    // One curly apostrophe or en dash drops the whole message to the 70-char
    // unicode limit, which would split it without anything looking wrong here.
    const gsm7 = /^[A-Za-z0-9 \n@£$¥èéùìòÇØøÅå_^{}\\[~\]|€ÆæßÉÑÜñüà!"#¤%&'()*+,\-./:;<=>?§¡¿]*$/;
    for (const caller of ["+12065551234", null]) {
      expect(incomingCallMessage(COMPANY, caller)).toMatch(gsm7);
    }
  });
});
