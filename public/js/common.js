// common.js — shared across every role page.
//
// IMPORTANT (this is the fix for the "page blinking constantly" bug):
// Never do `document.body.innerHTML = ...` or full page reloads on a poll
// timer. Every polling function below re-renders ONLY the specific
// container it owns, and only replaces it if the underlying data actually
// changed shape. That's what stops the flicker — full-DOM replacement on
// every tick is almost always the cause.

const API = {
  base: "",
  token: () => localStorage.getItem("hqr_token"),
  session: () => {
    try { return JSON.parse(localStorage.getItem("hqr_session") || "null"); }
    catch { return null; }
  },
  async call(path, { method = "GET", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    const t = API.token();
    if (t) headers["Authorization"] = `Bearer ${t}`;
    const res = await fetch(API.base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "request_failed"), { data, status: res.status });
    return data;
  },
};

function requireSession(expectedRole) {
  const s = API.session();
  if (!s || !API.token()) {
    window.location.href = "/index.html";
    return null;
  }
  if (expectedRole && s.role !== expectedRole) {
    window.location.href = "/index.html";
    return null;
  }
  return s;
}

function logout() {
  localStorage.removeItem("hqr_token");
  localStorage.removeItem("hqr_session");
  window.location.href = "/index.html";
}

function fmtTime(iso) {
  if (!iso) return "—";
  // SQLite datetime('now') strings ("YYYY-MM-DD HH:MM:SS") are UTC; planned exit times are local.
  const isSqlUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso);
  const d = new Date(isSqlUtc ? iso.replace(" ", "T") + "Z" : iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusBadge(status) {
  const label = status.replace(/_/g, " ");
  return `<span class="badge ${status}">${label}</span>`;
}

function riskBadge(flag) {
  if (!flag) return "";
  return `<span class="badge risk-${flag}">risk: ${flag}</span>`;
}

// ---- Notifications: targeted update, no page-level re-render ----
let _lastNotifSignature = "";

async function pollNotifications(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  try {
    const rows = await API.call("/api/notifications");
    const signature = rows.map((r) => `${r.id}:${r.read}`).join(",");
    if (signature === _lastNotifSignature) return; // nothing changed — skip re-render entirely
    _lastNotifSignature = signature;

    if (rows.length === 0) {
      el.innerHTML = `<div class="empty">No notifications yet.</div>`;
      return;
    }
    el.innerHTML = rows
      .map(
        (r) => `<div class="notif ${r.read ? "" : "unread"}">${escapeHtml(r.message)}
          <div class="small-muted">${fmtTime(r.ts)}</div></div>`
      )
      .join("");
  } catch (e) {
    // Silent fail on a poll tick — don't blast the UI with errors every 5s.
    console.warn("notification poll failed", e);
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function startTopbarClock() {
  // purely cosmetic — proves polling doesn't need to nuke the DOM
}

// ---- Shared UI: reject-reason dialog + request timeline modal ----
function openModal(innerHtml) {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  return { root: back.firstElementChild, close };
}

const REJECT_CHIPS = {
  warden: ["Too late at night", "Destination not permitted", "Too many outings this week", "Exams / academics", "Incomplete details", "Safety concern"],
  parent: ["Not comfortable with the plan", "Family commitment", "Safety concern", "Studies first"],
};

// Resolves with the reason string, or null if cancelled.
function askRejectReason({ required = false, chips = REJECT_CHIPS.warden } = {}) {
  return new Promise((resolve) => {
    const { root, close } = openModal(`
      <h3>Reject request</h3>
      <div class="small-muted">${required ? "A reason is required — the student will see it." : "Optional — the student will see it."}</div>
      <div class="chips">${chips.map((c) => `<button type="button" class="chip secondary">${escapeHtml(c)}</button>`).join("")}</div>
      <textarea id="rejectText" maxlength="300" placeholder="Add details…"></textarea>
      <div class="error-msg" id="rejectErr"></div>
      <div class="row" style="margin-top:12px;justify-content:flex-end;">
        <button type="button" class="secondary" id="rejectCancel">Cancel</button>
        <button type="button" class="danger" id="rejectOk">Reject</button>
      </div>`);
    const text = root.querySelector("#rejectText");
    const err = root.querySelector("#rejectErr");
    let done = false;
    const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
    root.querySelectorAll(".chip").forEach((c) =>
      c.addEventListener("click", () => { text.value = c.textContent; text.focus(); })
    );
    root.querySelector("#rejectCancel").addEventListener("click", () => finish(null));
    root.querySelector("#rejectOk").addEventListener("click", () => {
      const v = text.value.trim();
      if (required && v.length < 3) { err.textContent = "Please give a reason (at least 3 characters)."; return; }
      finish(v);
    });
    // Closing via Esc / backdrop removes the node without resolving: treat as cancel.
    new MutationObserver((_, o) => { if (!document.body.contains(root)) { o.disconnect(); finish(null); } })
      .observe(document.body, { childList: true });
    text.focus();
  });
}

async function showTimeline(requestId) {
  const { root } = openModal(`<h3>Request #${requestId}</h3><div class="empty">Loading…</div>`);
  try {
    const d = await API.call(`/api/requests/${requestId}/timeline`);
    const reasons = d.risk.reasons.length
      ? `<ul class="risk-list">${d.risk.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : "";
    root.innerHTML = `
      <h3>Request #${d.id} ${statusBadge(d.status)}</h3>
      <div class="tl-risk">${riskBadge(d.risk.flag)} <span class="small-muted">score ${d.risk.score ?? 0}</span>${reasons}</div>
      <ol class="tl">${d.events.map((e) => `
        <li class="tl-${e.tone}"><div class="tl-title">${escapeHtml(e.title)}</div>
          ${e.detail ? `<div class="tl-detail">${escapeHtml(e.detail)}</div>` : ""}
          <div class="small-muted">${fmtTime(e.ts)}</div></li>`).join("")}</ol>
      <div class="row" style="justify-content:flex-end;"><button class="secondary" id="tlClose">Close</button></div>`;
    root.querySelector("#tlClose").addEventListener("click", () => root.parentElement.remove());
  } catch (e) {
    root.innerHTML = `<h3>Request #${requestId}</h3><div class="error-msg">Could not load timeline.</div>`;
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-timeline]");
  if (b) showTimeline(b.dataset.timeline);
});

// Status badge plus the rejection reason (if any), for table cells.
function statusCell(r) {
  const why = r.status === "rejected" && r.reject_reason
    ? `<div class="small-muted reason">${escapeHtml(r.rejected_by || "")}: ${escapeHtml(r.reject_reason)}</div>` : "";
  return statusBadge(r.status) + why;
}
const timelineBtn = (id) => `<button class="secondary sm" data-timeline="${id}">Timeline</button>`;
