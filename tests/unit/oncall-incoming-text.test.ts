import { describe, expect, it } from "vitest";
import { incomingCallMessage, SMS_LIMIT } from "@/lib/oncall/message";
import type { CallerLookup } from "@/lib/oncall/tenants";

/**
 * The one piece of writing in this system a technician actually reads, half
 * asleep, on a lock screen. Worth pinning down.
 */

const COMPANY = "Milestone Properties";
const TENANT = "+12065551234";

const found = (...matches: CallerLookup["matches"]): CallerLookup => ({ matches, error: null });
const willowLake = {
  propertyName: "Willow Lake Apartments",
  unit: "V - 12",
  tenantName: "Kovacs, Nadia",
};

describe("the text sent as a technician's phone rings", () => {
  it("gives the resident's number in a form you can read and tap", () => {
    const body = incomingCallMessage(COMPANY, TENANT);
    expect(body).toContain("Callback: (206) 555-1234");
    // On its own line, so it is not buried mid-sentence.
    expect(body).toMatch(/\nCallback: \(206\) 555-1234\n/);
  });

  it("never tells anyone to call back the number on their screen", () => {
    // The text arrives *from* the office line, so calling back what the handset
    // shows routes straight into this same rotation — back to the technician.
    const body = incomingCallMessage(COMPANY, TENANT);
    expect(body).toContain("Do not call back the number on your screen.");
  });

  it("says what to do instead when the caller ID was blocked", () => {
    const body = incomingCallMessage(COMPANY, null);
    expect(body).toContain("came through blocked");
    expect(body).toContain("Get a callback number on the call");
    // The old wording pointed at a number that is not in the message at all.
    expect(body).not.toContain("this number");
  });

  it("names the company and says a call is ringing, either way", () => {
    for (const caller of [TENANT, null]) {
      const body = incomingCallMessage(COMPANY, caller);
      expect(body.startsWith(`${COMPANY} after-hours`)).toBe(true);
      expect(body).toContain("ringing you now");
    }
  });
});

describe("the unit the call is coming from", () => {
  it("names the property, unit and resident when the directory matched one unit", () => {
    const body = incomingCallMessage(COMPANY, TENANT, found(willowLake));
    // "Apartments" is dropped, the padded unit label is tightened, and the
    // AppFolio "Last, First" is flipped round the way a person says it.
    expect(body).toContain("Willow Lake #V-12, Nadia Kovacs");
    expect(body).not.toContain("Apartments");
    expect(body).not.toContain("Kovacs, Nadia");
  });

  it("puts the unit above the callback number, where the eye lands first", () => {
    const lines = incomingCallMessage(COMPANY, TENANT, found(willowLake)).split("\n");
    expect(lines[1]).toBe("Willow Lake #V-12, Nadia Kovacs");
    expect(lines[2]).toBe("Callback: (206) 555-1234");
  });

  it("says plainly when the number is not in the directory", () => {
    const body = incomingCallMessage(COMPANY, TENANT, found());
    expect(body).toContain("Number not in the tenant directory.");
  });

  it("refuses to guess when one number covers more than one unit", () => {
    const body = incomingCallMessage(
      COMPANY,
      TENANT,
      found(willowLake, { propertyName: "Iron Ridge Apartments", unit: "4", tenantName: "Lee, Sam" })
    );
    expect(body).toContain("2 units share this number.");
    expect(body).not.toContain("Willow Lake");
  });

  it("stays quiet rather than lying when the directory could not be reached", () => {
    // "Not in the directory" and "the directory was down" mean opposite things
    // to whoever is deciding whether to drive out.
    const body = incomingCallMessage(COMPANY, TENANT, { matches: [], error: "HTTP 503" });
    expect(body).not.toContain("directory");
    expect(body).toContain("Callback: (206) 555-1234");
  });

  it("reads exactly as it did before the directory existed when there is no lookup", () => {
    expect(incomingCallMessage(COMPANY, TENANT, null)).toBe(
      incomingCallMessage(COMPANY, TENANT)
    );
  });

  it("gives up the resident's name before the unit, and the unit last of all", () => {
    const body = incomingCallMessage(COMPANY, TENANT, found({
      propertyName: "California Court Apartments",
      unit: "12",
      tenantName: "Vandenberghe-Whitfield, Christopher",
    }));
    // The name is initialed rather than dropped while there is room for it;
    // the unit and the number are what survive any squeeze.
    expect(body).toContain("California Court #12, Christopher V.");
    expect(body).toContain("Callback: (206) 555-1234");
    expect(body.length).toBeLessThanOrEqual(SMS_LIMIT);
  });
});

describe("what a carrier will actually deliver", () => {
  const lookups: (CallerLookup | null | undefined)[] = [
    undefined,
    null,
    found(),
    found(willowLake),
    found({ propertyName: "California Court Apartments", unit: "Storage Unit 12", tenantName: "Vandenberghe-Whitfield, Christopher Alexander" }),
    found(willowLake, { propertyName: "Iron Ridge Apartments", unit: "4", tenantName: "Lee, Sam" }),
    { matches: [], error: "boom" },
  ];

  it("stays inside a single SMS segment", () => {
    // Over 160 GSM-7 characters a carrier splits the message, and a split one
    // can arrive out of order — with the number in the half that lands second.
    for (const caller of [TENANT, null]) {
      for (const lookup of lookups) {
        expect(incomingCallMessage(COMPANY, caller, lookup).length).toBeLessThanOrEqual(SMS_LIMIT);
      }
    }
  });

  it("uses only characters that fit a plain SMS", () => {
    // One curly apostrophe or en dash drops the whole message to the 70-char
    // unicode limit, which would split it without anything looking wrong here.
    const gsm7 = /^[A-Za-z0-9 \n@£$¥èéùìòÇØøÅå_^{}\\[~\]|€ÆæßÉÑÜñüà!"#¤%&'()*+,\-./:;<=>?§¡¿]*$/;
    for (const caller of [TENANT, null]) {
      for (const lookup of lookups) {
        expect(incomingCallMessage(COMPANY, caller, lookup)).toMatch(gsm7);
      }
    }
  });

  it("survives a resident's name that is not plain ASCII", () => {
    // An accented letter is not in the GSM-7 alphabet: one of them halves the
    // segment to 70 characters and splits the message in two.
    const body = incomingCallMessage(COMPANY, TENANT, found({
      propertyName: "Beachcomber Apartments",
      unit: "3",
      tenantName: "García, José",
    }));
    expect(body).toContain("Jose Garcia");
    expect(body.length).toBeLessThanOrEqual(SMS_LIMIT);
  });

  it("keeps the callback number even behind an absurd company name", () => {
    const body = incomingCallMessage("M".repeat(300), TENANT, found(willowLake));
    expect(body).toContain("(206) 555-1234");
    expect(body.length).toBeLessThanOrEqual(SMS_LIMIT);
  });
});
