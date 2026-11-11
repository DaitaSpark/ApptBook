-- Optional initial schedule. Run after migration 001. Safe to rerun; existing events are untouched.
do $$
declare event_id uuid; today date := (now() at time zone 'America/New_York')::date;
begin
  if not exists (select 1 from appt_private.events) then
    insert into appt_private.events(name, description) values
      ('JR & Co. Appointments', 'Book a 30-minute meeting with JR & Co.') returning id into event_id;
    perform appt_private.generate_workdays(event_id, today, today + 29);
  end if;
end;
$$;
