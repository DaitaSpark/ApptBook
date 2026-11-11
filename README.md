# JR & Co. appointments - static site + Supabase

The production app is now a static site, like BevStats. Python builds the files; **no Flask server, Gunicorn, paid Render web service, database password, or SMTP server runs on Render**. The calendar, times, and contact details progressively open on the first screen. Mobile displays the calendar and available times together, then opens contact details after a time is chosen. Assets, logo, fonts, and favicon are hosted locally.

Supabase stores date-specific schedules and bookings, authenticates admins, and runs atomic booking functions. A server-only delivery worker supports email and a shared Google Workspace calendar. Public booking requires no account: name plus email or phone; optional notes; one place per booking.

## Preview locally now

```powershell
python build_static.py --preview
python -m http.server 5000 --directory dist --bind 127.0.0.1
```

Open http://127.0.0.1:5000. This **read-only local preview** exports public availability from the previous local SQLite database; it exports no names/contact details from bookings. Calendar and time selection work, but booking and admin writes are disabled until Supabase is connected. No fake booking is saved. The old SQLite database remains in ignored `instance/`; keep it until migration is verified. Preview data cannot be built on Render.

## Connect Supabase

1. Create/select the dedicated project for ApptBook. Do not change BevStats's project without confirming the intended sharing.
2. In SQL Editor, run `supabase/migrations/001_appointments.sql`, then `supabase/migrations/002_custom_availability.sql`. They create an isolated `appt_private` schema and custom-hour scheduling functions, not public customer tables. They can be reapplied without deleting data. If 001 is already installed, run only 002 for the custom-hour controls.
3. Choose initial data:
   - For a fresh schedule, run `supabase/seed.sql` to create JR & Co. Appointments with the next 30 days of weekday availability, 9 a.m. to 4 p.m. Eastern, 30-minute slots, capacity 1. Past times are omitted; holidays are included.
   - To preserve local schedules/bookings, run `python scripts/export_legacy.py`, then run the ignored `supabase/import-legacy.sql` **instead of seed.sql**. The import requires empty appointment tables and refuses to overwrite existing data. It may contain guest information; never commit/publish it. Imported bookings do not automatically trigger new messages or calendar entries.
4. Create an admin email/password user under Supabase Authentication > Users. Disable public signups. Add that user's UUID to the allowlist with SQL:

```sql
insert into appt_private.admins(user_id)
values ('REPLACE_WITH_AUTH_USER_UUID') on conflict do nothing;
```

5. For local live use, copy `supabase-public.example.json` to `supabase-public.json` and enter the project URL and **publishable** key. A legacy `anon` key is also supported. The local file is ignored; the values are intentionally public in built config. Never use a secret/service-role key or database password. Run `python build_static.py` and serve `dist` as above. Python uses only the standard library; no pip install is needed.
6. Open `/admin.html` and sign in. The database checks allowlist membership on every admin operation. An authenticated non-admin cannot manage or export bookings. Admin sessions use sessionStorage and are refreshed when needed; signing out clears them.

The browser calls only the allowed RPC functions. Public roles cannot read the private schema, guest records, or delivery queue. All tables also have RLS enabled. Keep `appt_private` out of Supabase's exposed schemas. Do not grant browser roles private-schema privileges.

### Specific event dates and custom hours

Create an event with the default 30-day availability checkbox unchecked, then use **Create time slots**. Set a date range, first meeting start, **last meeting start**, meeting length (default 30 minutes), and capacity (blank uses the event default). Weekdays-only is optional. A preview states the number of meetings per day and when the final meeting ends. The separate **Add one individual meeting** form creates one appointment spanning its start/end, not a series of half-hour slots.

Example: PGA Show January 27-29, 2027, with last starts at 3:30 p.m. on Jan 27-28 and 11:30 a.m. on Jan 29. Generate Jan 27-28 from 09:00 through 15:30 (14 meetings/day), then Jan 29 from 09:00 through 11:30 (6 meetings), totaling 34 time slots. Each event's **Open booking page** link selects only its availability and opens the first available month automatically. Links containing `?event=...` hide and disable the event picker; the logo, booking navigation, and confirmation return action keep that event selected. Invalid event IDs show an unavailable-link message instead of falling back to the default. The root page without an event parameter retains the event picker. This is navigation scoping for publicly bookable events, not an authorization boundary.

The selected event name (such as PGA Show) is the large main heading, with Book your time as a small supporting line. The booking controls use compact spacing, calendar cells, time buttons, and fields. Mobile keeps legible 16px input text and usable touch targets. Desktop/tablet QA verifies the full 14-time PGA day and confirmation controls above the fold at heights down to 600px. Phone QA down to 320x568 verifies that the initial calendar is visible alongside the default day's times, another date can be chosen directly, and confirmation controls remain accessible. With the calendar now kept visible, shorter phones may scroll through the times below it. Event descriptions are hidden on short phone screens to prioritize dates and times.

On initial load, event changes, and availability refresh, the earliest future date with remaining capacity is selected automatically and its available times are displayed. No time is preselected and no booking is submitted automatically. Mobile keeps the calendar visible above those times; tapping another date immediately updates the list. Selecting a time opens the contact form, with Date and Time step buttons available to change the selection. Fully booked dates are skipped, and fully booked schedules stay unselected. Automatic selection does not move keyboard focus.

For year-round sharing, use `/?showEvents=true` to show the event dropdown, or append `&showEvents=true` to a specific event link (for example, `/?event=EVENT_UUID&showEvents=true`). The latter preselects that event and allows visitors to switch to the default calendar or other events. The flag stays in the URL through event changes and booking/home navigation, so reloading does not lock the dropdown. Only the exact value `true` enables this option. Event links without that flag stay locked, and invalid event IDs still do not fall back to another calendar. If only one event exists, there is no dropdown to show.

