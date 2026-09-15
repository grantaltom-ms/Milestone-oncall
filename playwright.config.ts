import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests run against a production build (`next build` must run
 * first). `oncall-server.mjs` starts that server together with local stand-ins
 * for Google Calendar, Twilio (SMS and recording media) and Supabase, so no
 * account, key or spend is involved and results are deterministic.
 */

/**
 * Environments that ship a Chromium but cannot download another — CI images,
 * sandboxes — point at theirs here rather than failing the whole suite with
 * "Executable doesn't exist". Unset everywhere else, which is the normal case.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // Most tests drive the API over HTTP with the `request` fixture and launch no
  // browser at all; `schedule-form.spec.ts` and part of `calls.spec.ts` are the
  // exceptions, because those pages are things a person clicks.
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: "node tests/e2e/oncall-server.mjs",
    url: "http://localhost:3000/api/oncall/status",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
