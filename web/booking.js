import {settings, rpc, el, notify, eastern, localTimestamp, option} from './api.js';

let cfg, events = [], slots = [], selectedEvent, selectedDate, selectedSlot, requestId;
let months = [], monthIndex = 0, loadSequence = 0, saving = false, previewData;
const form = el('booking-form');
const steps = [...document.querySelectorAll('[data-step]')];
const viewTimes = document.createElement('button');
viewTimes.id = 'view-selected-times';
viewTimes.type = 'button';
viewTimes.className = 'mobile-date-action';
viewTimes.hidden = true;
document.querySelector('.calendar-panel').append(viewTimes);
function showTimes() {
  if (saving || !selectedDate) return;
  stage('time');
  if (matchMedia('(max-width: 720px)').matches)
    document.querySelector('.slot-panel').scrollIntoView({block: 'nearest', behavior: 'instant'});
  el('day-times').querySelector('button:not(:disabled)')?.focus({preventScroll: true});
}
viewTimes.addEventListener('click', showTimes);
el('change-date').addEventListener('click', () => {
  if (saving) return;
  stage('date');
  document.querySelector('.calendar-day.selected')?.focus({preventScroll: true});
});
// Accept a second '?' before the flag, a common mistake when extending an event URL.
const normalizedSearch = location.search.slice(1).replace(/\?(?=showEvents=)/g, '&');
const eventParameters = new URLSearchParams(normalizedSearch);
if (normalizedSearch !== location.search.slice(1)) {
  const corrected = new URL(location.href); corrected.search = eventParameters.toString();
  history.replaceState(null, '', corrected);
}
const hasLinkedEvent = eventParameters.has('event');
const showEvents = eventParameters.get('showEvents') === 'true';
const eventLocked = hasLinkedEvent && !showEvents;
const linkedEventId = eventParameters.get('event');
const referralToken = eventParameters.get('ref') || null;
const activeReferral = eventId => referralToken && String(eventId) === linkedEventId ? referralToken : null;
const canBook = slot => slot.remaining > 0 && slot.is_open !== false;
const normalizeSlots = loaded => loaded.map(slot => ({...slot,
  local_start: slot.local_start || localTimestamp(slot.starts_at), local_end: slot.local_end || localTimestamp(slot.ends_at)}))
  .filter(slot => slot.local_start > localTimestamp(new Date().toISOString()))
  .sort((left, right) => left.local_start.localeCompare(right.local_start));
function updateBookingLinks(eventId = linkedEventId) {
  const parameters = new URLSearchParams();
  if (eventId !== null) parameters.set('event', eventId);
  if (showEvents) parameters.set('showEvents', 'true');
  if (activeReferral(eventId)) parameters.set('ref', referralToken);
  const target = parameters.size ? `/?${parameters}` : '/';
  document.querySelectorAll('[data-booking-home]').forEach(link => { link.href = target; });
}
if (hasLinkedEvent || showEvents) updateBookingLinks();
const timeLabel = slot => slot.local_start.slice(11, 16).replace(/^(\d\d):(\d\d)$/, (_, h, m) => `${+h % 12 || 12}:${m} ${+h >= 12 ? 'PM' : 'AM'}`);
const dayLabel = (day, options = {weekday: 'long', month: 'long', day: 'numeric'}) =>
  new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', ...options}).format(new Date(`${day}T12:00:00Z`));

