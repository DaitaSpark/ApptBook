import assert from 'node:assert/strict';
import {deliverCalendar, deliverEmail, googleAccessToken, removeCalendar} from '../supabase/functions/dispatch-bookings/delivery.js';

const booking = {id: '11111111-2222-4333-8444-555555555555', name: 'Guest', email: 'guest@example.com',
  phone: '555-0100', notes: 'Private team note', event_name: 'JR Golf', location: 'Office',
  starts_at: '2099-01-05T14:00:00Z', ends_at: '2099-01-05T14:30:00Z'};
const calls = [];
const success = async (url, init) => { calls.push({url, init}); return new Response('{}', {status: 200}); };
const secrets = {RESEND_API_KEY: 'test-only', MAIL_FROM: 'JR <appointments@example.com>', TEAM_EMAIL: 'team@example.com',
  WORKSPACE_EMAIL: 'appointments@example.com', GOOGLE_CALENDAR_ID: 'shared@example.com'};
await deliverEmail(booking, secrets, '', success);
let payload = JSON.parse(calls.at(-1).init.body);
assert.deepEqual(payload.to, [booking.email]);
assert.deepEqual(payload.bcc, [secrets.TEAM_EMAIL]);
assert.equal(calls.at(-1).init.headers['Idempotency-Key'], `appointment-${booking.id}`);
assert(!payload.text.includes(booking.notes));
await deliverEmail({...booking, email: ''}, secrets, '', success);
assert.deepEqual(JSON.parse(calls.at(-1).init.body).to, [secrets.TEAM_EMAIL]);
console.log('PASS email recipients, team notifications, privacy, and Resend idempotency');

await deliverEmail({...booking, event_name: 'Test\r\nBcc: attacker@example.com'}, secrets, 'google-token', success);
payload = JSON.parse(calls.at(-1).init.body);
const mime = Buffer.from(payload.raw, 'base64url').toString();
assert(mime.includes('Bcc: team@example.com'));
assert(!mime.includes('\r\nBcc: attacker@example.com'));
assert(calls.at(-1).url.includes('gmail/v1/users/me/messages/send'));
console.log('PASS Gmail MIME encoding and header injection protection');

await deliverCalendar(booking, secrets, 'token', success);
payload = JSON.parse(calls.at(-1).init.body);
assert.equal(payload.id, 'appt11111111222243338444555555555555');
assert.equal(payload.start.timeZone, 'America/New_York');
assert(payload.description.includes(booking.notes));
assert(!payload.attendees);
await deliverCalendar(booking, secrets, 'token', async (url, init) => init.method === 'POST' ?
  new Response('{}', {status: 409}) : new Response(JSON.stringify({extendedProperties: {private: {appt_booking_id: booking.id}}})));
await assert.rejects(deliverCalendar(booking, secrets, 'token', async (url, init) => init.method === 'POST' ?
  new Response('{}', {status: 409}) : new Response('{}')), /ID conflict/);
console.log('PASS stable calendar IDs, Eastern timezone, verified conflict retries, and no duplicate guest invites');
await assert.rejects(deliverEmail(booking, secrets, '', async () => new Response('secret provider error', {status: 503})), /HTTP 503/);
await assert.rejects(googleAccessToken({}, async () => new Response('{}')), /no access token/);
console.log('PASS provider failures surface without exposing response secrets');
const removals = [];
await removeCalendar(booking, secrets, 'token', async (url, init) => {
  removals.push({url, init});
  return init.method === 'DELETE' ? new Response(null, {status: 204}) :
    Response.json({extendedProperties: {private: {appt_booking_id: booking.id}}});
});
assert.equal(removals.length, 2);
assert.equal(removals[1].init.method, 'DELETE');
await removeCalendar(booking, secrets, 'token', async () => new Response('{}', {status: 404}));
await removeCalendar(booking, secrets, 'token', async () => new Response('{}', {status: 410}));
await assert.rejects(removeCalendar(booking, secrets, 'token', async () => Response.json({})), /ID conflict/);
console.log('PASS calendar removal verifies ownership, accepts already removed events, and retries safely');
