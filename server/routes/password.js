const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const session = require("../session");
const mail = require("../mail");
const twofa = require("../twofa");
const reqctx = require("../reqctx");
const { normalizePerms } = require("../perms");

const router = express.Router();

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sensitiveLimiter = rateLimit({
  windowMs: 60000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" }
});

function validatePassword(pw) {
  if (typeof pw !== "string") return "missing_password";
  if (pw.length < MIN_PASSWORD) return "password_too_short";
  if (pw.length > MAX_PASSWORD) return "password_too_long";
  return null;
}

// ─── Forgot ─────────────────────────────────────────────────────────────────

router.post("/forgot", sensitiveLimiter, async (req, res) => {
  const ctx = reqctx.build(req);
  const username = String((req.body && req.body.username) || "").trim();
  if (!username) return res.json({ ok: true });
  const user = db.getUserByUsername(username);
  if (!user || user.suspended || !user.email || !mail.isEnabled()) {
    db.logAudit({
      actorUsername: username,
      action: "password.forgot_noop",
      detail: { reason: !user ? "no_user" : !user.email ? "no_email" : "suspended_or_mail_off" },
      ctx
    });
    return res.json({ ok: true });
  }
  db.invalidateUserTokens(user.id, "reset");
  const ttlHours = parseInt(process.env.RESET_TOKEN_TTL_HOURS || "2", 10);
  const { token } = db.createToken({
    userId: user.id,
    purpose: "reset",
    ttlMs: ttlHours * 3600 * 1000
  });
  const origin = process.env.PUBLIC_ORIGIN || "https://auth.reforgedz.net";
  const url = `${origin}/reset?token=${encodeURIComponent(token)}`;
  try {
    await mail.sendPasswordReset(user.email, user.username, url, ttlHours);
  } catch (err) {
    console.error("[mail] forgot failed:", err.message);
  }
  db.logAudit({
    actorId: user.id,
    actorUsername: user.username,
    action: "password.forgot_requested",
    targetUserId: user.id,
    targetUsername: user.username,
    ctx
  });
  res.json({ ok: true });
});

// ─── Token info ─────────────────────────────────────────────────────────────

router.get("/token-info", (req, res) => {
  if (req.query.invite) {
    const inv = db.getInvitationByToken(String(req.query.invite));
    if (!inv) return res.status(400).json({ error: "invalid_or_expired" });
    if (inv.consumed_at) return res.status(400).json({ error: "already_used" });
    if (inv.expires_at < Date.now()) return res.status(400).json({ error: "expired" });
    return res.json({
      kind: "invite",
      label: inv.label || null,
      isManager: !!inv.is_manager,
      perms: inv.perms_json ? JSON.parse(inv.perms_json) : null
    });
  }
  const token = req.query.token;
  const purpose = req.query.purpose === "reset" ? "reset" : null;
  if (!token || !purpose) return res.status(400).json({ error: "missing_token" });
  const row = db.peekToken(String(token), purpose);
  if (!row) return res.status(400).json({ error: "invalid_or_expired" });
  const user = db.getUserById(row.user_id);
  if (!user || user.suspended) return res.status(400).json({ error: "invalid_or_expired" });
  res.json({ kind: "reset", username: user.username, emailHint: maskEmail(user.email) });
});

// ─── Invite redemption (create user) ────────────────────────────────────────

