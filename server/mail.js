let nodemailer = null;
let transporter = null;

function isEnabled() {
  return !!process.env.SMTP_HOST;
}

function getTransporter() {
  if (!isEnabled()) return null;
  if (transporter) return transporter;
  if (!nodemailer) nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" }
      : undefined
  });
  return transporter;
}

async function sendPasswordReset(to, username, url, ttlHours) {
  const t = getTransporter();
  if (!t) throw new Error("smtp_disabled");
  const from = process.env.MAIL_FROM || "noreply@reforgedz.net";
  await t.sendMail({
    from,
    to,
    subject: "ReforgedZ password reset",
    text:
      `Hello ${username},\n\n` +
      `A password reset was requested for your ReforgedZ staff account.\n\n` +
      `Open this link within ${ttlHours} hour(s) to set a new password:\n${url}\n\n` +
      `If you did not request this, ignore this email and your password stays the same.\n`,
    html: passwordResetHtml(username, url, ttlHours)
  });
}

function passwordResetHtml(username, url, ttlHours) {
  return `
<!doctype html><html><body style="background:#0a0e10;color:#e6f0f2;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;padding:24px;margin:0">
<div style="max-width:520px;margin:0 auto;background:#111719;border:1px solid #1d292c;border-radius:8px;padding:24px">
  <h2 style="color:#27d4dd;margin:0 0 12px 0;font-weight:600">ReforgedZ password reset</h2>
  <p>Hello <strong>${escapeHtml(username)}</strong>,</p>
  <p>A password reset was requested for your ReforgedZ staff account.</p>
  <p style="margin:24px 0">
    <a href="${escapeAttr(url)}" style="display:inline-block;background:#27d4dd;color:#0a0e10;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Set a new password</a>
  </p>
  <p style="color:#7a8c8f;font-size:13px">Link expires in ${ttlHours} hour(s). If you didn't request this, ignore this email.</p>
</div>
</body></html>`;
}

async function send2faCode(to, code, ttlMinutes) {
  const t = getTransporter();
  if (!t) throw new Error("smtp_disabled");
  const from = process.env.MAIL_FROM || "noreply@reforgedz.net";
  await t.sendMail({
    from,
    to,
    subject: `ReforgedZ login code: ${code}`,
    text:
      `Your one-time login code for ReforgedZ is: ${code}\n\n` +
      `It expires in ${ttlMinutes} minutes. If you didn't try to sign in, ignore this email and consider changing your password.\n`,
    html: codeHtml(code, ttlMinutes)
  });
}

function codeHtml(code, ttlMinutes) {
  return `
<!doctype html><html><body style="background:#0c0c0c;color:#f0f0f0;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;padding:24px;margin:0">
<div style="max-width:520px;margin:0 auto;background:#181818;border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:28px">
  <h2 style="color:#cc1f1f;margin:0 0 12px 0;font-weight:600;font-family:Oswald,sans-serif;letter-spacing:2px;text-transform:uppercase">ReforgedZ login code</h2>
  <p style="color:#aaa;margin:0 0 18px 0">Enter this code to finish signing in:</p>
  <div style="font-size:34px;letter-spacing:10px;font-weight:700;text-align:center;background:#0c0c0c;border:1px solid rgba(255,255,255,.07);border-radius:6px;padding:18px;color:#fff;font-family:'JetBrains Mono',ui-monospace,monospace">${escapeHtml(code)}</div>
  <p style="color:#777;font-size:13px;margin:18px 0 0 0">Expires in ${ttlMinutes} minutes. If you didn't try to sign in, ignore this email and consider changing your password.</p>
</div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

module.exports = { isEnabled, sendPasswordReset, send2faCode };
