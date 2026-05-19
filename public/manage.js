const PERMS = {
  admin: [
    ["replay","Replay"],["players","Players"],["bans","Bans"],["mutes","Mutes"],
    ["events","Events"],["health","Health"],["playerLookup","Player Lookup"],
    ["pii","PII"],["gmManagement","GM Management"],["dev","Dev"],["admin","Admin tools"]
  ],
  transcripts: [
    ["read","View transcripts"],
    ["delete","Delete transcripts"],
    ["appeals","Ban appeal transcripts"]
  ],
  restricted: [
    ["access","Restricted area"]
  ]
};

const state = {
  me: null,
  users: [],
  selectedId: null,
  isNew: false,
  filter: ""
};

function $(id) { return document.getElementById(id); }
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function buildPermGrid(containerId, group, perms) {
  const c = $(containerId);
  c.innerHTML = "";
  for (const [key, label] of PERMS[group]) {
    const id = `p_${group}_${key}`;
    const row = document.createElement("label");
    row.innerHTML = `<input type="checkbox" id="${id}" ${perms[group] && perms[group][key] ? "checked" : ""}><span>${label}</span>`;
    c.appendChild(row);
  }
}

function readPermGrid() {
  const out = { admin:{}, transcripts:{}, restricted:{} };
  for (const group of ["admin","transcripts","restricted"]) {
    for (const [key] of PERMS[group]) {
      out[group][key] = $(`p_${group}_${key}`).checked;
    }
  }
  return out;
}

function emptyPerms() {
  const out = { admin:{}, transcripts:{}, restricted:{} };
  for (const group of ["admin","transcripts","restricted"]) {
    for (const [key] of PERMS[group]) out[group][key] = false;
  }
  return out;
}

function fmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString();
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
  for (const group of ["admin","transcripts","restricted"]) {
    for (const [key,label] of PERMS[group]) {
      if (u.perms[group] && u.perms[group][key] && label.toLowerCase().includes(q)) return true;
    }
  }
  return false;
}

function renderUserList() {
  const tbody = $("usersBody");
  tbody.innerHTML = "";
  const filtered = state.users.filter(u => userMatchesFilter(u, state.filter));
  for (const u of filtered) {
    const tr = document.createElement("tr");
    if (u.id === state.selectedId) tr.classList.add("selected");
    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(u.username)}</strong>
        ${u.email ? `<div style="color:var(--text-ghost);font-size:.75rem">${escapeHtml(u.email)}</div>` : ""}
      </td>
      <td>${u.isManager ? '<span class="chip mgr">Manager</span>' : '<span class="chip">Staff</span>'}</td>
      <td>${u.suspended ? '<span class="chip susp">Suspended</span>' : (u.hasPassword ? '<span class="chip on">Active</span>' : '<span class="chip">Pending setup</span>')}</td>
      <td style="color:var(--text-dim)">${fmtDate(u.lastLoginAt)}</td>
    `;
    tr.addEventListener("click", () => selectUser(u.id));
    tbody.appendChild(tr);
  }
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-ghost);padding:24px">No users.</td></tr>`;
  }
}

function selectUser(id) {
  state.selectedId = id;
  state.isNew = false;
  hide($("linkBox"));
  hide($("editorErr"));
  hide($("editorOk"));
  const u = state.users.find(x => x.id === id);
  if (!u) return;
  $("editorTitle").textContent = `Edit · ${u.username}`;
  show($("editorBody"));
  $("eu").value = u.username;
  $("eu").disabled = true;
  $("eemail").value = u.email || "";
  $("emgr").checked = u.isManager;
  $("esusp").checked = u.suspended;
  buildPermGrid("permAdmin", "admin", u.perms);
  buildPermGrid("permTranscripts", "transcripts", u.perms);
  buildPermGrid("permRestricted", "restricted", u.perms);
  renderUserList();
}

function startNew() {
  state.selectedId = null;
  state.isNew = true;
  hide($("linkBox"));
  hide($("editorErr"));
  hide($("editorOk"));
  $("editorTitle").textContent = "New user";
  show($("editorBody"));
  $("eu").value = "";
  $("eu").disabled = false;
  $("eemail").value = "";
  $("emgr").checked = false;
  $("esusp").checked = false;
  const empty = emptyPerms();
  buildPermGrid("permAdmin", "admin", empty);
  buildPermGrid("permTranscripts", "transcripts", empty);
  buildPermGrid("permRestricted", "restricted", empty);
  renderUserList();
}

function showLink(url, label) {
  $("oneTimeLink").textContent = url;
  const box = $("linkBox");
  box.querySelector("div").textContent = label || "One-time link (share via Discord / DM):";
  show(box);
}

function showEditorErr(msg) {
  $("editorErr").textContent = msg;
  show($("editorErr"));
  hide($("editorOk"));
}
function showEditorOk(msg) {
  $("editorOk").textContent = msg;
  show($("editorOk"));
  hide($("editorErr"));
}