For correcting existing availability, **Replace unbooked slots on these dates** removes all unbooked slots for that event on those dates (including outside the new hours) before generating the new series. Booked slots retain their IDs, times, capacity, and reservations; overlaps are skipped and reported. Other dates and events are untouched. The option resets after a successful generation. Admin availability displays both start and end times. Applying migration 002 alone never changes a live schedule.

## Render: create a Static Site

Cancel any pending **paid Web Service** Blueprint creation. The new `render.yaml` describes `runtime: static`. An existing deployed Python Web Service cannot be converted in place simply by syncing YAML: create a **new Static Site**, verify it, then remove the old service separately if desired. Do not delete ProfitMax or any other app.

For manual setup choose **New > Static Site**:

| Setting | Value |
| --- | --- |
| Repository | DaitaSpark/ApptBook |
| Branch | main |
| Root directory | blank |
| Build command | `python build_static.py` |
| Publish directory | `dist` |
| Environment variable | `SUPABASE_URL` = project HTTPS URL |
| Environment variable | `SUPABASE_PUBLISHABLE_KEY` = publishable or legacy anon key |

Alternatively create a **new Blueprint** using `render.yaml`; it declares the same static hosting settings and redirects `/admin` to `/admin.html`. No start/pre-deploy command or Starter instance is needed. The build fails clearly if Render's public Supabase settings are missing or a private key is supplied. A static page avoids Render's sleeping Python-service screen; live data still depends on Supabase availability and service limits.

## Email and Google Workspace calendar

Bookings and capacity updates commit in a single database transaction. Two private delivery jobs (email and calendar) are created in that same transaction. Delivery runs separately and retries with exponential backoff. The browser never gets a provider credential. Until a worker/provider is configured, confirmations show **pending**, and appointments remain safely saved.

Deploy `supabase/functions/dispatch-bookings` using the Supabase CLI or dashboard. `supabase/config.toml` disables gateway JWT checks for this server-to-server endpoint; the function itself requires a high-entropy `x-dispatch-secret` and rejects missing/wrong values. It never allows browser-triggered dispatch. Set a random `DISPATCH_SECRET` in Edge Function secrets, not Render. Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the function.

For email before Workspace setup, set these Edge Function secrets:

- `RESEND_API_KEY`: provider API key.
- `MAIL_FROM`: verified sender, such as `JR & Co. <appointments@example.com>`.
- `TEAM_EMAIL`: team/shared inbox for booking notifications, including phone-only bookings.

For a delegated Gmail mailbox and shared calendar, use a Workspace-approved OAuth client with offline access authorized **as the mailbox account**. Gmail delegation in the user interface does not automatically grant API access. Store these only as Edge Function secrets:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.
- `WORKSPACE_EMAIL`: mailbox account or permitted send-as address.
- `GOOGLE_CALENDAR_ID`: calendar the authorizing account can write.
- `TEAM_EMAIL`: optional notification destination; defaults to WORKSPACE_EMAIL.

Enable Gmail and Calendar APIs. Request only `https://www.googleapis.com/auth/gmail.send` and `https://www.googleapis.com/auth/calendar.events`. Use an internal Workspace OAuth app with appropriate admin approval; do not leave a production refresh token in external testing mode. No broad domain-wide delegation is needed for this single-account OAuth approach. If the shared address is a Google Group, choose an authorized Gmail sender and separate shared calendar rather than treating the Group as a Gmail account.

With Google email configured, the worker sends guest confirmations from that account and Bccs the team, or notifies the team for phone-only bookings. The shared calendar receives one event per booking with a stable ID, so retries do not duplicate calendar events. Calendar events do not add guests or send a second invitation; guests receive the confirmation email. External calendar busy times do not yet remove capacity in this app.

Call the worker once with its secret to validate delivery, then enable pg_cron/pg_net, create Vault secrets `appt_project_url` and `appt_dispatch_secret`, and run `supabase/schedule-dispatch.sql` to dispatch every minute. The Vault secret must match DISPATCH_SECRET. Credential values belong in the provider's secret UI, never SQL committed to Git. Email and calendar remain unconnected until this setup is completed.

The worker leases each job, retries failures, and marks exhausted attempts for attention in admin. Calendar creation and Resend delivery use stable idempotency keys. Gmail delivery is at-least-once: a crash after sending but before acknowledgment can produce a duplicate email. Imported historical bookings are not automatically re-notified. Cancellation/rescheduling and two-way Google synchronization are future features; creating bookings, admin availability, reporting, and delivery of new bookings are implemented.

## Validation

```powershell
python -m unittest discover -s tests -v
python scripts/install_sql_test_tools.py
# Use any recent Node.js installation:
node tests/sql_checks.cjs
node tests/delivery_checks.mjs
# Node 24+ can also execute the Edge Function handler tests directly:
node tests/worker_checks.mjs
```

SQL tests execute the real migration/functions against local PostgreSQL WASM (PGlite): permissions, unauthorized admin denial, capacity exhaustion, retry idempotency, weekday boundaries, DST errors, and leased delivery retries. PGlite serializes sessions; multi-connection concurrency and live Supabase Auth/provider integration still require a configured project. The SQL installer is for development only and is never in the Render build. `tests/browser_checks.py` uses optional Playwright (`python -m pip install playwright`) plus an installed Edge browser to exercise the static UI against mocked Supabase HTTP responses; no real messages or bookings are sent.

Public booking uses server-side validation and atomic capacity checks. Before public launch, configure project abuse protection/rate limits appropriate to your audience, backups, and retention. No public anonymous endpoint can export guest details. Git and static output exclude local data, credentials, and private import SQL.
