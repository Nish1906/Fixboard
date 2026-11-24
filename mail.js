'use strict';
// Sends email through an HTTP email API (Resend or Brevo). With no provider set (development only), prints the email to the console.
function parseFrom(from) {
  const m = /^(.*)<(.+)>\s*$/.exec(from || '');
  return m ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() } : { name: '', email: (from || '').trim() };
}
async function send({ to, subject, text }) {
  const provider = (process.env.MAIL_PROVIDER || '').toLowerCase();
  const key = process.env.MAIL_API_KEY;
  const from = process.env.MAIL_FROM;
  if (provider === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text })
    });
    if (!r.ok) throw new Error('Resend error ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return;
  }
  if (provider === 'brevo') {
    const f = parseFrom(from);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: f.name || 'Fixboard', email: f.email }, to: [{ email: to }], subject, textContent: text })
    });
    if (!r.ok) throw new Error('Brevo error ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return;
  }
  console.log('[mail:dev] to=' + to + ' subject=' + subject + '\n' + text + '\n');
}
module.exports = { send };
