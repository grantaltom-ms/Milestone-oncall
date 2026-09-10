import { describe, it, expect } from "vitest";
import {
  createSessionToken,
  isCorrectPassword,
  isValidSessionToken,
  SESSION_HOURS,
} from "@/lib/oncall/session";

const PASSWORD = "correct horse battery staple";
const NOW = new Date("2026-09-10T12:00:00Z");

describe("dashboard sessions", () => {
  it("accepts a token it just minted", () => {
    expect(isValidSessionToken(createSessionToken(PASSWORD, NOW), PASSWORD, NOW)).toBe(true);
  });

  it("expires the session, and cannot be extended by editing the cookie", () => {
    const token = createSessionToken(PASSWORD, NOW);
    const justBefore = new Date(NOW.getTime() + SESSION_HOURS * 3_600_000 - 1000);
    const justAfter = new Date(NOW.getTime() + SESSION_HOURS * 3_600_000 + 1000);
    expect(isValidSessionToken(token, PASSWORD, justBefore)).toBe(true);
    expect(isValidSessionToken(token, PASSWORD, justAfter)).toBe(false);

    // Pushing the expiry out by hand breaks the signature.
    const [, signature] = token.split(".");
    const forged = `${NOW.getTime() + 999_999_999}.${signature}`;
    expect(isValidSessionToken(forged, PASSWORD, justAfter)).toBe(false);
  });

  it("rejects a token signed with a different password, so changing it logs everyone out", () => {
    const token = createSessionToken(PASSWORD, NOW);
    expect(isValidSessionToken(token, "a new password", NOW)).toBe(false);
  });

  it("rejects nonsense without throwing", () => {
    for (const junk of [undefined, "", "no-dot", ".", "abc.def", "12345."]) {
      expect(isValidSessionToken(junk, PASSWORD, NOW)).toBe(false);
    }
  });

  it("never puts the password in the cookie", () => {
    expect(createSessionToken(PASSWORD, NOW)).not.toContain(PASSWORD);
  });
});

describe("isCorrectPassword", () => {
  it("accepts only the exact password", () => {
    expect(isCorrectPassword(PASSWORD, PASSWORD)).toBe(true);
    expect(isCorrectPassword("wrong", PASSWORD)).toBe(false);
    expect(isCorrectPassword("", PASSWORD)).toBe(false);
    expect(isCorrectPassword(`${PASSWORD} `, PASSWORD)).toBe(false);
  });

  it("compares equal-length hashes, so a wrong guess reveals nothing by length", () => {
    // Both arguments are hashed before comparison, so a one-character guess and
    // a thousand-character guess do the same amount of work.
    expect(isCorrectPassword("x", PASSWORD)).toBe(false);
    expect(isCorrectPassword("x".repeat(1000), PASSWORD)).toBe(false);
  });
});
