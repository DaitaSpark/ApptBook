-- Adds per-event staged release and private salesperson/channel attribution.
-- Existing events stay unlimited and existing bookings stay untracked.
begin;
alter table appt_private.events add column if not exists open_times_per_day integer
  check (open_times_per_day between 1 and 100);
create table if not exists appt_private.referral_links (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references appt_private.events(id),
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  label text not null check (length(btrim(label)) between 1 and 120),
  kind text not null check (kind in ('salesperson', 'channel')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(event_id, kind, label)
);
alter table appt_private.referral_links enable row level security;
revoke all on appt_private.referral_links from public, anon, authenticated;
alter table appt_private.bookings add column if not exists referral_link_id uuid references appt_private.referral_links(id);
alter table appt_private.bookings add column if not exists source_label text;
alter table appt_private.bookings add column if not exists source_kind text;
create index if not exists appt_bookings_referral on appt_private.bookings(referral_link_id);

create or replace function public.appt_public_events() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name,
    'description', e.description, 'location', e.location, 'default_capacity', e.default_capacity,
    'open_times_per_day', e.open_times_per_day) order by e.name, e.id), '[]'::jsonb)
  from appt_private.events e;
$$;

create or replace function public.appt_public_slots(p_event_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with candidates as (
    select s.*, e.open_times_per_day,
      count(*) filter(where s.reserved < s.capacity) over (
        partition by (s.starts_at at time zone 'America/New_York')::date order by s.starts_at, s.id
        rows between unbounded preceding and current row) as open_position
    from appt_private.slots s join appt_private.events e on e.id = s.event_id
    where s.event_id = p_event_id and s.starts_at > now()
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'starts_at', starts_at, 'ends_at', ends_at,
    'remaining', capacity - reserved, 'is_open', reserved < capacity and
      (open_times_per_day is null or open_position <= open_times_per_day)) order by starts_at), '[]'::jsonb)
  from candidates;
$$;

create or replace function public.appt_ref_valid(p_event_id uuid, p_token text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from appt_private.referral_links where event_id = p_event_id and token = p_token and active);
$$;

