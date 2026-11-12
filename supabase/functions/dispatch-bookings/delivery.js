const formatted = value => new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York',
  dateStyle: 'full', timeStyle: 'short'}).format(new Date(value));
const cleanHeader = value => String(value).replace(/[\r\n]/g, ' ');
const base64 = text => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const checked = async (response, provider) => {
  if (!response.ok) throw new Error(`${provider} request failed (HTTP ${response.status}).`);
  return response;
};

export async function googleAccessToken(secrets, request = fetch) {
  const response = await request('https://oauth2.googleapis.com/token', {method: 'POST',
    body: new URLSearchParams({grant_type: 'refresh_token', client_id: secrets.GOOGLE_CLIENT_ID,
      client_secret: secrets.GOOGLE_CLIENT_SECRET, refresh_token: secrets.GOOGLE_REFRESH_TOKEN})});
  await checked(response, 'Google authorization');
  const token = (await response.json()).access_token;
  if (!token) throw new Error('Google authorization returned no access token.');
  return token;
}

export async function deliverEmail(booking, secrets, token, request = fetch) {
  const mailbox = secrets.TEAM_EMAIL || secrets.WORKSPACE_EMAIL;
  const recipient = booking.email || mailbox;
  if (!recipient) throw new Error('No email recipient configured for phone-only booking notification.');
  const subject = `JR & Co. appointment: ${booking.event_name}`;
  // Private notes and phone numbers go only in the calendar, not in guest confirmation copies.
  const text = `Hello ${booking.name},\n\nYour appointment is confirmed.\n\n${booking.event_name}\n` +
    `${formatted(booking.starts_at)} Eastern Time\nLocation: ${booking.location || 'To be arranged'}\n` +
    `Booking reference: ${booking.id}\n\nThank you,\nJR & Co.`;
  if (token && secrets.WORKSPACE_EMAIL) {
    const message = [`From: ${cleanHeader(secrets.WORKSPACE_EMAIL)}`, `To: ${cleanHeader(recipient)}`,
      ...(booking.email && mailbox && mailbox !== booking.email ? [`Bcc: ${cleanHeader(mailbox)}`] : []),
      `Subject: =?UTF-8?B?${base64(cleanHeader(subject))}?=`,
      `Message-ID: <appt-${booking.id}@${cleanHeader(secrets.WORKSPACE_EMAIL.split('@')[1])}>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64', '', base64(text)].join('\r\n');
    await checked(await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({raw: base64(message).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')})}), 'Gmail');
  } else {
    await checked(await request('https://api.resend.com/emails', {method: 'POST', headers: {
      Authorization: `Bearer ${secrets.RESEND_API_KEY}`, 'Content-Type': 'application/json',
      'Idempotency-Key': `appointment-${booking.id}`}, body: JSON.stringify({
        from: secrets.MAIL_FROM, to: [recipient], subject, text,
        ...(booking.email && mailbox && mailbox !== booking.email ? {bcc: [mailbox]} : {})})}), 'Email');
  }
}

export const calendarPayload = booking => {
  const eventId = 'appt' + booking.id.replaceAll('-', '');
  return {id: eventId, summary: `${booking.event_name} — ${booking.name}`,
      location: booking.location, description: [booking.name, booking.email, booking.phone,
        booking.company ? `Company / Golf Course: ${booking.company}` : '',
        `Source: ${booking.source_label || 'Direct / untracked'}${booking.source_label && booking.source_kind ? ` (${booking.source_kind})` : ''}`,
        booking.notes,
        `Booking reference: ${booking.id}`].filter(Boolean).join('\n'),
      start: {dateTime: booking.starts_at, timeZone: 'America/New_York'},
      end: {dateTime: booking.ends_at, timeZone: 'America/New_York'},
      extendedProperties: {private: {appt_booking_id: booking.id}}};
};

export async function deliverCalendar(booking, secrets, token, request = fetch) {
  const eventId = 'appt' + booking.id.replaceAll('-', '');
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(secrets.GOOGLE_CALENDAR_ID)}/events`;
  const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
  const response = await request(`${url}?sendUpdates=none`, {method: 'POST', headers,
    body: JSON.stringify(calendarPayload(booking))});
  if (response.status === 409) {
    const existing = await checked(await request(`${url}/${eventId}`, {headers}), 'Calendar verification');
    if ((await existing.json()).extendedProperties?.private?.appt_booking_id !== booking.id)
      throw new Error('Calendar event ID conflict.');
  } else await checked(response, 'Calendar');
}

export async function removeCalendar(booking, secrets, token, request = fetch) {
  const eventId = 'appt' + booking.id.replaceAll('-', '');
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(secrets.GOOGLE_CALENDAR_ID)}/events/${eventId}`;
  const headers = {Authorization: `Bearer ${token}`};
  const existing = await request(url, {headers});
  if ([404, 410].includes(existing.status)) return;
  await checked(existing, 'Calendar verification');
  if ((await existing.json()).extendedProperties?.private?.appt_booking_id !== booking.id)
    throw new Error('Calendar event ID conflict.');
  const response = await request(`${url}?sendUpdates=none`, {method: 'DELETE', headers});
  if (![404, 410].includes(response.status)) await checked(response, 'Calendar removal');
}

// Only explicit Google cancellation of a verified app entry releases a place.
// Missing entries and permission failures are audit issues, never cancellations.
export async function inspectCalendar(booking, secrets, token, verified, request = fetch) {
  const expected = calendarPayload(booking);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(secrets.GOOGLE_CALENDAR_ID)}/events/${expected.id}`;
  const response = await request(url, {headers: {Authorization: `Bearer ${token}`}});
  const result = (outcome, differences = [], owned = false) => ({outcome, differences, verified: owned});
  if ([404,410].includes(response.status)) return result('missing', ['Calendar entry not found; review manually. No booking was cancelled.']);
  await checked(response, 'Calendar audit');
  const actual = await response.json();
  if (actual.id !== expected.id) return result('error', ['Calendar event ID does not match.']);
  const owner = actual.extendedProperties?.private?.appt_booking_id;
  if (owner && owner !== booking.id) return result('error', ['Calendar entry belongs to another booking.']);
  if (actual.status === 'cancelled') {
    return verified ? result('cancelled', ['Cancelled in Google Calendar.'], true) :
      result('missing', ['Google cancellation found before ownership could be verified; review manually.']);
  }
  if (owner !== booking.id) return result('error', ['Booking reference metadata is missing; review manually.']);
  const differences = [];
  for (const [field, label] of [['start','Start'],['end','End']]) {
    const value = actual[field]?.dateTime;
    if (!value || new Date(value).getTime() !== new Date(expected[field].dateTime).getTime())
      differences.push(`${label} differs: app ${expected[field].dateTime}; Google ${value || actual[field]?.date || 'not set'}.`);
  }
  for (const [field,label] of [['summary','Title'],['location','Location'],['description','Contact / company / source / notes']]) {
    const normalize = value => String(value || '').replaceAll('\r\n','\n').trim();
    if (normalize(actual[field]) !== normalize(expected[field])) differences.push(`${label} differs.`);
  }
  if (actual.recurrence?.length || actual.recurringEventId) differences.push('Google entry is recurring; app booking is a single meeting.');
  return result(differences.length ? 'changed' : 'ok', differences, true);
}

// Poll Google's incremental feed each minute; only cancellations affect bookings here.
// Other event changes are compared by the separate 15-minute detail audit.
export async function syncCancellations(secrets, token, rpc, request = fetch) {
  const calendar = secrets.GOOGLE_CALENDAR_ID;
  const cursor = await rpc('appt_claim_calendar_sync', {p_calendar_id: calendar});
  if (!cursor) return {cancelled: 0, busy: true};
  let pageToken = cursor.page_token, cancelled = 0;
  const release = (reset = false, error = false) => rpc('appt_release_calendar_sync', {
    p_calendar_id: calendar, p_lease_token: cursor.lease_token, p_reset: reset, p_error: error});
  try {
    for (let page = 0; page < 3; page++) {
      const params = new URLSearchParams({showDeleted: 'true', singleEvents: 'false', maxResults: '250',
        fields: 'items(id,status,extendedProperties),nextPageToken,nextSyncToken'});
      if (cursor.sync_token) params.set('syncToken', cursor.sync_token);
      if (pageToken) params.set('pageToken', pageToken);
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events?${params}`;
      const response = await request(url, {headers: {Authorization: `Bearer ${token}`}});
      if (response.status === 410) {
        await release(true);
        return {cancelled, rebuilding: true};
      }
      await checked(response, 'Calendar cancellations');
      const data = await response.json();
      if (!Array.isArray(data.items) || (!data.nextPageToken && !data.nextSyncToken))
        throw new Error('Calendar cancellation response is incomplete.');
      const items = data.items.map(item => ({id: item.id, status: item.status,
        booking_id: item.extendedProperties?.private?.appt_booking_id || null}));
      cancelled += await rpc('appt_apply_calendar_sync_page', {p_calendar_id: calendar, p_lease_token: cursor.lease_token,
        p_items: items, p_next_page: data.nextPageToken || null, p_next_sync: data.nextPageToken ? null : data.nextSyncToken});
      if (!data.nextPageToken) return {cancelled, polled: true};
      pageToken = data.nextPageToken;
    }
    // Continue large calendars on the next invocation using the last committed page.
    await release();
    return {cancelled, backlog: true};
  } catch (error) {
    await release(false, true);
    throw error;
  }
}
