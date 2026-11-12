-- Run ONLY after 012, Gmail authorization and sender secrets are configured.
-- Re-running preserves the original cutoff and does not suppress newer bookings.
begin;
lock table appt_private.jobs in share row exclusive mode;
do $$
declare cutoff timestamptz;
begin
  select enabled_at into cutoff from appt_private.email_delivery_settings where singleton for update;
  if not found then raise exception 'Apply migration 012 before activating email.'; end if;
  if cutoff is null then
    cutoff := clock_timestamp();
    update appt_private.jobs set state = 'skipped', lease_token = null,
      completed_at = cutoff, last_error = 'Confirmation disabled for bookings before email activation.'
      where kind = 'email' and state <> 'sent';
    update appt_private.email_delivery_settings set enabled_at = cutoff where singleton;
  end if;
end;
$$;
commit;
select enabled_at as email_enabled_for_bookings_from
  from appt_private.email_delivery_settings where singleton;
