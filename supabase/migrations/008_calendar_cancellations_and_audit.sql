-- Apply after 007. Google cancellations are authoritative only for verified app entries.
begin;
alter table appt_private.bookings add column if not exists cancellation_origin text;
create table if not exists appt_private.calendar_audit (
  booking_id uuid primary key references appt_private.bookings(id),
  calendar_id text not null,
  verified boolean not null default false,
  outcome text not null default 'pending' check(outcome in ('pending','ok','changed','missing','error','cancelled')),
  differences jsonb not null default '[]',
  checked_at timestamptz,
  next_check timestamptz not null default now(),
  lease_token uuid
);
alter table appt_private.calendar_audit enable row level security;
revoke all on appt_private.calendar_audit from public, anon, authenticated;

create or replace function appt_private.cancel_booking(p_id uuid, p_origin text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  target appt_private.bookings%rowtype;
  event_id uuid;
  starts_at timestamptz;
  cleanup_after timestamptz;
begin
  if p_origin not in ('admin','google') then raise exception 'Invalid cancellation origin.'; end if;
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
  update appt_private.bookings set deleted_at = now(), deleted_by = auth.uid(), cancellation_origin = p_origin where id = p_id;
  update appt_private.jobs set state = 'failed', lease_token = null, last_error = 'Booking cancelled from ' || p_origin || '.'
    where booking_id = p_id and kind in ('email','calendar') and state <> 'sent';
  if p_origin = 'admin' then
  insert into appt_private.jobs(booking_id, kind, available_at)
    values(p_id, 'calendar_delete', greatest(now(), cleanup_after)) on conflict(booking_id, kind) do nothing;
  end if;
end;
$$;


create or replace function public.appt_admin_delete_booking(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform appt_private.require_admin();
  perform appt_private.cancel_booking(p_id, 'admin');
end;
$$;

-- Record the destination after a successful outbound creation, before acknowledging its job.
create or replace function public.appt_calendar_delivered(p_id uuid, p_calendar_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(btrim(p_calendar_id),'') is null then raise exception 'Calendar ID required.'; end if;
  insert into appt_private.calendar_audit(booking_id, calendar_id, verified)
    select b.id, p_calendar_id, true from appt_private.bookings b where b.id = p_id and b.deleted_at is null
  on conflict(booking_id) do update set verified = true
    where appt_private.calendar_audit.calendar_id = excluded.calendar_id;
end;
$$;

create or replace function public.appt_claim_calendar_audit(p_calendar_id text, p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if nullif(btrim(p_calendar_id),'') is null then raise exception 'Calendar ID required.'; end if;
  -- Adopt pre-upgrade deliveries conservatively: GET must verify ownership before cancellation sync.
  insert into appt_private.calendar_audit(booking_id, calendar_id)
    select b.id, p_calendar_id from appt_private.bookings b
      join appt_private.jobs j on j.booking_id = b.id and j.kind = 'calendar' and j.state = 'sent'
      join appt_private.slots s on s.id = b.slot_id
    where b.deleted_at is null and s.ends_at > now() - interval '30 days'
    on conflict(booking_id) do nothing;
  with due as (
    select a.booking_id from appt_private.calendar_audit a
      join appt_private.bookings b on b.id = a.booking_id
      join appt_private.slots s on s.id = b.slot_id
      join appt_private.jobs j on j.booking_id = b.id and j.kind = 'calendar' and j.state = 'sent'
    where a.calendar_id = p_calendar_id and b.deleted_at is null
      and s.ends_at > now() - interval '30 days' and a.next_check <= now()
    order by a.next_check, a.booking_id for update of a skip locked limit greatest(1,least(p_limit,20))
  ), claimed as (
    update appt_private.calendar_audit a set next_check = now() + interval '5 minutes', lease_token = gen_random_uuid()
      from due where a.booking_id = due.booking_id returning a.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('lease_token', a.lease_token, 'verified', a.verified,
    'booking', jsonb_build_object('id', b.id, 'name', b.name, 'email', b.email, 'phone', b.phone,
      'notes', b.notes, 'company', b.company, 'source_label', b.source_label, 'source_kind', b.source_kind,
      'event_name', e.name, 'location', e.location, 'starts_at', s.starts_at, 'ends_at', s.ends_at))), '[]'::jsonb)
    into result from claimed a join appt_private.bookings b on b.id = a.booking_id
      join appt_private.slots s on s.id = b.slot_id join appt_private.events e on e.id = s.event_id;
  return result;
end;
$$;

create or replace function public.appt_finish_calendar_audit(p_id uuid, p_lease_token uuid,
  p_outcome text, p_verified boolean, p_differences jsonb default '[]') returns void
language plpgsql security definer set search_path = '' as $$
declare target appt_private.calendar_audit%rowtype;
begin
  if p_outcome is null or p_outcome not in ('ok','changed','missing','error','cancelled')
    or p_verified is null or jsonb_typeof(p_differences) is distinct from 'array'
    or pg_column_size(p_differences) > 16000 then raise exception 'Invalid audit result.'; end if;
  select * into target from appt_private.calendar_audit where booking_id = p_id and lease_token = p_lease_token for update;
  if not found then return; end if;
  if p_outcome = 'cancelled' then
    if not target.verified then raise exception 'Calendar entry ownership must be verified before cancellation.'; end if;
    perform appt_private.cancel_booking(p_id, 'google');
  end if;
  update appt_private.calendar_audit set outcome = p_outcome, verified = verified or p_verified,
    differences = p_differences, checked_at = now(), next_check = now() + interval '15 minutes', lease_token = null
    where booking_id = p_id;
end;
$$;

create or replace function public.appt_admin_calendar_audit() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform appt_private.require_admin();
  return jsonb_build_object('last_checked', (select max(checked_at) from appt_private.calendar_audit),
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
revoke all on function appt_private.cancel_booking(uuid,text) from public, anon, authenticated;
revoke all on function public.appt_calendar_delivered(uuid,text), public.appt_claim_calendar_audit(text,integer),
  public.appt_finish_calendar_audit(uuid,uuid,text,boolean,jsonb), public.appt_admin_calendar_audit() from public, anon, authenticated;
grant execute on function public.appt_calendar_delivered(uuid,text), public.appt_claim_calendar_audit(text,integer),
  public.appt_finish_calendar_audit(uuid,uuid,text,boolean,jsonb) to service_role;
grant execute on function public.appt_admin_calendar_audit() to authenticated;
notify pgrst, 'reload schema';
commit;
