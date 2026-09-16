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
| `ONCALL_RECORD_CALLS` | Optional, off by default. Records the rotation's calls only, never business-hours office calls. Recording in Washington means announcing it — see below before turning it on. |
| `TWILIO_INTELLIGENCE_SERVICE_SID` | Optional. Transcribes each recording through Conversation Intelligence **(classic)**. A Service SID: `GA` plus 32 hex, not the newer product's `intelligence_configuration_…` ID. |
| `ANTHROPIC_API_KEY` | Optional. Claude writes the summary of each transcript. Without it the transcript is still stored. |

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

The match is read live on every call — nothing is copied into this app — so a
correction is in effect the moment `tenant_directory` carries it. That table is
what lags: it refreshes **weekly, on Mondays**. A resident who moves in on
Tuesday is therefore an unmatched number until the following Monday, and a
move-out keeps matching for the same stretch. If that gap matters, the fix is to
run the tenant directory sync more often — nothing in the phone line has to
change for it.

## Recording calls

**Off until you turn it on**, and worth reading before you do.

Washington is an **all-party consent** state (RCW 9.73.030): every person on a
recorded call has to be told. With `ONCALL_RECORD_CALLS=true`:

- Every caller hears *"This call will be recorded for maintenance records"*
  before anything is dialed — once per call, not once per unanswered ring.
- Recording starts when somebody answers, so an unanswered ring leaves nothing
  behind, and both sides are captured on separate channels.
- **Only the rotation's calls.** Weekday daytime calls reach the office and are
  not recorded or announced — the person at that desk never joined an on-call
  rotation. The switch covers the after-hours window only, the same window the
  rotation itself answers. (`ONCALL_ALWAYS=true` removes the distinction.)
- **Technicians are your side of the consent.** Tell each one in writing when
  they join the rotation that after-hours calls they answer are recorded; a
  line in the on-call policy they sign is the usual way to do it. The system
  cannot do this part for you.

A lawyer should look at the wording before this goes live in front of
residents. It is one environment variable to switch back off.

### The notice technicians get

Give this to every technician before their first shift, in writing, and keep
the signed copy. The resident's half of the consent is the announcement they
hear; this is the other half.

> **Recording on the after-hours maintenance line**
>
> Calls to the Milestone Properties after-hours maintenance line are recorded,
> including your side of them. Recording starts when you answer and ends when
> the call does. Only calls that come through the after-hours rotation are
> recorded — calls to the office during business hours are not.
>
> The resident hears an announcement before the call is connected. This notice
> is yours: by taking an on-call shift, you agree to be recorded on the calls
> you answer during it.
>
> Recordings are kept in Milestone's phone system and can be played back by
> office staff who have the on-call dashboard password. They are used to write
> up work orders and to establish what was said when an incident is disputed.
> They are not used to monitor your performance call by call.
>
> Questions about any of this go to [name] before your next shift.

That last paragraph is a commitment, so keep it only if it is true of how you
intend to use the recordings.

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

## Transcripts and summaries

Only recorded calls are transcribed, so this does nothing until
`ONCALL_RECORD_CALLS` is on.

### Setting it up

> **Twilio sells two products under almost the same name.** "Conversation
> Intelligence" (newer) deals in *Intelligence configurations* with IDs like
> `intelligence_configuration_01m2…`. "Conversation Intelligence **(classic)**"
> deals in *Services* with SIDs like `GA…`. This app speaks to the classic API
> at `intelligence.twilio.com/v2`, so it needs the second one. The newer
> product's ID is silently useless here — it is accepted by the form, then
> every transcription request fails.

1. **Twilio Console → All products → Conversation Intelligence (classic) →
   Services → Create new Service.** The classic section is usually not in the
   main sidebar; reach it through *All products* or the console search box, and
   check the heading says *(classic)* before creating anything. Give the Service
   a name, set the language to English, and leave auto-transcribe off — this app
   asks for each transcript explicitly, so it transcribes exactly the calls it
   recorded and nothing else.
2. Set that Service's **webhook URL** to
   `https://<your-app>.vercel.app/api/twilio/transcript`, method **POST**.
3. Paste the Service SID (`GA` plus 32 hex characters) into
   `TWILIO_INTELLIGENCE_SERVICE_SID` on Vercel.
4. Run [`docs/oncall-transcripts.sql`](oncall-transcripts.sql) in the Supabase
   SQL editor.
5. Optional: set `ANTHROPIC_API_KEY` for the summaries. Without it you get the
   transcript and no summary, which is still a large step up from audio.

