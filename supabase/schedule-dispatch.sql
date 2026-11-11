-- Run after deploying dispatch-bookings and setting secrets. Values are retrieved from Vault.
-- First create Vault secrets in the dashboard named appt_project_url and appt_dispatch_secret.
-- appt_dispatch_secret must match the Edge Function's DISPATCH_SECRET.
-- Enable pg_cron and pg_net in Supabase Extensions before running this script.
do $$
begin
  if not exists(select 1 from vault.decrypted_secrets where name = 'appt_project_url')
    or not exists(select 1 from vault.decrypted_secrets where name = 'appt_dispatch_secret') then
    raise exception 'Create the two appointment Vault secrets before scheduling.';
  end if;
end;
$$;
select cron.unschedule(jobid) from cron.job where jobname = 'appt-dispatch';
select cron.schedule('appt-dispatch', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'appt_project_url' limit 1) || '/functions/v1/dispatch-bookings',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'appt_dispatch_secret' limit 1)),
    body := '{}'::jsonb, timeout_milliseconds := 120000
  );
$$);
