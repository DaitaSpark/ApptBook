// Local preview only: builds files without contacting an email provider.
import fs from 'node:fs';
import {confirmationEmail} from '../supabase/functions/dispatch-bookings/confirmation.js';
import {deliverEmail} from '../supabase/functions/dispatch-bookings/delivery.js';

const booking = {id: 'preview-booking', name: 'Jeff Eckard', email: 'preview@example.com',
  event_name: 'PGA Show', location: '', starts_at: '2027-01-27T15:30:00Z'};
const email = confirmationEmail(booking);
fs.mkdirSync('instance/email-preview', {recursive: true});
fs.writeFileSync('instance/email-preview/confirmation.html',
  email.html.replace('cid:jrco-confirmation', `data:image/gif;base64,${email.attachment.content}`));
await deliverEmail(booking, {WORKSPACE_EMAIL: 'info@jrcogolf.com'}, 'preview-only', async (_url, init) => {
  fs.writeFileSync('instance/email-preview/confirmation.eml', Buffer.from(JSON.parse(init.body).raw, 'base64url'));
  return new Response('{}');
});
console.log('Preview: instance/email-preview/confirmation.html and confirmation.eml (no email sent)');
