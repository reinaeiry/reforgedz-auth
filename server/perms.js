// Admin-tools gate: each entry is a top-level access toggle for a sub-app.
// `moderation` is required to even SEE the moderation tab (player tools,
// bans, IP bans, servers, logs); the individual capabilities live below.
const ADMIN_TOOLS = [
  "replay",
  "gmManagement",
  "moderation"
];

const TRANSCRIPT_PERMS = ["read", "stats", "restricted"];

// `viewIps` is the single PII gate: BM IPs + in-game-log IPs + IP-ban CRUD.
// Steam IDs, hardware IDs, and session history are surfaced under viewPlayers.
// Was `battlemetrics` in the old shape — renamed to avoid confusion with the
// BM external service. JWT shape preserves the old key for back-compat
// (forward-migrated by normalizePerms).
const MODERATION_PERMS = [
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

// Per-log-type filters live under moderation.logs.* — gated independently
// so e.g. a junior mod can see kill/death/chat but not anticheat or base.
const LOG_LEVEL_PERMS = ["kill", "death", "anticheat", "shop", "chat", "base"];

function emptyPerms() {
  const admin = {};
  for (const k of ADMIN_TOOLS) admin[k] = false;
  const transcripts = {};
  for (const k of TRANSCRIPT_PERMS) transcripts[k] = false;
  const moderation = {};
  for (const k of MODERATION_PERMS) moderation[k] = false;
  moderation.logs = {};
  for (const k of LOG_LEVEL_PERMS) moderation.logs[k] = false;
  return { admin, transcripts, moderation };
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
  // Read moderation directly, or forward-migrate from the legacy
  // `battlemetrics` key. Anything we set in both wins on the new side.
  const modSrc = (input.moderation && typeof input.moderation === "object")
    ? input.moderation
    : (input.battlemetrics && typeof input.battlemetrics === "object")
      ? input.battlemetrics
      : null;
  if (modSrc) {
    for (const k of MODERATION_PERMS) out.moderation[k] = !!modSrc[k];
    // Older flag `viewSessions` collapsed into `viewIps`.
    if (modSrc.viewSessions) out.moderation.viewIps = true;
    if (modSrc.logs && typeof modSrc.logs === "object") {
      for (const k of LOG_LEVEL_PERMS) out.moderation.logs[k] = !!modSrc.logs[k];
    }
    // If user has viewActivity but no granular log perms yet, grant all.
    // Mirrors the prior behaviour where viewActivity was the only gate.
    if (modSrc.viewActivity && !modSrc.logs) {
      for (const k of LOG_LEVEL_PERMS) out.moderation.logs[k] = true;
    }
  }
  // Forward-migration of older flags that no longer exist:
  //   restricted.access   -> transcripts.restricted
  //   admin.viewIngameIps -> moderation.viewIps
  if (input.restricted && typeof input.restricted === "object" && input.restricted.access) {
    out.transcripts.restricted = true;
  }
  if (input.admin && input.admin.viewIngameIps) {
    out.moderation.viewIps = true;
  }
  // If a user has ANY moderation perm but no admin.moderation gate set,
  // grant the gate automatically so existing users don't lose access.
  if (!out.admin.moderation) {
    const anyMod = MODERATION_PERMS.some((k) => out.moderation[k]) ||
                   LOG_LEVEL_PERMS.some((k) => out.moderation.logs[k]);
    if (anyMod) out.admin.moderation = true;
  }
  return out;
}

module.exports = {
  ADMIN_TOOLS,
  TRANSCRIPT_PERMS,
  MODERATION_PERMS,
  LOG_LEVEL_PERMS,
  // Back-compat alias (some imports may still reach for this).
  BATTLEMETRICS_PERMS: MODERATION_PERMS,
  emptyPerms,
  normalizePerms
};
