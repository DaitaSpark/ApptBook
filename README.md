# JR & Co. appointments - static site + Supabase

The production app is now a static site, like BevStats. Python builds the files; **no Flask server, Gunicorn, paid Render web service, database password, or SMTP server runs on Render**. The calendar, times, and contact details progressively open on the first screen. Mobile shows the calendar first with an explicit View times button, replaces the calendar with times after a date is chosen, then opens contact details after a time is chosen. Assets, logo, fonts, and favicon are hosted locally.

Supabase stores date-specific schedules and bookings, authenticates admins, and runs atomic booking functions. A server-only delivery worker supports email and a shared Google Workspace calendar. Public booking requires no account: name plus email or phone; optional notes; one place per booking.

## Preview locally now

```powershell
python build_static.py --preview
python -m http.server 5000 --directory dist --bind 127.0.0.1
```

Open http://127.0.0.1:5000. This **read-only local preview** exports public availability from the previous local SQLite database; it exports no names/contact details from bookings. Calendar and time selection work, but booking and admin writes are disabled until Supabase is connected. No fake booking is saved. The old SQLite database remains in ignored `instance/`; keep it until migration is verified. Preview data cannot be built on Render.

## Connect Supabase

1. Create/select the dedicated project for ApptBook. Do not change BevStats's project without confirming the intended sharing.
2. In SQL Editor, run migrations in order: `001_appointments.sql`, `002_custom_availability.sql`, then `003_release_and_tracking.sql` , `004_delete_tracking_links.sql`, `005_delete_bookings.sql`, and `006_random_release.sql` from `supabase/migrations/`. They create an isolated `appt_private` schema, custom-hour scheduling, staged release, and private source tracking. Existing installations should apply only the newer migrations: if 005 is already installed, run only 006 for randomized release. Applying 003 does not delete slots/bookings or turn on limits for existing events. Reapply migrations in order rather than running an older migration alone over newer function definitions.
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

The selected event name (such as PGA Show) is the large main heading, with Book your time as a small supporting line. The booking controls use compact spacing, calendar cells, time buttons, and fields. Mobile keeps legible 16px input text and usable touch targets. Desktop/tablet QA verifies the full 14-time PGA day and confirmation controls above the fold at heights down to 600px. Phone QA down to 320x568 verifies that the initial calendar and View times action are visible, selecting a date replaces the calendar with its times, Change date returns to the calendar, and confirmation controls remain accessible. Event descriptions are hidden on short phone screens to prioritize dates and times.

On initial load, event changes, and availability refresh, the earliest future date with remaining capacity is selected automatically and its available times are displayed. No time is preselected and no booking is submitted automatically. Desktop shows those times immediately in the middle panel. Mobile initially keeps the calendar open with a View times for [date] button. Tapping a date or View times replaces the calendar with the time list in the same area; Change date restores the calendar. Selecting a time opens the contact form, with Date and Time step buttons available to change the selection. Fully booked dates are skipped, and fully booked schedules stay unselected. Automatic selection does not move keyboard focus.

For year-round sharing, use `/?showEvents=true` to show the event dropdown, or append `&showEvents=true` to a specific event link (for example, `/?event=EVENT_UUID&showEvents=true`). The latter preselects that event and allows visitors to switch to the default calendar or other events. The flag stays in the URL through event changes and booking/home navigation, so reloading does not lock the dropdown. Only the exact value `true` enables this option. Event links without that flag stay locked, and invalid event IDs still do not fall back to another calendar. An explicit showEvents=true shows the selector even if only one event exists. Admin includes an Open all calendars link with the correct flag. An accidental second question mark before showEvents is normalized to an ampersand; normal event links remain locked.

For correcting existing availability, **Replace unbooked slots on these dates** removes all unbooked slots for that event on those dates (including outside the new hours) before generating the new series. Booked slots retain their IDs, times, capacity, and reservations; overlaps are skipped and reported. Other dates and events are untouched. The option resets after a successful generation. Admin availability displays both start and end times. Applying migration 002 alone never changes a live schedule.

### Release a few time choices per day

After migration 003, use **Admin > Release time choices**, choose the event, enter `3`, and save. Blank means unlimited. This controls the number of distinct open times, not the capacity per time. With capacity 3, three open times initially offer up to nine places. An open time remains open until all its places are booked; once full, the next randomly prioritized future time opens. The limit is independent for each Eastern calendar day and shared across all salesperson/channel links. As time passes, past appointments drop out and later future choices can open.

