-- Adds Delete link. Unused links are removed; referenced links are archived privately.
begin;
alter table appt_private.referral_links add column if not exists deleted_at timestamptz;
alter table appt_private.referral_links drop constraint if exists referral_links_event_id_kind_label_key;
create unique index if not exists appt_referral_live_label
  on appt_private.referral_links(event_id, kind, label) where deleted_at is null;
do $$ begin
  if not exists(select 1 from pg_constraint where conname = 'appt_referral_deleted_inactive'
    and conrelid = 'appt_private.referral_links'::regclass) then
    alter table appt_private.referral_links add constraint appt_referral_deleted_inactive
      check (deleted_at is null or not active);
  end if;
end $$;

create or replace function public.appt_admin_delete_referral(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform appt_private.require_admin();
  perform 1 from appt_private.referral_links where id = p_id for update;
  if not found then return; end if;
  -- Waits for in-flight bookings that hold a share lock on this link before deciding.
  if exists(select 1 from appt_private.bookings where referral_link_id = p_id) then
    update appt_private.referral_links set active = false, deleted_at = coalesce(deleted_at, now()) where id = p_id;
  else
    delete from appt_private.referral_links where id = p_id;
  end if;
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
    on conflict(event_id, kind, label) where deleted_at is null do update set active = true returning * into result;
  return to_jsonb(result);
end;
$$;

create or replace function public.appt_admin_set_referral(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform appt_private.require_admin();
  if p_active is null then raise exception 'Choose a valid link status.'; end if;
  update appt_private.referral_links set active = p_active where id = p_id and deleted_at is null;
  if not found then raise exception 'Tracking link not found.'; end if;
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
      from appt_private.referral_links r where r.deleted_at is null));
end;
$$;
revoke all on function public.appt_admin_delete_referral(uuid) from public, anon, authenticated;
grant execute on function public.appt_admin_delete_referral(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
