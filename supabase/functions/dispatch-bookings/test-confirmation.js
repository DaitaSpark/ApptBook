import {deliverEmail, googleAccessToken} from './delivery.js';

const cors = {'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'};
const json = (body, status = 200) => Response.json(body, {status, headers: cors});
export async function testConfirmation(request, secrets, rpc, sendRequest = fetch) {
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
  if (request.method !== 'POST') return json({message: 'Method not allowed.'}, 405);
  let body;
  try {
    if (Number(request.headers.get('content-length')) > 4096) throw new Error();
    const raw = await request.text();
    if (raw.length > 4096) throw new Error();
    body = JSON.parse(raw);
  } catch { return json({message: 'Invalid test request.'}, 400); }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!body || typeof body.name !== 'string' || body.name.trim().replace(/\s+/g, ' ').toLowerCase() !== 'test test'
    || typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)
    || !uuid.test(body.slot_id) || !uuid.test(body.request_id))
    return json({message: 'Use Test Test as the name and enter a valid email address.'}, 400);
  const google = Boolean(secrets.WORKSPACE_EMAIL && secrets.GOOGLE_CLIENT_ID
    && secrets.GOOGLE_CLIENT_SECRET && secrets.GOOGLE_REFRESH_TOKEN);
  if (!google && !(secrets.RESEND_API_KEY && secrets.MAIL_FROM))
    return json({message: 'Test email sending is not configured. No appointment was created.'}, 503);
  let claim;
  try {
    claim = await rpc('appt_claim_test_confirmation', {p_request_id: body.request_id,
      p_slot_id: body.slot_id, p_name: body.name, p_email: body.email});
  } catch {
    return json({message: 'Test could not start. Choose a future time, wait one minute, and retry. No appointment was created.'}, 429);
  }
  if (!claim.send) return json(claim.receipt);
  try {
    const token = google ? await googleAccessToken(secrets, sendRequest) : '';
    await deliverEmail({...claim.receipt, is_test: true}, secrets, token, sendRequest);
  } catch {
    await rpc('appt_finish_test_confirmation', {p_request_id: body.request_id, p_sent: false}).catch(() => {});
    return json({message: 'Test email could not be sent. No appointment was created. Wait one minute before retrying.'}, 503);
  }
  try { await rpc('appt_finish_test_confirmation', {p_request_id: body.request_id, p_sent: true}); }
  catch {
    // Never retry an already-sent email just because acknowledgment failed.
    return json({message: 'Test email was sent, but its delivery marker could not be updated. Check your inbox. No appointment was created.'}, 503);
  }
  return json(claim.receipt);
}
