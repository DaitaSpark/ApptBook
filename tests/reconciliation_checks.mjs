import assert from 'node:assert/strict';
import {inspectCalendar, calendarPayload} from '../supabase/functions/dispatch-bookings/delivery.js';
const booking = {id:'11111111-2222-4333-8444-555555555555', event_name:'PGA', name:'Guest',
  starts_at:'2099-01-27T14:00:00Z', ends_at:'2099-01-27T14:30:00Z', company:'Golf Club', source_label:'Sales'};
const secrets = {GOOGLE_CALENDAR_ID:'shared@group.calendar.google.com'};
const expected = calendarPayload(booking);
const inspect = (event, verified = true) => inspectCalendar(booking,secrets,'token',verified,async () => Response.json(event));
assert.equal((await inspect({...expected,status:'confirmed'})).outcome,'ok');
const equivalent = {...expected, start:{dateTime:'2099-01-27T09:00:00-05:00'}};
assert.equal((await inspect(equivalent)).outcome,'ok');
const moved = await inspect({...expected,start:{dateTime:'2099-01-27T15:00:00Z'},summary:'Changed title'});
assert.equal(moved.outcome,'changed'); assert.equal(moved.differences.length,2);
assert.equal((await inspect({...expected,start:{date:'2099-01-27'},recurrence:['RRULE:FREQ=DAILY']})).outcome,'changed');
assert.equal((await inspect({id:expected.id,status:'cancelled'})).outcome,'cancelled');
assert.equal((await inspect({id:expected.id,status:'cancelled'},false)).outcome,'missing');
assert.equal((await inspect({id:'other',status:'cancelled'})).outcome,'error');
assert.equal((await inspect({...expected,status:'cancelled',extendedProperties:{private:{appt_booking_id:'wrong'}}})).outcome,'error');
assert.equal((await inspect({...expected,extendedProperties:{}})).outcome,'error');
for (const code of [404,410]) {
  assert.equal((await inspectCalendar(booking,secrets,'token',true,async () => new Response('{}',{status:code}))).outcome,'missing');
}
for (const code of [401,403,429,500]) {
  await assert.rejects(inspectCalendar(booking,secrets,'token',true,async () => new Response('private error',{status:code})), /Calendar audit request failed/);
}
await assert.rejects(inspectCalendar(booking,secrets,'token',true,async () => {throw new Error('Network down');}));
console.log('PASS matched timestamps, changed details/all-day/recurrence, verified cancellation, missing entries and provider failures');
