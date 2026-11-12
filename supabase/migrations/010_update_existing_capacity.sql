-- Update capacity in place, including slots with cancelled booking history.
-- No slots, bookings, delivery jobs, dates or release priorities are deleted/recreated.
begin;
create or replace function public.appt_admin_set_capacity(p_event_id uuid, p_capacity integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  updated integer;
  conflict_time timestamptz;
  conflict_count integer;
begin
  perform appt_private.require_admin();
  if p_capacity is null or p_capacity not between 1 and 10000 then
    raise exception 'Places per meeting must be between 1 and 10,000.';
  end if;
  -- Bookers take a shared event lock before reserving slots: finish them before this change.
  perform 1 from appt_private.events where id = p_event_id for update;
  if not found then raise exception 'Choose a valid person or event.'; end if;
  perform 1 from appt_private.slots where event_id = p_event_id and starts_at > now()
    order by starts_at, id for update;
  if exists(select 1 from appt_private.slots s where s.event_id = p_event_id and s.starts_at > now()
    and s.reserved <> (select count(*) from appt_private.bookings b where b.slot_id = s.id and b.deleted_at is null)) then
    raise exception 'Active booking totals are inconsistent. No capacities were changed; contact support.';
  end if;
  select starts_at, reserved into conflict_time, conflict_count from appt_private.slots
    where event_id = p_event_id and starts_at > now() and reserved > p_capacity order by starts_at limit 1;
  if found then
    raise exception 'Cannot set % places: % Eastern already has % active bookings. No capacities were changed.',
      p_capacity, to_char(conflict_time at time zone 'America/New_York','Mon DD, YYYY HH12:MI AM'), conflict_count;
  end if;
  update appt_private.slots set capacity = p_capacity where event_id = p_event_id and starts_at > now();
  get diagnostics updated = row_count;
  update appt_private.events set default_capacity = p_capacity where id = p_event_id;
  return jsonb_build_object('updated', updated, 'capacity', p_capacity);
end;
$$;
revoke all on function public.appt_admin_set_capacity(uuid,integer) from public, anon, authenticated;
grant execute on function public.appt_admin_set_capacity(uuid,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
