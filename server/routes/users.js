const express = require("express");
const db = require("../db");
const session = require("../session");
const { normalizePerms } = require("../perms");
const mail = require("../mail");
const reqctx = require("../reqctx");

const router = express.Router();

router.use(session.requireAuth, session.requireManager);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function inviteLinkFor(token) {
  const origin = process.env.PUBLIC_ORIGIN || "https://auth.reforgedz.net";
  return `${origin}/setup?invite=${encodeURIComponent(token)}`;
}

function resetLinkFor(token) {
  const origin = process.env.PUBLIC_ORIGIN || "https://auth.reforgedz.net";
  return `${origin}/reset?token=${encodeURIComponent(token)}`;
}

// ─── Existing user list / edit ───────────────────────────────────────────────

router.get("/", (req, res) => {
  res.json({ users: db.listUsers().map(publicUser) });
});

router.patch("/:id", (req, res) => {
  const actor = req.session.user;
  const ctx = reqctx.build(req);
  const id = parseInt(req.params.id, 10);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: "not_found" });

  const patch = {};
  const detail = {};
  if (req.body.email !== undefined) {
    const newEmail = req.body.email ? String(req.body.email).trim() : "";
    if (!newEmail || !EMAIL_RE.test(newEmail)) {
      return res.status(400).json({ error: "email_required" });
    }
    patch.email = newEmail;
    detail.email = true;
  }
  if (req.body.isManager !== undefined) {
    if (target.id === actor.id && !req.body.isManager) {
      return res.status(400).json({ error: "cannot_demote_self" });
    }
    patch.isManager = !!req.body.isManager;
    detail.isManager = patch.isManager;
    // isManager lives in the JWT — force the user to re-login so it takes effect.
    patch.bumpTokenVersion = true;
  }
  if (req.body.perms !== undefined) {
    patch.perms = normalizePerms(req.body.perms);
    detail.permsChanged = true;
    // Perms live in the JWT — force the user to re-login so the new perms apply.
    patch.bumpTokenVersion = true;
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
    ctx
  });
  res.json({ user: publicUser(updated) });
});

router.post("/:id/reset", async (req, res) => {
  const actor = req.session.user;
  const ctx = reqctx.build(req);
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
    ctx
  });

  res.json({ resetUrl: url, expiresAt, emailed });
});

router.post("/:id/revoke", (req, res) => {
  const actor = req.session.user;
  const ctx = reqctx.build(req);
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
    ctx
  });
  res.json({ user: publicUser(updated) });
});

router.delete("/:id", (req, res) => {
  const actor = req.session.user;
  const ctx = reqctx.build(req);
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
    ctx
  });
  res.json({ ok: true });
});

// ─── Invitations ─────────────────────────────────────────────────────────────

router.get("/invites/list", (req, res) => {
  const rows = db.listInvitations().map((r) => ({
    id: r.id,
    label: r.label,
    isManager: !!r.is_manager,
    perms: r.perms_json ? JSON.parse(r.perms_json) : null,
    expiresAt: r.expires_at,
    consumedAt: r.consumed_at,
    consumedUsername: r.consumed_username,
    createdByUsername: r.created_by_username,
    createdAt: r.created_at,
    status: r.consumed_at ? "redeemed" : (r.expires_at < Date.now() ? "expired" : "pending")
  }));
  res.json({ invitations: rows });
});

router.post("/invites", (req, res) => {
  const actor = req.session.user;
  const ctx = reqctx.build(req);
  const { perms, isManager, label } = req.body || {};
  const ttlHours = parseInt(process.env.INVITE_TTL_HOURS || "72", 10);
  const { id, token, expiresAt } = db.createInvitation({
    perms: perms || {},
    isManager: !!isManager,
    label: label || null,
    createdBy: actor.id,
    ttlMs: ttlHours * 3600 * 1000
  });
  const url = inviteLinkFor(token);
  db.logAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "invite.create",
    detail: { invitationId: id, label: label || null, isManager: !!isManager },
    ctx
  });
  res.json({ invitationId: id, inviteUrl: url, expiresAt, ttlHours });
});

router.delete("/invites/:id", (req, res) => {
  const actor = req.session.user;
  const ctx = reqctx.build(req);
  const id = parseInt(req.params.id, 10);
  db.revokeInvitation(id);
  db.logAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "invite.revoke",
    detail: { invitationId: id },
    ctx
  });
  res.json({ ok: true });
});

module.exports = router;
