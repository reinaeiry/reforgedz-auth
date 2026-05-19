#!/usr/bin/env node
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const db = require("../server/db");
const { emptyPerms } = require("../server/perms");

const username = process.argv[2];
if (!username) {
  console.error("Usage: npm run manager:create -- <username> [email]");
  process.exit(1);
}
const email = process.argv[3] || null;

db.open();
const existing = db.getUserByUsername(username);
if (existing) {
  console.error(`User '${existing.username}' already exists (id=${existing.id}).`);
  process.exit(1);
}

const perms = emptyPerms();
const created = db.createUser({ username, email, isManager: true, perms, createdBy: null });

const ttlHours = parseInt(process.env.SETUP_TOKEN_TTL_HOURS || "24", 10);
const { token, expiresAt } = db.createToken({
  userId: created.id,
  purpose: "setup",
  ttlMs: ttlHours * 3600 * 1000
});

const origin = process.env.PUBLIC_ORIGIN || "https://auth.reforgedz.net";
const url = `${origin}/setup?token=${encodeURIComponent(token)}`;

db.logAudit({
  actorId: null,
  actorUsername: "cli",
  action: "user.create",
  targetUserId: created.id,
  targetUsername: created.username,
  detail: { isManager: true, viaCli: true }
});

console.log(`Created manager user '${created.username}' (id=${created.id}).`);
console.log(`Setup link (valid ${ttlHours}h, expires ${new Date(expiresAt).toISOString()}):`);
console.log(url);
