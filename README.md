# JR & Co. appointments

Flask appointment booking with date-specific time slots, per-slot capacity, a protected admin workspace, CSV export, and SMTP email confirmations. Public visitors need no account. Each booking reserves one place; a name and at least one of email or phone are required. Phone-only bookings receive an on-screen confirmation.

## Local setup (PowerShell)

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env: set SECRET_KEY and ADMIN_PASSWORD.
.venv\Scripts\python -m flask --app app init-db
.venv\Scripts\python -m flask --app app run --debug
```

Open http://127.0.0.1:5000. On a fresh database, init-db creates JR & Co. Appointments with weekday availability for the next 30 days: Monday?Friday, 9 a.m.?4 p.m. Eastern, 30-minute slots, one place per slot. Past times are omitted. Holidays are included. Visit /admin to add people/events or generate more weekday slots for a chosen date range. New events default to the same 30-day schedule (optional checkbox), using their configured capacity. The last daily slot is 3:30?4 p.m. Re-running generation preserves existing overlapping slots and bookings; this is explicit date generation, not a recurring rule. Local data uses SQLite in instance/ unless DATABASE_URL is configured. Never commit .env.

## Render and Supabase

Push this directory to your Git repository, then connect that repository to Render. The included render.yaml supplies deployment settings. Configure DATABASE_URL with the Supabase **session pooler PostgreSQL connection string**, including SSL. The app accepts postgresql:// or postgresql+psycopg://. URL-encode special characters in the database password. Set a strong ADMIN_PASSWORD and persistent random SECRET_KEY. Schema creation runs via the pre-deploy command; on Render plans without pre-deploy support, run `flask --app app init-db` once from an environment connected to the database before accepting bookings.

Only the Flask server connects to the database. No Supabase database password belongs in browser code. Keep these tables in a private schema or disable exposure through Supabase's Data API; if exposing the public schema, enable RLS with no anonymous policies on event, slot, and booking. Use a database role with only required privileges for production.

Set SMTP_HOST, SMTP_PORT (STARTTLS, normally 587), SMTP_USERNAME, SMTP_PASSWORD and MAIL_FROM using your email provider. Render must support outbound SMTP on the selected plan; otherwise use a provider HTTP API adapter before launch. Unconfigured or failed email delivery is reported honestly on the confirmation screen and in the admin booking list. Bookings remain saved even if sending fails. No automatic retry is included yet.

## Behavior and scope

- Eastern Time uses America/New_York, automatically observing EST/EDT. Admins enter local Eastern times; ambiguous/nonexistent DST transition hours are rejected.
- An atomic conditional database update reserves capacity inside the same transaction as the booking, preventing oversubscription.
- Admin forms and bookings have CSRF protection; admin sessions use HTTP-only cookies. HTTPS cookies are enabled on Render.
- Branding uses the official logo, product photography, Assistant and Barlow fonts, and neutral colors from jrcogolf.com. Asset sources are documented in static/brand/SOURCES.md.
- Initial version supports creating events and slots, viewing bookings and exporting them. Editing/deleting availability, cancellations, rescheduling, reminders, recurring schedules, external calendar sync, and group bookings are not implemented.
- Before public launch, add infrastructure rate limiting for login and booking endpoints, decide retention/privacy rules, and configure database backups. Schema changes after this initial version should use migrations rather than create_all.

## Tests

```powershell
.venv\Scripts\python -m unittest discover -s tests -v
```
