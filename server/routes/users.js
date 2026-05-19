const express = require("express");
const db = require("../db");
const session = require("../session");
const { normalizePerms } = require("../perms");
const mail = require("../mail");

const router = express.Router();

router.use(session.requireAuth, session.requireManager);

const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,32}$/;

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    isManager: user.isManager,
    suspended: user.suspended,
    perms: session.buildPerms(user),
    hasPassword: user.hasPassword,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function setupLinkFor(token) {
  const origin = process.env.PUBLIC_ORIGIN || "https://auth.reforgedz.net";
  return `${origin}/setup?token=${encodeURIComponent(token)}`;
}

function resetLinkFor(token) {
  const origin = process.env.PUBLIC_ORIGIN || "https://auth.reforgedz.net";
  return `${origin}/reset?token=${encodeURIComponent(token)}`;
}

function clientIp(req) {
  return (req.headers["cf-connecting-ip"] || req.ip || "").toString();
}

router.get("/", (req, res) => {
  res.json({ users: db.listUsers().map(publicUser) });
});

router.post("/", (req, res) => {
  const actor = req.session.user;
  const { username, email, isManager, perms } = req.body || {};
  if (!username || !USERNAME_RE.test(String(username).trim())) {
    return res.status(400).json({ error: "invalid_username" });
  }
  const existing = db.getUserByUsername(String(username).trim());
  if (existing) return res.status(409).json({ error: "username_taken" });

  const created = db.createUser({
    username: String(username).trim(),
    email: email || null,
    isManager: !!isManager,
    perms: normalizePerms(perms || {}),
    createdBy: actor.id
  });

  const ttlHours = parseInt(process.env.SETUP_TOKEN_TTL_HOURS || "24", 10);
  const { token, expiresAt } = db.createToken({
    userId: created.id,
    purpose: "setup",
    ttlMs: ttlHours * 3600 * 1000
  });
  const url = setupLinkFor(token);

  db.logAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "user.create",
    targetUserId: created.id,
    targetUsername: created.username,
    detail: { isManager: !!isManager, hasEmail: !!created.email },
    ip: clientIp(req)
  });

  res.json({ user: publicUser(created), setupUrl: url, setupExpiresAt: expiresAt });
});

router.patch("/:id", (req, res) => {
  const actor = req.session.user;
  const id = parseInt(req.params.id, 10);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: "not_found" });

  const patch = {};
  const detail = {};
  if (req.body.email !== undefined) {
    patch.email = req.body.email;
    detail.email = !!req.body.email;
  }
  if (req.body.isManager !== undefined) {
    if (target.id === actor.id && !req.body.isManager) {
      return res.status(400).json({ error: "cannot_demote_self" });
    }
    patch.isManager = !!req.body.isManager;
    detail.isManager = patch.isManager;
  }
  if (req.body.perms !== undefined) {
    patch.perms = normalizePerms(req.body.perms);
    detail.permsChanged = true;
  }
  if (req.body.suspended !== undefined) {
    if (target.id === actor.id && req.body.suspended) {
      return res.status(400).json({ error: "cannot_suspend_self" });
    }
    patch.suspended = !!req.body.suspended;
    detail.suspended = patch.suspended;
    if (patch.suspended) patch.bumpTokenVersion = true;
  }

  const updated = db.updateUser(id, patch);
  db.logAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "user.update",
    targetUserId: updated.id,
    targetUsername: updated.username,
    detail,
    ip: clientIp(req)
  });
  res.json({ user: publicUser(updated) });
});

router.post("/:id/reset", async (req, res) => {
  const actor = req.session.user;
  const id = parseInt(req.params.id, 10);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: "not_found" });

  db.invalidateUserTokens(id, "reset");
  const ttlHours = parseInt(process.env.RESET_TOKEN_TTL_HOURS || "2", 10);
  const { token, expiresAt } = db.createToken({
    userId: id,
    purpose: "reset",
    ttlMs: ttlHours * 3600 * 1000
  });
  const url = resetLinkFor(token);

  let emailed = false;
  if (target.email && mail.isEnabled()) {
    try {
      await mail.sendPasswordReset(target.email, target.username, url, ttlHours);
      emailed = true;
    } catch (err) {
      console.error("[mail] reset email failed:", err.message);
    }
  }

  db.logAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "user.reset_password",
    targetUserId: target.id,
    targetUsername: target.username,
    detail: { emailed, hasEmail: !!target.email },
    ip: clientIp(req)
  });

  res.json({ resetUrl: url, expiresAt, emailed });
});

router.post("/:id/setup-link", (req, res) => {
  const actor = req.session.user;
  const id = parseInt(req.params.id, 10);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: "not_found" });

  db.invalidateUserTokens(id, "setup");
  const ttlHours = parseInt(process.env.SETUP_TOKEN_TTL_HOURS || "24", 10);
  const { token, expiresAt } = db.createToken({
    userId: id,
    purpose: "setup",
    ttlMs: ttlHours * 3600 * 1000
  });
  const url = setupLinkFor(token);

  db.logAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "user.setup_link",
    targetUserId: target.id,
    targetUsername: target.username,
    ip: clientIp(req)
  });

  res.json({ setupUrl: url, expiresAt });
});

router.post("/:id/revoke", (req, res) => {
  const actor = req.session.user;
  const id = parseInt(req.params.id, 10);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: "not_found" });

  const updated = db.updateUser(id, { bumpTokenVersion: true });
  db.logAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "user.revoke",
    targetUserId: target.id,
    targetUsername: target.username,
    ip: clientIp(req)
  });
  res.json({ user: publicUser(updated) });
});

router.delete("/:id", (req, res) => {
  const actor = req.session.user;
  const id = parseInt(req.params.id, 10);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: "not_found" });
  if (target.id === actor.id) return res.status(400).json({ error: "cannot_delete_self" });

  db.deleteUser(id);
  db.logAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "user.delete",
    targetUserId: target.id,
    targetUsername: target.username,
    ip: clientIp(req)
  });
  res.json({ ok: true });
});

module.exports = router;
