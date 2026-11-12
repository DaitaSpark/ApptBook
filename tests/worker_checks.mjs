import assert from 'node:assert/strict';
let handler;
let environment = {DISPATCH_SECRET: 'test-secret', SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'server-only'};
globalThis.Deno = {env: {get: name => environment[name]}, serve: fn => { handler = fn; }};
const calls = [];
globalThis.fetch = async (url, init) => { calls.push(url); throw new Error('Unexpected network request'); };
await import('../supabase/functions/dispatch-bookings/index.ts?none');
assert.equal((await handler(new Request('http://worker', {method: 'POST'}))).status, 401);
assert.equal((await handler(new Request('http://worker', {method: 'POST', headers: {'x-dispatch-secret': 'wrong'}}))).status, 401);
assert.equal((await handler(new Request('http://worker'))).status, 405);
assert.equal(calls.length, 0);
const authorized = () => new Request('http://worker', {method: 'POST', headers: {'x-dispatch-secret': 'test-secret'}});
assert.equal((await (await handler(authorized())).json()).processed, 0);
assert.equal(calls.length, 0);
console.log('PASS worker denies unauthorized/browser dispatch and leaves unconfigured jobs unclaimed');

environment = {...environment, RESEND_API_KEY: 'provider-only', MAIL_FROM: 'appointments@example.com', TEAM_EMAIL: 'team@example.com'};
const acknowledgments = [];
globalThis.fetch = async (url, init) => {
  calls.push(url);
  if (url.endsWith('/appt_claim_calendar_audit')) return Response.json([]);
  if (url.endsWith('/appt_claim_jobs')) {
    assert.equal(init.headers.Authorization, 'Bearer server-only');
    assert.deepEqual(JSON.parse(init.body).p_kinds, ['email']);
    return Response.json([{id: 'job', kind: 'email', lease_token: 'lease', booking: {
      id: 'booking', name: 'Guest', email: 'guest@example.com', event_name: 'Golf', starts_at: '2099-01-01T14:00:00Z'}}]);
  }
  if (url === 'https://api.resend.com/emails') return new Response('private provider payload', {status: 503});
  if (url.endsWith('/appt_finish_job')) {
    acknowledgments.push(JSON.parse(init.body));
    return new Response(null, {status: 204});
  }
  throw new Error('Unexpected URL');
};
await import('../supabase/functions/dispatch-bookings/index.ts?email');
const result = await handler(authorized());
assert.equal(result.status, 200);
assert.equal((await result.json()).delivered, 0);
assert.equal(acknowledgments.length, 1);
assert.equal(acknowledgments[0].p_lease_token, 'lease');
assert.equal(acknowledgments[0].p_error, 'Email request failed (HTTP 503).');
assert(!JSON.stringify(acknowledgments).includes('private provider payload'));
console.log('PASS failed provider deliveries are acknowledged for retry without leaking response data');

environment = {...environment, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'refresh', GOOGLE_CALENDAR_ID: 'shared@example.com'};
const cleanup = [];
globalThis.fetch = async (url, init) => {
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({access_token: 'google-token'});
  if (url.endsWith('/appt_claim_calendar_audit')) return Response.json([]);
  if (url.endsWith('/appt_claim_jobs')) {
    assert(JSON.parse(init.body).p_kinds.includes('calendar_delete'));
    return Response.json([{id: 'cleanup-job', kind: 'calendar_delete', lease_token: 'cleanup-lease', booking: {id: 'booking'}}]);
  }
  if (url.includes('/calendar/v3/')) {
    cleanup.push(init.method || 'GET');
    return init.method === 'DELETE' ? new Response(null, {status: 204}) :
      Response.json({extendedProperties: {private: {appt_booking_id: 'booking'}}});
  }
  if (url.endsWith('/appt_finish_job')) {
    assert.equal(JSON.parse(init.body).p_error, null);
    return new Response(null, {status: 204});
  }
  throw new Error('Unexpected provider request');
};
await import('../supabase/functions/dispatch-bookings/index.ts?calendar-cleanup');
assert.equal((await (await handler(authorized())).json()).delivered, 1);
assert.deepEqual(cleanup, ['GET', 'DELETE']);
console.log('PASS calendar cleanup jobs remove events instead of recreating them');

const syncedBooking = {id:'11111111-2222-4333-8444-555555555555',name:'Guest',event_name:'PGA',
  starts_at:'2099-01-27T14:00:00Z',ends_at:'2099-01-27T14:30:00Z'};
const syncCalls = [];
globalThis.fetch = async (url,init) => {
  if(url === 'https://oauth2.googleapis.com/token') return Response.json({access_token:'token'});
  if(url.endsWith('/appt_claim_jobs')) return Response.json([{id:'create',kind:'calendar',lease_token:'outbound',booking:syncedBooking}]);
  if(url.includes('/calendar/v3/')) {
    syncCalls.push(init.method || 'GET');
    if(init.method === 'POST') return Response.json({});
    return Response.json({id:'appt11111111222243338444555555555555',status:'cancelled'});
  }
  if(url.endsWith('/appt_calendar_delivered')) { syncCalls.push('bound'); return new Response(null,{status:204}); }
  if(url.endsWith('/appt_finish_job')) { syncCalls.push('acknowledged'); return new Response(null,{status:204}); }
  if(url.endsWith('/appt_claim_calendar_audit')) return Response.json([{booking:syncedBooking,verified:true,lease_token:'audit'}]);
  if(url.endsWith('/appt_finish_calendar_audit')) {
    const body=JSON.parse(init.body); assert.equal(body.p_outcome,'cancelled'); assert.equal(body.p_lease_token,'audit');
    syncCalls.push('cancelled'); return new Response(null,{status:204});
  }
  throw new Error('Unexpected sync request');
};
await import('../supabase/functions/dispatch-bookings/index.ts?sync');
const synced=await (await handler(authorized())).json();
assert.equal(synced.delivered,1);assert.equal(synced.audited,1);assert.equal(synced.audit_failed,false);
assert.deepEqual(syncCalls,['POST','bound','acknowledged','GET','cancelled']);
console.log('PASS worker binds successful deliveries before acknowledgment and applies verified inbound cancellations through leased RPC');
