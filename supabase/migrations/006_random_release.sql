-- Randomized release priority is assigned once per slot, shared by every visitor/link.
-- Public time buttons remain in chronological order; selectable choices are randomized.
begin;
alter table appt_private.slots add column if not exists release_priority uuid not null default gen_random_uuid();

create or replace function public.appt_public_slots(p_event_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with candidates as (
    select s.*, e.open_times_per_day,
      count(*) filter(where s.reserved < s.capacity) over (
        partition by (s.starts_at at time zone 'America/New_York')::date order by s.release_priority, s.id
        rows between unbounded preceding and current row) as open_position
    from appt_private.slots s join appt_private.events e on e.id = s.event_id
    where s.event_id = p_event_id and s.starts_at > now()
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'starts_at', starts_at, 'ends_at', ends_at,
    'remaining', capacity - reserved, 'is_open', reserved < capacity and
      (open_times_per_day is null or open_position <= open_times_per_day)) order by starts_at), '[]'::jsonb)
  from candidates;
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
  preceding_count integer;
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
    select count(*) into preceding_count from appt_private.slots s where s.event_id = target.event_id
      and s.starts_at > now() and s.reserved < s.capacity and (s.release_priority, s.id) < (target.release_priority, target.id)
      and (s.starts_at at time zone 'America/New_York')::date = (target.starts_at at time zone 'America/New_York')::date;
    if preceding_count >= release_limit then raise exception 'This time is not available. Please select an available time.'; end if;
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

revoke all on function public.appt_public_slots(uuid), public.appt_book_tracked(uuid,uuid,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.appt_public_slots(uuid), public.appt_book_tracked(uuid,uuid,text,text,text,text,text)
  to anon, authenticated;
notify pgrst, 'reload schema';
commit;