All scheduled times remain visible for the chosen date: released choices are selectable, unreleased choices are grey **Not available**, and full times are grey **Fully booked**. The database enforces release eligibility through both booking endpoints; guessing a later slot ID cannot book it early. Active pages refresh availability every 30 seconds and when their tab becomes visible. Refresh does not interrupt contact-form entry or move focus. A booking submission always rechecks the current release/capacity state. Existing events stay unlimited until an admin saves a release limit.

### Salesperson and channel booking links

Use **Admin > Create a tracked event link**, select an event, choose Salesperson or Channel, and enter its name. **Tracked event links** displays a unique shareable URL, a **Copy link** button, enable/disable controls, and its booking total. Creating the same event/name/type again reuses its link. Example: `/?event=EVENT_UUID&ref=OPAQUE_TOKEN`. Add `&showEvents=true` only when visitors should be able to switch events.

The source is saved with the booking, displayed in Admin's Source column, included in CSV exports, and counted per tracked link. Source names/types stay private to admins and the shared Google Calendar description; they are not displayed in the public form, confirmation, or guest email. Migration 007 includes the saved source snapshot in calendar delivery jobs. Existing and ordinary-link bookings are **Direct / untracked**; there is no retroactive attribution. Attribution means the link used, not verified proof of which person shared it. Copying/sharing another person's link credits that link.

The `ref` token is preserved through scoped home links, confirmation return, and reloads. It applies only to its event: switching to another event with showEvents enabled removes the token for that other event. Disabled/unknown/cross-event tokens cannot silently create untracked bookings through a tracked link. Retries keep the original source and never count twice or rewrite attribution. Disabling a link preserves its historical bookings and totals. Untracked bookings can use the legacy endpoint while migration 003 is pending; tracked bookings never fall back and drop their source.

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

The worker leases each job, retries failures, and marks exhausted attempts for attention in admin. Calendar creation and Resend delivery use stable idempotency keys. Gmail delivery is at-least-once: a crash after sending but before acknowledgment can produce a duplicate email. Imported historical bookings are not automatically re-notified. Admin booking deletion releases capacity and queues Google Calendar cleanup. Rescheduling and cancellation emails remain future features; Google cancellation sync and discrepancy audits require migration 008 and the updated worker; creating bookings, admin availability, reporting, and delivery of new bookings are implemented.

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

## Delete unwanted tracking links

After migration 004, each row in Tracked event links has a **Delete link** button. Confirming removes the link from the list and prevents new bookings with its token. Canceling the confirmation changes nothing. Unused links are physically removed. Links referenced by bookings are archived privately, disabled, and excluded from the list, preserving foreign keys and the booking's saved source name/type. They cannot be re-enabled. Recreating the same event/name/type generates a fresh link/token with a new booking count; historical bookings keep their original source. Deletion never deletes an event, time slot, booking, or delivery job. The backend requires an authorized admin and serializes deletion with in-flight reservations.

## Delete bookings

After applying migration 005, Admin's Bookings table includes **Delete booking** for each row. A confirmation identifies the guest, event, and time. Deleting removes the booking from active lists/CSV and active source counts, releases exactly one place, and lets staged-release availability recompute. Repeated requests cannot release capacity twice. A private audit record keeps the original details, source, deletion time, and deleting admin; deletion is not a personal-data purge. Slots referenced by booking history remain protected when replacing availability.

Queued confirmation/calendar-create jobs are stopped, and a calendar_delete delivery job is queued. No cancellation email is sent. Already sent messages cannot be recalled, and a confirmation already in flight may still complete. If a calendar creation was already claimed, its removal waits beyond the existing delivery lease to avoid removing an event before the in-flight creation finishes. Stale delivery acknowledgments cannot reactivate the canceled job. An old request-ID retry for a deleted booking fails rather than falsely returning a new confirmation.

If Google sync has already been enabled, redeploy the updated **dispatch-bookings** Edge Function so it handles calendar_delete jobs. Calendar removal verifies the app's booking ID before deleting the matching Google event and treats an already absent event as success. Without configured Google credentials/worker, cleanup remains queued; the app still releases capacity immediately. Existing web and booking functionality continues while migration 005 is pending, but Delete booking requires that update.

## Randomized release order

