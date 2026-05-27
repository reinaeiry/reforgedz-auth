const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { emptyPerms, normalizePerms } = require("./perms");

let db = null;

function open() {
  if (db) return db;
  const dbPath = path.resolve(process.env.DB_PATH || "./data/auth.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate();
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE,
      password_hash TEXT,
      email TEXT,
      token_version INTEGER NOT NULL DEFAULT 1,
      is_manager INTEGER NOT NULL DEFAULT 0,
      perms_json TEXT NOT NULL DEFAULT '{}',
      suspended INTEGER NOT NULL DEFAULT 0,
      last_login_at INTEGER,
      created_at INTEGER NOT NULL,
      created_by INTEGER,
      updated_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS setup_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_setup_tokens_user ON setup_tokens(user_id);

    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      perms_json TEXT NOT NULL,
      is_manager INTEGER NOT NULL DEFAULT 0,
      label TEXT,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      consumed_user_id INTEGER,
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
    CREATE INDEX IF NOT EXISTS idx_invitations_expires ON invitations(expires_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      actor_username TEXT,
      action TEXT NOT NULL,
      target_user_id INTEGER,
      target_username TEXT,
      detail_json TEXT,
      ip TEXT,
      ua TEXT,
      browser TEXT,
      os TEXT,
      device TEXT,
      device_label TEXT,
      geo_country TEXT,
      geo_region TEXT,
      geo_city TEXT,
      geo_label TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_user_id);

    CREATE TABLE IF NOT EXISTS pending_logins (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      ip TEXT,
      ua TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_logins(user_id);
    CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_logins(expires_at);
  `);
  backfillAuditColumns();
}

function backfillAuditColumns() {
  const cols = db.prepare("PRAGMA table_info(audit_log)").all().map((c) => c.name);
  const need = {
    ua: "TEXT",
    browser: "TEXT",
    os: "TEXT",
    device: "TEXT",
    device_label: "TEXT",
    geo_country: "TEXT",
    geo_region: "TEXT",
    geo_city: "TEXT",
    geo_label: "TEXT",
    category: "TEXT"
  };
  for (const [name, type] of Object.entries(need)) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE audit_log ADD COLUMN ${name} ${type}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_log(category)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_username)");
  // One-time backfill: derive category for any rows logged before the
  // column existed.
  const missing = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE category IS NULL").get().n;
  if (missing > 0) {
    const rows = db.prepare("SELECT id, action FROM audit_log WHERE category IS NULL").all();
    const upd = db.prepare("UPDATE audit_log SET category = ? WHERE id = ?");
    const tx = db.transaction(() => {
      for (const r of rows) upd.run(categorizeAction(r.action), r.id);
    });
    tx();
  }
}

// Bucket an action string into a UI category. Keep in sync with the tab
// list in public/manage.js.
function categorizeAction(action) {
  const a = String(action || "");
  if (a.startsWith("view.")) return "views";
  if (a.startsWith("ingame.mute")) return "mutes";
  if (a.startsWith("ingame.ban") || a.startsWith("bm.ban")) return "bans";
  if (a.startsWith("ipban")) return "ipbans";
  if (a === "bm.kick") return "kicks";
  if (a.startsWith("bm.note")) return "notes";
  if (a.startsWith("ticket")) return "tickets";
  if (a.startsWith("gm.") || a.startsWith("adminmgr") || a.startsWith("priorityqueue")) return "gm";
  // Auth-side account/session activity.
  if (/^(login|logout|password|session|invite|user\.|perms|twofa|2fa|email|manager)/.test(a)) return "auth";
  return "other";
}

function rowToUser(row) {
  if (!row) return null;
  let perms;
  try {
    perms = normalizePerms(JSON.parse(row.perms_json || "{}"));
  } catch {
    perms = emptyPerms();
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email || null,
    hasPassword: !!row.password_hash,
    passwordHash: row.password_hash || null,
    tokenVersion: row.token_version,
    isManager: !!row.is_manager,
    perms,
    suspended: !!row.suspended,
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at,
    createdBy: row.created_by || null,
    updatedAt: row.updated_at || null
  };
}

function getUserById(id) {
  return rowToUser(open().prepare("SELECT * FROM users WHERE id = ?").get(id));
}

function getUserByUsername(username) {
  return rowToUser(
    open().prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username)
  );
}

function listUsers() {
  return open()
    .prepare("SELECT * FROM users ORDER BY username COLLATE NOCASE")
    .all()
    .map(rowToUser);
}

function createUser({ username, email, isManager, perms, createdBy }) {
  const now = Date.now();
  const stmt = open().prepare(`
    INSERT INTO users (username, email, is_manager, perms_json, created_at, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    username.trim(),
    email ? email.trim().toLowerCase() : null,
    isManager ? 1 : 0,
    JSON.stringify(normalizePerms(perms)),
    now,
    createdBy || null,
    now
  );
  return getUserById(info.lastInsertRowid);
}

function updateUser(id, patch) {
  const cur = getUserById(id);
  if (!cur) return null;
  const fields = [];
  const values = [];
  if (patch.email !== undefined) {
    fields.push("email = ?");
    values.push(patch.email ? String(patch.email).trim().toLowerCase() : null);
  }
  if (patch.isManager !== undefined) {
    fields.push("is_manager = ?");
    values.push(patch.isManager ? 1 : 0);
  }
  if (patch.perms !== undefined) {
    fields.push("perms_json = ?");
    values.push(JSON.stringify(normalizePerms(patch.perms)));
  }
  if (patch.suspended !== undefined) {
    fields.push("suspended = ?");
    values.push(patch.suspended ? 1 : 0);
  }
  if (patch.passwordHash !== undefined) {
    fields.push("password_hash = ?");
    values.push(patch.passwordHash);
  }
  if (patch.bumpTokenVersion) {
    fields.push("token_version = token_version + 1");
  }
  if (patch.lastLoginAt !== undefined) {
    fields.push("last_login_at = ?");
    values.push(patch.lastLoginAt);
  }
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  open()
    .prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getUserById(id);
}

function deleteUser(id) {
  return open().prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
}

function createToken({ userId, purpose, ttlMs }) {
  const crypto = require("crypto");
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  open()
    .prepare(
      "INSERT INTO setup_tokens (token, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(token, userId, purpose, now + ttlMs, now);
  return { token, expiresAt: now + ttlMs };
}

function consumeToken(token, purpose) {
  const row = open()
    .prepare("SELECT * FROM setup_tokens WHERE token = ? AND purpose = ?")
    .get(token, purpose);
  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at < Date.now()) return null;
  open()
    .prepare("UPDATE setup_tokens SET used_at = ? WHERE token = ?")
    .run(Date.now(), token);
  return row;
}

function peekToken(token, purpose) {
  const row = open()
    .prepare("SELECT * FROM setup_tokens WHERE token = ? AND purpose = ?")
    .get(token, purpose);
  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}

function invalidateUserTokens(userId, purpose) {
  const now = Date.now();
  open()
    .prepare(
      "UPDATE setup_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL"
    )
    .run(now, userId, purpose);
}

function logAudit({ actorId, actorUsername, action, targetUserId, targetUsername, detail, ctx }) {
  const c = ctx || {};
  const geo = c.geo || {};
  open()
    .prepare(
      `INSERT INTO audit_log
       (actor_id, actor_username, action, category, target_user_id, target_username, detail_json,
        ip, ua, browser, os, device, device_label,
        geo_country, geo_region, geo_city, geo_label, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      actorId || null,
      actorUsername || null,
      action,
      categorizeAction(action),
      targetUserId || null,
      targetUsername || null,
      detail ? JSON.stringify(detail) : null,
      c.ip || null,
      c.ua || null,
      c.browser || null,
      c.os || null,
      c.device || null,
      c.deviceLabel || null,
      geo.country || null,
      geo.region || null,
      geo.city || null,
      c.geoLabel || null,
      Date.now()
    );
}

// Filterable + paginated audit query. Returns { entries, total }.
function listAudit({ limit = 100, offset = 0, search, category, actor, action, sinceMs, untilMs } = {}) {
  const where = [];
  const params = [];
  if (search && search.trim()) {
    where.push("(actor_username LIKE ? OR target_username LIKE ? OR action LIKE ? OR ip LIKE ? OR geo_label LIKE ? OR device_label LIKE ? OR detail_json LIKE ?)");
    const s = `%${search.trim()}%`;
    params.push(s, s, s, s, s, s, s);
  }
  if (category && category !== "all") { where.push("category = ?"); params.push(category); }
  if (actor && actor.trim()) { where.push("actor_username = ? COLLATE NOCASE"); params.push(actor.trim()); }
  if (action && action.trim()) { where.push("action = ?"); params.push(action.trim()); }
  if (sinceMs) { where.push("at >= ?"); params.push(+sinceMs); }
  if (untilMs) { where.push("at <= ?"); params.push(+untilMs); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = open().prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`).get(...params).n;
  const entries = open()
    .prepare(`SELECT * FROM audit_log ${whereSql} ORDER BY at DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.min(+limit || 100, 500), Math.max(+offset || 0, 0))
    .map((r) => ({ ...r, detail: r.detail_json ? safeParse(r.detail_json) : null }));
  return { entries, total };
}

// Distinct values for the filter dropdowns + per-category counts.
function auditFacets() {
  const db2 = open();
  const categories = db2.prepare("SELECT category, COUNT(*) AS n FROM audit_log GROUP BY category").all();
  const actors = db2.prepare("SELECT DISTINCT actor_username FROM audit_log WHERE actor_username IS NOT NULL ORDER BY actor_username COLLATE NOCASE").all().map((r) => r.actor_username);
  const actions = db2.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all().map((r) => r.action);
  return { categories, actors, actions };
}

function createPendingLogin({ userId, codeHash, purpose, ttlMs, ip, ua }) {
  const crypto = require("crypto");
  const id = crypto.randomBytes(18).toString("base64url");
  const now = Date.now();
  open()
    .prepare(
      `INSERT INTO pending_logins (id, user_id, code_hash, purpose, expires_at, ip, ua, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, userId, codeHash, purpose, now + ttlMs, ip || null, ua || null, now);
  return { id, expiresAt: now + ttlMs };
}

function getPendingLogin(id) {
  return open().prepare("SELECT * FROM pending_logins WHERE id = ?").get(id);
}

function consumePendingLogin(id) {
  open().prepare("UPDATE pending_logins SET consumed_at = ? WHERE id = ?").run(Date.now(), id);
}

function bumpPendingAttempts(id) {
  open().prepare("UPDATE pending_logins SET attempts = attempts + 1 WHERE id = ?").run(id);
}

function purgeExpiredPending() {
  open().prepare("DELETE FROM pending_logins WHERE expires_at < ?").run(Date.now() - 24 * 3600 * 1000);
}

function createInvitation({ perms, isManager, label, createdBy, ttlMs }) {
  const crypto = require("crypto");
  const { normalizePerms } = require("./perms");
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const info = open()
    .prepare(
      `INSERT INTO invitations (token, perms_json, is_manager, label, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      token,
      JSON.stringify(normalizePerms(perms || {})),
      isManager ? 1 : 0,
      label || null,
      now + ttlMs,
      createdBy || null,
      now
    );
  return { id: info.lastInsertRowid, token, expiresAt: now + ttlMs };
}

function getInvitationByToken(token) {
  return open().prepare("SELECT * FROM invitations WHERE token = ?").get(token);
}

function consumeInvitation(token, userId) {
  open()
    .prepare("UPDATE invitations SET consumed_at = ?, consumed_user_id = ? WHERE token = ?")
    .run(Date.now(), userId, token);
}

function listInvitations() {
  return open()
    .prepare(`
      SELECT i.*, u.username AS consumed_username, c.username AS created_by_username
      FROM invitations i
      LEFT JOIN users u ON u.id = i.consumed_user_id
      LEFT JOIN users c ON c.id = i.created_by
      ORDER BY i.created_at DESC
    `)
    .all();
}

function revokeInvitation(id) {
  // Soft-revoke: bump expires_at into the past.
  open()
    .prepare("UPDATE invitations SET expires_at = ? WHERE id = ? AND consumed_at IS NULL")
    .run(Date.now() - 1, id);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = {
  open,
  getUserById,
  getUserByUsername,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  createToken,
  consumeToken,
  peekToken,
  invalidateUserTokens,
  logAudit,
  listAudit,
  auditFacets,
  createPendingLogin,
  getPendingLogin,
  consumePendingLogin,
  bumpPendingAttempts,
  purgeExpiredPending,
  createInvitation,
  getInvitationByToken,
  consumeInvitation,
  listInvitations,
  revokeInvitation
};
