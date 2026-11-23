// parent.js
const session = requireSession("parent");
document.getElementById("whoami").textContent = `${session.name} (${session.id}) — child: ${session.linked_student_id}`;

let _lastAllSignature = "";

function renderPending(rows) {
  const el = document.getElementById("pendingTable");
  const pending = rows.filter((r) => r.status === "pending_parent");
  if (pending.length === 0) {
    el.innerHTML = `<div class="empty">Nothing waiting on you right now.</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>#</th><th>Destination</th><th>Exit</th><th>Duration</th><th>Risk</th><th>Action</th></tr></thead>
      <tbody>
        ${pending
          .map(
            (r) => `<tr>
              <td>${r.id}</td>
              <td>${escapeHtml(r.destination)}</td>
              <td>${fmtTime(r.exit_time)}</td>
              <td>${r.expected_duration_min} min</td>
              <td>${riskBadge(r.risk_flag)}</td>
              <td>
                ${timelineBtn(r.id)}
                <button data-id="${r.id}" data-decision="approve" class="decideBtn">Approve</button>
                <button data-id="${r.id}" data-decision="reject" class="decideBtn danger">Reject</button>
              </td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>`;

  el.querySelectorAll(".decideBtn").forEach((btn) => {
    btn.addEventListener("click", () => decide(btn.dataset.id, btn.dataset.decision));
  });
}

function renderAll(rows) {
  const el = document.getElementById("allTable");
  if (rows.length === 0) {
    el.innerHTML = `<div class="empty">No requests yet.</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>#</th><th>Destination</th><th>Status</th><th>Risk</th><th></th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr><td>${r.id}</td><td>${escapeHtml(r.destination)}</td><td>${statusCell(r)}</td><td>${riskBadge(r.risk_flag)}</td><td>${timelineBtn(r.id)}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

async function decide(id, decision) {
  let reason;
  if (decision === "reject") {
    reason = await askRejectReason({ required: false, chips: REJECT_CHIPS.parent });
    if (reason === null) return; // cancelled
  }
  try {
    await API.call(`/api/requests/${id}/parent-decision`, { method: "POST", body: { decision, reason } });
    _lastAllSignature = "";
    refresh();
  } catch (e) {
    alert("Could not record decision: " + (e.data?.error || e.message));
  }
}

async function refresh() {
  try {
    const rows = await API.call("/api/requests");
    renderPending(rows);
    const signature = rows.map((r) => `${r.id}:${r.status}`).join(",");
    if (signature !== _lastAllSignature) {
      _lastAllSignature = signature;
      renderAll(rows);
    }
  } catch (e) {
    console.warn(e);
  }
}

refresh();
pollNotifications("notifBox");
setInterval(refresh, 4000);
setInterval(() => pollNotifications("notifBox"), 5000);
