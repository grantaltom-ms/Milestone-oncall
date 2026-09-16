# Milestone on-call line

After-hours maintenance call routing. Tenants call one number; whoever is on
the rotation calendar right now gets rung — and their phone always shows **the
office number**, never the tenant's, so every technician can set one Emergency
Bypass rule that works for every shift. The text that arrives as their phone
rings says **which unit is calling**, matched from the tenant directory on the
caller ID.

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
  │     └─ text the tech: "Willow Lake #V-12, Nadia Kovacs / Callback: ..."
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
| `POST /api/twilio/voicemail` | Twilio's recording callback. Texts the voicemail link, with the unit, to the notify list and files it in the call log. |
| `POST /api/twilio/recording` | Where a recorded conversation lands when `ONCALL_RECORD_CALLS` is on. Files it under the unit that called, and asks for a transcript. |
| `POST /api/twilio/transcript` | Where Conversational Intelligence says the words are ready. Believes nothing in the request; reads everything back from Twilio. |
| `GET /api/oncall/status` | Who is on call right now, as JSON, plus a config self-check. Full phone numbers only with `ONCALL_API_KEY`. |
| `/` | The same answer as a page: who picks up now, and anything still missing from setup. Names and last-four only. |
| `/schedule` | The scheduling dashboard — add, edit and delete shifts, with coverage gaps flagged. Behind a shared password; disabled entirely when `ONCALL_DASHBOARD_PASSWORD` is unset. |
| `/calls` | Last night's calls and voicemails, with the unit already matched, a player, and the note to paste into AppFolio. Same password. |

## Which unit is calling

Twilio hands over a phone number and nothing else. That number is matched
against `tenant_directory` in Supabase, and what comes back goes on its own
line of the technician's text:

```
Milestone Properties after-hours call ringing you now.
Willow Lake #V-12, Nadia Kovacs
Callback: (206) 555-9876
Do not call back the number on your screen.
```

The whole text is held to one 160-character SMS segment, because a split
message can arrive out of order — with the callback number in the half that
lands second. When the budget is tight the resident's name is initialed, then
dropped; the unit and the number never are.

It is honest about what it does not know. A number in nobody's record says
"Number not in the tenant directory"; a number on two leases says "2 units
share this number" rather than guessing a door; and a directory that is
unreachable says *nothing at all*, because "not in the directory" and "the
directory is down" mean opposite things to someone deciding whether to drive
out. The lookup happens after the TwiML is already on its way back to Twilio,
so none of it can hold up a ringing phone.

Run [`docs/oncall-caller-lookup.sql`](docs/oncall-caller-lookup.sql) once to
create it.

## Recording calls, and the notes that come out of them

Off until `ONCALL_RECORD_CALLS=true`. Washington is an all-party consent state
(RCW 9.73.030), so with it on every caller hears "This call will be recorded
for maintenance records" before anything is dialed, once per call — and your
technicians need telling in writing when they join the rotation. Recording
starts when someone answers, so an unanswered ring leaves nothing behind.

Only the rotation's calls are recorded. The same line during business hours
reaches the office and is left alone: the person at that desk never joined an
on-call rotation, and a resident calling at 2pm is not reporting an after-hours
emergency.

Recorded calls and voicemails land on **`/calls`**, newest first, each already
filed under the unit that called. Listen back in the browser, then **Copy note**
for the block that goes into the AppFolio work order:

```
After-hours call — Sat, Sep 13, 9:41 PM
Willow Lake Apartments #V-12 — Nadia Kovacs
From (206) 555-9876 · 4 min 12 sec
Recording: https://…/api/calls/RE…/audio

Reported:
Action taken:
Follow-up:
```

The three empty lines are deliberate. Everything the system knows is filled in;
everything a person has to judge is left for the person.

Audio never leaves the password: the page plays it through
`/api/calls/[sid]/audio`, which fetches from Twilio server-side with the
account's own credentials and streams it on. No public recording URL, and no
Twilio token in a browser.

## What the call was about

With `TWILIO_INTELLIGENCE_SERVICE_SID` set, every recording is transcribed by
Twilio Conversational Intelligence — chosen over a dedicated transcription
vendor because the audio never leaves Twilio. Dual-channel recording means who
spoke is a fact rather than a guess, so the transcript comes back labelled:

```
Resident: There's water coming through the bedroom ceiling.
Milestone: Can you shut the valve under the kitchen sink?
Resident: Doing it now.
```

With `ANTHROPIC_API_KEY` set as well, Claude reads that and writes the summary
that goes on the card and into the note:

> Resident at Willow Lake reported water coming through the back bedroom
> ceiling, worsening over about an hour. Technician talked them through the
> shut-off valve and said he would attend.
>
> Urgency: emergency
> Promised: onsite within the hour
> Follow-up: check the unit above for the source

The summary is a convenience on top of the transcript, and the code treats it
that way: a model that is unreachable, slow or unwilling costs the reviewer
nothing they did not already have. The words are stored either way.

