-- Caller ID → which unit is calling, and the log of after-hours calls.
--
-- Run this once in the Supabase SQL editor. Two objects:
--
--   oncall_caller_lookup — a read-only view over tenant_directory that turns
--     every phone number on a tenant record into a bare 10-digit number, so an
--     incoming Twilio caller ID can be matched against it exactly. Nothing is
--     copied: the view reads the directory live, so a number corrected in
--     AppFolio this afternoon matches tonight.
--
--   oncall_calls — one row per recorded call leg or voicemail, written by the
--     Twilio webhooks after the call ends. This is what /calls reads back.
--
-- The phone line degrades rather than fails: if either object is missing or
-- Supabase is unreachable, the call still routes and the technician still gets
-- a text — just without the unit on it.

-- ─────────────────────────────────────────────────────────────────────────────
-- Caller ID → unit
-- ─────────────────────────────────────────────────────────────────────────────

-- Phone numbers in tenant_directory are whatever AppFolio exported: (206)
-- 555-1234, 206-555-1234, +1 206 555 1234, and ~100 records carrying two
-- numbers in one field. Stripping to digits and then reading off 10-digit runs
-- (skipping a leading country code) handles all of those, and yields one row
-- per number rather than per tenant — so a household with two cells matches on
-- either phone.
create or replace view public.oncall_caller_lookup
with (security_invoker = true) as
select
  t.id,
  (m.digits)[1]        as phone10,
  t.property_name,
  t.unit,
  t.tenant_name,
  t.status,
  t.tenant_type,
  -- Current residents first, so a number that once belonged to someone else
  -- never outranks the person living there now.
  case t.status when 'Current' then 0 when 'Notice' then 1 else 2 end as match_rank
from public.tenant_directory t
cross join lateral regexp_matches(
  regexp_replace(coalesce(t.phone, ''), '\D', '', 'g'),
  '1?(\d{10})',
  'g'
) as m(digits)
-- Past residents are left out on purpose: at 2am, "unit 304" is worse than
-- nothing if the person in 304 moved out in March.
where t.status in ('Current', 'Notice');

comment on view public.oncall_caller_lookup is
  'Tenant phone numbers as bare 10-digit values, for matching an inbound caller ID to a unit. Read by the after-hours maintenance line.';

-- The view carries resident names, units and phone numbers, so it is closed to
-- the browser-facing keys twice over: security_invoker makes the reader's own
-- row-level security apply (anon and authenticated have no policy on
-- tenant_directory, so they see nothing), and the grants come off as well.
-- Only the server, holding the service-role key, reads it.
revoke all on public.oncall_caller_lookup from anon, authenticated;

-- A sequential scan over ~2,500 directory rows answers in well under the
-- 2 seconds the phone line allows it, so this is deliberately un-indexed —
-- an index on the underlying text column could not serve the normalized match
-- anyway.

-- ─────────────────────────────────────────────────────────────────────────────
-- The call log
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.oncall_calls (
  id                uuid primary key default gen_random_uuid(),
  -- Twilio's identifiers. One call can produce more than one recording (the
  -- technician's leg, then the backup manager's), so the recording is the key
  -- and the call is what groups them.
  call_sid          text not null,
  recording_sid     text unique,
  recording_seconds integer,
  -- 'call' for a conversation someone answered, 'voicemail' for a message left.
  kind              text not null default 'call',
  caller_phone      text,
  -- Resolved from the tenant directory at the time of the call, and kept, so a
  -- note written next month still says who called tonight.
  property_name     text,
  unit              text,
  tenant_name       text,
  match_count       integer not null default 0,
  started_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

comment on table public.oncall_calls is
  'After-hours maintenance calls that produced a recording or a voicemail. Written by the Twilio webhooks, read by /calls.';
comment on column public.oncall_calls.match_count is
  'How many tenant records matched the caller ID. 0 = unknown number, 2+ = the unit shown is a guess.';

create index if not exists oncall_calls_started_at_idx
  on public.oncall_calls (started_at desc);
create index if not exists oncall_calls_call_sid_idx
  on public.oncall_calls (call_sid);

-- Same reasoning as oncall_techs: the server reaches Supabase with the
-- service-role key, which bypasses row-level security. RLS is on with no
-- permissive policy so the anon and authenticated keys cannot read residents'
-- call history.
alter table public.oncall_calls enable row level security;
