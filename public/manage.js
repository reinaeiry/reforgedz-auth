const PERMS = {
  admin: [
    ["replay","Replay"],
    ["gmManagement","GM Management"],
    ["moderation","Moderation panel access (gate)"]
  ],
  transcripts: [
    ["read","View transcripts"],
    ["stats","Admin stats"],
    ["restricted","Access Restricted Transcripts"]
  ],
  moderation: [
    ["viewServers","View server status"],
    ["viewPlayers","View players (name, GUID, Steam, hardware IDs, sessions)"],
    ["viewIps","View IPs (BM + in-game logs) + manage IP bans"],
    ["viewActivity","View activity feed"],
    ["viewBans","View bans"],
    ["writeNotes","Write player notes"],
    ["kick","Kick players"],
    ["ban","Ban players"],
    ["manage","Manage banlists / triggers (v2)"]
  ]
};

// Per-server log gates. Each scope has only the log types that channel
// actually produces. Written into perms.moderation.logs[scope][type].
const LOG_SCOPES = {
  NA1: { label: "NA1 (kill + chat)", types: [["kill","Kill"],["chat","Chat"]] },
  NA2: { label: "NA2 (kill + chat)", types: [["kill","Kill"],["chat","Chat"]] },
  EU1: { label: "EU1 (kill + chat)", types: [["kill","Kill"],["chat","Chat"]] },
  EU2: { label: "EU2 (kill + chat)", types: [["kill","Kill"],["chat","Chat"]] },
  NA:  { label: "NA region (anticheat + shop)", types: [["anticheat","Anticheat"],["shop","Shop"]] },
  EU:  { label: "EU region (anticheat + shop)", types: [["anticheat","Anticheat"],["shop","Shop"]] },
  ALL: { label: "Global (base)", types: [["base","Base"]] }
};

const GROUPS = ["admin", "transcripts", "moderation"];

const state = {
  me: null,
  users: [],
  invitations: [],
  selectedId: null,
  filter: "",
  auditFilter: ""
};

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDate = (ms) => ms ? new Date(ms).toLocaleString() : "—";

function buildPermGrid(containerId, group, perms, prefix) {
  const c = $(containerId);
  c.innerHTML = "";
  const src = perms[group] || {};
  for (const [key, label] of PERMS[group]) {
    const id = `${prefix}_${group}_${key}`;
    const row = document.createElement("label");
    row.innerHTML = `<input type="checkbox" id="${id}" ${src[key] ? "checked" : ""}><span>${label}</span>`;
    c.appendChild(row);
  }
}

// Per-server logs grid — one row of checkboxes per scope.
function buildLogScopeGrid(containerId, perms, prefix) {
  const c = $(containerId);
  c.innerHTML = "";
  const logs = (perms.moderation && perms.moderation.logs) || {};
  for (const [scope, info] of Object.entries(LOG_SCOPES)) {
    const wrap = document.createElement("div");
    wrap.className = "log-scope-row";
    const head = document.createElement("div");
    head.className = "log-scope-label";
    head.textContent = info.label;
    wrap.appendChild(head);
    const grid = document.createElement("div");
    grid.className = "log-scope-types";
    for (const [type, typeLabel] of info.types) {
      const id = `${prefix}_logs_${scope}_${type}`;
      const lbl = document.createElement("label");
      const on = !!(logs[scope] && logs[scope][type]);
      lbl.innerHTML = `<input type="checkbox" id="${id}" ${on ? "checked" : ""}><span>${typeLabel}</span>`;
      grid.appendChild(lbl);
    }
    wrap.appendChild(grid);
    c.appendChild(wrap);
  }
}

function readPermGrid(prefix) {
  const out = { admin:{}, transcripts:{}, moderation:{} };
  out.moderation.logs = {};
  for (const group of GROUPS) {
    for (const [key] of PERMS[group]) {
      const el = $(`${prefix}_${group}_${key}`);
      out[group][key] = !!(el && el.checked);
    }
  }
  for (const [scope, info] of Object.entries(LOG_SCOPES)) {
    out.moderation.logs[scope] = {};
    for (const [type] of info.types) {
      const el = $(`${prefix}_logs_${scope}_${type}`);
      out.moderation.logs[scope][type] = !!(el && el.checked);
    }
  }
  return out;
}