**The transcript webhook believes nothing it is sent.** Twilio does not
document a signature on the Conversational Intelligence callback, so the post
is treated as a nudge: the transcript ID is checked for shape, and then the
status, the recording it belongs to and the words themselves are all read back
from Twilio over an authenticated request. A forged post costs one wasted API
call and can change nothing, because none of the data it carries is used.

Run [`docs/oncall-transcripts.sql`](docs/oncall-transcripts.sql) to add the
columns, and point the Intelligence Service's webhook at
`/api/twilio/transcript`.

Worth knowing: a transcript is a far more spreadable thing than an audio file —
searchable, copy-pasteable, easy to forward. It sits behind the same password,
but how long you keep transcripts is a separate decision from how long you keep
recordings.

## Scheduling the rotation

A shift is an ordinary Google Calendar event: the technician's name is the
title, their number is the location. That stays true whichever way it was
created, so a shift added on `/schedule` and one typed into Google Calendar on
a phone are the same thing, and either can be edited from either place.

The dashboard adds what a calendar cannot: a roster so numbers are picked
rather than retyped, validation that refuses a number the line could not dial,
and **gap detection** — the uncovered Saturday that is otherwise invisible
until a tenant finds it.

It needs two things beyond the phone line's own setup:

1. The calendar shared with the service account as **"Make changes to events"**
   rather than "See all event details".
2. The `oncall_techs` table — run [`docs/oncall-techs.sql`](docs/oncall-techs.sql)
   in the Supabase SQL editor.

The phone line never reads the roster. Each shift carries its own phone number
on the calendar event, so routing keeps working if Supabase is unreachable or a
technician is later removed.

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
| `ONCALL_DASHBOARD_PASSWORD` | Unlocks `/schedule`. Unset means the dashboard is off, not open. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | The technician roster. Server-only; the service-role key bypasses row-level security. |

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
which also runs local stand-ins for Google Calendar, Twilio (SMS and recording
media) and Supabase — so the tests never touch a real account, cost nothing,
and cover a mid-rotation shift change, a Google outage, a directory that is
down, and the whole recorded call from the first ring to the note being copied
out of `/calls`.

## Project layout

```
src/app/api/twilio/voice        the webhook Twilio calls on every ring
src/app/api/twilio/voicemail    texts a link when a voicemail is left
src/app/api/twilio/recording    files a recorded call under the unit that made it
src/app/api/twilio/transcript   stores the words and the summary when they are ready
src/app/api/oncall/status       who is on call right now, as JSON
src/app/page.tsx                the same, as a page
src/lib/oncall/calendar.ts      reads the shift from Google Calendar (service-account JWT, no SDK)
src/lib/oncall/window.ts        after-hours rules in local time, daylight saving included
src/lib/oncall/routing.ts       picks the destination: tech → backup → voicemail
src/lib/oncall/twilio.ts        verifies Twilio's signature; sends texts
src/lib/oncall/twiml.ts         builds the XML Twilio expects back
src/lib/oncall/phone.ts         phone-number normalizing, formatting, masking
src/lib/oncall/tenants.ts       caller ID → unit, from the tenant directory
src/lib/oncall/message.ts       the text a technician reads at 2am, inside one SMS
src/lib/oncall/calls.ts         the call log: written by the webhooks, read by /calls
src/lib/oncall/intelligence.ts  Twilio Conversational Intelligence: recording in, words out
src/lib/oncall/summary.ts       the transcript, as the note that goes in a work order
src/lib/oncall/background.ts    work that runs after the TwiML, never before it
src/lib/oncall/config.ts        every setting, read fresh on each request
src/app/schedule                the scheduling dashboard (shared password)
src/app/api/schedule            sign-in, roster, and shift create/edit/delete
src/lib/oncall/roster.ts        technician roster from Supabase (dashboard only)
src/lib/oncall/session.ts       signed-cookie sessions for the dashboard
src/app/calls                   recordings and voicemails, with notes for AppFolio
src/app/api/calls               the call log, and the authenticated audio proxy
docs/oncall-techs.sql           the roster table migration
docs/oncall-caller-lookup.sql   the caller-ID lookup view and the call log table
docs/oncall-transcripts.sql     transcript and summary columns on the call log
docs/oncall-routing.md          setup and week-to-week runbook
twilio/studio-flow.json         optional drag-and-drop alternative to the webhook
```

No `googleapis` and no `twilio` SDK: both are handled with `fetch` plus
`node:crypto` (a service-account JWT for Google, HMAC-SHA1 for Twilio's
signature). Two HTTPS calls don't justify tens of megabytes in a function that
has seconds to answer a ringing phone.

The one exception is `@anthropic-ai/sdk`, used by the summarizer. The reason
for the rule does not apply there: nothing in that route runs until everyone
has hung up, and it is the only route that imports it.
