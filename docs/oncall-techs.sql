-- The technician roster for the scheduling dashboard.
--
-- Run this once in the Supabase SQL editor. The phone line never reads this
-- table: every shift carries its own phone number on the calendar event, so
-- routing keeps working even if Supabase is unreachable or a technician is
-- later removed from the roster.

create table if not exists public.oncall_techs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text not null,
  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now()
);

comment on table public.oncall_techs is
  'Maintenance technicians available for the after-hours on-call rotation.';
comment on column public.oncall_techs.phone is
  'Mobile number. Any common format works — the app normalizes to E.164.';
comment on column public.oncall_techs.active is
  'Unset this instead of deleting, so historical shifts keep their meaning.';

-- The app reaches Supabase with the service-role key, which bypasses row-level
-- security. RLS is enabled anyway with no permissive policy, so the anon and
-- authenticated keys cannot read technicians' phone numbers.
alter table public.oncall_techs enable row level security;

-- Seed the roster. Replace with your real technicians.
-- insert into public.oncall_techs (name, phone) values
--   ('Mike Alvarez', '206-555-0134'),
--   ('Dana Kim',     '206-555-0175');
