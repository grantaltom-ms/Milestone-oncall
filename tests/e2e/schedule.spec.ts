import { test, expect, type APIRequestContext } from "@playwright/test";
import config from "./oncall.config.json";
import { computeTwilioSignature } from "../../src/lib/oncall/twilio";

/**
 * The scheduling dashboard's core flow, against the production build: sign in,
 * add a shift, and confirm the phone line immediately routes to the technician
 * that shift names — the whole point of the feature.
 */

const APP = "http://localhost:3000";
const MOCK = `http://127.0.0.1:${config.mockPort}/_mock/state`;

async function resetMock(request: APIRequestContext) {
  await request.post(MOCK, {
    data: {
      reset: true,
      calendarStatus: 200,
      items: [],
      techs: [
        { id: 1, name: config.techA.name, phone: config.techA.phone, active: true },
        { id: 2, name: config.techB.name, phone: config.techB.phone, active: true },
        { id: 3, name: "Retired Rick", phone: "+12065550111", active: false },
      ],
    },
  });
}

async function signIn(request: APIRequestContext) {
  const res = await request.post(`${APP}/api/schedule/session`, {
    data: { password: config.dashboardPassword },
  });
  expect(res.status()).toBe(200);
}

/** A shift covering right now, so the router should pick it up immediately. */
function shiftAroundNow(tech: { name: string; phone: string }) {
  const now = Date.now();
  return {
    techName: tech.name,
    phone: tech.phone,
    start: new Date(now - 3_600_000).toISOString(),
    end: new Date(now + 3_600_000).toISOString(),
  };
}

test.describe("scheduling dashboard", () => {
  test("refuses everything until you sign in", async ({ request }) => {
    await resetMock(request);
    // A fresh context with no session cookie.
    for (const path of ["/api/schedule/shifts", "/api/schedule/techs"]) {
      const res = await request.get(`${APP}${path}`, { headers: { cookie: "" } });
      expect(res.status()).toBe(401);
    }

    const wrong = await request.post(`${APP}/api/schedule/session`, {
      data: { password: "not the password" },
    });
    expect(wrong.status()).toBe(401);

    const created = await request.post(`${APP}/api/schedule/shifts`, {
      data: shiftAroundNow(config.techA),
      headers: { cookie: "" },
    });
    expect(created.status()).toBe(401);
  });

  test("a shift added on the dashboard answers the next call", async ({ request }) => {
    await resetMock(request);
    await signIn(request);

    // Nobody on call yet — the line falls through to the backup manager.
    const before = await (await request.get(`${APP}/api/oncall/status?key=${config.statusKey}`)).json();
    expect(before).toMatchObject({ on_call_found: false, destination: "backup" });

    const created = await request.post(`${APP}/api/schedule/shifts`, {
      data: shiftAroundNow(config.techA),
    });
    expect(created.status()).toBe(201);
    const { shift } = await created.json();
    expect(shift).toMatchObject({ techName: config.techA.name, phone: config.techA.phone });

    // The routing decision changes with no deploy and no Twilio change.
    const after = await (await request.get(`${APP}/api/oncall/status?key=${config.statusKey}`)).json();
    expect(after).toMatchObject({
      on_call_found: true,
      tech_name: config.techA.name,
      tech_phone: config.techA.phone,
      destination: "tech",
      reason: "calendar",
    });

    // And a real signed call now rings that technician.
    const url = `${APP}/api/twilio/voice`;
    const form = { CallSid: "CA-sched", From: config.tenant, To: config.mainLine };
    const call = await request.post(url, {
      headers: { "x-twilio-signature": computeTwilioSignature(url, form, config.authToken) },
      form,
    });
    expect(await call.text()).toContain(`<Number>${config.techA.phone}</Number>`);

    // Deleting it puts the backup manager back on the hook.
    const removed = await request.delete(`${APP}/api/schedule/shifts/${shift.id}`);
    expect(removed.status()).toBe(200);
    const afterDelete = await (await request.get(`${APP}/api/oncall/status?key=${config.statusKey}`)).json();
    expect(afterDelete).toMatchObject({ on_call_found: false, destination: "backup" });
  });

  test("editing a shift hands the line to someone else", async ({ request }) => {
    await resetMock(request);
    await signIn(request);

    const created = await request.post(`${APP}/api/schedule/shifts`, {
      data: shiftAroundNow(config.techA),
    });
    const { shift } = await created.json();

    const edited = await request.patch(`${APP}/api/schedule/shifts/${shift.id}`, {
      data: shiftAroundNow(config.techB),
    });
    expect(edited.status()).toBe(200);

    const status = await (await request.get(`${APP}/api/oncall/status?key=${config.statusKey}`)).json();
    expect(status).toMatchObject({ tech_name: config.techB.name, tech_phone: config.techB.phone });
  });

  test("the roster offers active technicians only", async ({ request }) => {
    await resetMock(request);
    await signIn(request);

    const { techs } = await (await request.get(`${APP}/api/schedule/techs`)).json();
    expect(techs.map((tech: { name: string }) => tech.name)).toEqual([
      config.techA.name,
      config.techB.name,
      "Retired Rick",
    ]);
    // The dashboard filters inactive people out; the API reports the flag.
    expect(techs.find((tech: { name: string }) => tech.name === "Retired Rick").active).toBe(false);
  });

  test("rejects a shift the phone line could not act on", async ({ request }) => {
    await resetMock(request);
    await signIn(request);

    const badPhone = await request.post(`${APP}/api/schedule/shifts`, {
      data: { ...shiftAroundNow(config.techA), phone: "ask the office" },
    });
    expect(badPhone.status()).toBe(400);
    expect((await badPhone.json()).error).toContain("not a phone number");

    const backwards = await request.post(`${APP}/api/schedule/shifts`, {
      data: {
        ...shiftAroundNow(config.techA),
        start: new Date(Date.now() + 3_600_000).toISOString(),
        end: new Date(Date.now() - 3_600_000).toISOString(),
      },
    });
    expect(backwards.status()).toBe(400);
    expect((await backwards.json()).error).toContain("ends before it starts");
  });
});
