import { after } from "next/server";

/**
 * Work that must not keep a ringing phone waiting: the "who is calling" text,
 * the directory lookup behind it, the call log write.
 *
 * On Vercel `after()` runs the task once the TwiML is already on its way back
 * to Twilio — the difference between a technician's phone ringing now and
 * ringing three seconds from now, every single call.
 *
 * `after` throws outside a request scope, which is exactly the situation in
 * the unit tests: they call the route handlers directly. There the task is
 * awaited instead, so tests stay deterministic and assert on the same work.
 */
export async function background(task: () => Promise<void>): Promise<void> {
  try {
    after(task);
  } catch {
    await task();
  }
}
