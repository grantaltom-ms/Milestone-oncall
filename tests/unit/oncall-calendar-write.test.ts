import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  CalendarWriteError,
  createShift,
  deleteShift,
  listShifts,
  lookupOnCall,
  READ_SCOPE,
  resetGoogleTokenCache,
  updateShift,
  WRITE_SCOPE,
} from "@/lib/oncall/calendar";
import type { GoogleConfig } from "@/lib/oncall/config";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const google: GoogleConfig = {
  serviceAccountEmail: "oncall@milestone.iam.gserviceaccount.com",
  privateKey,
  calendarId: "maintenance@milestoneprop.com",
  tokenUrl: "https://oauth.test/token",
  apiBase: "https://cal.test",
};

const SHIFT = {
  techName: "Mike Alvarez",
  phone: "+12065550134",
  start: "2026-09-11T17:00:00.000Z",
  end: "2026-09-18T17:00:00.000Z",
};

type Call = { url: string; method: string; body?: string; scope?: string };
let calls: Call[] = [];

function mockGoogle(options: { eventsStatus?: number; item?: Record<string, unknown> } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      const body = init?.body ? String(init.body) : undefined;

      if (url.startsWith(google.tokenUrl)) {
        const assertion = new URLSearchParams(body).get("assertion")!;
        const claims = JSON.parse(
          Buffer.from(assertion.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
        );
        calls.push({ url, method, scope: claims.scope });
        return Response.json({ access_token: `token-for-${claims.scope}`, expires_in: 3600 });
      }

      calls.push({ url, method, body });
      if (options.eventsStatus && options.eventsStatus !== 200) {
        return new Response("no", { status: options.eventsStatus });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "GET") return Response.json({ items: [options.item ?? {}] });
      return Response.json(
        options.item ?? {
          id: "evt-1",
          summary: SHIFT.techName,
          location: "206-555-0134",
          start: { dateTime: SHIFT.start },
          end: { dateTime: SHIFT.end },
        }
      );
    })
  );
}

beforeEach(() => {
  calls = [];
  resetGoogleTokenCache();
});
afterEach(() => vi.unstubAllGlobals());

describe("scopes", () => {
  it("gives the phone line a read-only token and the dashboard a write token", async () => {
    mockGoogle();
    await lookupOnCall(google, new Date("2026-09-12T04:00:00Z"));
    await createShift(google, SHIFT);

    const scopes = calls.filter((call) => call.scope).map((call) => call.scope);
    expect(scopes).toEqual([READ_SCOPE, WRITE_SCOPE]);
  });

  it("caches the two tokens separately rather than reusing one for both", async () => {
    mockGoogle();
    await lookupOnCall(google, new Date("2026-09-12T04:00:00Z"));
    await lookupOnCall(google, new Date("2026-09-12T04:01:00Z"));
    await createShift(google, SHIFT);
    await createShift(google, SHIFT);

    // Two token requests total — one per scope — not one per operation.
    expect(calls.filter((call) => call.scope)).toHaveLength(2);
  });
});

describe("createShift", () => {
  it("writes the shape the router reads back: name in the title, number in the location", async () => {
    mockGoogle();
    const shift = await createShift(google, SHIFT);

    const post = calls.find((call) => call.method === "POST" && call.url.includes("cal.test"))!;
    const body = JSON.parse(post.body!);
    expect(body.summary).toBe("Mike Alvarez");
    expect(body.location).toBe("+12065550134");
    expect(body.start.dateTime).toBe(SHIFT.start);
    expect(body.transparency).toBe("transparent"); // an on-call week is not "busy"

    expect(shift).toMatchObject({ id: "evt-1", techName: "Mike Alvarez", phone: "+12065550134" });
  });

  it("explains a read-only calendar instead of passing along a bare 403", async () => {
    mockGoogle({ eventsStatus: 403 });
    await expect(createShift(google, SHIFT)).rejects.toThrow(/Make changes to events/);
    await expect(createShift(google, SHIFT)).rejects.toBeInstanceOf(CalendarWriteError);
  });
});

describe("updateShift and deleteShift", () => {
  it("patches by id", async () => {
    mockGoogle();
    await updateShift(google, "evt-1", { ...SHIFT, techName: "Dana Kim" });
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toContain("/events/evt-1");
    expect(JSON.parse(patch.body!).summary).toBe("Dana Kim");
  });

  it("deletes by id and tolerates the empty 204 body", async () => {
    mockGoogle();
    await expect(deleteShift(google, "evt-1")).resolves.toBeUndefined();
    expect(calls.find((call) => call.method === "DELETE")!.url).toContain("/events/evt-1");
  });

  it("url-encodes an id rather than building a broken path", async () => {
    mockGoogle();
    await deleteShift(google, "weird/id?x=1");
    expect(calls.find((call) => call.method === "DELETE")!.url).toContain("weird%2Fid%3Fx%3D1");
  });
});

describe("listShifts", () => {
  it("asks for expanded, ordered events across the window", async () => {
    mockGoogle({
      item: {
        id: "evt-9",
        summary: "Dana Kim",
        location: "206-555-0175",
        start: { dateTime: "2026-09-18T17:00:00-07:00" },
        end: { dateTime: "2026-09-25T17:00:00-07:00" },
      },
    });
    const shifts = await listShifts(google, "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z");

    const get = calls.find((call) => call.method === "GET" && call.url.includes("cal.test"))!;
    expect(get.url).toContain("singleEvents=true");
    expect(get.url).toContain("orderBy=startTime");
    expect(shifts).toEqual([
      {
        id: "evt-9",
        techName: "Dana Kim",
        phone: "+12065550175",
        start: "2026-09-18T17:00:00-07:00",
        end: "2026-09-25T17:00:00-07:00",
      },
    ]);
  });

  it("keeps a hand-written shift that has no dialable number, flagged with a null phone", async () => {
    mockGoogle({
      item: { id: "evt-x", summary: "Mike on call", start: { dateTime: "a" }, end: { dateTime: "b" } },
    });
    await expect(listShifts(google, "a", "b")).resolves.toMatchObject([{ phone: null }]);
  });
});
