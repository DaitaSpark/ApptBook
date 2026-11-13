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
    `\nSee the industry’s best designs in our new catalogue:\n` +
    `${catalogueUrl}\n\nThank you,\nJR & Co.\nhttps://jrcogolf.com/`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eeefeb;color:#111511;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eeefeb;"><tr><td align="center" style="padding:12px 10px;">
<table role="presentation" width="660" cellpadding="0" cellspacing="0" style="width:100%;max-width:660px;background:#fcfcfa;">
<tr><td style="padding:18px 22px 0;font-family:Georgia,serif;font-size:22px;">Hey ${escapeHtml(firstName)},</td></tr>
<tr><td align="center"><img src="cid:jrco-confirmation" width="360" height="158" alt="Your meeting is confirmed. Thank you!" style="display:block;width:100%;max-width:360px;height:auto;border:0;"></td></tr>
<tr><td style="padding:0 22px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #dcded5;"><tr><td align="center" style="padding:0 0 16px;">
<p style="margin:0 0 7px;font-size:16px;"><strong>${escapeHtml(booking.event_name)}</strong></p>
<p style="margin:0 0 12px;font-size:18px;font-weight:bold;line-height:1.4;">${escapeHtml(meetingTime)}</p>
<p style="margin:0;font-size:16px;line-height:1.4;color:#355541;"><strong>${pga ? 'See you at Booth #5596' : escapeHtml(location)}</strong>${pga ? '<br>On the Right side of the Back Wall of the Convention Floor.' : ''}</p>
</td></tr></table></td></tr>
<tr><td align="center" style="padding:0 22px 20px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#355541" style="border-radius:3px;"><a href="${catalogueUrl}" style="display:inline-block;padding:14px 22px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;">See the industry&#8217;s best designs in our new catalogue &#8599;</a></td></tr></table>
</td></tr>
<tr><td bgcolor="#10130f" style="padding:15px 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-family:Georgia,serif;font-size:25px;font-weight:bold;font-style:italic;color:#ffffff;">JR &amp; Co.</td>
<td align="right"><a href="https://jrcogolf.com/" style="color:#c4a15b;font-size:12px;text-decoration:none;">JRCOGOLF.COM</a></td>
</tr></table></td></tr></table></td></tr></table></body></html>`;
  return {text, html, attachment: {filename: 'confirmation-confetti.gif', content: confirmationGif,
    content_type: 'image/gif', content_id: 'jrco-confirmation'}};
}
