import assert from 'node:assert/strict';
import {syncCancellations} from '../supabase/functions/dispatch-bookings/delivery.js';
const secrets={GOOGLE_CALENDAR_ID:'shared@group.calendar.google.com'};
let commits=[], releases=[], pages=[], cursor, responses=[];
const rpc=async(name,body)=>{
  if(name==='appt_claim_calendar_sync') return cursor;
  if(name==='appt_apply_calendar_sync_page') {commits.push(body);return body.p_items.filter(i=>i.status==='cancelled').length;}
  if(name==='appt_release_calendar_sync') {releases.push(body);return null;}
  throw new Error('Unexpected RPC');
};
const request=async url=>{pages.push(new URL(url));const next=responses.shift();if(next instanceof Error)throw next;return next;};
function reset(value={lease_token:'lease',sync_token:'old-sync',page_token:null}) {cursor=value;commits=[];releases=[];pages=[];responses=[];}
reset(null);assert.equal((await syncCancellations(secrets,'token',rpc,request)).busy,true);assert.equal(pages.length,0);
reset();responses=[Response.json({items:[{id:'cancel',status:'cancelled'}],nextPageToken:'page-2'}),
  Response.json({items:[{id:'changed',status:'confirmed',summary:'private',extendedProperties:{private:{appt_booking_id:'id'}}}],nextSyncToken:'new-sync'})];
let result=await syncCancellations(secrets,'token',rpc,request);
assert.equal(result.cancelled,1);assert.equal(result.polled,true);assert.equal(commits.length,2);
assert.equal(pages[0].searchParams.get('syncToken'),'old-sync');assert.equal(pages[1].searchParams.get('syncToken'),'old-sync');
assert.equal(pages[1].searchParams.get('pageToken'),'page-2');assert.equal(commits[0].p_next_sync,null);assert.equal(commits[1].p_next_sync,'new-sync');
assert(!JSON.stringify(commits).includes('private'));assert.equal(commits[1].p_items[0].booking_id,'id');
assert.equal(pages[0].searchParams.get('showDeleted'),'true');assert(!pages[0].searchParams.has('timeMin'));
reset({lease_token:'lease',sync_token:null,page_token:'resume'});responses=[Response.json({items:[],nextSyncToken:'first-sync'})];
await syncCancellations(secrets,'token',rpc,request);assert(!pages[0].searchParams.has('syncToken'));assert.equal(pages[0].searchParams.get('pageToken'),'resume');
reset();responses=[new Response('{}',{status:410})];result=await syncCancellations(secrets,'token',rpc,request);
assert(result.rebuilding);assert.equal(commits.length,0);assert.equal(releases[0].p_reset,true);
for(const response of [new Response('{}',{status:403}),new Error('network'),Response.json({items:[]})]) {
  reset();responses=[response];await assert.rejects(syncCancellations(secrets,'token',rpc,request));
  assert.equal(commits.length,0);assert.equal(releases[0].p_reset,false);assert.equal(releases[0].p_error,true);
}
reset();responses=Array.from({length:3},(_,i)=>Response.json({items:[],nextPageToken:`page-${i}`}));
assert((await syncCancellations(secrets,'token',rpc,request)).backlog);assert.equal(commits.length,3);assert.equal(releases[0].p_reset,false);
reset();responses=[Response.json({items:[{id:'cancel',status:'cancelled'}],nextSyncToken:'new'})];
await assert.rejects(syncCancellations(secrets,'token',async(name,body)=>{
  if(name==='appt_apply_calendar_sync_page')throw new Error('Database unavailable');return rpc(name,body);
},request));assert.equal(releases[0].p_error,true);
console.log('PASS incremental sync, initial/resumed pagination, private field projection, bounded catch-up, token expiration, failed requests and failed database commits');
