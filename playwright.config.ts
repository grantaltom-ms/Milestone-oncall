import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests run against a production build (`next build` must run
 * first). `oncall-server.mjs` starts that server together with local stand-ins
 * for Google Calendar and Twilio's SMS API, so no account, key or spend is
 * involved and results are deterministic.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // Most tests drive the API over HTTP with the `request` fixture and launch no
  // browser at all; `schedule-form.spec.ts` is the exception, because the
  // scheduling form is something a person clicks.
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/e2e/oncall-server.mjs",
    url: "http://localhost:3000/api/oncall/status",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
