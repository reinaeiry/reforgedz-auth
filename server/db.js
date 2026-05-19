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
    geo_label: "TEXT"
  };
  for (const [name, type] of Object.entries(need)) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE audit_log ADD COLUMN ${name} ${type}`);
  }
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
       (actor_id, actor_username, action, target_user_id, target_username, detail_json,
        ip, ua, browser, os, device, device_label,
        geo_country, geo_region, geo_city, geo_label, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      actorId || null,
      actorUsername || null,
      action,
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

function listAudit({ limit = 100, offset = 0, search } = {}) {
  let where = "";
  const params = [];
  if (search && search.trim()) {
    where = `WHERE (actor_username LIKE ? OR target_username LIKE ? OR action LIKE ? OR ip LIKE ? OR geo_label LIKE ? OR device_label LIKE ?)`;
    const s = `%${search.trim()}%`;
    params.push(s, s, s, s, s, s);
  }
  return open()
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map((r) => ({
      ...r,
      detail: r.detail_json ? safeParse(r.detail_json) : null
    }));
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
  createPendingLogin,
  getPendingLogin,
  consumePendingLogin,
  bumpPendingAttempts,
  purgeExpiredPending
};
