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
      line.textContent = `${dateFormat(slot.starts_at)} – ${eastern(slot.ends_at, {timeStyle: 'short'})} — ${slot.reserved} / ${slot.capacity} booked`;
      details.append(line);
    }
    availability.append(details);
  }
  if (!events.length) availability.textContent = 'Create your first person or event above.';
  renderReferralLinks(data.referral_links || []);
  updateReleaseField();
  el('bookings-heading').textContent = `Bookings (${data.booking_count})`;
  el('booking-count').textContent = data.booking_count > data.bookings.length ?
    `Showing the latest ${data.bookings.length}. CSV export includes all bookings.` : '';
  el('bookings-table').replaceChildren();
  for (const booking of data.bookings) {
    const row = document.createElement('tr');
    row.append(cell(booking.name), cell(booking.company), cell([booking.email, booking.phone].filter(Boolean).join('\n')),
      cell(`${booking.event_name}\n${dateFormat(booking.starts_at)}`), cell(booking.notes),
      cell(booking.source_label ? `${booking.source_label}\n${booking.source_kind || ''}` : 'Direct / untracked'),
      cell(`Email: ${stateLabel(booking.email_status)}\nCalendar: ${stateLabel(booking.calendar_status)}`));
    const actions = document.createElement('td');
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary';
    remove.textContent = 'Delete booking';
    remove.setAttribute('aria-label', `Delete booking for ${booking.name}`);
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete ${booking.name}’s booking for ${booking.event_name} on ${dateFormat(booking.starts_at)}? This frees one place and removes the booking from the active list. No cancellation email is sent.`)) return;
      remove.disabled = true;
      try {
        await rpc('appt_admin_delete_booking', {p_id: booking.id}, true);
        await dashboard();
        notify('Booking deleted and its place released. Calendar removal is queued if Google sync is configured.');
      } catch (error) {
        notify(error.code === 'PGRST202' ? 'Run database update 005_delete_bookings.sql in Supabase SQL Editor to enable booking deletion.' : error.message, true);
        remove.disabled = false;
      }
    });
    actions.append(remove); row.append(actions);
    el('bookings-table').append(row);
  }
  await renderCalendarAudit();
  if (!data.bookings.length) { const row = document.createElement('tr'); const empty = cell('No bookings yet.'); empty.colSpan = 8; row.append(empty); el('bookings-table').append(row); }
}
async function renderCalendarAudit() {
  const status = el('calendar-audit-status'), list = el('calendar-audit-issues');
  list.replaceChildren();
  try {
    const data = await rpc('appt_admin_calendar_audit', {}, true);
    const last = data.last_checked ? dateFormat(data.last_checked) : 'Not checked yet';
    const stale = data.last_checked && Date.now() - new Date(data.last_checked).getTime() > 30 * 60 * 1000;
    const sync = data.cancellation_sync;
    const cancellationStatus = sync?.last_polled ? `Last cancellation check: ${dateFormat(sync.last_polled)}.` : 'Cancellation check: waiting for first completed poll.';
    const cancellationDelayed = sync?.last_polled && Date.now() - new Date(sync.last_polled).getTime() > 5 * 60 * 1000;
    status.textContent = `${cancellationStatus} ${sync?.last_error || (cancellationDelayed ? 'Cancellation checks appear delayed.' : '')} Last detail audit: ${last}. ${data.pending} awaiting first audit.` +
      (stale ? ' Checks appear delayed; check the sync function logs.' : ' Use Refresh to load the latest results.');
    if (!data.issues.length) {
      const note = document.createElement('p');
      note.textContent = data.last_checked ? 'No differences reported in the checks completed so far.' : 'Waiting for the first scheduled audit.';
      list.append(note);
    }
    for (const issue of data.issues) {
      const item = document.createElement('div'); item.className = 'notice';
      const title = document.createElement('strong');
      const label = {cancelled: 'Cancelled in Google - place released', changed: 'Needs review', missing: 'Entry missing - booking retained', error: 'Could not verify'}[issue.outcome];
      title.textContent = `${issue.event_name} / ${issue.name}: ${label}`;
      const detail = document.createElement('p');
      detail.textContent = `App appointment: ${dateFormat(issue.starts_at)}. Checked: ${dateFormat(issue.checked_at)}.`;
      const differences = document.createElement('p'); differences.textContent = issue.differences.join(' ');
      item.append(title, detail, differences); list.append(item);
    }
  } catch {
    status.textContent = 'Calendar audit is not available yet. Apply database updates 008 and 009 and deploy the updated sync function.';
  }
}
function updateReleaseField() {
  const event = events.find(event => event.id === el('release-event').value);
  el('release-form').elements.limit.value = event?.open_times_per_day ?? '';
}
el('release-event').addEventListener('change', updateReleaseField);
function renderReferralLinks(links) {
  const container = el('referral-links');
  container.replaceChildren();
  if (!links.length) { container.textContent = 'No tracking links yet. Create a salesperson or channel link above.'; return; }
  for (const source of links) {
    const row = document.createElement('div'); row.className = 'referral-link';
    const title = document.createElement('strong');
    const event = events.find(event => event.id === source.event_id);
    title.textContent = `${source.label} (${source.kind}) — ${event?.name || 'Event'} — ${source.booking_count} bookings${source.active ? '' : ' — disabled'}`;
    const url = new URL('/', location.origin);
    url.searchParams.set('event', source.event_id); url.searchParams.set('ref', source.token);
    const input = document.createElement('input'); input.readOnly = true; input.value = url.href;
    input.setAttribute('aria-label', `Booking link for ${source.label}`);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary'; copy.textContent = 'Copy link';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url.href); notify(`Link copied for ${source.label}.`); }
      catch { input.focus(); input.select(); notify('Copy the selected link with Ctrl+C or your device’s Copy command.'); }
    });
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'secondary';
    toggle.textContent = source.active ? 'Disable link' : 'Enable link';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        await rpc('appt_admin_set_referral', {p_id: source.id, p_active: !source.active}, true);
        await dashboard(); notify('Tracking link updated. Existing booking attribution was preserved.');
      } catch (error) { notify(error.message, true); toggle.disabled = false; }
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary delete-link';
    remove.textContent = 'Delete link';
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete the link for ${source.label}? It will disappear and stop accepting bookings. Existing bookings and their recorded source will be kept.`)) return;
      remove.disabled = true;
      try {
        await rpc('appt_admin_delete_referral', {p_id: source.id}, true);
        await dashboard(); notify('Tracking link deleted. Existing bookings and attribution were kept.');
      } catch (error) {
        notify(error.code === 'PGRST202' ? 'Run database update 004_delete_tracking_links.sql in Supabase SQL Editor to enable link deletion.' : error.message, true);
        remove.disabled = false;
      }
    });
    const actions = document.createElement('div'); actions.className = 'referral-actions'; actions.append(copy, toggle, remove);
    row.append(title, input, actions); container.append(row);
  }
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
    } catch (error) {
      notify(error.code === 'PGRST202' ? 'Run database update 003_release_and_tracking.sql in Supabase SQL Editor to enable release settings and tracking links.' : error.message, true);
    }
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
mutation('release-form', async values => {
  await rpc('appt_admin_set_release', {p_event_id: values.event_id, p_limit: values.limit ? Number(values.limit) : null}, true);
  return values.limit ? `This event now offers up to ${values.limit} open time choices per day.` : 'All available time choices are now open for this event.';
});
mutation('referral-form', async values => {
  await rpc('appt_admin_create_referral', {p_event_id: values.event_id, p_label: values.label.trim(), p_kind: values.kind}, true);
  el('referral-form').elements.label.value = '';
  return 'Tracking link created. Use Copy link under Tracked event links below to share it.';
});
mutation('slot-form', async values => {
  await rpc('appt_admin_add_slot', {p_event_id: values.event_id, p_start: `${values.date}T${values.start}:00`,
    p_end: `${values.date}T${values.end}:00`, p_capacity: values.capacity ? Number(values.capacity) : null}, true);
  return 'Time slot added.';
});
mutation('range-form', async values => {
  let result;
  try {
    result = await rpc('appt_admin_generate_slots', {p_event_id: values.event_id,
      p_first: values.first_date, p_last: values.last_date, p_first_start: values.first_start,
      p_last_start: values.last_start, p_minutes: Number(values.minutes),
      p_capacity: values.capacity ? Number(values.capacity) : null,
      p_weekdays: Boolean(values.weekdays), p_replace: Boolean(values.replace)}, true);
  } catch (error) {
    if (error.code === 'PGRST202') throw new Error('Run database update 002_custom_availability.sql in Supabase SQL Editor to enable custom time slots.');
    throw error;
  }
  el('range-form').elements.replace.checked = false;
  return `Created ${result.added} meeting slots. Replaced ${result.removed} unbooked slots. ` +
    `${result.preserved} slots with bookings preserved. ${result.conflicts} overlapping times skipped.`;
});
function rangeSummary() {
  const form = el('range-form');
  const asMinutes = value => { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; };
  const first = asMinutes(form.elements.first_start.value), last = asMinutes(form.elements.last_start.value);
  const length = Number(form.elements.minutes.value);
  if (!Number.isFinite(first + last) || !Number.isInteger(length) || length < 5 || last < first || (last - first) % length || last + length >= 1440) {
    el('range-summary').textContent = 'Choose aligned first and last start times and a meeting length that ends before midnight.';
    return;
  }
  const finish = last + length;
  const hour = Math.floor(finish / 60);
  const endLabel = `${hour % 12 || 12}:${String(finish % 60).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
  el('range-summary').textContent = `${(last - first) / length + 1} meetings per selected day. The last meeting ends at ${endLabel} Eastern.`;
}
el('range-form').addEventListener('input', rangeSummary);
rangeSummary();
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
    const rows = [['Name', 'Company / Golf Course', 'Email', 'Phone', 'Event', 'Start (Eastern)', 'Notes', 'Source', 'Source type', 'Email status', 'Calendar status'],
      ...records.map(record => [record.name, record.company || '', record.email, record.phone, record.event_name,
        dateFormat(record.starts_at), record.notes, record.source_label || 'Direct / untracked', record.source_kind || '',
        record.email_status, record.calendar_status])];
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
