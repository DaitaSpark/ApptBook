-- Email stays disabled until activate-email.sql is run. Calendar work is unchanged.
begin;
lock table appt_private.jobs in share row exclusive mode;
do $$ begin
  if exists(select 1 from appt_private.jobs where kind = 'email' and state = 'processing'
    and available_at > now()) then
    raise exception 'An email worker has an active lease. Pause dispatch and wait for leases to expire before retrying.';
  end if;
end $$;

create table appt_private.email_delivery_settings (
  singleton boolean primary key default true check (singleton),
  enabled_at timestamptz
);
insert into appt_private.email_delivery_settings(singleton) values(true);
alter table appt_private.email_delivery_settings enable row level security;
revoke all on appt_private.email_delivery_settings from public, anon, authenticated;

alter table appt_private.jobs drop constraint jobs_state_check;
alter table appt_private.jobs add constraint jobs_state_check
  check (state in ('queued', 'processing', 'sent', 'failed', 'skipped'));
update appt_private.jobs set state = 'skipped', lease_token = null,
  completed_at = now(), last_error = 'Confirmation disabled for bookings before email activation.'
  where kind = 'email' and state <> 'sent';

create or replace function public.appt_claim_jobs(p_kinds text[], p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  with pending as (
    select j.id from appt_private.jobs j
    join appt_private.bookings b on b.id = j.booking_id
    where j.kind = any(p_kinds) and j.attempts < 10 and j.available_at <= now()
      and j.state in ('queued', 'processing')
      and (j.kind <> 'email' or exists (
        select 1 from appt_private.email_delivery_settings e
        where e.singleton and e.enabled_at is not null and b.created_at >= e.enabled_at))
    order by j.available_at for update of j skip locked limit greatest(1, least(p_limit, 20))
  ), claimed as (
    update appt_private.jobs j set state = 'processing', attempts = attempts + 1,
      available_at = now() + interval '10 minutes', lease_token = gen_random_uuid()
      from pending where pending.id = j.id returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'kind', j.kind, 'lease_token', j.lease_token,
    'booking', jsonb_build_object('id', b.id, 'name', b.name, 'email', b.email, 'phone', b.phone,
      'notes', b.notes, 'company', b.company, 'source_label', b.source_label, 'source_kind', b.source_kind,
      'event_name', e.name, 'location', e.location, 'starts_at', s.starts_at, 'ends_at', s.ends_at))), '[]'::jsonb)
    into result from claimed j join appt_private.bookings b on b.id = j.booking_id
      join appt_private.slots s on s.id = b.slot_id join appt_private.events e on e.id = s.event_id;
  update appt_private.jobs set state = 'failed', last_error = 'Delivery attempts exhausted.'
    where state = 'processing' and attempts >= 10 and available_at <= now();
  return result;
end;
$$;
commit;
