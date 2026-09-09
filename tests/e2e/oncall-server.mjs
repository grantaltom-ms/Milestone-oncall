/**
 * Boots the production app for the end-to-end tests with a stand-in for Google
 * Calendar and the Twilio REST API on a local port, so the on-call tests drive
 * the real route handlers over real HTTP without an account, a key, or a cent
 * of spend.
 *
 * Started by playwright.config.ts as the `webServer` command; it owns both the
 * mock and the `npm run start` child so there is no start-order race.
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "oncall.config.json"), "utf-8"));

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** Mutable stand-in state the tests drive through /_mock. */
let calendarItems = [];
let calendarStatus = 200;
let sentSms = [];

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });

const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const mock = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.mockPort}`);

  if (url.pathname === "/token") return json(res, { access_token: "e2e-token", expires_in: 3600 });

  if (url.pathname.startsWith("/calendar/v3/calendars/")) {
    if (calendarStatus !== 200) return json(res, { error: "calendar down" }, calendarStatus);
    return json(res, { items: calendarItems });
  }

  if (url.pathname.endsWith("/Messages.json")) {
    const form = new URLSearchParams(await readBody(req));
    sentSms.push({ to: form.get("To"), from: form.get("From"), body: form.get("Body") });
    return json(res, { sid: `SM${sentSms.length}` }, 201);
  }

  if (url.pathname === "/_mock/state") {
    if (req.method === "POST") {
      const next = JSON.parse((await readBody(req)) || "{}");
      if (next.items !== undefined) calendarItems = next.items;
      if (next.calendarStatus !== undefined) calendarStatus = next.calendarStatus;
      if (next.reset) sentSms = [];
      return json(res, { ok: true });
    }
    return json(res, { items: calendarItems, calendarStatus, sms: sentSms });
  }

  json(res, { error: `unexpected ${req.method} ${url.pathname}` }, 404);
});

mock.listen(config.mockPort, "127.0.0.1", () => {
  const base = `http://127.0.0.1:${config.mockPort}`;
  const app = spawn("npm", ["run", "start"], {
    stdio: "inherit",
    env: {
      ...process.env,
      TWILIO_ACCOUNT_SID: "AC-e2e",
      TWILIO_AUTH_TOKEN: config.authToken,
      TWILIO_API_BASE: base,
      TWILIO_MAIN_LINE: config.mainLine,
      ONCALL_BACKUP_PHONE: config.backupPhone,
      ONCALL_ALWAYS: "true", // the clock is covered by unit tests; keep e2e deterministic
      ONCALL_API_KEY: config.statusKey,
      ONCALL_PUBLIC_BASE_URL: "http://localhost:3000",
      ONCALL_VOICEMAIL_NOTIFY: config.backupPhone,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "oncall@milestone.iam.gserviceaccount.com",
      GOOGLE_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
      GOOGLE_CALENDAR_ID: "maintenance@milestoneprop.com",
      GOOGLE_OAUTH_TOKEN_URL: `${base}/token`,
      GOOGLE_CALENDAR_API_BASE: base,
    },
  });

  const shutdown = (signal) => {
    app.kill(signal);
    mock.close();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  app.on("exit", (code) => {
    mock.close();
    process.exit(code ?? 0);
  });
});