Migration 006 assigns each slot a random UUID priority once. Limited events select up to the configured number of remaining future times per Eastern date using that priority. All visitors, refreshes, and referral links use the same database priorities; clients cannot reshuffle or book a different closed time. Public buttons remain sorted by appointment time for readability, with a random subset selectable. A partially filled time stays selectable until full, at which point another priority-ranked time opens. New dates/slots receive fresh priorities; reapplying the migration does not reroll existing priorities. Removing a booking can reopen its original priority-ranked time. No existing bookings, capacities, tracking links, or event release limits are changed by this migration.

Apply `supabase/migrations/006_random_release.sql` once after the earlier migrations. Existing event limits (for example, 3) are retained. Blank/unlimited release settings continue to offer all remaining times. Random selection can occasionally select adjacent times; there is no enforced morning/afternoon distribution.

## Company / Golf Course and automatic calendar delivery

Run `supabase/migrations/007_company_and_calendar_source.sql` after migrations 001-006. It adds an optional Company / Golf Course field (240 characters), an atomic booking RPC, admin/CSV reporting, and company/source data in server-only delivery jobs. Existing bookings have a blank company. Requests with company details require migration 007 and never silently discard the field if the migration is missing. Ordinary bookings remain compatible during rollout.

After applying 007, replace `delivery.js` in the deployed `dispatch-bookings` function with the repository version and redeploy it. Calendar descriptions for newly delivered entries include Company / Golf Course and Source (saved salesperson/channel label, or Direct / untracked). Existing calendar entries are not rewritten. Source is not included in customer confirmation email, and no Google attendee invitation is sent by the current calendar integration.

For automatic delivery, enable `pg_cron` and `pg_net` in Supabase, then create two secrets in **Vault** (separate from Edge Function Secrets):

- `appt_project_url`: the Supabase project URL, without a trailing slash.
- `appt_dispatch_secret`: the same private value as the Edge Function's `DISPATCH_SECRET`.

Run `supabase/schedule-dispatch.sql`. It replaces only the `appt-dispatch` schedule and invokes the worker every minute. Google credentials remain in Edge Function Secrets; the scheduler reads only the dispatch secret from Vault. Never put these secrets in the static app or Git. Verify by making a clearly named test booking, waiting for the automatic run, checking its exact date/time in Google Calendar, then deleting it through Admin and verifying cleanup after the next run. Use the function's Logs and Admin delivery status to diagnose failures.

The current `GOOGLE_CALENDAR_ID` is global: all app events sync to that one shared calendar. Per-event Google calendar routing is not implemented. Before update 008, calendar writes and deletions are one-way from the app. Update 008 adds the cancellation/audit behavior below. Email delivery requires separate provider setup and is not enabled by Calendar-only authorization.

## Google cancellations and calendar alignment audit (008)

Apply `supabase/migrations/008_calendar_cancellations_and_audit.sql` after 007, then replace **both** `index.ts` and `delivery.js` in the existing `dispatch-bookings` function and redeploy. Keep JWT verification off: the function still validates `DISPATCH_SECRET`. No new Google permissions, secrets, scheduler, or Render service is needed. The existing every-minute job also checks audit work that is due.

The worker records the shared calendar destination for each successful delivery. It checks up to ten due app-created, successfully delivered, active meetings per invocation, with a 15-minute per-booking interval and leased work so overlapping runs cannot apply the same cancellation twice. It checks future meetings and those ending in the preceding 30 days. Large backlogs or failed workers can delay checks beyond 15 minutes.

Only a Google event explicitly returned with `status: cancelled`, the expected stable event ID, and previously verified app ownership cancels its matching app booking. This retains the private record with a Google cancellation origin, releases exactly one place, stops unsent confirmation work, and removes it from active admin views. It does not queue another Google delete or send a cancellation email. Repeated checks, stale audit leases, and a simultaneous admin cancellation do not release a second place. Restoring the Google event does not restore the cancelled booking; make a new booking in the app.

Missing entries (404/410), permission/network errors, missing ownership metadata, and pre-upgrade cancellations that were never verified are flagged for review and never release capacity. Existing sent bookings are adopted by first reading and verifying their booking reference in the currently configured shared calendar. Changing the configured calendar does not retarget already bound bookings. Do not move app appointments to another Google calendar: removal from the original calendar may be reported by Google as cancellation.