function emptyPerms() {
  const out = { admin:{}, transcripts:{}, moderation:{} };
  out.moderation.logs = {};
  for (const group of GROUPS) {
    for (const [key] of PERMS[group]) out[group][key] = false;
  }
  for (const [scope, info] of Object.entries(LOG_SCOPES)) {
    out.moderation.logs[scope] = {};
    for (const [type] of info.types) out.moderation.logs[scope][type] = false;
  }
  return out;
}

async function loadMe() {
  const r = await fetch("/api/auth/me", { credentials: "include" });
  if (!r.ok) { location.href = "/login?return=" + encodeURIComponent(location.href); return; }
  const { user } = await r.json();
  if (!user.isManager) { location.href = "/account"; return; }
  state.me = user;
  $("who").textContent = user.username;
}

async function loadUsers() {
  const r = await fetch("/api/users", { credentials: "include" });
  if (!r.ok) return;
  const { users } = await r.json();
  state.users = users;
  renderUserList();
}

function userMatchesFilter(u, q) {
  if (!q) return true;
  q = q.toLowerCase();
  if (u.username.toLowerCase().includes(q)) return true;
  if ((u.email || "").toLowerCase().includes(q)) return true;
  for (const group of GROUPS) {
    const src = u.perms[group] || {};
    for (const [key,label] of PERMS[group]) {
      if (src[key] && label.toLowerCase().includes(q)) return true;
    }
  }
  // Match against any per-server log perm label too ("EU1", "kill", etc).
  const logs = (u.perms.moderation && u.perms.moderation.logs) || {};
  for (const [scope, info] of Object.entries(LOG_SCOPES)) {
    if (info.label.toLowerCase().includes(q)) {
      for (const [type] of info.types) {
        if (logs[scope] && logs[scope][type]) return true;
      }
    }
  }
  return false;
}

function renderUserList() {
  const tbody = $("usersBody");
  tbody.innerHTML = "";
  const filtered = state.users.filter((u) => userMatchesFilter(u, state.filter));
  for (const u of filtered) {
    const tr = document.createElement("tr");
    if (u.id === state.selectedId) tr.classList.add("selected");
    tr.innerHTML = `
      <td><strong>${esc(u.username)}</strong></td>
      <td style="color:var(--text-dim)">${esc(u.email || "")}</td>
      <td>${u.isManager ? '<span class="chip mgr">Manager</span>' : '<span class="chip">Staff</span>'}</td>
      <td>${u.suspended ? '<span class="chip susp">Suspended</span>' : (u.hasPassword ? '<span class="chip on">Active</span>' : '<span class="chip">Pending</span>')}</td>
      <td style="color:var(--text-dim)">${fmtDate(u.lastLoginAt)}</td>
    `;
    tr.addEventListener("click", () => selectUser(u.id));
    tbody.appendChild(tr);
  }
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-ghost);padding:24px">No users.</td></tr>`;
  }
}

function selectUser(id) {
  state.selectedId = id;
  hide($("linkBox"));
  hide($("editorErr"));
  hide($("editorOk"));
  const u = state.users.find((x) => x.id === id);
  if (!u) return;
  $("editorTitle").textContent = `Edit · ${u.username}`;
  show($("editorBody"));
  $("eu").value = u.username;
  $("eemail").value = u.email || "";
  $("emgr").checked = u.isManager;
  $("esusp").checked = u.suspended;
  buildPermGrid("permAdmin", "admin", u.perms, "u");
  buildPermGrid("permTranscripts", "transcripts", u.perms, "u");
  buildPermGrid("permModeration", "moderation", u.perms, "u");
  buildLogScopeGrid("permModerationLogs", u.perms, "u");
  renderUserList();
}

function showLink(boxId, codeId, url, label) {
  $(codeId).textContent = url;
  const box = $(boxId);
  box.querySelector("div").textContent = label;
  show(box);
}

function showEditorErr(msg) { $("editorErr").textContent = msg; show($("editorErr")); hide($("editorOk")); }
function showEditorOk(msg) { $("editorOk").textContent = msg; show($("editorOk")); hide($("editorErr")); }

