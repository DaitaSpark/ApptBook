# Activate confirmations from Jeff

The temporary sender is `Jeff@jrcogolf.com`. This setup uses the existing
`dispatch-bookings` worker and its every-minute schedule. Calendar IDs do not
change. No customer email should be sent until step 4 is complete.

## 1. Protect historical bookings first

In the ApptBook Supabase project's SQL Editor, run
`migrations/012_email_activation.sql` after migrations 001–011.

This marks unsent email jobs as **skipped**, preserves sent-email records and
all calendar jobs, and blocks email claims until explicit activation. If it
reports an active email lease, pause the dispatch schedule and allow the worker
to finish and the lease to expire before retrying. An email already sent or
already in flight cannot be recalled.

Do not configure the sender before applying this migration. Existing versions
of the worker already call the protected database claim function, so no Edge
Function code change is required for the cutoff.

## 2. Authorize Jeff's account

The existing Google OAuth refresh token needs both scopes:

```
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/calendar.events
```

In the Google Cloud project used by the existing calendar integration, enable
the Gmail API, retain the Calendar API, and allow these scopes in the OAuth
consent configuration. Workspace policy might require administrator approval.

If the original token already grants both scopes to Jeff, it can be reused.
Otherwise obtain a new offline refresh token while signed in as
`Jeff@jrcogolf.com`. Retain the calendar scope so replacing the shared token
does not break calendar delivery or cancellation checks. Jeff must also retain
access to the Meetings calendar.

One manual authorization method is Google's OAuth Playground:

1. Add `https://developers.google.com/oauthplayground` to the existing web
   OAuth client's authorized redirect URIs.
2. Open https://developers.google.com/oauthplayground/ and, in its settings,
   select **Use your own OAuth credentials**. Supply the same client ID and
   client secret used by the worker. Use offline access and consent prompting.
3. Authorize both scopes above as Jeff, then exchange the authorization code
   for tokens. Use the returned **refresh token**, not the short-lived access
   token. Do not use Playground's default client for a production token.

Never put these credentials in Git, a chat message, or Render's frontend
environment. Use the private Supabase Edge Function Secrets interface.

## 3. Configure the existing worker

In Supabase **Edge Functions > Secrets**, retain the existing dispatch,
Supabase, and Google Calendar settings. Set:

| Secret | Value |
| --- | --- |
| `WORKSPACE_EMAIL` | `Jeff@jrcogolf.com` |
| `TEAM_EMAIL` | `Jeff@jrcogolf.com` |
| `GOOGLE_CLIENT_ID` | Existing OAuth client's ID |
| `GOOGLE_CLIENT_SECRET` | Same client's secret |
| `GOOGLE_REFRESH_TOKEN` | Token authorized by Jeff for both scopes |

Keep `GOOGLE_CALENDAR_ID` unchanged. This uses Gmail; no Resend key or
`MAIL_FROM` setting is required. Secret changes do not require an Edge Function
redeploy. Confirm the existing `appt-dispatch` cron schedule is enabled; only
run `schedule-dispatch.sql` if scheduling has not already been configured.

At this point calendar delivery can continue, but email claims remain disabled.

## 4. Activate only new confirmations

When the sender and authorization are ready, run `activate-email.sql` in SQL
Editor. It skips any additional email jobs created during setup and saves the
activation timestamp. Only bookings created at or after that timestamp may
send. Re-running this script preserves the timestamp and newer email jobs.

Historical email jobs remain excluded even if someone manually requeues them.
The timestamp uses each booking's creation time, not its appointment date.
Thus old test bookings for future dates still cannot send.

## 5. Verify with a new booking

Make one new booking using an email address you control. After the next worker
run, verify the confirmation arrived from Jeff with the correct event, Eastern
time, location, and reference. The worker Bccs the team address when different
from the guest address. Phone-only bookings generate a team notification.

In Admin, old test bookings should show **not sent (before email activation)**
and the new booking should show **sent**. Confirm the new appointment also
reaches the existing Meetings calendar. Delete the disposable test booking
through Admin after checking it; deletion does not send a cancellation email.

## Later: switch to meetings@jrcogolf.com

Create the group and verify it as a permitted **Send mail as** address on the
authorized account. Then change `WORKSPACE_EMAIL` and `TEAM_EMAIL` to
`meetings@jrcogolf.com`. Keep the original activation timestamp; do not repeat
the migration or reset the queue. No calendar change is needed.

References:

- Google OAuth: https://developers.google.com/identity/protocols/oauth2/web-server
- OAuth Playground: https://developers.google.com/oauthplayground/
- Supabase secrets: https://supabase.com/docs/guides/functions/secrets
