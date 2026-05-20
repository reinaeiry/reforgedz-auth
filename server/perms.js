const ADMIN_TOOLS = [
  "replay",
  "gmManagement",
  // Reserved for the future ingame-logs merge into /player/:guid — see plan.
  "viewIngameIps"
];

const TRANSCRIPT_PERMS = ["read", "stats", "restricted"];

const BATTLEMETRICS_PERMS = [
  "viewServers",
  "viewPlayers",
  "viewSessions",
  "viewChat",
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
  }
  // Forward-migration of the older restricted.access → transcripts.restricted.
  if (input.restricted && typeof input.restricted === "object" && input.restricted.access) {
    out.transcripts.restricted = true;
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
