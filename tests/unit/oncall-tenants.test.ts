import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastTenDigits, lookupCaller } from "@/lib/oncall/tenants";

/**
 * Matching a caller ID to a unit. The rule underneath every case here: this
 * runs while a phone is ringing, so it answers with what it knows and never
 * throws, whatever the directory does.
 */

const SUPABASE = { url: "https://db.test", serviceRoleKey: "service-role-key" };

let requested: URL[] = [];
let respond: () => Response | Promise<Response>;

beforeEach(() => {
  requested = [];
  respond = () => Response.json([]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      requested.push(new URL(String(input instanceof Request ? input.url : input)));
      return respond();
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const row = (property: string, unit: string, tenant: string) => ({
  property_name: property,
  unit,
  tenant_name: tenant,
});

describe("normalizing a caller ID for the directory", () => {
  it("accepts the shapes a US number actually arrives in", () => {
    expect(lastTenDigits("+12065551234")).toBe("2065551234");
    expect(lastTenDigits("2065551234")).toBe("2065551234");
    expect(lastTenDigits("(206) 555-1234")).toBe("2065551234");
  });

  it("gives up on anything that cannot be a US number", () => {
    // A short code, an international caller, a blocked caller ID: no point
    // spending 2 seconds of a ringing phone on a query that cannot match.
    expect(lastTenDigits("+442071838750")).toBeNull();
    expect(lastTenDigits("55512")).toBeNull();
    expect(lastTenDigits(null)).toBeNull();
  });
});

describe("looking a caller up", () => {
  it("asks the directory for that exact number, current residents first", async () => {
    respond = () => Response.json([row("Willow Lake Apartments", "V - 12", "Kovacs, Nadia")]);
    const lookup = await lookupCaller(SUPABASE, "+12065551234");

    expect(lookup.matches).toEqual([
      { propertyName: "Willow Lake Apartments", unit: "V - 12", tenantName: "Kovacs, Nadia" },
    ]);
    expect(lookup.error).toBeNull();
    expect(requested[0].pathname).toBe("/rest/v1/oncall_caller_lookup");
    expect(requested[0].searchParams.get("phone10")).toBe("eq.2065551234");
    expect(requested[0].searchParams.get("order")).toBe("match_rank.asc");
  });

  it("counts a household as one unit, not as two residents", async () => {
    // Both people on the lease list the same mobile. The technician is being
    // sent to an address, so this is one match, not an ambiguous two.
    respond = () =>
      Response.json([
        row("Willow Lake Apartments", "V - 12", "Kovacs, Nadia"),
        row("Willow Lake Apartments", "V - 12", "Kovacs, Peter"),
      ]);
    const lookup = await lookupCaller(SUPABASE, "+12065551234");
    expect(lookup.matches).toHaveLength(1);
    expect(lookup.matches[0].tenantName).toBe("Kovacs, Nadia");
  });

  it("keeps genuinely different units apart", async () => {
    respond = () =>
      Response.json([
        row("Willow Lake Apartments", "V - 12", "Kovacs, Nadia"),
        row("Iron Ridge Apartments", "4", "Lee, Sam"),
      ]);
    expect((await lookupCaller(SUPABASE, "+12065551234")).matches).toHaveLength(2);
  });

  it("never asks at all about a number that cannot match", async () => {
    const lookup = await lookupCaller(SUPABASE, "+442071838750");
    expect(lookup).toEqual({ matches: [], error: null });
    expect(requested).toHaveLength(0);
  });

  it("says the migration has not been run when the view is missing", async () => {
    respond = () => new Response("", { status: 404 });
    const lookup = await lookupCaller(SUPABASE, "+12065551234");
    expect(lookup.matches).toEqual([]);
    expect(lookup.error).toContain("oncall-caller-lookup.sql");
  });

  it("reports a failure rather than throwing into a ringing phone call", async () => {
    respond = () => {
      throw new Error("connect ETIMEDOUT");
    };
    const lookup = await lookupCaller(SUPABASE, "+12065551234");
    expect(lookup.matches).toEqual([]);
    expect(lookup.error).toContain("ETIMEDOUT");
  });

  it("drops a row with no property rather than texting a blank line", async () => {
    respond = () => Response.json([{ property_name: "  ", unit: "4", tenant_name: "Lee, Sam" }]);
    expect((await lookupCaller(SUPABASE, "+12065551234")).matches).toEqual([]);
  });

  it("asks for one more than it will name, so 'four' and 'more than four' differ", async () => {
    await lookupCaller(SUPABASE, "+12065551234");
    expect(requested[0].searchParams.get("limit")).toBe("5");
  });
});