async function saveUser() {
  if (!state.selectedId) return;
  hide($("editorErr"));
  hide($("editorOk"));
  const perms = readPermGrid("u");
  const body = {
    email: $("eemail").value.trim() || null,
    isManager: $("emgr").checked,
    suspended: $("esusp").checked,
    perms
  };
  const r = await fetch(`/api/users/${state.selectedId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const map = {
      cannot_demote_self: "You can't demote your own manager role.",
      cannot_suspend_self: "You can't suspend yourself.",
      email_required: "A valid email is required."
    };
    return showEditorErr(map[d.error] || "Could not save changes.");
  }
  await loadUsers();
  selectUser(state.selectedId);
  showEditorOk("Saved.");
}

async function resetPassword() {
  if (!state.selectedId) return;
  const r = await fetch(`/api/users/${state.selectedId}/reset`, { method: "POST", credentials: "include" });
  if (!r.ok) return showEditorErr("Could not generate reset link.");
  const data = await r.json();
  const msg = data.emailed
    ? "Reset email sent. Backup one-time link below."
    : "Reset link (no email on file — share via Discord / DM):";
  showLink("linkBox", "oneTimeLink", data.resetUrl, msg);
}

async function revokeSessions() {
  if (!state.selectedId) return;
  if (!confirm("Revoke all active sessions for this user? They'll be signed out everywhere within ~60s.")) return;
  const r = await fetch(`/api/users/${state.selectedId}/revoke`, { method: "POST", credentials: "include" });
  if (!r.ok) return showEditorErr("Could not revoke sessions.");
  await loadUsers();
  selectUser(state.selectedId);
  showEditorOk("Sessions revoked.");
}

async function deleteUser() {
  if (!state.selectedId) return;
  const u = state.users.find((x) => x.id === state.selectedId);
  if (!u) return;
  if (!confirm(`Permanently delete '${u.username}'? Cannot be undone.`)) return;
  const r = await fetch(`/api/users/${state.selectedId}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    return showEditorErr(d.error === "cannot_delete_self" ? "You can't delete your own account." : "Could not delete.");
  }
  state.selectedId = null;
  hide($("editorBody"));
  $("editorTitle").textContent = "Select a user";
  await loadUsers();
}

// ─── Invitations ─────────────────────────────────────────────────────────────

async function loadInvitations() {
  const r = await fetch("/api/users/invites/list", { credentials: "include" });
  if (!r.ok) return;
  const data = await r.json();
  state.invitations = data.invitations;
  renderInvitesList();
}

function renderInvitesList() {
  const tbody = $("invitesBody");
  tbody.innerHTML = "";
  if (state.invitations.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-ghost);padding:24px">No invitations yet.</td></tr>`;
    return;
  }
  for (const inv of state.invitations) {
    const statusChip = inv.status === "pending"
      ? '<span class="chip on">Pending</span>'
      : inv.status === "redeemed"
        ? `<span class="chip">Redeemed by ${esc(inv.consumedUsername || "?")}</span>`
        : '<span class="chip susp">Expired</span>';
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(inv.label || "(no label)")}</td>
      <td>${inv.isManager ? '<span class="chip mgr">Manager</span>' : '<span class="chip">Staff</span>'}</td>
      <td>${statusChip}</td>
      <td style="color:var(--text-dim)">${fmtDate(inv.createdAt)}<br><small style="color:var(--text-ghost)">by ${esc(inv.createdByUsername || "—")}</small></td>
      <td style="color:var(--text-dim)">${fmtDate(inv.expiresAt)}
        ${inv.status === "pending" ? `<button class="btn sm ghost" data-revoke="${inv.id}" style="margin-left:8px">Revoke</button>` : ""}
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button[data-revoke]").forEach((b) => {
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = b.getAttribute("data-revoke");
      if (!confirm("Revoke this invitation link?")) return;
      await fetch(`/api/users/invites/${id}`, { method: "DELETE", credentials: "include" });
      await loadInvitations();
    });
  });
}

function startNewInvite() {
  hide($("inviteLinkBox"));
  hide($("inviteErr"));
  $("iLabel").value = "";
  $("iMgr").checked = false;
  const empty = emptyPerms();
  buildPermGrid("iPermAdmin", "admin", empty, "i");
  buildPermGrid("iPermTranscripts", "transcripts", empty, "i");
  buildPermGrid("iPermModeration", "moderation", empty, "i");
  buildLogScopeGrid("iPermModerationLogs", empty, "i");
}