If the classic section is hard to find in the console, the same Service can be
created over the API, webhook and all:

```bash
curl -X POST "https://intelligence.twilio.com/v2/Services" \
  --data-urlencode "UniqueName=milestone-oncall" \
  --data-urlencode "LanguageCode=en-US" \
  --data-urlencode "WebhookUrl=https://<your-app>.vercel.app/api/twilio/transcript" \
  --data-urlencode "WebhookHttpMethod=POST" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN"
```

The `sid` in the response is the value to paste. Twilio may require the
Predictive and Generative AI/ML Features Addendum to be accepted in the console
once before the API will create a Service; if the call is refused on those
grounds, accept it there and run the command again.

**On Vercel, a new environment variable only reaches the next build.** Adding
the SID does nothing to the deployment already serving traffic — redeploy, then
open `/api/oncall/status` and read the `transcription` field:

| `transcription` | Means |
| --- | --- |
| `summarized` | The whole chain is live: recorded, transcribed, summarized. |
| `transcript_only` | Working, but `ANTHROPIC_API_KEY` is unset, so no note is written. |
| `no_recordings` | A Service is set but `ONCALL_RECORD_CALLS` is off, so it never receives audio. |
| `misconfigured` | The SID is not `GA` plus 32 hex — usually the newer product's ID. The `warnings` list says which. |
| `off` | No `TWILIO_INTELLIGENCE_SERVICE_SID` at all. |

If the field is missing from the response entirely, the deployment predates
this check and has not picked up the new variables either.

### What it costs

At Twilio's published rates, per 5-minute call: recording $0.0125, storage
$0.0025/month, transcription $0.12, summary about $0.013. Twenty after-hours
calls a month is roughly **$3**. The storage line is the only one that grows —
it accrues for as long as you keep the audio, which is the argument for setting
a retention period rather than the transcription bill.

Transcription was put on Twilio rather than a dedicated vendor (Deepgram and
AssemblyAI are five to ten times cheaper per minute) for one reason: the audio
never leaves a company that already has it. At two dollars a month the saving
does not pay for a second vendor holding recordings of residents. If call
volume ever grew fiftyfold, that trade is worth revisiting.

### How it hangs together

```
recording finishes
  └─ /api/twilio/recording files the call, then asks for a transcript
       (CustomerKey = the recording SID, so the job carries its own return address)
           ↓ minutes later
     Conversational Intelligence posts to /api/twilio/transcript
  └─ that route reads the status, the recording and the words back from Twilio,
     has Claude summarize them, and writes both onto the call
           ↓
     /calls shows the summary, folds the transcript away beneath it, and the
     Copy note button produces a note that is already most of the way written
```

The webhook **believes nothing it is sent.** Twilio does not document a
signature on this callback, so the transcript ID is checked for shape and every
fact after that is read back over an authenticated request. A forged post costs
one wasted API call and can change nothing.

### Two things worth deciding

- **Keep transcripts for how long?** A transcript is the same conversation in a
  form that is searchable, copy-pasteable and easy to forward. It sits behind
  the same password as the audio, but it does not have to have the same
  lifespan, and the argument for keeping it longer (an archive you can search)
  cuts against the argument for keeping it shorter (it is a record of a
  resident's bad night).
- **Read the first few.** The summary is written from what was said, and it is
  told not to invent a cause or a fix nobody mentioned — but it is worth
  reading the first handful against their recordings before anyone starts
  pasting them into work orders unread.

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
| Recordings appear but never get a transcript | `TWILIO_INTELLIGENCE_SERVICE_SID` unset, holding the newer product's `intelligence_configuration_…` ID, or the Service's webhook does not point here | `/api/oncall/status` reports `transcription` and the reason in `warnings`; Vercel logs show `"stage":"transcribe_requested"` |
| Everything looks right but nothing changed | Environment variables were added after the running deployment was built | `/api/oncall/status` still reports the old `transcription` value, or omits the field; redeploy |
| Transcripts appear but never a summary | `ANTHROPIC_API_KEY` unset, or the call failed | Vercel logs show `"stage":"transcript","summarized":false` and the error |
| A transcript never arrives | The Service webhook is wrong, or the transcript failed inside Twilio | Twilio Console → Conversational Intelligence → Transcripts shows each one's status |

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
| `src/app/api/twilio/transcript/route.ts` | Stores the words and the summary when Twilio says they are ready |
| `src/lib/oncall/intelligence.ts` | Twilio Conversational Intelligence: a recording in, words out |
| `src/lib/oncall/summary.ts` | The transcript, as the note that goes in a work order |
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
