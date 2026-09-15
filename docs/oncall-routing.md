# After-hours maintenance call routing

One phone number for tenants. Behind it, whoever is on the rotation calendar
tonight. The technician's phone always shows **the office number** — never the
tenant's — so each tech can set one Emergency Bypass rule and stop missing 2am
water leaks.

## What happens on a call

```
Tenant calls the office line, 9:40pm Saturday
  │
  ├─ Is it after hours?   weekdays 5:00pm–8:00am, all day Sat/Sun
  │     no  → ring the office line
  │     yes ↓
  ├─ Who is on the rotation calendar right now?   (read live, every call)
  │     nobody / calendar down → skip to the backup manager
  │     ↓
  ├─ Ring the on-call tech for 25 seconds       ← caller ID: the office number
  │     └─ text the tech: which unit is calling, and the number to call back
  ├─ No answer → ring the same tech again, 25 seconds
  ├─ Still nothing → "please hold", ring the backup manager (also texted)
  └─ Still nothing → voicemail, and the recording is texted to the backup manager
```

Nothing is hard-coded per person. Changing next week's rotation is a calendar
edit, not a code change or a Twilio login.

## One-time setup

### 1. The phone number (Twilio)

1. Buy a local number in the Twilio Console (Phone Numbers → Buy a number),
   voice **and** SMS capable. This is the number tenants call and the number
   every technician will see.
2. Leave the number's configuration alone for now — step 4 points it here.
3. Copy the **Account SID** and **Auth Token** from the Console dashboard.

### 2. The rotation calendar (Google)

1. Make a Google Calendar named something like **Maintenance On-Call**. Its
   calendar ID is under Calendar settings → Integrate calendar (it looks like
   an email address).
2. In Google Cloud Console, create a **service account** (an account for the
   app itself, not a person), enable the **Google Calendar API**, and create a
   JSON key for it.
3. Share the calendar with the service account's email address — "See all
   event details" is enough. This is the step people forget; without it the
   calendar looks empty to the app.

### 3. Settings (Vercel → Project → Settings → Environment Variables)

Set these for **Production** and **Preview**. Full list with defaults in
`.env.example`.

| Variable | What it is |
| --- | --- |
| `TWILIO_MAIN_LINE` | The number tenants call, e.g. `+12065550100`. The caller ID every tech sees. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | From the Twilio dashboard. Verifies incoming calls really came from Twilio, and sends the texts. |
| `ONCALL_BACKUP_PHONE` | The manager who rings when the tech misses the call. |
| `ONCALL_OFFICE_PHONE` | Where business-hours calls go. Leave blank for 24/7 rotation. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_CALENDAR_ID` | From the JSON key file and the calendar's settings page. Paste the private key exactly as it appears, `\n` sequences and all. |
| `ONCALL_API_KEY` | Any long random string. Required before the status page will show full phone numbers. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Optional. Turns on the unit lookup and the call log. The service-role key is server-only — never prefix it with `NEXT_PUBLIC_`. |
| `ONCALL_RECORD_CALLS` | Optional, off by default. Recording calls in Washington means announcing it — see below before turning it on. |

### 4. Point the number at the app

In the Twilio Console, open the phone number and set:

- **A call comes in** → Webhook → `https://<your-app>.vercel.app/api/twilio/voice` → **HTTP POST**
- **Primary handler fails** (optional) → your backup manager's number, so a
  Vercel outage still rings a human.

That is the whole install. No Studio flow needed — the app answers Twilio
directly. (A Studio version is included at `twilio/studio-flow.json` if you
ever want to edit the call flow by dragging boxes; it is simpler and does not
do the escalation ladder or the texts.)

## Telling the technician which unit is calling

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, then run
[`docs/oncall-caller-lookup.sql`](oncall-caller-lookup.sql) once in the Supabase
SQL editor. From the next call on, the caller ID is matched against
`tenant_directory` and the text reads:

```
Milestone Properties after-hours call ringing you now.
Willow Lake #V-12, Nadia Kovacs
Callback: (206) 555-9876
Do not call back the number on your screen.
```

Nothing else changes: the whole lookup happens after the call is already being
connected, and a directory that is slow, missing or down costs that one line
and nothing more.

