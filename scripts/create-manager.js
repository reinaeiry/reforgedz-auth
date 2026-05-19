#!/usr/bin/env node
// Bootstrap: create a one-time invitation that grants full manager perms.
// The first manager opens the link, registers their own username + email +
// password, and confirms their email with a 6-digit code.
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const db = require("../server/db");
const { ADMIN_TOOLS, TRANSCRIPT_PERMS, RESTRICTED_PERMS } = require("../server/perms");

db.open();

const label = process.argv[2] || "first-manager";

const fullPerms = { admin: {}, transcripts: {}, restricted: {} };
for (const k of ADMIN_TOOLS) fullPerms.admin[k] = true;
for (const k of TRANSCRIPT_PERMS) fullPerms.transcripts[k] = true;
for (const k of RESTRICTED_PERMS) fullPerms.restricted[k] = true;

const ttlHours = parseInt(process.env.INVITE_TTL_HOURS || "72", 10);
const inv = db.createInvitation({
  perms: fullPerms,
  isManager: true,
  label,
  createdBy: null,
  ttlMs: ttlHours * 3600 * 1000
});

const origin = process.env.PUBLIC_ORIGIN || "https://auth.reforgedz.net";
const url = `${origin}/setup?invite=${encodeURIComponent(inv.token)}`;

db.logAudit({
  actorUsername: "cli",
  action: "invite.create",
  detail: { invitationId: inv.id, label, isManager: true, viaCli: true }
});

console.log(`Created bootstrap invitation '${label}' (id=${inv.id}).`);
console.log(`Invite link (valid ${ttlHours}h, expires ${new Date(inv.expiresAt).toISOString()}):`);
console.log("");
console.log("  " + url);
console.log("");
console.log("Open it, set your username + email + password, then enter the 6-digit code we email you.");
