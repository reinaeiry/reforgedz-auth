const ADMIN_TOOLS = [
  "replay",
  "admin",
  "dev",
  "players",
  "bans",
  "mutes",
  "events",
  "health",
  "playerLookup",
  "pii",
  "gmManagement"
];

const TRANSCRIPT_PERMS = ["read", "delete", "appeals"];
const RESTRICTED_PERMS = ["access"];

function emptyPerms() {
  const admin = {};
  for (const k of ADMIN_TOOLS) admin[k] = false;
  const transcripts = {};
  for (const k of TRANSCRIPT_PERMS) transcripts[k] = false;
  const restricted = {};
  for (const k of RESTRICTED_PERMS) restricted[k] = false;
  return { admin, transcripts, restricted };
}

function normalizePerms(input) {
  const out = emptyPerms();
  if (!input || typeof input !== "object") return out;
  if (input.admin && typeof input.admin === "object") {
    for (const k of ADMIN_TOOLS) out.admin[k] = !!input.admin[k];
  }
  if (input.transcripts && typeof input.transcripts === "object") {
    for (const k of TRANSCRIPT_PERMS) out.transcripts[k] = !!input.transcripts[k];
  }
  if (input.restricted && typeof input.restricted === "object") {
    for (const k of RESTRICTED_PERMS) out.restricted[k] = !!input.restricted[k];
  }
  return out;
}

module.exports = {
  ADMIN_TOOLS,
  TRANSCRIPT_PERMS,
  RESTRICTED_PERMS,
  emptyPerms,
  normalizePerms
};
