import {deliverCalendar, deliverEmail, googleAccessToken} from './delivery.js';

const secrets = Object.fromEntries(['DISPATCH_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY', 'MAIL_FROM', 'TEAM_EMAIL', 'WORKSPACE_EMAIL', 'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CALENDAR_ID'].map(key => [key, Deno.env.get(key) || '']));
const requestWithTimeout = (input: string, init: RequestInit = {}) => fetch(input, {...init, signal: AbortSignal.timeout(15000)});
async function rpc(name: string, body: Record<string, unknown>) {
  const response = await requestWithTimeout(`${secrets.SUPABASE_URL}/rest/v1/rpc/${name}`, {method: 'POST',
    headers: {apikey: secrets.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${secrets.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (!response.ok) throw new Error(`Queue operation failed (HTTP ${response.status}).`);
  return response.status === 204 ? null : response.json();
}
async function sameSecret(supplied: string, expected: string) {
  const hash = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([hash(supplied), hash(expected)]);
  return left.reduce((difference, value, index) => difference | (value ^ right[index]), 0) === 0;
}
Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', {status: 405});
  if (!secrets.DISPATCH_SECRET || !await sameSecret(request.headers.get('x-dispatch-secret') || '', secrets.DISPATCH_SECRET))
    return new Response('Unauthorized', {status: 401});
  try {
    const googleConfigured = Boolean(secrets.GOOGLE_CLIENT_ID && secrets.GOOGLE_CLIENT_SECRET && secrets.GOOGLE_REFRESH_TOKEN);
    const kinds = [];
    if ((googleConfigured && secrets.WORKSPACE_EMAIL) || (secrets.RESEND_API_KEY && secrets.MAIL_FROM)) kinds.push('email');
    if (googleConfigured && secrets.GOOGLE_CALENDAR_ID) kinds.push('calendar');
    if (!kinds.length) return Response.json({processed: 0, message: 'No delivery provider configured; bookings remain queued.'});
    const token = googleConfigured ? await googleAccessToken(secrets, requestWithTimeout) : '';
    const jobs = await rpc('appt_claim_jobs', {p_kinds: kinds, p_limit: 5});
    let delivered = 0;
    for (const job of jobs) {
      let errorText = null;
      try {
        if (job.kind === 'email') await deliverEmail(job.booking, secrets, token, requestWithTimeout);
        else await deliverCalendar(job.booking, secrets, token, requestWithTimeout);
        delivered++;
      } catch (error) { errorText = error instanceof Error ? error.message : 'Delivery failed.'; }
      await rpc('appt_finish_job', {p_id: job.id, p_lease_token: job.lease_token, p_error: errorText});
    }
    return Response.json({processed: jobs.length, delivered});
  } catch {
    // Do not expose provider responses, mailbox contents, or credentials in logs/responses.
    return Response.json({error: 'Delivery worker unavailable. Saved bookings remain queued for retry.'}, {status: 503});
  }
});
