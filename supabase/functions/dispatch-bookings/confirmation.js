import {confirmationGif} from './confirmation-image.js';

export const catalogueUrl = 'https://jrcogolf.com/pages/wholesale-catalog';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const formatted = value => new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York',
  dateStyle: 'full', timeStyle: 'short'}).format(new Date(value));

export function confirmationEmail(booking) {
  const firstName = booking.name.trim().split(/\s+/)[0] || 'there';
  const pga = /^PGA\b/i.test(booking.event_name.trim());
  const location = pga ? 'Booth #5596 (On the Right side of the Back Wall of the Convention Floor).'
    : booking.location || 'Location to be arranged';
  const welcome = pga ? "We can't wait to see you at the PGA Show." : "We can't wait to see you.";
  const meetingTime = `${formatted(booking.starts_at)} Eastern Time`;
  const text = `Hey ${firstName},\n\nYour meeting is confirmed. Thank you!\n${welcome}\n\n` +
    `${pga ? 'See you at ' : 'Location: '}${location}\n\n${booking.event_name}\n${meetingTime}\n` +
    `Booking reference: ${booking.id}\n\nUntil we see you, feel free to look through our latest catalogue:\n` +
    `${catalogueUrl}\n\nThank you,\nJR & Co.\nhttps://jrcogolf.com/`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eeefeb;color:#111511;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eeefeb;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="660" cellpadding="0" cellspacing="0" style="width:100%;max-width:660px;background:#fcfcfa;">
<tr><td style="padding:28px 30px 0;font-family:Georgia,serif;font-size:23px;">Hey ${escapeHtml(firstName)},</td></tr>
<tr><td><img src="cid:jrco-confirmation" width="660" height="290" alt="Your meeting is confirmed. Thank you!" style="display:block;width:100%;max-width:660px;height:auto;border:0;"></td></tr>
<tr><td align="center" style="padding:0 28px 26px;">
<p style="margin:0 0 16px;font-family:Georgia,serif;font-size:24px;font-style:italic;line-height:1.4;">${escapeHtml(welcome)}</p>
<p style="margin:0;font-size:17px;line-height:1.6;color:#355541;"><strong>${pga ? 'See you at Booth #5596' : escapeHtml(location)}</strong>${pga ? '<br>On the Right side of the Back Wall<br>of the Convention Floor.' : ''}</p>
</td></tr>
<tr><td style="padding:0 28px 26px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #dcded5;border-bottom:1px solid #dcded5;"><tr><td align="center" style="padding:22px 12px;">
<p style="margin:0 0 9px;font-size:18px;"><strong>${escapeHtml(booking.event_name)}</strong></p>
<p style="margin:0;font-size:16px;line-height:1.6;">${escapeHtml(meetingTime)}</p>
<p style="margin:12px 0 0;font-size:11px;line-height:1.6;color:#62665d;overflow-wrap:anywhere;">Booking reference: ${escapeHtml(booking.id)}</p>
</td></tr></table></td></tr>
<tr><td align="center" style="padding:0 28px 32px;">
<p style="margin:0 0 20px;font-size:16px;line-height:1.7;">Until we see you, feel free to look through<br>our latest catalogue.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#355541" style="border-radius:3px;"><a href="${catalogueUrl}" style="display:inline-block;padding:15px 25px;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">Explore our latest catalogue &#8599;</a></td></tr></table>
</td></tr>
<tr><td bgcolor="#10130f" style="padding:23px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-family:Georgia,serif;font-size:30px;font-weight:bold;font-style:italic;color:#ffffff;">JR &amp; Co.</td>
<td align="right"><a href="https://jrcogolf.com/" style="color:#c4a15b;font-size:12px;text-decoration:none;">JRCOGOLF.COM</a></td>
</tr></table></td></tr></table></td></tr></table></body></html>`;
  return {text, html, attachment: {filename: 'confirmation-confetti.gif', content: confirmationGif,
    content_type: 'image/gif', content_id: 'jrco-confirmation'}};
}