async function createInvite() {
  hide($("inviteLinkBox"));
  hide($("inviteErr"));
  const perms = readPermGrid("i");
  const r = await fetch("/api/users/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      label: $("iLabel").value.trim() || null,
      isManager: $("iMgr").checked,
      perms
    })
  });
  if (!r.ok) {
    $("inviteErr").textContent = "Could not create invitation.";
    show($("inviteErr"));
    return;
  }
  const data = await r.json();
  showLink("inviteLinkBox", "inviteLink", data.inviteUrl, `Invite link (valid ${data.ttlHours}h):`);
  await loadInvitations();
}

// ─── Audit log ───────────────────────────────────────────────────────────────

async function loadAudit() {
  const params = new URLSearchParams({ limit: 200 });
  if (state.auditFilter) params.set("search", state.auditFilter);
  const r = await fetch("/api/audit?" + params, { credentials: "include" });
  if (!r.ok) return;
  const { entries } = await r.json();
  const list = $("auditList");
  list.innerHTML = "";
  if (entries.length === 0) {
    list.innerHTML = `<div style="color:var(--text-ghost);text-align:center;padding:24px">No audit entries.</div>`;
    return;
  }
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "audit-row";
    const detail = e.detail
      ? Object.entries(e.detail).map(([k,v]) => `${esc(k)}=${esc(typeof v === "object" ? JSON.stringify(v) : String(v))}`).join(" ")
      : "";
    const meta = [];
    if (e.ip) meta.push(`<code>${esc(e.ip)}</code>`);
    if (e.geo_label) meta.push(esc(e.geo_label));
    if (e.device_label) meta.push(esc(e.device_label));
    row.innerHTML = `
      <div class="when">${fmtDate(e.at)}</div>
      <div class="who">${esc(e.actor_username || "—")}</div>
      <div class="what">
        <strong>${esc(e.action)}</strong>
        ${e.target_username && e.target_username !== e.actor_username ? ` → ${esc(e.target_username)}` : ""}
        ${detail ? `<div style="color:var(--text-ghost);font-size:.78rem;margin-top:2px">${detail}</div>` : ""}
        ${meta.length ? `<div style="color:var(--text-dim);font-size:.78rem;margin-top:2px">${meta.join(" · ")}</div>` : ""}
      </div>
    `;
    list.appendChild(row);
  }
}

// ─── Wire-up ─────────────────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const tab = t.dataset.tab;
      $("tab-users").classList.toggle("hidden", tab !== "users");
      $("tab-invites").classList.toggle("hidden", tab !== "invites");
      $("tab-audit").classList.toggle("hidden", tab !== "audit");
      if (tab === "audit") loadAudit();
      if (tab === "invites") loadInvitations();
    });
  });
}

function setupBindings() {
  $("reloadBtn").addEventListener("click", loadUsers);
  $("auditReload").addEventListener("click", loadAudit);
  $("filter").addEventListener("input", (e) => { state.filter = e.target.value; renderUserList(); });
  $("auditFilter").addEventListener("input", (e) => { state.auditFilter = e.target.value; loadAudit(); });
  $("saveBtn").addEventListener("click", saveUser);
  $("resetBtn").addEventListener("click", resetPassword);
  $("revokeBtn").addEventListener("click", revokeSessions);
  $("deleteBtn").addEventListener("click", deleteUser);
  $("newInviteBtn").addEventListener("click", startNewInvite);
  $("createInviteBtn").addEventListener("click", createInvite);
  $("reloadInvites").addEventListener("click", loadInvitations);
  $("copyLink").addEventListener("click", () => copyText($("oneTimeLink").textContent, $("copyLink")));
  $("copyInviteLink").addEventListener("click", () => copyText($("inviteLink").textContent, $("copyInviteLink")));
  $("logout").addEventListener("click", async (e) => {
    e.preventDefault();
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    location.href = "/login";
  });
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch {}
}

(async function init() {
  setupTabs();
  setupBindings();
  await loadMe();
  await loadUsers();
  startNewInvite();
})();
