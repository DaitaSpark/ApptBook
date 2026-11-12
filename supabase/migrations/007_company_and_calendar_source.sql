-- Apply after migrations 001-006. Existing bookings retain an empty company.
begin;
alter table appt_private.bookings add column if not exists company text not null default ''
  check (length(company) <= 240);

-- Preserve the existing atomic capacity, random release and attribution logic.
-- Company is committed in the same transaction before any worker can claim jobs.
create or replace function public.appt_book_company(p_slot_id uuid, p_request_id uuid,
  p_name text, p_email text, p_phone text, p_notes text, p_company text, p_ref text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  existing appt_private.bookings%rowtype;
  result jsonb;
begin
  p_company := btrim(coalesce(p_company, ''));
  if length(p_company) > 240 then raise exception 'Company / Golf Course must be 240 characters or fewer.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select * into existing from appt_private.bookings where request_id = p_request_id;
  if found and existing.company <> p_company then
    raise exception 'This request already saved a booking with different company details. Check your confirmation before booking again.';
  end if;
  result := public.appt_book_tracked(p_slot_id, p_request_id, p_name, p_email, p_phone, p_notes, p_ref);
  update appt_private.bookings set company = p_company where id = (result->>'id')::uuid;
  return result;
end;
$$;
revoke all on function public.appt_book_company(uuid,uuid,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.appt_book_company(uuid,uuid,text,text,text,text,text,text) to anon, authenticated;

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
      'notes', b.notes, 'company', b.company, 'source_label', b.source_label, 'source_kind', b.source_kind, 'event_name', e.name, 'location', e.location, 'starts_at', s.starts_at, 'ends_at', s.ends_at))), '[]'::jsonb)
    into result from claimed j join appt_private.bookings b on b.id = j.booking_id
      join appt_private.slots s on s.id = b.slot_id join appt_private.events e on e.id = s.event_id;
  -- Exhausted leases from crashed workers should remain visible as failures.
  update appt_private.jobs set state = 'failed', last_error = 'Delivery attempts exhausted.'
    where state = 'processing' and attempts >= 10 and available_at <= now();
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
    select b.id, b.name, b.email, b.phone, b.notes, b.company, b.created_at, b.referral_link_id, b.source_label, b.source_kind,
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


notify pgrst, 'reload schema';
commit;
