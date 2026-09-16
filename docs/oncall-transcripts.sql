-- Transcripts and summaries on the after-hours call log.
--
-- Run this once in the Supabase SQL editor, after docs/oncall-caller-lookup.sql.
--
-- The recording already tells you a call happened and which unit made it. These
-- columns are what it was about: the words, and the summary somebody pastes
-- into an AppFolio work order the next morning.
--
-- Twilio Conversational Intelligence produces the transcript from the recording
-- it already holds; Claude turns that into the summary. Both are optional —
-- with neither configured the log keeps working exactly as it does today.

alter table public.oncall_calls
  add column if not exists transcript_sid   text,
  add column if not exists transcript       text,
  add column if not exists summary          text,
  add column if not exists summary_model    text,
  add column if not exists transcribed_at   timestamptz;

comment on column public.oncall_calls.transcript_sid is
  'Twilio Conversational Intelligence transcript (GT...). Present once transcription has been requested.';
comment on column public.oncall_calls.transcript is
  'The call, speaker-labelled, one line per sentence. Resident PII — never expose to the anon key.';
comment on column public.oncall_calls.summary is
  'What the call was about, written for pasting into an AppFolio work order.';
comment on column public.oncall_calls.summary_model is
  'Which model wrote the summary, so a change in wording later has an explanation.';

-- The webhook finds its row by the recording it was asked to transcribe. That
-- column is already unique (and therefore indexed) from the original table, so
-- there is no index to add here.

-- Row-level security is already enabled on this table with no permissive
-- policy, so the transcript is reachable only with the service-role key —
-- which is server-side only. Nothing further to do here; this is a reminder
-- that these two columns are the most sensitive in the schema.
