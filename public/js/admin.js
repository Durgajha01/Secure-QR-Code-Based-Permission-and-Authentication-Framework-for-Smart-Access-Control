// admin.js
const session = requireSession("admin");
document.getElementById("whoami").textContent = `${session.name} (${session.id})`;

let _lastAllSig = "", _lastAuditSig = "", _lastScanSig = "";

async function loadStudents() {
  const students = await API.call("/api/admin/students");
  const sel = document.getElementById("studentSelect");
  sel.innerHTML = students.map((s) => `<option value="${s.id}">${s.name} (${s.id})</option>`).join("");
  sel.addEventListener("change", () => loadProfile(sel.value));
  if (students.length) loadProfile(students[0].id);
}

async function loadProfile(studentId) {
  const p = await API.call(`/api/admin/risk/${studentId}`);
  const el = document.getElementById("profileBox");
  el.innerHTML = `
    <div class="row" style="margin-bottom:10px;">
      <div class="card" style="flex:1; margin-bottom:0;">
        <div class="small-muted">Total requests</div>
        <div style="font-size:22px; font-weight:700;">${p.totalRequests}</div>
      </div>
      <div class="card" style="flex:1; margin-bottom:0;">
        <div class="small-muted">Flagged (medium/high)</div>
        <div style="font-size:22px; font-weight:700; color:${p.flaggedCount ? "#f4b740" : "#38c172"};">${p.flaggedCount}</div>
      </div>
    </div>
    <div class="small-muted" style="margin-bottom:6px;">Top destinations</div>
    <table>
      <thead><tr><th>Destination</th><th>Times visited</th></tr></thead>
      <tbody>
        ${p.topDestinations.map((d) => `<tr><td>${escapeHtml(d.destination)}</td><td>${d.count}</td></tr>`).join("") ||
          `<tr><td colspan="2" class="empty">No data yet</td></tr>`}
      </tbody>
    </table>`;
}

function renderAll(rows) {
  const el = document.getElementById("allTable");
  el.innerHTML = rows.length
    ? `<table><thead><tr><th>#</th><th>Student</th><th>Destination</th><th>Status</th><th>Risk</th><th>Warden esc.</th><th>Parent esc.</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr><td>${r.id}</td><td>${r.student_id}</td><td>${escapeHtml(r.destination)}</td>
              <td>${statusBadge(r.status)}</td><td>${riskBadge(r.risk_flag)}</td>
              <td>${r.warden_escalated ? "⚠️" : "—"}</td><td>${r.parent_escalated ? "⚠️" : "—"}</td></tr>`
          )
          .join("")}</tbody></table>`
    : `<div class="empty">No requests yet.</div>`;
}

function renderScans(rows) {
  const el = document.getElementById("scanTable");
  el.innerHTML = rows.length
    ? `<table><thead><tr><th>Time</th><th>Student</th><th>Destination</th><th>Result</th></tr></thead>
        <tbody>${rows
          .map((r) => `<tr><td>${fmtTime(r.scanned_at)}</td><td>${r.student_id}</td><td>${escapeHtml(r.destination)}</td><td>${r.result}</td></tr>`)
          .join("")}</tbody></table>`
    : `<div class="empty">No gate scans yet.</div>`;
}

function renderAudit(rows) {
  const el = document.getElementById("auditTable");
  el.innerHTML = rows.length
    ? `<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>${rows
          .map((r) => `<tr><td>${fmtTime(r.ts)}</td><td>${r.actor || "—"}</td><td>${r.action}</td><td class="small-muted">${escapeHtml(r.details || "")}</td></tr>`)
          .join("")}</tbody></table>`
    : `<div class="empty">No audit entries yet.</div>`;
}

async function refresh() {
  try {
    const rows = await API.call("/api/requests");
    const sig = rows.map((r) => `${r.id}:${r.status}:${r.warden_escalated}:${r.parent_escalated}`).join(",");
    if (sig !== _lastAllSig) { _lastAllSig = sig; renderAll(rows); }

    const scans = await API.call("/api/admin/scans");
    const scanSig = scans.map((s) => s.id).join(",");
    if (scanSig !== _lastScanSig) { _lastScanSig = scanSig; renderScans(scans); }

    const audit = await API.call("/api/admin/audit");
    const auditSig = audit.map((a) => a.id).join(",");
    if (auditSig !== _lastAuditSig) { _lastAuditSig = auditSig; renderAudit(audit); }
  } catch (e) {
    console.warn(e);
  }
}

loadStudents();
refresh();
setInterval(refresh, 5000);

pollNotifications("notifBox");
setInterval(() => pollNotifications("notifBox"), 5000);
