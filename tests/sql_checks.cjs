// Actual PostgreSQL execution using the local-only PGlite WASM engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {PGlite} = require('../.test-tools/pglite/package/dist/index.cjs');

(async () => {
  const db = new PGlite();
  let checks = 0;
  const admin = randomUUID(), ordinary = randomUUID();
  const query = async (sql, args = []) => (await db.query(sql, args)).rows;
  const scalar = async (sql, args = []) => Object.values((await query(sql, args))[0])[0];
  async function role(name, user = '') {
    await db.exec('reset role');
    await query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
    await db.exec(`set role ${name}`);
  }
  const check = description => { checks++; console.log(`PASS ${description}`); };
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
  const migration = fs.readFileSync('supabase/migrations/001_appointments.sql', 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  const customMigration = fs.readFileSync('supabase/migrations/002_custom_availability.sql', 'utf8');
  await db.exec(customMigration);
  await db.exec(customMigration);
  const trackingMigration = fs.readFileSync('supabase/migrations/003_release_and_tracking.sql', 'utf8');
  await db.exec(trackingMigration);
  await db.exec(trackingMigration);
  const deleteMigration = fs.readFileSync('supabase/migrations/004_delete_tracking_links.sql', 'utf8');
  await db.exec(deleteMigration);
  await db.exec(deleteMigration);
  const bookingDeletion = fs.readFileSync('supabase/migrations/005_delete_bookings.sql', 'utf8');
  await db.exec(bookingDeletion);
  await db.exec(bookingDeletion);
  await query('insert into auth.users values($1),($2)', [admin, ordinary]);
  await query('insert into appt_private.admins values($1)', [admin]);
  check('migration executes and can be reapplied without dropping data');

  await role('anon');
  assert.deepEqual(await scalar('select public.appt_public_events()'), []);
  await assert.rejects(query('select * from appt_private.bookings'), /permission denied/);
  await assert.rejects(query('select public.appt_admin_dashboard()'), /permission denied/);
  await assert.rejects(query("select public.appt_claim_jobs(array['email'])"), /permission denied/);
  await assert.rejects(query("select public.appt_admin_generate_slots(null,'2099-01-27','2099-01-29','09:00','15:30')"), /permission denied/);
  check('anonymous users cannot read private tables, admin data, or delivery jobs');
  await role('authenticated', ordinary);
  await assert.rejects(query('select public.appt_admin_dashboard()'), /authorized admin/);
  await assert.rejects(query("select public.appt_admin_create_event('Intruder','','',1,false)"), /authorized admin/);
  await assert.rejects(query("select public.appt_claim_jobs(array['email'])"), /permission denied/);
  await assert.rejects(query("select public.appt_admin_generate_slots(null,'2099-01-27','2099-01-29','09:00','15:30')"), /authorized admin/);
  check('signing in without the admin allowlist grants no management access');

  await role('authenticated', admin);
  const eventId = await scalar("select public.appt_admin_create_event('JR Golf','','Office',1,false)");
  const monday = new Date('2099-01-01T12:00:00Z');
  while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
  const first = monday.toISOString().slice(0, 10);
  const nextMonday = new Date(monday); nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
  const last = nextMonday.toISOString().slice(0, 10);
  assert.equal(await scalar('select public.appt_admin_add_workdays($1,$2,$3)', [eventId, first, last]), 84);
  assert.equal(await scalar('select public.appt_admin_add_workdays($1,$2,$3)', [eventId, first, last]), 0);
  const dashboard = await scalar('select public.appt_admin_dashboard()');
  assert.equal(dashboard.slots.length, 84);
  assert(dashboard.slots.every(slot => slot.capacity === 1));
  assert.equal(new Date(dashboard.slots[0].starts_at).getUTCHours(), 14); // 9 a.m. EST
  assert.equal(new Date(dashboard.slots[13].ends_at).getUTCHours(), 21); // 4 p.m. EST
  check('weekday generator creates 14 half-hour slots per weekday, skips weekends, and is idempotent');
  await assert.rejects(query('select public.appt_admin_add_slot($1,$2,$3,1)', [eventId, `${first}T09:15`, `${first}T10:15`]), /overlaps/);
  await assert.rejects(query('select public.appt_admin_add_workdays($1,$2,$3)', [eventId, last, first]), /valid date range/);
  await assert.rejects(query("select public.appt_admin_add_slot($1,'2030-03-10 02:30','2030-03-10 03:30',1)", [eventId]), /daylight saving/);
  await assert.rejects(query("select public.appt_admin_add_slot($1,'2030-11-03 01:30','2030-11-03 02:30',1)", [eventId]), /daylight saving/);
  check('overlaps, reversed ranges, and ambiguous/nonexistent Eastern times are rejected');

  const slotId = dashboard.slots[0].id;
  const requestId = randomUUID();
  const args = [slotId, requestId, 'A Guest', '', '555-0100', 'Private note'];
  await role('anon');
  await assert.rejects(query('select public.appt_book($1,$2,$3,$4,$5,$6)', [slotId, randomUUID(), 'A Guest', '', '', '']), /email address or phone/);
  await assert.rejects(query('select public.appt_book($1,$2,$3,$4,$5,$6)', [slotId, randomUUID(), 'A Guest', 'bad-email', '', '']), /email address or phone/);
  const receipt = await scalar('select public.appt_book($1,$2,$3,$4,$5,$6)', args);
  assert(receipt.id);
  assert.deepEqual(await scalar('select public.appt_book($1,$2,$3,$4,$5,$6)', args), receipt);
  await assert.rejects(query('select public.appt_book($1,$2,$3,$4,$5,$6)', [slotId, requestId, 'Different guest', '', '555-0100', '']), /different details/);
  const competing = await Promise.allSettled(Array.from({length: 8}, () =>
    query('select public.appt_book($1,$2,$3,$4,$5,$6)', [slotId, randomUUID(), 'Other guest', '', '555-0100', ''])));
  assert(competing.every(result => result.status === 'rejected' && /no longer available/.test(result.reason.message)));
  check('contact validation, idempotent retries, request conflicts, and capacity rejection execute in PostgreSQL');
  const publicSlots = await scalar('select public.appt_public_slots($1)', [eventId]);
  assert.equal(publicSlots.find(slot => slot.id === slotId).remaining, 0);
  assert(publicSlots.every(slot => !('name' in slot) && !('email' in slot) && !('phone' in slot) && !('notes' in slot)));
  check('public availability reveals remaining capacity but no guest data');
  await role('authenticated', admin);
  const saved = await scalar('select public.appt_admin_dashboard()');
  assert.equal(saved.booking_count, 1);
  assert.equal(saved.bookings[0].notes, 'Private note');
  assert.equal(saved.slots.find(slot => slot.id === slotId).reserved, 1);
  await scalar('select public.appt_admin_add_workdays($1,$2,$3)', [eventId, first, last]);
  assert.equal((await scalar('select public.appt_admin_dashboard()')).slots.find(slot => slot.id === slotId).reserved, 1);
  check('admin reporting works and regeneration preserves reserved places');

  await role('service_role');
  const jobs = await scalar("select public.appt_claim_jobs(array['calendar'],5)");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].booking.id, receipt.id);
  assert.deepEqual(await scalar("select public.appt_claim_jobs(array['calendar'],5)"), []);
  await query('select public.appt_finish_job($1,$2,null)', [jobs[0].id, randomUUID()]);
  await role('authenticated', admin);
  assert.equal((await scalar('select public.appt_admin_dashboard()')).bookings[0].calendar_status, 'processing');
  await role('service_role');
  await query('select public.appt_finish_job($1,$2,null)', [jobs[0].id, jobs[0].lease_token]);
  const emailJob = (await scalar("select public.appt_claim_jobs(array['email'],5)"))[0];
  await query('select public.appt_finish_job($1,$2,$3)', [emailJob.id, emailJob.lease_token, 'Provider unavailable']);
  await db.exec('reset role');
  const states = await query('select kind,state,available_at > now() as delayed from appt_private.jobs order by kind');
  assert.equal(states[0].state, 'sent');
  assert.equal(states[1].state, 'queued');
  assert(states[1].delayed);
  assert.equal(await scalar('select count(*)::integer from appt_private.bookings'), 1);
  check('worker leases prevent double claims; acknowledgments require lease tokens; failures retry without losing bookings');

  await db.exec(fs.readFileSync('supabase/seed.sql', 'utf8'));
  assert.equal(await scalar('select count(*)::integer from appt_private.events'), 1);
  check('initial seeding leaves existing schedules intact');

  await role('authenticated', admin);
  const pga = await scalar("select public.appt_admin_create_event('PGA Show','','',3,false)");
  for (const day of ['27', '28', '29'])
    await scalar('select public.appt_admin_add_slot($1,$2,$3,3)', [pga, `2099-01-${day}T09:00`, `2099-01-${day}T15:30`]);
  const untouched = await scalar("select public.appt_admin_add_slot($1,'2099-01-30 09:00','2099-01-30 09:30',3)", [pga]);
  let generated = await scalar("select public.appt_admin_generate_slots($1,'2099-01-27','2099-01-28','09:00','15:30',30,null,false,true)", [pga]);
  assert.deepEqual(generated, {added: 28, removed: 2, preserved: 0, conflicts: 0});
  generated = await scalar("select public.appt_admin_generate_slots($1,'2099-01-29','2099-01-29','09:00','11:30',30,null,false,true)", [pga]);
  assert.deepEqual(generated, {added: 6, removed: 1, preserved: 0, conflicts: 0});
  let pgaSlots = await scalar('select public.appt_public_slots($1)', [pga]);
  assert.equal(pgaSlots.length, 35); // 34 requested meetings plus the untouched Jan 30 meeting.
  assert(pgaSlots.every(slot => slot.remaining === 3));
  assert(pgaSlots.some(slot => slot.id === untouched));
  assert.equal(pgaSlots.filter(slot => slot.starts_at.startsWith('2099-01-29')).length, 6);
  assert.equal(pgaSlots.filter(slot => slot.starts_at.startsWith('2099-01-29')).at(-1).ends_at, '2099-01-29T17:00:00+00:00');
  check('custom hours replace long unbooked ranges with 34 half-hour meetings, retain capacity 3, and leave other dates untouched');
  await role('anon');
  const protectedId = pgaSlots[0].id;
  await scalar('select public.appt_book($1,$2,$3,$4,$5,$6)', [protectedId, randomUUID(), 'Booked guest', '', '555-0100', '']);
  await role('authenticated', admin);
  generated = await scalar("select public.appt_admin_generate_slots($1,'2099-01-27','2099-01-28','09:00','15:30',30,1,false,true)", [pga]);
  assert.deepEqual(generated, {added: 27, removed: 27, preserved: 1, conflicts: 1});
  const protectedSlot = (await scalar('select public.appt_admin_dashboard()')).slots.find(slot => slot.id === protectedId);
  assert.equal(protectedSlot.reserved, 1);
  assert.equal(protectedSlot.capacity, 3);
  assert.equal(protectedSlot.id, protectedId);
  await assert.rejects(query("select public.appt_admin_generate_slots($1,'2099-01-27','2099-01-28','09:00','15:40',30,1,false,true)", [pga]), /aligned/);
  await assert.rejects(query("select public.appt_admin_generate_slots($1,'2099-01-27','2099-01-28','09:00','15:30',30,0,false,true)", [pga]), /Capacity/);
  pgaSlots = await scalar('select public.appt_public_slots($1)', [pga]);
  assert.equal(pgaSlots.length, 35);
  check('replacement preserves booked slot IDs/capacity and invalid ranges roll back without removing availability');

  const releaseEvent = await scalar("select public.appt_admin_create_event('Limited show','','',2,false)");
  await scalar("select public.appt_admin_generate_slots($1,'2099-02-10','2099-02-11','09:00','11:00',30,2,false,false)", [releaseEvent]);
  await query('select public.appt_admin_set_release($1,3)', [releaseEvent]);
  const referral = await scalar("select public.appt_admin_create_referral($1,'Jeff','salesperson')", [releaseEvent]);
  const channel = await scalar("select public.appt_admin_create_referral($1,'Newsletter','channel')", [releaseEvent]);
  const duplicate = await scalar("select public.appt_admin_create_referral($1,'Jeff','salesperson')", [releaseEvent]);
  assert.equal(duplicate.token, referral.token);
  await role('authenticated', ordinary);
  await assert.rejects(query('select public.appt_admin_set_release($1,1)', [releaseEvent]), /authorized admin/);
  await assert.rejects(query("select public.appt_admin_create_referral($1,'Intruder','channel')", [releaseEvent]), /authorized admin/);
  await role('anon');
  await assert.rejects(query('select * from appt_private.referral_links'), /permission denied/);
  assert.equal(await scalar('select public.appt_ref_valid($1,$2)', [releaseEvent, referral.token]), true);
  assert.equal(await scalar('select public.appt_ref_valid($1,$2)', [pga, referral.token]), false);
  let released = await scalar('select public.appt_public_slots($1)', [releaseEvent]);
  assert.equal(released.length, 10);
  assert.equal(released.filter(slot => slot.is_open).length, 6); // Three independently on each day.
  assert(released.every(slot => !('source_label' in slot) && !('token' in slot)));
  await assert.rejects(query('select public.appt_book($1,$2,$3,$4,$5,$6)',
    [released[3].id, randomUUID(), 'Guest', '', '555-0100', '']), /not yet open/);
  await assert.rejects(query('select public.appt_book_tracked($1,$2,$3,$4,$5,$6,$7)',
    [released[3].id, randomUUID(), 'Guest', '', '555-0100', '', referral.token]), /not yet open/);
  check('daily release limit opens only three times per day, and neither old nor new booking endpoints can bypass it');
  const firstRequest = randomUUID();
  const firstReceipt = await scalar('select public.appt_book_tracked($1,$2,$3,$4,$5,$6,$7)',
    [released[0].id, firstRequest, 'Sales lead', '', '555-0100', '', referral.token]);
  released = await scalar('select public.appt_public_slots($1)', [releaseEvent]);
  assert.equal(released[0].remaining, 1);
  assert.equal(released[3].is_open, false); // Partial capacity still counts as one of the three open times.
  await scalar('select public.appt_book_tracked($1,$2,$3,$4,$5,$6,$7)',
    [released[0].id, randomUUID(), 'Channel lead', '', '555-0101', '', channel.token]);
  released = await scalar('select public.appt_public_slots($1)', [releaseEvent]);
  assert.equal(released[0].remaining, 0);
  assert.equal(released[0].is_open, false);
  assert.equal(released[3].is_open, true);
  assert.equal(released.filter(slot => slot.is_open).length, 6);
  await assert.rejects(query('select public.appt_book_tracked($1,$2,$3,$4,$5,$6,$7)',
    [released[1].id, randomUUID(), 'Unknown lead', '', '555-0102', '', 'unknown']), /link is no longer active/);
  await assert.rejects(query('select public.appt_book_tracked($1,$2,$3,$4,$5,$6,$7)',
    [pgaSlots[1].id, randomUUID(), 'Wrong event', '', '555-0102', '', referral.token]), /link is no longer active/);
  check('the next time opens only when a time fills; source tokens are validated against their event');
  await role('authenticated', admin);
  let tracked = await scalar('select public.appt_admin_dashboard()');
  assert.equal(tracked.referral_links.find(link => link.id === referral.id).booking_count, 1);
  assert.equal(tracked.referral_links.find(link => link.id === channel.id).booking_count, 1);
  assert.equal(tracked.bookings.find(booking => booking.id === firstReceipt.id).source_label, 'Jeff');
  assert.equal(tracked.bookings.find(booking => booking.id === firstReceipt.id).source_kind, 'salesperson');
  await query('select public.appt_admin_set_referral($1,false)', [referral.id]);
  await role('anon');
  assert.equal(await scalar('select public.appt_ref_valid($1,$2)', [releaseEvent, referral.token]), false);
  assert.deepEqual(await scalar('select public.appt_book_tracked($1,$2,$3,$4,$5,$6,$7)',
    [released[0].id, firstRequest, 'Sales lead', '', '555-0100', '', channel.token]), firstReceipt);
  await assert.rejects(query('select public.appt_book_tracked($1,$2,$3,$4,$5,$6,$7)',
    [released[1].id, randomUUID(), 'Disabled lead', '', '555-0103', '', referral.token]), /link is no longer active/);
  await role('authenticated', admin);
  tracked = await scalar('select public.appt_admin_dashboard()');
  assert.equal(tracked.bookings.find(booking => booking.id === firstReceipt.id).source_label, 'Jeff');
  assert.equal(tracked.referral_links.find(link => link.id === referral.id).booking_count, 1);
  await query('select public.appt_admin_set_release($1,null)', [releaseEvent]);
  assert.equal((await scalar('select public.appt_public_slots($1)', [releaseEvent])).filter(slot => slot.is_open).length, 9);
  check('source snapshots/totals are private, duplicate retries never reattribute, disabled links reject new bookings, and limits can be removed');

  const unused = await scalar("select public.appt_admin_create_referral($1,'Unused campaign','channel')", [releaseEvent]);
  await role('anon');
  await assert.rejects(query('select public.appt_admin_delete_referral($1)', [unused.id]), /permission denied/);
  await role('authenticated', ordinary);
  await assert.rejects(query('select public.appt_admin_delete_referral($1)', [unused.id]), /authorized admin/);
  await role('authenticated', admin);
  await query('select public.appt_admin_delete_referral($1)', [unused.id]);
  await query('select public.appt_admin_delete_referral($1)', [unused.id]);
  await query('select public.appt_admin_delete_referral($1)', [referral.id]);
  await query('select public.appt_admin_delete_referral($1)', [referral.id]);
  const afterDelete = await scalar('select public.appt_admin_dashboard()');
  assert(!afterDelete.referral_links.some(link => link.id === unused.id || link.id === referral.id));
  assert.equal(afterDelete.bookings.find(booking => booking.id === firstReceipt.id).source_label, 'Jeff');
  await assert.rejects(query('select public.appt_admin_set_referral($1,true)', [referral.id]), /not found/);
  const recreated = await scalar("select public.appt_admin_create_referral($1,'Jeff','salesperson')", [releaseEvent]);
  assert.notEqual(recreated.id, referral.id);
  assert.notEqual(recreated.token, referral.token);
  assert.equal((await scalar('select public.appt_admin_dashboard()')).referral_links.find(link => link.id === recreated.id).booking_count, 0);
  await role('anon');
  assert.equal(await scalar('select public.appt_ref_valid($1,$2)', [releaseEvent, referral.token]), false);
  assert.equal(await scalar('select public.appt_ref_valid($1,$2)', [releaseEvent, unused.token]), false);
  await db.exec('reset role');
  assert.equal(await scalar('select count(*)::integer from appt_private.referral_links where id=$1', [unused.id]), 0);
  assert.equal(await scalar('select active from appt_private.referral_links where id=$1', [referral.id]), false);
  assert.equal(await scalar('select count(*)::integer from appt_private.bookings where id=$1', [firstReceipt.id]), 1);
  check('deletion removes unwanted links, rejects public access, preserves booking history, and recreates names with fresh tokens');

  await role('anon');
  await assert.rejects(query('select public.appt_admin_delete_booking($1)', [firstReceipt.id]), /permission denied/);
  await role('authenticated', ordinary);
  await assert.rejects(query('select public.appt_admin_delete_booking($1)', [firstReceipt.id]), /authorized admin/);
  await db.exec('reset role');
  await query("update appt_private.jobs set state='processing',available_at=now()+interval '10 minutes',lease_token=$2 where booking_id=$1 and kind='calendar'", [firstReceipt.id, randomUUID()]);
  const oldLease = await scalar("select lease_token from appt_private.jobs where booking_id=$1 and kind='calendar'", [firstReceipt.id]);
  const activeBefore = await scalar('select count(*)::integer from appt_private.bookings where deleted_at is null');
  await role('authenticated', admin);
  await query('select public.appt_admin_set_release($1,3)', [releaseEvent]);
  await query('select public.appt_admin_delete_booking($1)', [firstReceipt.id]);
  await query('select public.appt_admin_delete_booking($1)', [firstReceipt.id]);
  const deletedView = await scalar('select public.appt_admin_dashboard()');
  assert.equal(deletedView.booking_count, activeBefore - 1);
  assert(!deletedView.bookings.some(booking => booking.id === firstReceipt.id));
  assert.equal(deletedView.slots.find(slot => slot.id === released[0].id).reserved, 1);
  const reopened = await scalar('select public.appt_public_slots($1)', [releaseEvent]);
  assert.equal(reopened[0].is_open, true);
  assert.equal(reopened[3].is_open, false);
  await role('anon');
  await assert.rejects(query('select public.appt_book_tracked($1,$2,$3,$4,$5,$6,$7)',
    [released[0].id, firstRequest, 'Sales lead', '', '555-0100', '', referral.token]), /booking was deleted/);
  const replacement = await scalar('select public.appt_book_tracked($1,$2,$3,$4,$5,$6,$7)',
    [released[0].id, randomUUID(), 'New lead', '', '555-0100', '', recreated.token]);
  assert(replacement.id !== firstReceipt.id);
  await db.exec('reset role');
  const tombstone = (await query('select * from appt_private.bookings where id=$1', [firstReceipt.id]))[0];
  assert(tombstone.deleted_at);
  assert.equal(tombstone.deleted_by, admin);
  assert.equal(tombstone.source_label, 'Jeff');
  assert.equal(await scalar("select count(*)::integer from appt_private.jobs where booking_id=$1 and kind='calendar_delete'", [firstReceipt.id]), 1);
  assert.equal(await scalar("select available_at > now()+interval '10 minutes' from appt_private.jobs where booking_id=$1 and kind='calendar_delete'", [firstReceipt.id]), true);
  await role('service_role');
  await db.exec('reset role');
  const oldJob = (await query("select id,state from appt_private.jobs where booking_id=$1 and kind='calendar'", [firstReceipt.id]))[0];
  await role('service_role');
  await query('select public.appt_finish_job($1,$2,null)', [oldJob.id, oldLease]);
  await db.exec('reset role');
  assert.equal(await scalar('select state from appt_private.jobs where id=$1', [oldJob.id]), 'failed');
  await role('authenticated', admin);
  assert.equal((await scalar('select public.appt_admin_dashboard()')).referral_links.find(link => link.id === recreated.id).booking_count, 1);
  await query('select public.appt_admin_delete_booking($1)', [replacement.id]);
  assert.equal((await scalar('select public.appt_admin_dashboard()')).referral_links.find(link => link.id === recreated.id).booking_count, 0);
  await role('service_role');
  const readyCleanup = await scalar("select public.appt_claim_jobs(array['calendar_delete'],20)");
  assert.equal(readyCleanup.length, 1);
  assert.equal(readyCleanup[0].booking.id, replacement.id);
  assert.equal(readyCleanup[0].kind, 'calendar_delete');
  check('booking deletion is admin-only and idempotent, releases one place, hides active rows, retains audit data, and queues safe calendar cleanup');
  await db.exec('reset role');
  const randomMigration = fs.readFileSync('supabase/migrations/006_random_release.sql', 'utf8');
  await db.exec(randomMigration);
  await role('authenticated', admin);
  const randomEvent = await scalar("select public.appt_admin_create_event('Random release','','',2,false)");
  await scalar("select public.appt_admin_generate_slots($1,'2099-04-15','2099-04-16','09:00','13:30',30,2,false,false)", [randomEvent]);
  await query('select public.appt_admin_set_release($1,3)', [randomEvent]);
  await db.exec('reset role');
  const prioritiesBefore = await query('select id,release_priority from appt_private.slots where event_id=$1 order by id', [randomEvent]);
  assert.equal(new Set(prioritiesBefore.map(slot => slot.release_priority)).size, 20);
  await db.exec(randomMigration);
  assert.deepEqual(await query('select id,release_priority from appt_private.slots where event_id=$1 order by id', [randomEvent]), prioritiesBefore);
  let randomSlots = await scalar('select public.appt_public_slots($1)', [randomEvent]);
  const ranks = [8,1,7,6,2,9,5,4,3,10];
  for (let index=0; index<randomSlots.length; index++) {
    await query('update appt_private.slots set release_priority=$2 where id=$1',
      [randomSlots[index].id, `${String(ranks[index % 10]).padStart(8,'0')}-0000-4000-8000-000000000000`]);
  }
  await role('anon');
  randomSlots = await scalar('select public.appt_public_slots($1)', [randomEvent]);
  const selectedIds = randomSlots.filter(slot => slot.is_open).map(slot => slot.id);
  assert.deepEqual(selectedIds, [1,4,8,11,14,18].map(index => randomSlots[index].id));
  assert(randomSlots.every(slot => !('release_priority' in slot)));
  assert.deepEqual((await scalar('select public.appt_public_slots($1)', [randomEvent])).filter(slot => slot.is_open).map(slot => slot.id), selectedIds);
  await assert.rejects(query('select public.appt_book($1,$2,$3,$4,$5,$6)',
    [randomSlots[0].id, randomUUID(), 'Closed time', '', '555-0100', '']), /not available/);
  const randomBooking = await scalar('select public.appt_book($1,$2,$3,$4,$5,$6)',
    [randomSlots[1].id, randomUUID(), 'First place', '', '555-0101', '']);
  assert.deepEqual((await scalar('select public.appt_public_slots($1)', [randomEvent])).filter(slot => slot.is_open).map(slot => slot.id), selectedIds);
  await scalar('select public.appt_book($1,$2,$3,$4,$5,$6)',
    [randomSlots[1].id, randomUUID(), 'Second place', '', '555-0102', '']);
  assert.deepEqual((await scalar('select public.appt_public_slots($1)', [randomEvent])).filter(slot => slot.is_open).map(slot => slot.id),
    [4,7,8,11,14,18].map(index => randomSlots[index].id));
  await role('authenticated', admin);
  await query('select public.appt_admin_delete_booking($1)', [randomBooking.id]);
  assert.deepEqual((await scalar('select public.appt_public_slots($1)', [randomEvent])).filter(slot => slot.is_open).map(slot => slot.id), selectedIds);
  check('random priorities persist across refresh/migration, spread choices through the day, gate booking, and replace only filled times');
  await db.close();
  console.log(`${checks} SQL checks passed. PGlite serializes sessions; multi-connection load testing remains a live-project check.`);
})().catch(error => { console.error(error.message, error.detail || '', error.where || ''); process.exit(1); });