create or replace function public.appt_book_tracked(p_slot_id uuid, p_request_id uuid,
  p_name text, p_email text, p_phone text, p_notes text, p_ref text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  existing appt_private.bookings%rowtype;
  target appt_private.slots%rowtype;
  source appt_private.referral_links%rowtype;
  booking_id uuid;
  release_limit integer;
  earlier_count integer;
begin
  p_name := btrim(coalesce(p_name, ''));
  p_email := btrim(coalesce(p_email, ''));
  p_phone := btrim(coalesce(p_phone, ''));
  p_notes := btrim(coalesce(p_notes, ''));
  p_ref := nullif(btrim(p_ref), '');
  if p_request_id is null or p_slot_id is null or length(p_name) not between 1 and 160
    or length(p_email) > 254 or length(p_phone) > 40 or length(p_notes) > 3000
    or (p_email = '' and p_phone = '')
    or (p_email <> '' and p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Enter your name and a valid email address or phone number.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select * into existing from appt_private.bookings where request_id = p_request_id;
  if found then
    if existing.slot_id <> p_slot_id or existing.name <> p_name or existing.email <> p_email
      or existing.phone <> p_phone or existing.notes <> p_notes then
      raise exception 'This request already saved a booking with different details. Check your confirmation before booking again.';
    end if;
    -- A retry never rewrites the original attribution, even after a link is disabled.
    return appt_private.receipt(existing.id);
  end if;
  select * into target from appt_private.slots where id = p_slot_id;
  if not found then raise exception 'That time is no longer available.'; end if;
  -- One release decision per event/day at a time, shared across all sales links.
  perform pg_advisory_xact_lock(hashtextextended(target.event_id::text || ':' ||
    (target.starts_at at time zone 'America/New_York')::date::text, 2));
  select open_times_per_day into release_limit from appt_private.events where id = target.event_id for share;
  if p_ref is not null then
    select * into source from appt_private.referral_links
      where token = p_ref and event_id = target.event_id and active for share;
    if not found then raise exception 'This booking link is no longer active for this event. Please contact the organizer.'; end if;
  end if;
  if release_limit is not null then
    select count(*) into earlier_count from appt_private.slots s where s.event_id = target.event_id
      and s.starts_at > now() and s.reserved < s.capacity and s.starts_at < target.starts_at
      and (s.starts_at at time zone 'America/New_York')::date = (target.starts_at at time zone 'America/New_York')::date;
    if earlier_count >= release_limit then raise exception 'This time is not yet open. Please select an open time.'; end if;
  end if;
  update appt_private.slots set reserved = reserved + 1
    where id = p_slot_id and starts_at > now() and reserved < capacity returning * into target;
  if not found then raise exception 'That time is no longer available.'; end if;
  insert into appt_private.bookings(request_id, slot_id, name, email, phone, notes,
    referral_link_id, source_label, source_kind)
    values(p_request_id, p_slot_id, p_name, p_email, p_phone, p_notes, source.id, source.label, source.kind)
    returning id into booking_id;
  insert into appt_private.jobs(booking_id, kind) values(booking_id, 'email'), (booking_id, 'calendar');
  return appt_private.receipt(booking_id);
end;
$$;

-- Old clients also go through the release check; it cannot be bypassed via the old endpoint.
create or replace function public.appt_book(p_slot_id uuid, p_request_id uuid,
  p_name text, p_email text, p_phone text, p_notes text) returns jsonb
language sql security definer set search_path = '' as $$
  select public.appt_book_tracked(p_slot_id, p_request_id, p_name, p_email, p_phone, p_notes, null);
$$;

create or replace function public.appt_admin_set_release(p_event_id uuid, p_limit integer default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform appt_private.require_admin();
  if p_limit is not null and p_limit not between 1 and 100 then raise exception 'Choose 1–100 open times per day, or leave blank for all times.'; end if;
  update appt_private.events set open_times_per_day = p_limit where id = p_event_id;
  if not found then raise exception 'Person or event not found.'; end if;
end;
$$;

create or replace function public.appt_admin_create_referral(p_event_id uuid, p_label text, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result appt_private.referral_links%rowtype;
begin
  perform appt_private.require_admin();
  p_label := btrim(coalesce(p_label, ''));
  if length(p_label) not between 1 and 120 or p_kind is null or p_kind not in ('salesperson', 'channel') then
    raise exception 'Enter a salesperson or channel name and choose its type.';
  end if;
  insert into appt_private.referral_links(event_id, label, kind) values(p_event_id, p_label, p_kind)
    on conflict(event_id, kind, label) do update set active = true returning * into result;
  return to_jsonb(result);
end;
$$;

create or replace function public.appt_admin_set_referral(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform appt_private.require_admin();
  if p_active is null then raise exception 'Choose a valid link status.'; end if;
  update appt_private.referral_links set active = p_active where id = p_id;
  if not found then raise exception 'Tracking link not found.'; end if;
end;
$$;

create or replace function public.appt_admin_bookings(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform appt_private.require_admin();
  if p_offset is null or p_offset < 0 then raise exception 'Invalid page.'; end if;
  select coalesce(jsonb_agg(to_jsonb(rows) order by rows.created_at desc, rows.id), '[]'::jsonb) into result from (
    select b.id, b.name, b.email, b.phone, b.notes, b.created_at, b.referral_link_id, b.source_label, b.source_kind,
      s.starts_at, s.event_id, e.name as event_name,
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
begin
  perform appt_private.require_admin();
  return jsonb_build_object('events', public.appt_public_events(),
    'slots', (select coalesce(jsonb_agg(to_jsonb(s) order by s.starts_at), '[]'::jsonb)
      from appt_private.slots s where s.starts_at > now()),
    'bookings', public.appt_admin_bookings(0), 'booking_count', (select count(*) from appt_private.bookings),
    'referral_links', (select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('booking_count',
      (select count(*) from appt_private.bookings b where b.referral_link_id = r.id)) order by r.created_at), '[]'::jsonb)
      from appt_private.referral_links r));
end;
$$;

revoke all on function public.appt_book_tracked(uuid,uuid,text,text,text,text,text),
  public.appt_ref_valid(uuid,text), public.appt_admin_set_release(uuid,integer),
  public.appt_admin_create_referral(uuid,text,text), public.appt_admin_set_referral(uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.appt_book_tracked(uuid,uuid,text,text,text,text,text),
  public.appt_ref_valid(uuid,text) to anon, authenticated;
grant execute on function public.appt_admin_set_release(uuid,integer), public.appt_admin_create_referral(uuid,text,text),
  public.appt_admin_set_referral(uuid,boolean) to authenticated;
notify pgrst, 'reload schema';
commit;
