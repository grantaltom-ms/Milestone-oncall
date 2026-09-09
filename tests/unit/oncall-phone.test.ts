import { describe, it, expect } from "vitest";
import { findPhoneIn, formatUS, maskPhone, toE164 } from "@/lib/oncall/phone";

describe("toE164", () => {
  it("accepts the shapes a building manager actually types", () => {
    expect(toE164("2065551234")).toBe("+12065551234");
    expect(toE164("(206) 555-1234")).toBe("+12065551234");
    expect(toE164("206.555.1234")).toBe("+12065551234");
    expect(toE164("1-206-555-1234")).toBe("+12065551234");
    expect(toE164("+1 206 555 1234")).toBe("+12065551234");
    expect(toE164("  +12065551234  ")).toBe("+12065551234");
  });

  it("rejects anything that is not a dialable number", () => {
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164("555-1234")).toBeNull(); // no area code
    expect(toE164("ask the office")).toBeNull();
    expect(toE164("+0123456789")).toBeNull(); // country codes never start with 0
    expect(toE164("anonymous")).toBeNull(); // Twilio's value for a blocked caller
    expect(toE164("Restricted")).toBeNull();
  });

  it("keeps international numbers as given", () => {
    expect(toE164("+442071838750")).toBe("+442071838750");
  });
});

describe("findPhoneIn", () => {
  it("pulls the number out of a calendar entry written any which way", () => {
    expect(findPhoneIn("Mike Alvarez (206) 555-0134")).toBe("+12065550134");
    expect(findPhoneIn("On call — cell 206-555-0134, backup radio 4")).toBe("+12065550134");
    expect(findPhoneIn("+1 206 555 0134")).toBe("+12065550134");
  });

  it("skips numbers that cannot be dialed and finds the one that can", () => {
    expect(findPhoneIn("Unit 101-B, call 206 555 0134")).toBe("+12065550134");
    expect(findPhoneIn("Unit 101, apt 4")).toBeNull();
    expect(findPhoneIn("")).toBeNull();
    expect(findPhoneIn(undefined)).toBeNull();
  });
});

describe("formatUS / maskPhone", () => {
  it("formats for humans and masks for strangers", () => {
    expect(formatUS("+12065551234")).toBe("(206) 555-1234");
    expect(formatUS("+442071838750")).toBe("+442071838750");
    expect(formatUS(null)).toBe("unknown");
    expect(maskPhone("+12065551234")).toBe("•••-1234");
    expect(maskPhone(null)).toBeNull();
  });
});
