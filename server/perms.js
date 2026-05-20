// Admin-tools gate: each entry is a top-level access toggle for a sub-app.
// `moderation` is required to even SEE the moderation tab (player tools,
// bans, IP bans, servers, logs); the individual capabilities live below.
const ADMIN_TOOLS = [
  "replay",
  "gmManagement",
  "moderation",
  "tickets"
];

const TRANSCRIPT_PERMS = ["read", "stats", "restricted"];

// `viewIps` is the single PII gate: BM IPs + in-game-log IPs + IP-ban CRUD.
// Steam IDs, hardware IDs, and session history are surfaced under viewPlayers.
const MODERATION_PERMS = [
  "viewServers",
  "viewPlayers",
  "viewIps",
  "viewActivity",
  "viewBans",
  "writeNotes",
  "kick",
  "ban",
  "manage",
  // In-game bans/mutes are read from / written to each game-server's
  // ReforgedZBans.json / ReforgedZMutes.json over SSH. Distinct from
  // BattleMetrics bans (covered by `ban` above).
  "viewIngameBans",
  "editIngameBans",
  "viewIngameMutes",
  "editIngameMutes"
];

// Log perms are scoped per game-server because the Discord channels carry
// different log volumes per server:
//   NA1/NA2/EU1/EU2 — per-server kill + chat logs
//   NA, EU         — region-wide anticheat + shop logs (one channel each)
//   ALL            — global base log (one channel, all servers)
//
// A user with only EU1 staff role can be granted scope=EU1 (kill/chat) only,
// or also scope=EU (anticheat/shop) if they handle moderation across both
// EU servers, etc.
// Ticket categories — one boolean per Discord ticket type. A user with
// only `tickets.na1 = true` only sees NA1 Support tickets in the relay tab.
// Closing requires `manager` or `moderation.manage`, not a separate perm.
const TICKET_CATEGORIES = [
  "devApplications",
  "gmApplications",
  "banAppeals",
  "na1",
  "na2",
  "eu1",
  "eu2",
  "shopSupport",
  "managementSupport"
];

const LOG_SCOPES = {
  NA1: ["kill", "chat"],
  NA2: ["kill", "chat"],
  EU1: ["kill", "chat"],
  EU2: ["kill", "chat"],
  NA:  ["anticheat", "shop"],
  EU:  ["anticheat", "shop"],
  ALL: ["base"]
};
const LOG_SCOPE_KEYS = Object.keys(LOG_SCOPES);

function emptyPerms() {
  const admin = {};
  for (const k of ADMIN_TOOLS) admin[k] = false;
  const transcripts = {};
  for (const k of TRANSCRIPT_PERMS) transcripts[k] = false;
  const moderation = {};
  for (const k of MODERATION_PERMS) moderation[k] = false;
  moderation.logs = {};
  for (const scope of LOG_SCOPE_KEYS) {
    moderation.logs[scope] = {};
    for (const t of LOG_SCOPES[scope]) moderation.logs[scope][t] = false;
  }
  const tickets = {};
  for (const cat of TICKET_CATEGORIES) tickets[cat] = false;
  return { admin, transcripts, moderation, tickets };
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
  // `battlemetrics` key.
  const modSrc = (input.moderation && typeof input.moderation === "object")
    ? input.moderation
    : (input.battlemetrics && typeof input.battlemetrics === "object")
      ? input.battlemetrics
      : null;
  if (modSrc) {
    for (const k of MODERATION_PERMS) out.moderation[k] = !!modSrc[k];
    if (modSrc.viewSessions) out.moderation.viewIps = true;

    const logsSrc = (modSrc.logs && typeof modSrc.logs === "object") ? modSrc.logs : null;
    if (logsSrc) {
      // Detect whether the old flat shape was used (logs.kill, logs.chat, ...)
      // or the new nested per-scope shape (logs.NA1.kill, ...).
      const flatTypes = ["kill", "death", "anticheat", "shop", "chat", "base"];
      const looksFlat = flatTypes.some((t) => typeof logsSrc[t] === "boolean");
      if (looksFlat) {
        for (const scope of LOG_SCOPE_KEYS) {
          for (const t of LOG_SCOPES[scope]) {
            out.moderation.logs[scope][t] = !!logsSrc[t];
          }
        }
      } else {
        for (const scope of LOG_SCOPE_KEYS) {
          const srcScope = logsSrc[scope] || {};
          for (const t of LOG_SCOPES[scope]) out.moderation.logs[scope][t] = !!srcScope[t];
        }
      }
    } else if (modSrc.viewActivity) {
      // No granular log perms set yet — fall back to viewActivity granting all.
      for (const scope of LOG_SCOPE_KEYS) {
        for (const t of LOG_SCOPES[scope]) out.moderation.logs[scope][t] = true;
      }
    }
  }
  if (input.restricted && typeof input.restricted === "object" && input.restricted.access) {
    out.transcripts.restricted = true;
  }
  if (input.admin && input.admin.viewIngameIps) {
    out.moderation.viewIps = true;
  }
  if (!out.admin.moderation) {
    let anyMod = MODERATION_PERMS.some((k) => out.moderation[k]);
    if (!anyMod) {
      for (const scope of LOG_SCOPE_KEYS) {
        for (const t of LOG_SCOPES[scope]) if (out.moderation.logs[scope][t]) { anyMod = true; break; }
        if (anyMod) break;
      }
    }
    if (anyMod) out.admin.moderation = true;
  }

  // Tickets — read the per-category booleans.
  if (input.tickets && typeof input.tickets === "object") {
    for (const cat of TICKET_CATEGORIES) out.tickets[cat] = !!input.tickets[cat];
  }
  // Auto-grant the admin.tickets gate when any category is enabled,
  // so existing data stays consistent without explicit re-saves.
  if (!out.admin.tickets && TICKET_CATEGORIES.some((cat) => out.tickets[cat])) {
    out.admin.tickets = true;
  }
  return out;
}

module.exports = {
  ADMIN_TOOLS,
  TRANSCRIPT_PERMS,
  MODERATION_PERMS,
  LOG_SCOPES,
  LOG_SCOPE_KEYS,
  TICKET_CATEGORIES,
  BATTLEMETRICS_PERMS: MODERATION_PERMS,
  emptyPerms,
  normalizePerms
};
