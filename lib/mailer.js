// Outgoing email (invites and sign-in codes) over SMTP. Without SMTP_HOST, emails are printed to the
// server log instead, so the app can be tried locally before a mail account is set up.
import nodemailer from 'nodemailer';

const APP_NAME = 'Practice Test Portal';

export const mailConfigured = () => Boolean(process.env.SMTP_HOST);

let transporter;
function transport() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

const sender = () => process.env.MAIL_FROM || (process.env.SMTP_USER ? `${APP_NAME} <${process.env.SMTP_USER}>` : undefined);

// Returns { delivery: 'email' } once the SMTP server accepts the message, or { delivery: 'log' } without SMTP.
export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) {
    console.log(`\n----- Email not sent (SMTP is not configured) -----\nTo: ${to}\nSubject: ${subject}\n\n${text}\n---------------------------------------------------\n`);
    return { delivery: 'log' };
  }
  await transport().sendMail({ from: sender(), to, subject, text, html });
  return { delivery: 'email' };
}

// Checks the SMTP settings at startup so a wrong password shows up in the log straight away.
export async function verifyMail() {
  if (!mailConfigured()) return { ok: false, error: 'SMTP_HOST is not set' };
  try {
    await transport().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- messages ----------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const layout = (body) => `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6fb;font-family:'Segoe UI',Arial,sans-serif;color:#182032">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dde3ee;border-radius:12px;padding:28px">
<p style="margin:0 0 18px;font-weight:700;color:#2f5bea">${APP_NAME}</p>${body}</div></body></html>`;

export function inviteEmail({ name, email, link, invitedBy }) {
  const subject = `You're invited to the ${APP_NAME}`;
  const text = [
    `Hello ${name},`,
    '',
    `${invitedBy} has invited you to the ${APP_NAME}, where you can take timed practice tests and see your results.`,
    '',
    `Open the portal: ${link}`,
    '',
    `Sign in with this email address (${email}). Each time you sign in, we email you a 6-digit code to enter.`,
    '',
    'If you weren\'t expecting this invite, you can ignore this email.',
  ].join('\n');
  const html = layout(`<p style="margin:0 0 12px">Hello ${esc(name)},</p>
<p style="margin:0 0 20px">${esc(invitedBy)} has invited you to the ${APP_NAME}, where you can take timed practice tests and see your results.</p>
<p style="margin:0 0 20px"><a href="${esc(link)}" style="display:inline-block;background:#2f5bea;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px">Open the portal</a></p>
<p style="margin:0 0 12px">Sign in with this email address (<strong>${esc(email)}</strong>). Each time you sign in, we email you a 6-digit code to enter.</p>
<p style="margin:0 0 12px;font-size:13px;color:#5a6579">If the button doesn't work, copy this link into your browser:<br><a href="${esc(link)}" style="color:#2f5bea;word-break:break-all">${esc(link)}</a></p>
<p style="margin:0;font-size:13px;color:#5a6579">If you weren't expecting this invite, you can ignore this email.</p>`);
  return { subject, text, html };
}

export function codeEmail({ name, code, minutes }) {
  const subject = `Your ${APP_NAME} sign-in code`;
  const text = [
    `Hello ${name},`,
    '',
    `Your sign-in code is ${code}. It expires in ${minutes} minutes.`,
    '',
    "If you didn't try to sign in, you can ignore this email. Nobody can sign in without the code.",
  ].join('\n');
  const html = layout(`<p style="margin:0 0 12px">Hello ${esc(name)},</p>
<p style="margin:0 0 12px">Your sign-in code is:</p>
<p style="margin:0 0 16px;font-size:30px;font-weight:700;letter-spacing:6px">${esc(code)}</p>
<p style="margin:0 0 12px">It expires in ${minutes} minutes.</p>
<p style="margin:0;font-size:13px;color:#5a6579">If you didn't try to sign in, you can ignore this email. Nobody can sign in without the code.</p>`);
  return { subject, text, html };
}
