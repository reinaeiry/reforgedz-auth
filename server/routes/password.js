const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const session = require("../session");
const mail = require("../mail");

const router = express.Router();

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

const sensitiveLimiter = rateLimit({
  windowMs: 60000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" }
});

function clientIp(req) {
  return (req.headers["cf-connecting-ip"] || req.ip || "").toString();
}

function validatePassword(pw) {
  if (typeof pw !== "string") return "missing_password";
  if (pw.length < MIN_PASSWORD) return "password_too_short";
  if (pw.length > MAX_PASSWORD) return "password_too_long";
  return null;
}

router.post("/forgot", sensitiveLimiter, async (req, res) => {
  const username = String((req.body && req.body.username) || "").trim();
  if (!username) return res.json({ ok: true });
  const user = db.getUserByUsername(username);
  if (!user || user.suspended || !user.email || !mail.isEnabled()) {
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
    ip: clientIp(req)
  });
  res.json({ ok: true });
});

router.get("/token-info", (req, res) => {
  const token = req.query.token;
  const purpose = req.query.purpose === "reset" ? "reset" : "setup";
  if (!token) return res.status(400).json({ error: "missing_token" });
  const row = db.peekToken(String(token), purpose);
  if (!row) return res.status(400).json({ error: "invalid_or_expired" });
  const user = db.getUserById(row.user_id);
  if (!user || user.suspended) return res.status(400).json({ error: "invalid_or_expired" });
  res.json({ username: user.username, purpose });
});

router.post("/redeem", sensitiveLimiter, async (req, res) => {
  const { token, password, purpose } = req.body || {};
  const purposeNorm = purpose === "reset" ? "reset" : "setup";
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (!token) return res.status(400).json({ error: "missing_token" });

  const row = db.consumeToken(String(token), purposeNorm);
  if (!row) return res.status(400).json({ error: "invalid_or_expired" });
  const user = db.getUserById(row.user_id);
  if (!user || user.suspended) return res.status(400).json({ error: "invalid_or_expired" });

  const hash = await bcrypt.hash(String(password), 10);
  db.updateUser(user.id, { passwordHash: hash, bumpTokenVersion: true });
  db.invalidateUserTokens(user.id, "reset");
  db.invalidateUserTokens(user.id, "setup");
  const fresh = db.getUserById(user.id);
  session.setSessionCookie(res, fresh);
  db.logAudit({
    actorId: fresh.id,
    actorUsername: fresh.username,
    action: purposeNorm === "setup" ? "password.setup" : "password.reset",
    targetUserId: fresh.id,
    targetUsername: fresh.username,
    ip: clientIp(req)
  });
  res.json({ ok: true, user: { id: fresh.id, username: fresh.username } });
});

router.post("/change", session.requireAuth, async (req, res) => {
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
    ip: clientIp(req)
  });
  res.json({ ok: true });
});

module.exports = router;
