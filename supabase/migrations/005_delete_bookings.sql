-- Delete from active views while retaining a private audit record and releasing capacity.
begin;
alter table appt_private.bookings add column if not exists deleted_at timestamptz;
alter table appt_private.bookings add column if not exists deleted_by uuid references auth.users(id) on delete set null;
alter table appt_private.jobs drop constraint if exists jobs_kind_check;
do $$ begin
  if not exists(select 1 from pg_constraint where conname = 'appt_jobs_kind_check'
    and conrelid = 'appt_private.jobs'::regclass) then
    alter table appt_private.jobs add constraint appt_jobs_kind_check check(kind in ('email','calendar','calendar_delete'));
  end if;
end $$;

create or replace function public.appt_admin_delete_booking(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  target appt_private.bookings%rowtype;
  event_id uuid;
  starts_at timestamptz;
  cleanup_after timestamptz;
begin
  perform appt_private.require_admin();
  select s.event_id, s.starts_at into event_id, starts_at from appt_private.bookings b
    join appt_private.slots s on s.id = b.slot_id where b.id = p_id;
  if not found then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(event_id::text || ':' ||
    (starts_at at time zone 'America/New_York')::date::text, 2));
  select * into target from appt_private.bookings where id = p_id for update;
  if target.deleted_at is not null then return; end if;
  -- Lock delivery rows before inspecting leases, including claims racing with deletion.
  perform 1 from appt_private.jobs where booking_id = p_id order by id for update;
  select coalesce(max(available_at) filter(where kind = 'calendar' and state = 'processing'), now())
    into cleanup_after from appt_private.jobs where booking_id = p_id;
  -- An already claimed create may still finish. Cleanup waits beyond that lease.
  if cleanup_after > now() then cleanup_after := cleanup_after + interval '30 seconds'; end if;
  update appt_private.slots set reserved = reserved - 1 where id = target.slot_id and reserved > 0;
  if not found then raise exception 'Booking capacity is inconsistent. No changes were saved.'; end if;
  update appt_private.bookings set deleted_at = now(), deleted_by = auth.uid() where id = p_id;
  update appt_private.jobs set state = 'failed', lease_token = null, last_error = 'Booking deleted by admin.'
    where booking_id = p_id and kind in ('email','calendar') and state <> 'sent';
  insert into appt_private.jobs(booking_id, kind, available_at)
    values(p_id, 'calendar_delete', greatest(now(), cleanup_after)) on conflict(booking_id, kind) do nothing;
end;
$$;

create or replace function appt_private.receipt(p_booking_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object('id', b.id, 'name', b.name, 'event_name', e.name,
    'starts_at', s.starts_at, 'ends_at', s.ends_at, 'location', e.location) into result
    from appt_private.bookings b join appt_private.slots s on s.id = b.slot_id
      join appt_private.events e on e.id = s.event_id where b.id = p_booking_id and b.deleted_at is null;
  if not found then raise exception 'This booking was deleted. Please choose a time to make a new booking.'; end if;
  return result;
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
    where b.deleted_at is null order by b.created_at desc, b.id offset p_offset limit 500
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
    'bookings', public.appt_admin_bookings(0),
    'booking_count', (select count(*) from appt_private.bookings where deleted_at is null),
    'referral_links', (select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('booking_count',
      (select count(*) from appt_private.bookings b where b.referral_link_id = r.id and b.deleted_at is null))
      order by r.created_at), '[]'::jsonb) from appt_private.referral_links r where r.deleted_at is null));
end;
$$;
revoke all on function public.appt_admin_delete_booking(uuid) from public, anon, authenticated;
grant execute on function public.appt_admin_delete_booking(uuid) to authenticated;
revoke all on function appt_private.receipt(uuid) from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
