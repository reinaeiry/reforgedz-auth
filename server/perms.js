const ADMIN_TOOLS = [
  "replay",
  "gmManagement"
];

const TRANSCRIPT_PERMS = ["read", "stats", "restricted"];

// `viewIps` is the single PII gate: BM IPs + in-game-log IPs + IP-ban CRUD.
// Steam IDs, hardware IDs, and session history are surfaced under viewPlayers.
const BATTLEMETRICS_PERMS = [
  "viewServers",
  "viewPlayers",
  "viewIps",
  "viewActivity",
  "viewBans",
  "writeNotes",
  "kick",
  "ban",
  "manage"
];

function emptyPerms() {
  const admin = {};
  for (const k of ADMIN_TOOLS) admin[k] = false;
  const transcripts = {};
  for (const k of TRANSCRIPT_PERMS) transcripts[k] = false;
  const battlemetrics = {};
  for (const k of BATTLEMETRICS_PERMS) battlemetrics[k] = false;
  return { admin, transcripts, battlemetrics };
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
  if (input.battlemetrics && typeof input.battlemetrics === "object") {
    for (const k of BATTLEMETRICS_PERMS) out.battlemetrics[k] = !!input.battlemetrics[k];
    // Forward-migration: the old `viewSessions` (PII for IPs/Steam/hwid) is
    // collapsed into `viewIps` (only IPs gated; Steam/hwid move under viewPlayers).
    if (input.battlemetrics.viewSessions) out.battlemetrics.viewIps = true;
  }
  // Forward-migration of older flags that no longer exist:
  //   restricted.access   -> transcripts.restricted
  //   admin.viewIngameIps -> battlemetrics.viewIps
  if (input.restricted && typeof input.restricted === "object" && input.restricted.access) {
    out.transcripts.restricted = true;
  }
  if (input.admin && input.admin.viewIngameIps) {
    out.battlemetrics.viewIps = true;
  }
  return out;
}

module.exports = {
  ADMIN_TOOLS,
  TRANSCRIPT_PERMS,
  BATTLEMETRICS_PERMS,
  emptyPerms,
  normalizePerms
};