function stage(value) {
  el('booking-workspace').dataset.stage = value;
  steps.forEach(button => {
    button.classList.toggle('active', button.dataset.step === value);
    if (button.dataset.step === value) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
}
function clearSelection() {
  selectedDate = selectedSlot = requestId = null;
  viewTimes.hidden = true;
  form.hidden = true;
  el('book-button').disabled = true;
  el('details-placeholder').hidden = false;
  el('time-placeholder').hidden = false;
  el('day-times').hidden = true;
  el('chosen-date').textContent = 'Select a highlighted date to see times.';
  el('selection').textContent = 'Choose a time to continue.';
  steps.filter(button => button.dataset.step !== 'date').forEach(button => { button.disabled = true; });
  stage('date');
}
function renderCalendar() {
  const month = months[monthIndex];
  el('month-label').textContent = dayLabel(`${month}-01`, {month: 'long', year: 'numeric'});
  el('previous-month').disabled = monthIndex === 0;
  el('next-month').disabled = monthIndex === months.length - 1;
  const [year, number] = month.split('-').map(Number);
  const leading = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const available = new Set(slots.filter(canBook).map(slot => slot.local_start.slice(0, 10)));
  el('calendar').replaceChildren();
  for (let cell = 0; cell < Math.ceil((leading + days) / 7) * 7; cell++) {
    const number = cell - leading + 1;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calendar-day';
    if (number < 1 || number > days) {
      button.disabled = true;
      button.setAttribute('aria-hidden', 'true');
    } else {
      const day = `${month}-${String(number).padStart(2, '0')}`;
      button.textContent = number;
      button.dataset.date = day;
      button.disabled = !available.has(day);
      button.classList.toggle('has-availability', !button.disabled);
      button.classList.toggle('selected', day === selectedDate);
      button.setAttribute('aria-pressed', String(day === selectedDate));
      button.setAttribute('aria-label', `${dayLabel(day)}, ${button.disabled ? 'unavailable' : 'available'}`);
      button.addEventListener('click', () => chooseDate(day));
    }
    el('calendar').append(button);
  }
}
function chooseDate(day, {focus = true, automatic = false} = {}) {
  if (saving && !automatic) return;
  clearSelection();
  selectedDate = day;
  viewTimes.textContent = `View times for ${dayLabel(day, {month: 'short', day: 'numeric'})} →`;
  viewTimes.hidden = false;
  renderCalendar();
  el('chosen-date').textContent = dayLabel(day);
  el('time-placeholder').hidden = true;
  const times = el('day-times');
  times.hidden = false;
  times.replaceChildren();
  for (const slot of slots.filter(slot => slot.local_start.startsWith(day))) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'time'; button.dataset.timeId = slot.id;
    button.disabled = !canBook(slot);
    if (!button.disabled) button.dataset.slot = slot.id;
    button.textContent = timeLabel(slot);
    button.setAttribute('aria-pressed', 'false');
    const remaining = document.createElement('small');
    remaining.textContent = button.disabled ? (slot.remaining > 0 ? 'Not available' : 'Fully booked') :
      `${slot.remaining} ${slot.remaining === 1 ? 'place' : 'places'} left`;
    button.append(remaining);
    if (!button.disabled) button.addEventListener('click', () => chooseTime(slot, button));
    times.append(button);
  }
  steps.find(button => button.dataset.step === 'time').disabled = false;
  stage(automatic ? 'date' : 'time');
  if (!automatic && focus) showTimes();
}
function chooseTime(slot, button) {
  if (saving) return;
  selectedSlot = slot;
  requestId = crypto.randomUUID();
  el('day-times').querySelectorAll('button').forEach(other => {
    other.classList.toggle('selected', other === button);
    other.setAttribute('aria-pressed', String(other === button));
  });
  el('selection').textContent = `${dayLabel(selectedDate, {weekday: 'short', month: 'short', day: 'numeric'})} · ${timeLabel(slot)} Eastern`;
  form.hidden = false;
  el('details-placeholder').hidden = true;
  el('book-button').disabled = cfg.preview;
  el('book-button').textContent = cfg.preview ? 'Preview — booking disabled' : 'Confirm appointment';
  steps.find(button => button.dataset.step === 'details').disabled = false;
  stage('details');
}
async function loadSlots(eventId) {
  if (eventLocked && String(eventId) !== linkedEventId) return;
  const sequence = ++loadSequence;
  clearSelection();
  el('booking-workspace').setAttribute('aria-busy', 'true');
  el('calendar').replaceChildren();
  el('availability-status').textContent = 'Checking availability…';
  selectedEvent = events.find(event => String(event.id) === String(eventId));
  if (showEvents) updateBookingLinks(String(selectedEvent.id));
  el('event-name').textContent = selectedEvent.name;
  el('event-location').textContent = selectedEvent.location || '';
  el('event-bar').hidden = !selectedEvent.location && el('event-picker').hidden;
  el('event-description').textContent = selectedEvent.description || '';
  const today = localTimestamp(new Date().toISOString());
  try {
    const loaded = cfg.preview ? previewData.slots.filter(slot => String(slot.event_id) === String(eventId)) :
      await rpc('appt_public_slots', {p_event_id: eventId});
    if (sequence !== loadSequence) return;
    slots = normalizeSlots(loaded);
    months = [...new Set(slots.map(slot => slot.local_start.slice(0, 7)))].sort();
    if (!months.length) months = [today.slice(0, 7)];
    const firstAvailable = slots.find(canBook);
    monthIndex = firstAvailable ? months.indexOf(firstAvailable.local_start.slice(0, 7)) : 0;
    renderCalendar();
    if (firstAvailable) chooseDate(firstAvailable.local_start.slice(0, 10), {focus: false, automatic: true});
    el('availability-status').textContent = slots.some(canBook) ? '' : 'No upcoming times are available. Please check back soon.';
    el('release-hint').hidden = !selectedEvent.open_times_per_day;
  } catch (error) {
    if (sequence !== loadSequence) return;
    slots = [];
    el('availability-status').textContent = 'Availability could not be loaded.';
    notify(error.message, true);
  } finally {
    if (sequence === loadSequence) el('booking-workspace').setAttribute('aria-busy', 'false');
  }
}
steps.forEach(button => button.addEventListener('click', () => { if (!saving) stage(button.dataset.step); }));
el('previous-month').addEventListener('click', () => { if (!saving && monthIndex > 0) { monthIndex--; renderCalendar(); } });
el('next-month').addEventListener('click', () => { if (!saving && monthIndex < months.length - 1) { monthIndex++; renderCalendar(); } });
el('event-choice').addEventListener('change', async event => {
  if (eventLocked) { event.target.value = linkedEventId; return; }
  const url = new URL(location.href); url.searchParams.set('event', event.target.value);
  if (activeReferral(event.target.value)) url.searchParams.set('ref', referralToken);
  else url.searchParams.delete('ref');
  history.replaceState(null, '', url);
  await loadSlots(event.target.value);
});
['email', 'phone'].forEach(name => form.elements[name].addEventListener('input', () => form.elements.email.setCustomValidity('')));
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (saving || !selectedSlot || cfg.preview) return;
  const values = Object.fromEntries(new FormData(form));
  if (!values.email.trim() && !values.phone.trim()) {
    form.elements.email.setCustomValidity('Enter an email address or phone number.');
    form.elements.email.reportValidity(); return;
  }
  saving = true;
  el('book-button').disabled = true;
  el('event-choice').disabled = true;
  el('book-button').textContent = 'Saving your appointment…';
  notify('');
  try {
    const parameters = {p_slot_id: selectedSlot.id, p_request_id: requestId,
      p_name: values.name.trim(), p_email: values.email.trim(), p_phone: values.phone.trim(), p_notes: values.notes.trim(),
      p_ref: activeReferral(selectedEvent.id)};
    let receipt;
    try { receipt = values.company.trim() ?
      await rpc('appt_book_company', {...parameters, p_company: values.company.trim()}) :
      await rpc('appt_book_tracked', parameters); }
    catch (error) {
      // Keep ordinary bookings working while update 003 is being applied.
      // A tracked link must never silently lose its attribution.
      if (error.code !== 'PGRST202' || parameters.p_ref || values.company.trim()) throw error;
      const {p_ref, ...legacy} = parameters;
      receipt = await rpc('appt_book', legacy);
    }
    el('confirmation-name').textContent = `See you then, ${receipt.name}.`;
    el('confirmation-event').textContent = receipt.event_name;
    el('confirmation-time').textContent = `${eastern(receipt.starts_at, {dateStyle: 'full', timeStyle: 'short'})} Eastern`;
    el('confirmation-location').textContent = receipt.location || 'Location to be arranged';
    el('confirmation-email').textContent = values.email.trim() ? 'Your appointment is saved. Email confirmation is pending; save these details for your records.' :
      'Your appointment is saved. Save these details for your records.';
    el('confirmation-reference').textContent = `Booking reference: ${receipt.id}`;
    el('booking-workspace').hidden = true;
    el('confirmation').hidden = false;
    form.reset();
    el('confirmation').scrollIntoView({block: 'start', behavior: 'smooth'});
  } catch (error) {
    if (error.message.includes('no longer available') || error.message.includes('not yet open') || error.message.includes('time is not available')) {
      await loadSlots(selectedEvent.id);
      notify('That time is no longer available. Please choose another available time.', true);
    } else if (error.code === 'PGRST202') notify('Booking setup is being updated. Please contact the organizer or try again shortly.', true);
    else notify(`${error.message} If the connection was interrupted, retrying the same booking will not reserve another place.`, true);
  } finally {
    saving = false;
    el('book-button').disabled = false;
    el('book-button').textContent = 'Confirm appointment';
    el('event-choice').disabled = eventLocked;
  }
});
el('another-booking').addEventListener('click', async () => {
  el('confirmation').hidden = true;
  el('booking-workspace').hidden = false;
  await loadSlots(selectedEvent.id);
});
async function init() {
  try {
    cfg = await settings();
    if (cfg.preview) {
      const response = await fetch('/preview-data.json');
      if (!response.ok) throw new Error('Local preview availability is missing. Rebuild with --preview.');
      previewData = await response.json();
      events = previewData.events;
      el('preview-label').hidden = false;
    } else events = await rpc('appt_public_events');
    const linkedEvent = events.find(event => String(event.id) === linkedEventId);
    if (hasLinkedEvent && !linkedEvent) {
      el('availability-status').textContent = 'This event link is unavailable. Please ask the organizer for a current link.';
      return;
    }
    if (!events.length) { el('availability-status').textContent = 'New appointments are on the way. Please check back soon.'; return; }
    el('event-bar').hidden = false;
    if (eventLocked) events = [linkedEvent];
    el('event-picker').hidden = eventLocked || (!showEvents && events.length < 2);
    el('event-choice').disabled = eventLocked;
    el('event-choice').replaceChildren(...events.map(event => option(event.id, event.name)));
    const selected = linkedEvent || events[0];
    if (referralToken && (!hasLinkedEvent || (!cfg.preview && !await rpc('appt_ref_valid', {p_event_id: selected.id, p_token: referralToken})))) {
      el('availability-status').textContent = 'This booking link is no longer active. Please contact the organizer.';
      return;
    }
    if (eventLocked) document.title = `${selected.name} · JR & Co.`;
    el('event-choice').value = selected.id;
    await loadSlots(selected.id);
  } catch (error) { notify(error.message, true); el('availability-status').textContent = 'Booking is not available yet.'; }
  finally { el('booking-workspace').setAttribute('aria-busy', 'false'); }
}
init();

