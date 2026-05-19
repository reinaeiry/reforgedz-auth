const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const session = require("../session");
const twofa = require("../twofa");
const reqctx = require("../reqctx");
const { getPublicPem } = require("../keys");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || "60000", 10),
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || "5", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" }
});

const twofaLimiter = rateLimit({
  windowMs: 60000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" }
});

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    isManager: user.isManager,
    perms: session.buildPerms(user),
    suspended: user.suspended,
    lastLoginAt: user.lastLoginAt
  };
}

router.post("/login", loginLimiter, async (req, res) => {
  const ctx = reqctx.build(req);
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "missing_credentials" });
  const user = db.getUserByUsername(String(username).trim());
  if (!user || !user.passwordHash) {
    db.logAudit({
      actorUsername: String(username).trim(),
      action: "login.failed",
      detail: { reason: "no_such_user" },
      ctx
    });
    return res.status(401).json({ error: "invalid_credentials" });
  }
  if (user.suspended) {
    db.logAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "login.failed",
      targetUserId: user.id,
      targetUsername: user.username,
      detail: { reason: "suspended" },
      ctx
    });
    return res.status(403).json({ error: "account_suspended" });
  }
  const ok = await bcrypt.compare(String(password), user.passwordHash);
  if (!ok) {
    db.logAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "login.failed",
      targetUserId: user.id,
      targetUsername: user.username,
      detail: { reason: "wrong_password" },
      ctx
    });
    return res.status(401).json({ error: "invalid_credentials" });
  }

  // Password OK — issue a 2FA challenge over email.
  if (!user.email) {
    return res.status(500).json({ error: "no_email_on_file" });
  }
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
      action: "login.password_ok",
      targetUserId: user.id,
      targetUsername: user.username,
      detail: { challengeId },
      ctx
    });
    res.json({
      needs2fa: true,
      challengeId,
      emailHint: maskEmail(user.email)
    });
  } catch (err) {
    db.logAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "login.2fa_send_failed",
      targetUserId: user.id,
      targetUsername: user.username,
      detail: { error: err.message },
      ctx
    });
    res.status(500).json({ error: "mail_send_failed" });
  }
});

router.post("/2fa/verify", twofaLimiter, async (req, res) => {
  const ctx = reqctx.build(req);
  const { challengeId, code } = req.body || {};
  if (!challengeId || !code) return res.status(400).json({ error: "missing_fields" });
  const result = await twofa.verifyChallenge({
    challengeId: String(challengeId),
    code: String(code),
    expectedPurpose: "login"
  });
  if (!result.ok) {
    db.logAudit({
      action: "login.2fa_failed",
      detail: { reason: result.reason, attemptsRemaining: result.attemptsRemaining },
      ctx
    });
    return res.status(401).json(result);
  }
  const user = db.getUserById(result.userId);
  if (!user || user.suspended) return res.status(401).json({ error: "account_unavailable" });

  db.updateUser(user.id, { lastLoginAt: Date.now() });
  const fresh = db.getUserById(user.id);
  session.setSessionCookie(res, fresh);
  db.logAudit({
    actorId: fresh.id,
    actorUsername: fresh.username,
    action: "login.success",
    targetUserId: fresh.id,
    targetUsername: fresh.username,
    ctx
  });
  res.json({ user: publicUser(fresh) });
});

router.post("/2fa/resend", twofaLimiter, async (req, res) => {
  const ctx = reqctx.build(req);
  const { challengeId } = req.body || {};
  if (!challengeId) return res.status(400).json({ error: "missing_fields" });
  const existing = db.getPendingLogin(String(challengeId));
  if (!existing || existing.consumed_at || existing.expires_at < Date.now()) {
    return res.status(400).json({ error: "invalid_challenge" });
  }
  const user = db.getUserById(existing.user_id);
  if (!user || !user.email) return res.status(400).json({ error: "invalid_challenge" });
  try {
    const { challengeId: newId } = await twofa.startChallenge({
      userId: user.id,
      purpose: existing.purpose,
      email: user.email,
      ip: ctx.ip,
      ua: ctx.ua
    });
    // Invalidate the old challenge by consuming it.
    db.consumePendingLogin(String(challengeId));
    db.logAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "login.2fa_resent",
      targetUserId: user.id,
      targetUsername: user.username,
      ctx
    });
    res.json({ challengeId: newId, emailHint: maskEmail(user.email) });
  } catch {
    res.status(500).json({ error: "mail_send_failed" });
  }
});

router.post("/logout", (req, res) => {
  const ctx = reqctx.build(req);
  const sess = session.readSession(req);
  session.clearSessionCookie(res);
  if (sess) {
    db.logAudit({
      actorId: sess.user.id,
      actorUsername: sess.user.username,
      action: "logout",
      targetUserId: sess.user.id,
      targetUsername: sess.user.username,
      ctx
    });
  }
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  const sess = session.readSession(req);
  if (!sess) return res.status(401).json({ error: "unauthorized" });
  res.json({ user: publicUser(sess.user) });
});

router.get("/sessions/check", (req, res) => {
  const sub = req.query.sub;
  const rev = req.query.rev;
  if (!sub || rev === undefined) return res.json({ valid: false });
  const user = db.getUserById(parseInt(sub, 10));
  if (!user || user.suspended) return res.json({ valid: false });
  res.json({ valid: user.tokenVersion === parseInt(rev, 10) });
});

router.get("/public-key", (req, res) => {
  res.type("text/plain").send(getPublicPem());
});

function maskEmail(e) {
  if (!e) return null;
  const [u, d] = e.split("@");
  if (!u || !d) return e;
  const masked = u.length <= 2 ? u[0] + "*" : u[0] + "*".repeat(Math.max(1, u.length - 2)) + u[u.length - 1];
  return masked + "@" + d;
}

module.exports = router;