router.post("/invite/redeem", sensitiveLimiter, async (req, res) => {
  const ctx = reqctx.build(req);
  const { invite, username, email, password } = req.body || {};
  if (!invite) return res.status(400).json({ error: "missing_invite" });
  if (!username || !USERNAME_RE.test(String(username).trim())) {
    return res.status(400).json({ error: "invalid_username" });
  }
  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: "email_required" });
  }
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const inv = db.getInvitationByToken(String(invite));
  if (!inv || inv.consumed_at || inv.expires_at < Date.now()) {
    return res.status(400).json({ error: "invalid_or_expired" });
  }
  const uname = String(username).trim();
  if (db.getUserByUsername(uname)) return res.status(409).json({ error: "username_taken" });

  const hash = await bcrypt.hash(String(password), 10);
  const created = db.createUser({
    username: uname,
    email: String(email).trim().toLowerCase(),
    isManager: !!inv.is_manager,
    perms: normalizePerms(inv.perms_json ? JSON.parse(inv.perms_json) : {}),
    createdBy: inv.created_by
  });
  db.updateUser(created.id, { passwordHash: hash });

  // Send 2FA code to the email they just supplied.
  try {
    const { challengeId } = await twofa.startChallenge({
      userId: created.id,
      purpose: "login",
      email: created.email,
      ip: ctx.ip,
      ua: ctx.ua
    });
    db.consumeInvitation(String(invite), created.id);
    db.logAudit({
      actorId: created.id,
      actorUsername: created.username,
      action: "invite.redeem",
      targetUserId: created.id,
      targetUsername: created.username,
      detail: { invitationId: inv.id, label: inv.label || null },
      ctx
    });
    res.json({ needs2fa: true, challengeId, emailHint: maskEmail(created.email) });
  } catch (err) {
    // Roll back created user if mail fails — they can try again.
    db.deleteUser(created.id);
    res.status(500).json({ error: "mail_send_failed" });
  }
});

// ─── Password reset (existing user) ─────────────────────────────────────────

router.post("/reset/redeem", sensitiveLimiter, async (req, res) => {
  const ctx = reqctx.build(req);
  const { token, password } = req.body || {};
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (!token) return res.status(400).json({ error: "missing_token" });

  const row = db.consumeToken(String(token), "reset");
  if (!row) return res.status(400).json({ error: "invalid_or_expired" });
  const user = db.getUserById(row.user_id);
  if (!user || user.suspended) return res.status(400).json({ error: "invalid_or_expired" });

  const hash = await bcrypt.hash(String(password), 10);
  db.updateUser(user.id, { passwordHash: hash, bumpTokenVersion: true });
  db.invalidateUserTokens(user.id, "reset");

  try {
    const { challengeId } = await twofa.startChallenge({
      userId: user.id,
      purpose: "login",
      email: user.email,
      ip: ctx.ip,
      ua: ctx.ua
    });
    db.logAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "password.reset",
      targetUserId: user.id,
      targetUsername: user.username,
      ctx
    });
    res.json({ needs2fa: true, challengeId, emailHint: maskEmail(user.email) });
  } catch {
    res.status(500).json({ error: "mail_send_failed" });
  }
});

// ─── Password change (authenticated) ────────────────────────────────────────

router.post("/change", session.requireAuth, async (req, res) => {
  const ctx = reqctx.build(req);
  const { current, password } = req.body || {};
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (!current) return res.status(400).json({ error: "missing_current_password" });

  const user = req.session.user;
  if (!user.passwordHash) return res.status(400).json({ error: "no_password_set" });
  const ok = await bcrypt.compare(String(current), user.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid_current_password" });

  const hash = await bcrypt.hash(String(password), 10);
  db.updateUser(user.id, { passwordHash: hash, bumpTokenVersion: true });
  const fresh = db.getUserById(user.id);
  session.setSessionCookie(res, fresh);
  db.logAudit({
    actorId: fresh.id,
    actorUsername: fresh.username,
    action: "password.change",
    targetUserId: fresh.id,
    targetUsername: fresh.username,
    ctx
  });
  res.json({ ok: true });
});

function maskEmail(e) {
  if (!e) return null;
  const [u, d] = e.split("@");
  if (!u || !d) return e;
  const masked = u.length <= 2 ? u[0] + "*" : u[0] + "*".repeat(Math.max(1, u.length - 2)) + u[u.length - 1];
  return masked + "@" + d;
}

module.exports = router;