What it will not do is guess. Roughly one number in two hundred in the
directory sits on two different leases; those say "2 units share this number"
instead of naming a door. A number nobody has says so. Only a number matched to
exactly one unit gets a unit printed.

Two things make matches miss, and both are fixed in AppFolio rather than here:

- **The resident is calling from a number the directory does not have** — a
  partner's phone, a new number they have not told you about. The text says the
  number is not in the directory and the technician asks, as they do today.
- **The directory has a placeholder.** There are a handful of records carrying
  `000-000-0000` and one real mobile listed on six different units. Cleaning
  those up in AppFolio is what makes the match land; nothing here has to change.

The match is only ever read live — the directory is never copied — so a number
corrected in AppFolio this afternoon is matched correctly tonight, as soon as
the nightly tenant directory sync carries it over.

## Recording calls

**Off until you turn it on**, and worth reading before you do.

Washington is an **all-party consent** state (RCW 9.73.030): every person on a
recorded call has to be told. With `ONCALL_RECORD_CALLS=true`:

- Every caller hears *"This call will be recorded for maintenance records"*
  before anything is dialed — once per call, not once per unanswered ring.
- Recording starts when somebody answers, so an unanswered ring leaves nothing
  behind, and both sides are captured on separate channels.
- **Technicians are your side of the consent.** Tell each one in writing when
  they join the rotation that after-hours calls they answer are recorded; a
  line in the on-call policy they sign is the usual way to do it. The system
  cannot do this part for you.

A lawyer should look at the wording before this goes live in front of
residents. It is one environment variable to switch back off.

### Listening back, and the note that goes into AppFolio

`/calls` lists recorded calls and voicemails newest first, behind the same
password as the scheduling dashboard, each one already filed under the unit
that called. Play it in the browser, then **Copy note**:

```
After-hours call — Sat, Sep 13, 9:41 PM
Willow Lake Apartments #V-12 — Nadia Kovacs
From (206) 555-9876 · 4 min 12 sec
Recording: https://…/api/calls/RE…/audio

Reported:
Action taken:
Follow-up:
```

Paste it into the AppFolio work order and fill in the last three lines.

The recordings themselves stay in Twilio. The page never hands the browser a
Twilio URL — it fetches the audio server-side with the account's credentials
and streams it through `/api/calls/[sid]/audio`, which needs the dashboard
password. Set a retention period in the Twilio Console (Voice → Settings) so
recordings of residents are not kept forever by default, and remember that
storage is billed per recording per month.

## Running the rotation week to week

The easy way is the dashboard at `/schedule`. Pick a technician, a first day
and a last day — no times. Every shift starts at **8:00 AM on the first day**
and ends at **8:00 AM the morning after the last day**, so Monday through
Sunday means Monday 8:00 AM to the following Monday 8:00 AM, and the person
covers the last night of their week. The form spells the window out under the
date boxes before you save it, and after each save it moves on to the week that
just opened up, so a five-week rotation is five names and five clicks.

Behind the dashboard, each shift is an ordinary calendar event on the on-call
calendar, and one added by hand works exactly the same:

| Field | What to put |
| --- | --- |
| Title | The tech's name — `Mike Alvarez` |
| Location | Their cell number — `206-555-0134` (any format works) |
| When | The shift, e.g. Mon 8:00am → Mon 8:00am |

Repeat weekly and the rotation runs itself. Rules the app follows:

- The number can be in the **location**, the **description**, or the **title**;
  location wins if there is more than one.
- Overlapping shifts: the one that started first wins.
- A shift with no phone number in it is ignored — the call goes to the backup
  manager and the status page names the offending event.
- Deleting or cancelling an event takes effect on the very next call.
- Editing a hand-typed shift on the dashboard snaps it to the 8:00 AM handoff,
  since the form only deals in whole days.

Check the current state any time:

```
https://<your-app>.vercel.app/api/oncall/status?key=<ONCALL_API_KEY>
```

It answers who is on call right now, whether it considers this "after hours",
and lists any settings still missing. Without the key it still works, but shows
only the last four digits of any number.

## Telling technicians how to set Emergency Bypass

Send this to each tech once. It only works because the caller ID is always the
same number.

