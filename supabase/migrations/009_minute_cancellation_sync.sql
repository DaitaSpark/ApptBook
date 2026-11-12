-- Apply after 008. Incremental Google cancellation checks use the existing minute schedule.
begin;
create table if not exists appt_private.calendar_sync (
  calendar_id text primary key,
  sync_token text,
  page_token text,
  lease_token uuid,
  lease_until timestamptz,
  last_polled timestamptz,
  last_attempt timestamptz not null default now(),
  last_error text
);
alter table appt_private.calendar_sync enable row level security;
revoke all on appt_private.calendar_sync from public, anon, authenticated;

create or replace function public.appt_claim_calendar_sync(p_calendar_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if nullif(btrim(p_calendar_id),'') is null then raise exception 'Calendar ID required.'; end if;
  insert into appt_private.calendar_audit(booking_id, calendar_id)
    select b.id, p_calendar_id from appt_private.bookings b
      join appt_private.jobs j on j.booking_id = b.id and j.kind = 'calendar' and j.state = 'sent'
      join appt_private.slots s on s.id = b.slot_id
    where b.deleted_at is null and s.ends_at > now() - interval '30 days'
    on conflict(booking_id) do nothing;
  insert into appt_private.calendar_sync(calendar_id) values(p_calendar_id) on conflict do nothing;
  update appt_private.calendar_sync set lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes', last_attempt = now()
    where calendar_id = p_calendar_id and (lease_token is null or lease_until <= now())
    returning jsonb_build_object('lease_token', lease_token, 'sync_token', sync_token, 'page_token', page_token) into result;
  return result;
end;
$$;

-- Commit each page and its cursor atomically; no cancellation can be skipped after a crash.
create or replace function public.appt_apply_calendar_sync_page(p_calendar_id text, p_lease_token uuid,
  p_items jsonb, p_next_page text default null, p_next_sync text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  target appt_private.calendar_audit%rowtype;
  cancelled integer := 0;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 250
    or (nullif(p_next_page,'') is null and nullif(p_next_sync,'') is null)
    or (p_next_page is not null and p_next_sync is not null)
    or length(coalesce(p_next_page,p_next_sync)) > 8192 then raise exception 'Invalid calendar sync page.'; end if;
  perform 1 from appt_private.calendar_sync where calendar_id = p_calendar_id and lease_token = p_lease_token for update;
  if not found then raise exception 'Calendar sync lease expired.'; end if;
  -- Lock all matching audit rows before taking any event/day capacity lock.
  -- This keeps a multi-cancellation page from deadlocking with a single-booking audit.
  perform a.booking_id from appt_private.calendar_audit a
    where a.calendar_id = p_calendar_id and exists (
      select 1 from jsonb_array_elements(p_items) e where e->>'id' = 'appt' || replace(a.booking_id::text,'-',''))
    order by a.booking_id for update;
  for item in select value from jsonb_array_elements(p_items) order by value->>'id' loop
    -- Ignore unrelated events and forged/mismatched booking reference metadata.
    select a.* into target from appt_private.calendar_audit a
      join appt_private.bookings b on b.id = a.booking_id
      join appt_private.jobs j on j.booking_id = b.id and j.kind = 'calendar' and j.state = 'sent'
      join appt_private.slots s on s.id = b.slot_id
      where a.calendar_id = p_calendar_id and b.deleted_at is null and s.ends_at > now() - interval '30 days'
        and 'appt' || replace(b.id::text,'-','') = item->>'id'
      for update of a;
    if not found then continue; end if;
    if nullif(item->>'booking_id','') is not null and item->>'booking_id' <> target.booking_id::text then continue; end if;
    if item->>'status' = 'cancelled' and target.verified then
      perform appt_private.cancel_booking(target.booking_id, 'google');
      update appt_private.calendar_audit set outcome = 'cancelled', checked_at = now(), lease_token = null,
        differences = '["Cancelled in Google Calendar."]'::jsonb, next_check = now() + interval '15 minutes'
        where booking_id = target.booking_id;
      cancelled := cancelled + 1;
    elsif item->>'status' = 'confirmed' and item->>'booking_id' = target.booking_id::text then
      -- Establish ownership for pre-upgrade entries without changing the full audit's timer/results.
      update appt_private.calendar_audit set verified = true where booking_id = target.booking_id;
    end if;
  end loop;
  update appt_private.calendar_sync set page_token = nullif(p_next_page,''),
    sync_token = coalesce(nullif(p_next_sync,''),sync_token),
    lease_token = case when nullif(p_next_page,'') is null then null else lease_token end,
    lease_until = case when nullif(p_next_page,'') is null then null else now() + interval '5 minutes' end,
    last_polled = case when nullif(p_next_page,'') is null then now() else last_polled end, last_error = null
    where calendar_id = p_calendar_id;
  return cancelled;
end;
$$;

create or replace function public.appt_release_calendar_sync(p_calendar_id text, p_lease_token uuid,
  p_reset boolean default false, p_error boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update appt_private.calendar_sync set lease_token = null, lease_until = null,
    sync_token = case when p_reset then null else sync_token end,
    page_token = case when p_reset then null else page_token end,
    last_error = case when p_error then 'Cancellation check could not complete; retrying automatically.'
      when p_reset then 'Google sync position expired; rebuilding automatically.' else null end
    where calendar_id = p_calendar_id and lease_token = p_lease_token;
end;
$$;

create or replace function public.appt_admin_calendar_audit() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform appt_private.require_admin();
  return jsonb_build_object('cancellation_sync', (select jsonb_build_object('last_polled', last_polled, 'last_error', last_error)
    from appt_private.calendar_sync order by last_attempt desc limit 1), 'last_checked', (select max(checked_at) from appt_private.calendar_audit),
    'pending', (select count(*) from appt_private.bookings b join appt_private.jobs j on j.booking_id = b.id and j.kind = 'calendar' and j.state = 'sent'
      join appt_private.slots s on s.id = b.slot_id left join appt_private.calendar_audit a on a.booking_id = b.id
      where b.deleted_at is null and s.ends_at > now() - interval '30 days' and a.checked_at is null),
    'issues', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
      select b.id, b.name, e.name as event_name, s.starts_at, a.outcome, a.differences, a.checked_at
      from appt_private.calendar_audit a join appt_private.bookings b on b.id = a.booking_id
        join appt_private.slots s on s.id = b.slot_id join appt_private.events e on e.id = s.event_id
      where (b.deleted_at is null and a.outcome in ('changed','missing','error'))
        or (a.outcome = 'cancelled' and a.checked_at > now() - interval '30 days')
      order by a.checked_at desc limit 100
    ) r));
end;
$$;

revoke all on function public.appt_claim_calendar_sync(text), public.appt_apply_calendar_sync_page(text,uuid,jsonb,text,text),
  public.appt_release_calendar_sync(text,uuid,boolean,boolean) from public, anon, authenticated;
grant execute on function public.appt_claim_calendar_sync(text), public.appt_apply_calendar_sync_page(text,uuid,jsonb,text,text),
  public.appt_release_calendar_sync(text,uuid,boolean,boolean) to service_role;
notify pgrst, 'reload schema';
commit;
