-- Run once in Supabase SQL Editor after 001. Adds flexible date/hour slot generation.
begin;
create or replace function public.appt_admin_generate_slots(
  p_event_id uuid, p_first date, p_last date, p_first_start time, p_last_start time,
  p_minutes integer default 30, p_capacity integer default null,
  p_weekdays boolean default true, p_replace boolean default false
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  day date;
  local_start timestamp;
  start_time timestamptz;
  end_time timestamptz;
  capacity_value integer;
  added integer := 0;
  removed integer := 0;
  preserved integer := 0;
  conflicts integer := 0;
begin
  perform appt_private.require_admin();
  if p_first is null or p_last is null or p_last < p_first or p_last - p_first > 366
    or p_last < (now() at time zone 'America/New_York')::date then
    raise exception 'Choose a current or future date range of at most one year.';
  end if;
  if p_first_start is null or p_last_start is null or p_last_start < p_first_start
    or p_minutes is null or p_minutes < 5 or p_minutes > 480
    or extract(second from p_first_start) <> 0 or extract(second from p_last_start) <> 0
    or (extract(epoch from (p_last_start - p_first_start))::integer % (p_minutes * 60)) <> 0
    or p_last_start + make_interval(mins => p_minutes) <= p_last_start then
    raise exception 'Choose first and last meeting start times aligned to the meeting length, ending before midnight.';
  end if;
  if p_replace is null or p_weekdays is null then raise exception 'Choose valid availability options.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text, 1));
  select coalesce(p_capacity, default_capacity) into capacity_value from appt_private.events where id = p_event_id;
  if not found then raise exception 'Person or event not found.'; end if;
  if capacity_value not between 1 and 10000 then raise exception 'Capacity must be between 1 and 10,000.'; end if;

  -- Lock existing target rows before checking for bookings or replacing anything.
  -- A simultaneous reservation either commits first and is preserved, or sees its old slot removed.
  perform 1 from appt_private.slots s where s.event_id = p_event_id and s.starts_at > now()
    and (s.starts_at at time zone 'America/New_York')::date between p_first and p_last
    and (not p_weekdays or extract(isodow from s.starts_at at time zone 'America/New_York') between 1 and 5)
    order by s.starts_at for update;
  select count(*) into preserved from appt_private.slots s where s.event_id = p_event_id and s.starts_at > now()
    and (s.starts_at at time zone 'America/New_York')::date between p_first and p_last
    and (not p_weekdays or extract(isodow from s.starts_at at time zone 'America/New_York') between 1 and 5)
    and (s.reserved > 0 or exists(select 1 from appt_private.bookings b where b.slot_id = s.id));
  if p_replace then
    delete from appt_private.slots s where s.event_id = p_event_id and s.starts_at > now()
      and (s.starts_at at time zone 'America/New_York')::date between p_first and p_last
      and (not p_weekdays or extract(isodow from s.starts_at at time zone 'America/New_York') between 1 and 5)
      and s.reserved = 0 and not exists(select 1 from appt_private.bookings b where b.slot_id = s.id);
    get diagnostics removed = row_count;
  end if;
  day := p_first;
  while day <= p_last loop
    if not p_weekdays or extract(isodow from day) between 1 and 5 then
      local_start := day + p_first_start;
      while local_start <= day + p_last_start loop
        start_time := appt_private.eastern_instant(local_start);
        end_time := appt_private.eastern_instant(local_start + make_interval(mins => p_minutes));
        if start_time > now() then
          if not exists(select 1 from appt_private.slots s where s.event_id = p_event_id
            and s.starts_at < end_time and s.ends_at > start_time) then
            insert into appt_private.slots(event_id, starts_at, ends_at, capacity)
              values(p_event_id, start_time, end_time, capacity_value);
            added := added + 1;
          else
            conflicts := conflicts + 1;
          end if;
        end if;
        local_start := local_start + make_interval(mins => p_minutes);
      end loop;
    end if;
    day := day + 1;
  end loop;
  return jsonb_build_object('added', added, 'removed', removed, 'preserved', preserved, 'conflicts', conflicts);
end;
$$;
revoke all on function public.appt_admin_generate_slots(uuid, date, date, time, time, integer, integer, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.appt_admin_generate_slots(uuid, date, date, time, time, integer, integer, boolean, boolean)
  to authenticated;
notify pgrst, 'reload schema';
commit;