**iPhone**
1. Save the office number as a contact: `Milestone After-Hours Line`.
2. Open the contact → **Edit** → **Ringtone** → turn on **Emergency Bypass**.
3. Do the same under **Text Tone** so the "who is calling" text comes through too.
4. Settings → Focus → Do Not Disturb → **People** → Allow calls from that contact.

**Android** (wording varies by phone)
1. Save the same contact and tap the ☆ to make it a **Favorite**.
2. Settings → Sounds → **Do Not Disturb** → Calls → allow **Starred contacts**,
   and turn on **Repeat callers**.

## Two things worth knowing about Twilio

- **Texts need A2P 10DLC registration.** Sending SMS from a US 10-digit number
  requires registering the brand and campaign in the Twilio Console
  (Messaging → Regulatory Compliance). Unregistered numbers get their texts
  filtered by carriers. Calls are unaffected — the line still routes correctly,
  the techs just will not get the "who is calling" text until this is done.
- **Costs are per minute, not per seat.** A phone number, plus a few cents a
  call (Twilio bills both the tenant's leg and the forwarded leg), plus a
  fraction of a cent per text. Check current rates on Twilio's pricing page.

## When something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every call goes to the backup manager | Calendar not shared with the service account, or no shift covering right now | Open the status URL — the `reason` field says which |
| Calls fail with a 403 in Twilio's debugger | The webhook URL Twilio calls does not match what the app sees (custom domain, proxy) | Set `ONCALL_PUBLIC_BASE_URL` to the exact public URL |
| Tech sees the tenant's number, not the office | `TWILIO_MAIN_LINE` not set, and the number dialed is not what you expect | Set `TWILIO_MAIN_LINE` |
| No "who is calling" text | `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` missing, or A2P 10DLC not registered | Check the status URL's warnings, then Twilio's Messaging logs |
| Tech's voicemail answers instead of escalating | Their carrier voicemail picks up before 25 seconds | Lower `ONCALL_DIAL_TIMEOUT`, or have the tech extend their carrier's ring time |
| Line answers but nobody is reachable | Everything failed, so it took a voicemail | The recording is texted to `ONCALL_VOICEMAIL_NOTIFY` (or the backup manager) |
| Texts never name a unit | `docs/oncall-caller-lookup.sql` has not been run, or Supabase is not configured | Vercel logs show `"stage":"lookup"` with the reason on every call |
| A text names the wrong unit | Two leases carry that number in AppFolio | It says "2 units share this number" instead of guessing; fix the record in AppFolio |
| `/calls` is empty | Recording is off, and nobody has left a voicemail | The page says so at the top; set `ONCALL_RECORD_CALLS=true` to record answered calls |
| A recording will not play | The dashboard session expired, or Twilio deleted it under its retention policy | Sign in again; check Twilio → Monitor → Recordings |

Every call writes one line to the Vercel logs (`event: "oncall"`) with who was
chosen and why — filter on `oncall` in Vercel → Logs to see last night's calls.

## How it is built

| File | Job |
| --- | --- |
| `src/app/api/twilio/voice/route.ts` | The webhook Twilio calls; runs the escalation ladder |
| `src/app/api/twilio/voicemail/route.ts` | Texts the voicemail link when a message is left |
| `src/app/api/twilio/recording/route.ts` | Files a recorded call under the unit that made it |
| `src/lib/oncall/tenants.ts` | Matches a caller ID to a unit in the tenant directory |
| `src/lib/oncall/message.ts` | Writes the text the technician reads, inside one SMS segment |
| `src/app/calls/page.tsx` | Listening back, and the note that goes into AppFolio |
| `src/app/api/oncall/status/route.ts` | "Who is on call right now?" as JSON |
| `src/lib/oncall/calendar.ts` | Reads the shift from Google Calendar (service-account JWT, no SDK) |
| `src/lib/oncall/window.ts` | After-hours rules, in Seattle time, daylight saving included |
| `src/lib/oncall/routing.ts` | Picks the destination: tech → backup → voicemail |
| `src/lib/oncall/twilio.ts` | Verifies Twilio's signature; sends texts |
| `src/lib/oncall/twiml.ts` | Builds the XML Twilio expects back |

Tests: `tests/unit/oncall-*.test.ts` (hours, calendar parsing, signatures, every
branch of the ladder) and `tests/e2e/oncall.spec.ts`, which drives a full night
of calls against the production build with Google and Twilio stubbed locally.