async function saveUser() {
  hide($("editorErr"));
  hide($("editorOk"));
  hide($("linkBox"));
  const perms = readPermGrid();
  const body = {
    email: $("eemail").value.trim() || null,
    isManager: $("emgr").checked,
    suspended: $("esusp").checked,
    perms
  };
  if (state.isNew) {
    body.username = $("eu").value.trim();
    if (!body.username) return showEditorErr("Username is required.");
    const r = await fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const d = await r.json().catch(()=>({}));
      const map = {
        invalid_username: "Username must be 2-32 chars, letters/digits/._- only.",
        username_taken: "That username is already in use."
      };
      return showEditorErr(map[d.error] || "Could not create user.");
    }
    const data = await r.json();
    await loadUsers();
    selectUser(data.user.id);
    showLink(data.setupUrl, "Setup link (valid 24h). Send to the user via Discord or DM.");
    showEditorOk(`Created '${data.user.username}'. Share the setup link below.`);
  } else if (state.selectedId) {
    const r = await fetch(`/api/users/${state.selectedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const d = await r.json().catch(()=>({}));
      const map = {
        cannot_demote_self: "You can't demote your own manager role.",
        cannot_suspend_self: "You can't suspend yourself."
      };
      return showEditorErr(map[d.error] || "Could not save changes.");
    }
    await loadUsers();
    selectUser(state.selectedId);
    showEditorOk("Saved.");
  }
}

async function setupLink() {
  if (!state.selectedId) return;
  const r = await fetch(`/api/users/${state.selectedId}/setup-link`, {
    method: "POST",
    credentials: "include"
  });
  if (!r.ok) return showEditorErr("Could not generate setup link.");
  const data = await r.json();
  showLink(data.setupUrl, "New setup link (any prior setup link is now invalid). Share via Discord or DM.");
}

async function resetPassword() {
  if (!state.selectedId) return;
  const r = await fetch(`/api/users/${state.selectedId}/reset`, {
    method: "POST",
    credentials: "include"
  });
  if (!r.ok) return showEditorErr("Could not generate reset link.");
  const data = await r.json();
  const msg = data.emailed
    ? "Reset email sent. Backup one-time link below."
    : "Reset link (no email on file — share via Discord / DM):";
  showLink(data.resetUrl, msg);
}

async function revokeSessions() {
  if (!state.selectedId) return;
  if (!confirm("Revoke all active sessions for this user? They will be signed out everywhere within ~60s.")) return;
  const r = await fetch(`/api/users/${state.selectedId}/revoke`, {
    method: "POST",
    credentials: "include"
  });
  if (!r.ok) return showEditorErr("Could not revoke sessions.");
  await loadUsers();
  selectUser(state.selectedId);
  showEditorOk("Sessions revoked.");
}

async function deleteUser() {
  if (!state.selectedId) return;
  const u = state.users.find(x => x.id === state.selectedId);
  if (!u) return;
  if (!confirm(`Permanently delete user '${u.username}'? This cannot be undone.`)) return;
  const r = await fetch(`/api/users/${state.selectedId}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!r.ok) {
    const d = await r.json().catch(()=>({}));
    return showEditorErr(d.error === "cannot_delete_self" ? "You can't delete your own account." : "Could not delete user.");
  }
  state.selectedId = null;
  hide($("editorBody"));
  $("editorTitle").textContent = "Select a user";
  await loadUsers();
}

async function loadAudit() {
  const r = await fetch("/api/audit?limit=200", { credentials: "include" });
  if (!r.ok) return;
  const { entries } = await r.json();
  const list = $("auditList");
  list.innerHTML = "";
  if (entries.length === 0) {
    list.innerHTML = `<div style="color:var(--text-ghost);text-align:center;padding:24px">No audit entries yet.</div>`;
    return;
  }
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "audit-row";
    const detail = e.detail ? Object.entries(e.detail).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(" ") : "";
    row.innerHTML = `
      <div class="when">${fmtDate(e.at)}</div>
      <div class="who">${escapeHtml(e.actor_username || "—")}</div>
      <div class="what">
        <strong>${escapeHtml(e.action)}</strong>
        ${e.target_username ? ` → ${escapeHtml(e.target_username)}` : ""}
        ${detail ? `<span style="color:var(--text-ghost);margin-left:6px">${escapeHtml(detail)}</span>` : ""}
      </div>
    `;
    list.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      const tab = t.dataset.tab;
      $("tab-users").classList.toggle("hidden", tab !== "users");
      $("tab-audit").classList.toggle("hidden", tab !== "audit");
      if (tab === "audit") loadAudit();
    });
  });
}

function setupBindings() {
  $("newBtn").addEventListener("click", startNew);
  $("reloadBtn").addEventListener("click", loadUsers);
  $("auditReload").addEventListener("click", loadAudit);
  $("filter").addEventListener("input", (e) => { state.filter = e.target.value; renderUserList(); });
  $("saveBtn").addEventListener("click", saveUser);
  $("setupLinkBtn").addEventListener("click", setupLink);
  $("resetBtn").addEventListener("click", resetPassword);
  $("revokeBtn").addEventListener("click", revokeSessions);
  $("deleteBtn").addEventListener("click", deleteUser);
  $("copyLink").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("oneTimeLink").textContent);
      $("copyLink").textContent = "Copied";
      setTimeout(() => { $("copyLink").textContent = "Copy"; }, 1500);
    } catch {}
  });
  $("logout").addEventListener("click", async (e) => {
    e.preventDefault();
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    location.href = "/login";
  });
}

(async function init() {
  setupTabs();
  setupBindings();
  await loadMe();
  await loadUsers();
})();
