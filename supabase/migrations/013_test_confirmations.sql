-- Test email delivery markers only: never insert bookings, jobs or reservations.
begin;
create table appt_private.test_confirmations (
  request_id uuid primary key,
  recipient_hash text not null,
  slot_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  state text not null default 'sending' check (state in ('sending','sent','failed'))
);
alter table appt_private.test_confirmations enable row level security;
revoke all on appt_private.test_confirmations from public, anon, authenticated;

create function public.appt_claim_test_confirmation(p_request_id uuid, p_slot_id uuid,
  p_name text, p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing appt_private.test_confirmations%rowtype; result jsonb; recipient text;
begin
  if p_request_id is null or p_slot_id is null
    or lower(regexp_replace(btrim(coalesce(p_name,'')), '\s+', ' ', 'g')) <> 'test test'
    or length(coalesce(p_email,'')) > 254 or coalesce(p_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Use Test Test as the name and enter a valid email address.';
  end if;
  recipient := md5(lower(p_email));
  perform pg_advisory_xact_lock(5596013);
  delete from appt_private.test_confirmations where created_at < clock_timestamp() - interval '1 day';
  select * into existing from appt_private.test_confirmations where request_id = p_request_id;
  if found and (existing.recipient_hash <> recipient or existing.slot_id <> p_slot_id) then
    raise exception 'This test request was already used with different details.';
  end if;
  if existing.state = 'sending' then raise exception 'This test is already processing. Check your inbox before trying again.'; end if;
  if existing.state is distinct from 'sent' then
    if exists(select 1 from appt_private.test_confirmations where recipient_hash = recipient
      and created_at > clock_timestamp() - interval '1 minute') then
      raise exception 'Please wait one minute before sending another test email to this address.';
    end if;
    if (select count(*) from appt_private.test_confirmations
      where created_at > clock_timestamp() - interval '1 minute') >= 10 then
      raise exception 'Test email limit reached. Please wait one minute.';
    end if;
  end if;
  select jsonb_build_object('id', 'test-' || p_request_id, 'is_test', true, 'name', 'Test Test',
    'email', p_email, 'event_name', e.name, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
    'location', e.location) into result from appt_private.slots s
    join appt_private.events e on e.id = s.event_id where s.id = p_slot_id and s.starts_at > now();
  if result is null then raise exception 'Choose a future appointment time for your test.'; end if;
  if existing.state = 'sent' then return jsonb_build_object('send', false, 'receipt', result); end if;
  insert into appt_private.test_confirmations(request_id, recipient_hash, slot_id)
    values(p_request_id, recipient, p_slot_id)
    on conflict(request_id) do update set state = 'sending', created_at = clock_timestamp();
  return jsonb_build_object('send', true, 'receipt', result);
end;
$$;

create function public.appt_finish_test_confirmation(p_request_id uuid, p_sent boolean) returns void
language sql security definer set search_path = '' as $$
  update appt_private.test_confirmations set state = case when p_sent then 'sent' else 'failed' end
    where request_id = p_request_id and state = 'sending';
$$;
revoke all on function public.appt_claim_test_confirmation(uuid,uuid,text,text),
  public.appt_finish_test_confirmation(uuid,boolean) from public, anon, authenticated;
grant execute on function public.appt_claim_test_confirmation(uuid,uuid,text,text),
  public.appt_finish_test_confirmation(uuid,boolean) to service_role;
commit;
