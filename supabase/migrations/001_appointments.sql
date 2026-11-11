-- Run in the Supabase SQL Editor. Uses a private schema, separate from legacy Flask tables.
begin;
create schema if not exists appt_private;
revoke all on schema appt_private from public, anon, authenticated;

create table if not exists appt_private.events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  description text not null default '' check (length(description) <= 3000),
  location text not null default '' check (length(location) <= 240),
  default_capacity integer not null default 1 check (default_capacity between 1 and 10000),
  created_at timestamptz not null default now()
);
create table if not exists appt_private.slots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references appt_private.events(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity integer not null check (capacity between 1 and 10000),
  reserved integer not null default 0 check (reserved >= 0 and reserved <= capacity),
  check (ends_at > starts_at),
  unique (event_id, starts_at)
);
create index if not exists appt_slots_availability on appt_private.slots(event_id, starts_at);
create table if not exists appt_private.bookings (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  slot_id uuid not null references appt_private.slots(id),
  name text not null check (length(btrim(name)) between 1 and 160),
  email text not null default '' check (length(email) <= 254),
  phone text not null default '' check (length(phone) <= 40),
  notes text not null default '' check (length(notes) <= 3000),
  created_at timestamptz not null default now(),
  check (email <> '' or phone <> '')
);
create table if not exists appt_private.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table if not exists appt_private.jobs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references appt_private.bookings(id),
  kind text not null check (kind in ('email', 'calendar')),
  state text not null default 'queued' check (state in ('queued', 'processing', 'sent', 'failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  last_error text,
  completed_at timestamptz,
  unique (booking_id, kind)
);
create index if not exists appt_jobs_pending on appt_private.jobs(state, available_at);
alter table appt_private.events enable row level security;
alter table appt_private.slots enable row level security;
alter table appt_private.bookings enable row level security;
alter table appt_private.admins enable row level security;
alter table appt_private.jobs enable row level security;
revoke all on all tables in schema appt_private from public, anon, authenticated;

create or replace function appt_private.require_admin() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from appt_private.admins where user_id = auth.uid()) then
    raise exception 'An authorized admin account is required.' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.appt_public_events() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name,
    'description', e.description, 'location', e.location, 'default_capacity', e.default_capacity)
    order by e.name, e.id), '[]'::jsonb) from appt_private.events e;
$$;

create or replace function public.appt_public_slots(p_event_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'starts_at', s.starts_at,
    'ends_at', s.ends_at, 'remaining', s.capacity - s.reserved) order by s.starts_at), '[]'::jsonb)
  from appt_private.slots s where s.event_id = p_event_id and s.starts_at > now();
$$;

create or replace function appt_private.receipt(p_booking_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', b.id, 'name', b.name, 'event_name', e.name,
    'starts_at', s.starts_at, 'ends_at', s.ends_at, 'location', e.location)
  from appt_private.bookings b join appt_private.slots s on s.id = b.slot_id
    join appt_private.events e on e.id = s.event_id where b.id = p_booking_id;
$$;

