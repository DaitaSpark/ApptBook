import assert from 'node:assert/strict';
import {testConfirmation} from '../supabase/functions/dispatch-bookings/test-confirmation.js';
const slot = '11111111-2222-4333-8444-555555555555';
const id = '22222222-2222-4333-8444-555555555555';
const body = {name: 'Test Test', email: 'test@example.com', slot_id: slot, request_id: id};
const request = (values = body) => new Request('https://worker.test/?mode=test-confirmation', {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(values)});
const secrets = {WORKSPACE_EMAIL: 'info@example.com', TEAM_EMAIL: 'team@example.com',
  GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'refresh'};
const receipt = {name: 'Test Test', email: body.email, id: `test-${id}`, is_test: true,
  event_name: 'PGA Show', starts_at: '2099-01-05T14:00:00Z', location: ''};
const rpcCalls = [], networkCalls = [];
const rpc = async (name, args) => {
  rpcCalls.push({name, args});
  if (name === 'appt_claim_test_confirmation') return {send: true, receipt};
  if (name === 'appt_finish_test_confirmation') return null;
  throw new Error('Unexpected database write');
};
const send = async (url, init) => {
  networkCalls.push({url, init});
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({access_token: 'token'});
  assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  const mime = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString();
  assert(!mime.includes('Bcc:'));
  const encodedSubject = mime.match(/Subject: =\?UTF-8\?B\?([^?]+)/)[1];
  assert(Buffer.from(encodedSubject, 'base64').toString().includes('[TEST - no appointment reserved]'));
  return Response.json({id: 'sent'});
};
const result = await testConfirmation(request(), secrets, rpc, send);
assert.equal(result.status, 200);
assert.equal((await result.json()).is_test, true);
assert.deepEqual(rpcCalls.map(c => c.name), ['appt_claim_test_confirmation', 'appt_finish_test_confirmation']);
assert.equal(rpcCalls[1].args.p_sent, true);
const priorNetwork = networkCalls.length;
const duplicate = await testConfirmation(request(), secrets, async () => ({send: false, receipt}), send);
assert.equal(duplicate.status, 200);
assert.equal(networkCalls.length, priorNetwork);
assert.equal((await testConfirmation(request({...body, name: 'Real Guest'}), secrets, rpc, send)).status, 400);
assert.equal((await testConfirmation(request({...body, email: ''}), secrets, rpc, send)).status, 400);
assert.equal((await testConfirmation(request(), {}, rpc, send)).status, 503);
const failedCalls = [];
const failed = await testConfirmation(request(), secrets, async (name, args) => {
  failedCalls.push({name, args});
  return name === 'appt_claim_test_confirmation' ? {send: true, receipt} : null;
}, async () => new Response('private provider details', {status: 400}));
assert.equal(failed.status, 503);
assert.equal(failedCalls.at(-1).args.p_sent, false);
assert(!(await failed.text()).includes('private provider details'));
const options = await testConfirmation(new Request('https://worker.test/', {method: 'OPTIONS'}), secrets, rpc, send);
assert.equal(options.status, 204);
assert.equal(options.headers.get('Access-Control-Allow-Origin'), '*');
console.log('PASS test email validates input, sends only labelled email without team Bcc/calendar, handles CORS/errors, and avoids duplicate sends');
