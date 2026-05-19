const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const session = require("../session");
const { getPublicPem } = require("../keys");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || "60000", 10),
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || "5", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" }
});

function clientIp(req) {
  return (req.headers["cf-connecting-ip"] || req.ip || "").toString();
}

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
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "missing_credentials" });
  const user = db.getUserByUsername(String(username).trim());
  if (!user || !user.passwordHash) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  if (user.suspended) return res.status(403).json({ error: "account_suspended" });
  const ok = await bcrypt.compare(String(password), user.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  db.updateUser(user.id, { lastLoginAt: Date.now() });
  const fresh = db.getUserById(user.id);
  session.setSessionCookie(res, fresh);
  db.logAudit({
    actorId: fresh.id,
    actorUsername: fresh.username,
    action: "login",
    targetUserId: fresh.id,
    targetUsername: fresh.username,
    ip: clientIp(req)
  });
  res.json({ user: publicUser(fresh) });
});

router.post("/logout", (req, res) => {
  const sess = session.readSession(req);
  session.clearSessionCookie(res);
  if (sess) {
    db.logAudit({
      actorId: sess.user.id,
      actorUsername: sess.user.username,
      action: "logout",
      targetUserId: sess.user.id,
      targetUsername: sess.user.username,
      ip: clientIp(req)
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

module.exports = router;