Start/end times, title, location, description (contact/company/source/notes), and recurrence are compared. Differences appear in **Admin > Google Calendar audit**, along with the last check and recent Google cancellations; click the existing Refresh button to load current results. No audit changes meeting times or overwrites either side. Restore Google details to match the app, or cancel/rebook through the app to resolve a change. A later matching check clears the discrepancy. This audits known active ApptBook entries; unrelated manually created Google events and restored/orphan entries for already cancelled app bookings are not imported or audited. It does not compare attendees, conferencing, reminders, or calendar colors.

Activation checks: create a clearly labeled test booking and allow an automatic dispatch/audit; move its Google start/end and verify a discrepancy appears without changing app capacity; restore its times and verify the discrepancy clears; delete it in Google, wait for the audit, and verify the app booking disappears and exactly one place reopens. Test on disposable bookings only. Existing live Google deletions are not simulated in local tests.

## Every-minute cancellations, 15-minute detail audits (009)

Apply `supabase/migrations/009_minute_cancellation_sync.sql` after 008, then replace **both** `index.ts` and `delivery.js` in `dispatch-bookings` and redeploy. The existing one-minute cron job, Google scopes, secrets, and JWT setting remain unchanged. The Render admin update shows separate last-cancellation-check and last-detail-audit times.

The worker now polls Google's `events.list` incremental feed on each scheduled invocation. The first poll lists the calendar to establish a sync token; later requests fetch only changes since that token. Only stable-ID, verified, app-owned cancellations affect bookings. Confirmed entries can establish ownership for older deliveries without changing their detail-audit timer or overwriting existing discrepancies. Other changes are left for the existing 15-minute audit. Unrelated Google events are ignored, not imported.

Private database state holds one cursor and lease per calendar. Each page applies cancellations and advances its page/sync token in the same transaction. Retries cannot skip a page or release capacity twice. Up to three pages (250 entries each) are processed per invocation; large calendars continue from the saved page on later runs. A 410 expired-token response triggers a fresh baseline on the next run, never mass cancellation. Permission/network failures retain the cursor and retry. Missing entries and unverifiable cancellations retain the safeguards in 008. Audit failures do not block outbound booking delivery.

For a normally caught-up, healthy worker, Google cancellations are picked up on the next minute poll (allow roughly 1-2 minutes), while the detail comparison interval stays about 15 minutes. Initial baselines, backlogs, API failures, and cron delays can take longer. The full detail audit also remains a fallback cancellation check. No cancellation email is sent and restoring an event does not reinstate its cancelled booking.

Activation test: after deploying, wait until Admin shows a completed cancellation poll, then delete a disposable app-created Google event and verify its booking/place updates after the next scheduled poll. Change another disposable event's time and verify the app time/capacity stays unchanged and the existing detail audit later flags the difference. The local tests cover cursor leases, private access, pagination/resumption, duplicate cancellations, ownership, HTTP 410 recovery, failures without cursor loss, and unchanged detail-audit state; live Google timing requires this activation test.

## PGA confirmation and calendar title presentation

PGA events (names starting with the word PGA) show `Booth 5596 (Back right wall of Convention Floor)` on the public confirmation screen. This is a display override; event/booking records and the calendar location field are unchanged. New Google entries for PGA use a title such as `Jeff E - PGA`, using the first name and initial of the final name component. Single names use `Madonna - PGA`. The full supplied name remains stored and included in the shared calendar description, admin views, and exports. Other events retain their existing display behavior.

Deploy the updated `delivery.js` in `dispatch-bookings` to activate the title format. No database migration or scheduler change is needed. Previously delivered calendar entries are not renamed automatically; the detail audit can flag their old titles as a difference from the new format.

## Change capacity on existing times (010)

Apply `supabase/migrations/010_update_existing_capacity.sql` after the preceding migrations. In Admin, use **Change places per meeting**, select the person/event, enter the new capacity (for example 2), and click **Update existing times**. It updates all upcoming slots for that event in place, including times with cancelled booking history and active bookings that fit within the new capacity, and also sets the event's default for future new slots. Other events and past times are unchanged. No Edge Function redeployment or cron change is needed.

If any target time has more active bookings than the requested capacity, the entire update is rejected and the message identifies the conflicting time. Inconsistent reservation totals are also rejected. Times, slot IDs, release priorities, booking history and delivery jobs are preserved. The existing **Create time slots > Replace unbooked slots** tool still preserves times with any booking history; use the new capacity control instead when changing places rather than meeting dates/hours.
