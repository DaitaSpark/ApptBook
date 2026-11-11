import {settings, rpc, el, notify, currentSession, signIn, signOut, localTimestamp, eastern, option} from './api.js';
let events = [];
const dateFormat = value => eastern(value, {dateStyle: 'medium', timeStyle: 'short'});
const stateLabel = value => ({queued: 'pending', processing: 'sending', sent: 'sent', failed: 'needs attention',
  not_requested: 'not requested'})[value] || 'pending';
const cell = text => { const node = document.createElement('td'); node.textContent = text || ''; return node; };

async function dashboard() {
  const data = await rpc('appt_admin_dashboard', {}, true);
  events = data.events;
  el('login-panel').hidden = true;
  el('admin-workspace').hidden = false;
  document.querySelectorAll('.event-select').forEach(select => {
    const selected = select.value;
    select.replaceChildren(option('', 'Select a person or event'), ...events.map(event =>
      option(event.id, `${event.name} (default: ${event.default_capacity})`)));
    select.value = events.some(event => event.id === selected) ? selected : '';
  });
  const availability = el('admin-availability');
  availability.replaceChildren();
  for (const event of events) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const eventSlots = data.slots.filter(slot => slot.event_id === event.id);
    summary.textContent = `${event.name} — ${eventSlots.length} upcoming slots`;
    details.append(summary);
    const link = document.createElement('a'); link.href = `/?event=${encodeURIComponent(event.id)}`; link.textContent = 'Open booking page ↗';
    details.append(link);
    for (const slot of eventSlots) {
      const line = document.createElement('p');
      line.textContent = `${dateFormat(slot.starts_at)} — ${slot.reserved} / ${slot.capacity} booked`;
      details.append(line);
    }
    availability.append(details);
  }
  if (!events.length) availability.textContent = 'Create your first person or event above.';
  el('bookings-heading').textContent = `Bookings (${data.booking_count})`;
  el('booking-count').textContent = data.booking_count > data.bookings.length ?
    `Showing the latest ${data.bookings.length}. CSV export includes all bookings.` : '';
  el('bookings-table').replaceChildren();
  for (const booking of data.bookings) {
    const row = document.createElement('tr');
    row.append(cell(booking.name), cell([booking.email, booking.phone].filter(Boolean).join('\n')),
      cell(`${booking.event_name}\n${dateFormat(booking.starts_at)}`), cell(booking.notes),
      cell(`Email: ${stateLabel(booking.email_status)}\nCalendar: ${stateLabel(booking.calendar_status)}`));
    el('bookings-table').append(row);
  }
  if (!data.bookings.length) { const row = document.createElement('tr'); const empty = cell('No bookings yet.'); empty.colSpan = 5; row.append(empty); el('bookings-table').append(row); }
}
function mutation(id, action) {
  el(id).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const message = await action(Object.fromEntries(new FormData(form)));
      await dashboard();
      notify(message);
    } catch (error) { notify(error.message, true); }
    finally { button.disabled = false; }
  });
}
mutation('login-form', async values => {
  await signIn(values.email.trim(), values.password);
  el('login-form').elements.password.value = '';
  try { await dashboard(); }
  catch (error) { await signOut(); throw error; }
  return 'Signed in.';
});
mutation('event-form', async values => {
  await rpc('appt_admin_create_event', {p_name: values.name.trim(), p_description: values.description.trim(),
    p_location: values.location.trim(), p_capacity: Number(values.capacity), p_workdays: Boolean(values.workdays)}, true);
  el('event-form').reset();
  return 'Person or event created.';
});
mutation('slot-form', async values => {
  await rpc('appt_admin_add_slot', {p_event_id: values.event_id, p_start: `${values.date}T${values.start}:00`,
    p_end: `${values.date}T${values.end}:00`, p_capacity: values.capacity ? Number(values.capacity) : null}, true);
  return 'Time slot added.';
});
mutation('workdays-form', async values => {
  const count = await rpc('appt_admin_add_workdays', {p_event_id: values.event_id,
    p_first: values.first_date, p_last: values.last_date}, true);
  return `Added ${count} weekday slots. Existing availability was preserved.`;
});
el('sign-out').addEventListener('click', async () => {
  await signOut(); location.reload();
});
el('refresh').addEventListener('click', () => dashboard().then(() => notify('Bookings refreshed.')).catch(error => notify(error.message, true)));
el('export').addEventListener('click', async event => {
  const button = event.target; button.disabled = true;
  try {
    const records = [];
    for (let offset = 0; ; offset += 500) {
      const page = await rpc('appt_admin_bookings', {p_offset: offset}, true);
      records.push(...page);
      if (page.length < 500) break;
    }
    const escape = value => {
      let text = String(value ?? '');
      if (/^[=+\-@\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    const rows = [['Name', 'Email', 'Phone', 'Event', 'Start (Eastern)', 'Notes', 'Email status', 'Calendar status'],
      ...records.map(record => [record.name, record.email, record.phone, record.event_name,
        dateFormat(record.starts_at), record.notes, record.email_status, record.calendar_status])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n')], {type: 'text/csv;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = 'jrco-bookings.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
});
async function init() {
  const today = localTimestamp(new Date().toISOString()).slice(0, 10);
  document.querySelectorAll('.today-date').forEach(input => { input.value = today; input.min = today; });
  const end = new Date(`${today}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 29);
  el('last-date').value = end.toISOString().slice(0, 10);
  try {
    if ((await settings()).preview) {
      el('sign-in').disabled = true;
      notify('Read-only local preview. Admin sign-in and changes become available after Supabase is connected.');
    } else if (currentSession()) await dashboard();
  } catch (error) { notify(error.message, true); }
}
init();