create or replace function public.appt_book(p_slot_id uuid, p_request_id uuid,
  p_name text, p_email text, p_phone text, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  existing appt_private.bookings%rowtype;
  booking_id uuid;
  slot_id uuid;
begin
  p_name := btrim(coalesce(p_name, ''));
  p_email := btrim(coalesce(p_email, ''));
  p_phone := btrim(coalesce(p_phone, ''));
  p_notes := btrim(coalesce(p_notes, ''));
  if p_request_id is null or p_slot_id is null or length(p_name) not between 1 and 160
    or length(p_email) > 254 or length(p_phone) > 40 or length(p_notes) > 3000
    or (p_email = '' and p_phone = '')
    or (p_email <> '' and p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Enter your name and a valid email address or phone number.';
  end if;
  -- Serializes duplicate network retries, even if different slot IDs are supplied.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select * into existing from appt_private.bookings where request_id = p_request_id;
  if found then
    if existing.slot_id <> p_slot_id or existing.name <> p_name or existing.email <> p_email
      or existing.phone <> p_phone or existing.notes <> p_notes then
      raise exception 'This request already saved a booking with different details. Check your confirmation before booking again.';
    end if;
    return appt_private.receipt(existing.id);
  end if;
  -- The guarded update takes a row lock; the booking and capacity update commit together.
  update appt_private.slots set reserved = reserved + 1
    where id = p_slot_id and starts_at > now() and reserved < capacity returning id into slot_id;
  if slot_id is null then raise exception 'That time is no longer available.'; end if;
  insert into appt_private.bookings(request_id, slot_id, name, email, phone, notes)
    values(p_request_id, p_slot_id, p_name, p_email, p_phone, p_notes) returning id into booking_id;
  insert into appt_private.jobs(booking_id, kind) values(booking_id, 'email'), (booking_id, 'calendar');
  return appt_private.receipt(booking_id);
end;
$$;

create or replace function appt_private.generate_workdays(p_event_id uuid, p_first date, p_last date)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  day date;
  start_time timestamptz;
  capacity_value integer;
  slot_index integer;
  total integer := 0;
begin
  if p_first is null or p_last is null or p_last < p_first or p_last - p_first > 366 then
    raise exception 'Choose a valid date range of at most one year.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text, 1));
  select default_capacity into capacity_value from appt_private.events where id = p_event_id;
  if not found then raise exception 'Person or event not found.'; end if;
  day := p_first;
  while day <= p_last loop
    if extract(isodow from day) between 1 and 5 then
      for slot_index in 0..13 loop
        start_time := (day + time '09:00' + slot_index * interval '30 minutes') at time zone 'America/New_York';
        if start_time > now() and not exists(select 1 from appt_private.slots
          where event_id = p_event_id and starts_at < start_time + interval '30 minutes' and ends_at > start_time) then
          insert into appt_private.slots(event_id, starts_at, ends_at, capacity)
            values(p_event_id, start_time, start_time + interval '30 minutes', capacity_value);
          total := total + 1;
        end if;
      end loop;
    end if;
    day := day + 1;
  end loop;
  return total;
end;
$$;

create or replace function public.appt_admin_create_event(p_name text, p_description text,
  p_location text, p_capacity integer, p_workdays boolean default true) returns uuid
language plpgsql security definer set search_path = '' as $$
declare event_id uuid; today date := (now() at time zone 'America/New_York')::date;
begin
  perform appt_private.require_admin();
  insert into appt_private.events(name, description, location, default_capacity)
    values(btrim(p_name), coalesce(p_description, ''), coalesce(p_location, ''), p_capacity) returning id into event_id;
  if p_workdays then perform appt_private.generate_workdays(event_id, today, today + 29); end if;
  return event_id;
end;
$$;

create or replace function public.appt_admin_add_workdays(p_event_id uuid, p_first date, p_last date)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  perform appt_private.require_admin();
  return appt_private.generate_workdays(p_event_id, p_first, p_last);
end;
$$;

create or replace function appt_private.eastern_instant(local_time timestamp) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare result timestamptz := local_time at time zone 'America/New_York';
begin
  if local_time is null or result at time zone 'America/New_York' <> local_time
    or (result - interval '1 hour') at time zone 'America/New_York' = local_time
    or (result + interval '1 hour') at time zone 'America/New_York' = local_time then
    raise exception 'Choose a time outside the daylight saving transition hour.';
  end if;
  return result;
end;
$$;

create or replace function public.appt_admin_add_slot(p_event_id uuid, p_start timestamp,
  p_end timestamp, p_capacity integer default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare start_time timestamptz; end_time timestamptz; capacity_value integer; slot_id uuid;
begin
  perform appt_private.require_admin();
  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text, 1));
  start_time := appt_private.eastern_instant(p_start);
  end_time := appt_private.eastern_instant(p_end);
  if start_time <= now() or end_time <= start_time or p_start::date <> p_end::date then
    raise exception 'Choose a future start and later end on the same date.';
  end if;
  select coalesce(p_capacity, default_capacity) into capacity_value from appt_private.events where id = p_event_id;
  if not found then raise exception 'Person or event not found.'; end if;
  if exists(select 1 from appt_private.slots where event_id = p_event_id and starts_at < end_time and ends_at > start_time) then
    raise exception 'This time overlaps existing availability. Choose another time.';
  end if;
  insert into appt_private.slots(event_id, starts_at, ends_at, capacity)
    values(p_event_id, start_time, end_time, capacity_value) returning id into slot_id;
  return slot_id;
end;
$$;

create or replace function public.appt_admin_bookings(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform appt_private.require_admin();
  if p_offset is null or p_offset < 0 then raise exception 'Invalid page.'; end if;
  select coalesce(jsonb_agg(to_jsonb(rows) order by rows.created_at desc, rows.id), '[]'::jsonb) into result from (
    select b.id, b.name, b.email, b.phone, b.notes, b.created_at, s.starts_at, e.name as event_name,
      case when b.email = '' then 'not_requested' else coalesce(j_email.state, 'queued') end as email_status,
      coalesce(j_calendar.state, 'queued') as calendar_status
    from appt_private.bookings b join appt_private.slots s on s.id = b.slot_id
      join appt_private.events e on e.id = s.event_id
      left join appt_private.jobs j_email on j_email.booking_id = b.id and j_email.kind = 'email'
      left join appt_private.jobs j_calendar on j_calendar.booking_id = b.id and j_calendar.kind = 'calendar'
    order by b.created_at desc, b.id offset p_offset limit 500
  ) rows;
  return result;
end;
$$;

create or replace function public.appt_admin_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform appt_private.require_admin();
  select jsonb_build_object('events', public.appt_public_events(),
    'slots', (select coalesce(jsonb_agg(to_jsonb(s) order by s.starts_at), '[]'::jsonb)
      from appt_private.slots s where s.starts_at > now()),
    'bookings', public.appt_admin_bookings(0),
    'booking_count', (select count(*) from appt_private.bookings)) into result;
  return result;
end;
$$;

-- Only server-side service-role calls may claim jobs or acknowledge delivery.
create or replace function public.appt_claim_jobs(p_kinds text[], p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  with pending as (
    select id from appt_private.jobs where kind = any(p_kinds) and attempts < 10 and available_at <= now()
      and state in ('queued', 'processing') order by available_at for update skip locked limit greatest(1, least(p_limit, 20))
  ), claimed as (
    update appt_private.jobs j set state = 'processing', attempts = attempts + 1,
      available_at = now() + interval '10 minutes', lease_token = gen_random_uuid()
      from pending where pending.id = j.id returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'kind', j.kind, 'lease_token', j.lease_token,
    'booking', jsonb_build_object('id', b.id, 'name', b.name, 'email', b.email, 'phone', b.phone,
      'notes', b.notes, 'event_name', e.name, 'location', e.location, 'starts_at', s.starts_at, 'ends_at', s.ends_at))), '[]'::jsonb)
    into result from claimed j join appt_private.bookings b on b.id = j.booking_id
      join appt_private.slots s on s.id = b.slot_id join appt_private.events e on e.id = s.event_id;
  -- Exhausted leases from crashed workers should remain visible as failures.
  update appt_private.jobs set state = 'failed', last_error = 'Delivery attempts exhausted.'
    where state = 'processing' and attempts >= 10 and available_at <= now();
  return result;
end;
$$;

create or replace function public.appt_finish_job(p_id uuid, p_lease_token uuid, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update appt_private.jobs set
    state = case when p_error is null then 'sent' when attempts >= 10 then 'failed' else 'queued' end,
    last_error = left(p_error, 160),
    completed_at = case when p_error is null then now() else null end,
    available_at = now() + least(3600, 30 * power(2, attempts)::integer) * interval '1 second'
    where id = p_id and lease_token = p_lease_token and state = 'processing';
end;
$$;

-- PostgreSQL grants new functions to PUBLIC by default. Close that before explicit grants.
revoke all on all functions in schema appt_private from public, anon, authenticated;
revoke all on function public.appt_public_events() from public, anon, authenticated;
revoke all on function public.appt_public_slots(uuid) from public, anon, authenticated;
revoke all on function public.appt_book(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.appt_admin_create_event(text, text, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.appt_admin_add_workdays(uuid, date, date) from public, anon, authenticated;
revoke all on function public.appt_admin_add_slot(uuid, timestamp, timestamp, integer) from public, anon, authenticated;
revoke all on function public.appt_admin_bookings(integer) from public, anon, authenticated;
revoke all on function public.appt_admin_dashboard() from public, anon, authenticated;
revoke all on function public.appt_claim_jobs(text[], integer) from public, anon, authenticated;
revoke all on function public.appt_finish_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.appt_public_events(), public.appt_public_slots(uuid),
  public.appt_book(uuid, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.appt_admin_create_event(text, text, text, integer, boolean),
  public.appt_admin_add_workdays(uuid, date, date), public.appt_admin_add_slot(uuid, timestamp, timestamp, integer),
  public.appt_admin_bookings(integer), public.appt_admin_dashboard() to authenticated;
grant execute on function public.appt_claim_jobs(text[], integer), public.appt_finish_job(uuid, uuid, text) to service_role;
commit;