async function refreshReleasedTimes() {
  if (!selectedEvent || cfg?.preview || saving || !form.hidden || document.hidden) return;
  const sequence = loadSequence, eventId = selectedEvent.id;
  try {
    const updated = normalizeSlots(await rpc('appt_public_slots', {p_event_id: eventId}));
    if (sequence !== loadSequence || eventId !== selectedEvent.id || saving || !form.hidden) return;
    if (JSON.stringify(updated) === JSON.stringify(slots)) return;
    const previousDate = selectedDate, previousStage = el('booking-workspace').dataset.stage, previousMonth = months[monthIndex];
    slots = updated;
    months = [...new Set(slots.map(slot => slot.local_start.slice(0, 7)))].sort();
    if (!months.length) months = [localTimestamp(new Date().toISOString()).slice(0, 7)];
    const first = slots.find(slot => canBook(slot) && slot.local_start.startsWith(previousDate || '!')) || slots.find(canBook);
    monthIndex = first ? months.indexOf(first.local_start.slice(0, 7)) : 0;
    if (previousStage === 'date' && months.includes(previousMonth)) monthIndex = months.indexOf(previousMonth);
    if (first) { chooseDate(first.local_start.slice(0, 10), {focus: false, automatic: true}); stage(previousStage); }
    else { clearSelection(); renderCalendar(); }
    el('availability-status').textContent = first ? '' : 'No upcoming times are available. Please check back soon.';
  } catch { /* Submission always rechecks availability if a background refresh fails. */ }
}
setInterval(refreshReleasedTimes, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshReleasedTimes(); });
