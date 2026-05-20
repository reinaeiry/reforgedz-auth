const ADMIN_TOOLS = [
  "replay",
  "gmManagement"
];

const TRANSCRIPT_PERMS = ["read", "stats", "restricted"];

function emptyPerms() {
  const admin = {};
  for (const k of ADMIN_TOOLS) admin[k] = false;
  const transcripts = {};
  for (const k of TRANSCRIPT_PERMS) transcripts[k] = false;
  return { admin, transcripts };
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
  // Migration: an older record may still have restricted.access set under a
  // top-level "restricted" group. Map it forward so existing managers don't
  // have to re-grant it manually after the perm rename.
  if (input.restricted && typeof input.restricted === "object" && input.restricted.access) {
    out.transcripts.restricted = true;
  }
  return out;
}

module.exports = {
  ADMIN_TOOLS,
  TRANSCRIPT_PERMS,
  emptyPerms,
  normalizePerms
};
