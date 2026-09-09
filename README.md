# Milestone on-call line

After-hours maintenance call routing. Tenants call one number; whoever is on
the rotation calendar right now gets rung — and their phone always shows **the
office number**, never the tenant's, so every technician can set one Emergency
Bypass rule that works for every shift.

**Setup and the week-to-week runbook: [docs/oncall-routing.md](docs/oncall-routing.md).**

## What happens on a call

```
Tenant calls the office line, 9:40pm Saturday
  │
  ├─ After hours?   weekdays 5:00pm–8:00am, all day Sat/Sun
  │     no  → ring the office line
  │     yes ↓
  ├─ Who is on the rotation calendar right now?   (read live, every call)
  │     nobody / calendar down → skip to the backup manager
  │     ↓
  ├─ Ring the on-call tech, 25 seconds          ← caller ID: the office number
  │     └─ text the tech: "call from (206) 555-9876"
  ├─ No answer → ring the same tech again
  ├─ Still nothing → "please hold", ring the backup manager (also texted)
  └─ Still nothing → voicemail, texted out as a link
```

Changing next week's rotation is a calendar edit — no deploy, no Twilio login.
Every failure path still reaches a human: no shift on the calendar, a Google
outage, a missing setting, or an unverifiable request all fall through to the
backup manager, then voicemail.

## Routes

| Route | What it does |
| --- | --- |
| `POST /api/twilio/voice` | The webhook Twilio calls on every ring. Drives the escalation ladder through a `stage` parameter. Point the phone number's "A call comes in" here. |
| `POST /api/twilio/voicemail` | Twilio's recording callback. Texts the voicemail link to the notify list. |
| `GET /api/oncall/status` | Who is on call right now, as JSON, plus a config self-check. Full phone numbers only with `ONCALL_API_KEY`. |
| `/` | The same answer as a page: who picks up now, and anything still missing from setup. Names and last-four only. |

## Configuration

Every setting is an environment variable — see [`.env.example`](.env.example)
for the full list with defaults. The six that matter:

| Variable | Notes |
| --- | --- |
| `TWILIO_MAIN_LINE` | The number tenants call; the caller ID every tech sees. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Verifies Twilio's webhook signature, and sends the texts. |
| `ONCALL_BACKUP_PHONE` | The manager who rings when the tech misses the call. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_CALENDAR_ID` | Read access to the rotation calendar. |
| `ONCALL_OFFICE_PHONE` | Business-hours destination. Blank means 24/7 rotation. |
| `ONCALL_API_KEY` | Required before the status endpoint reveals full numbers. |

A request without a valid `X-Twilio-Signature` is refused, so the rotation
cannot be harvested by probing the endpoint. Route handlers are capped at 15
seconds (`vercel.json`) because that is roughly how long Twilio waits for an
answer before giving up on the call.

## Running locally

```bash
npm ci
cp .env.example .env.local   # fill in what you have
npm run dev                  # http://localhost:3000
```

To exercise the phone flow without Twilio, run the end-to-end suite — it drives
a full night of calls against the production build.

## Checks

Every push and pull request runs the full suite in GitHub Actions
(`.github/workflows/ci.yml`).

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # vitest: hours, calendar parsing, signatures, every escalation branch
npm run build       # next build
npm run test:e2e    # Playwright: signed webhooks against the production build
npm run check       # all of the above
```

`npm run test:e2e` starts the server through `tests/e2e/oncall-server.mjs`,
which also runs local stand-ins for Google Calendar and Twilio's SMS API — so
the tests never touch a real account, cost nothing, and cover a mid-rotation
shift change and a Google outage.

## Project layout

```
src/app/api/twilio/voice        the webhook Twilio calls on every ring
src/app/api/twilio/voicemail    texts a link when a voicemail is left
src/app/api/oncall/status       who is on call right now, as JSON
src/app/page.tsx                the same, as a page
src/lib/oncall/calendar.ts      reads the shift from Google Calendar (service-account JWT, no SDK)
src/lib/oncall/window.ts        after-hours rules in local time, daylight saving included
src/lib/oncall/routing.ts       picks the destination: tech → backup → voicemail
src/lib/oncall/twilio.ts        verifies Twilio's signature; sends texts
src/lib/oncall/twiml.ts         builds the XML Twilio expects back
src/lib/oncall/phone.ts         phone-number normalizing, formatting, masking
src/lib/oncall/config.ts        every setting, read fresh on each request
docs/oncall-routing.md          setup and week-to-week runbook
twilio/studio-flow.json         optional drag-and-drop alternative to the webhook
```

No `googleapis` and no `twilio` SDK: both are handled with `fetch` plus
`node:crypto` (a service-account JWT for Google, HMAC-SHA1 for Twilio's
signature). Two HTTPS calls don't justify tens of megabytes in a function that
has seconds to answer a ringing phone.
