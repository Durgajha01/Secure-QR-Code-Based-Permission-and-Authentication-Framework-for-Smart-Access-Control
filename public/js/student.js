// student.js
const session = requireSession("student");
document.getElementById("whoami").textContent = `${session.name} (${session.id})`;

let _lastReqSignature = "";
let currentQrRequestId = null;
let qrPollTimer = null;

async function submitRequest() {
  const purpose = document.getElementById("purpose").value.trim();
  const destination = document.getElementById("destination").value.trim();
  const exitTimeRaw = document.getElementById("exitTime").value;
  const duration = Number(document.getElementById("duration").value);
  const msgEl = document.getElementById("formMsg");
  msgEl.textContent = "";
  msgEl.style.color = "";

  if (!purpose || !destination || !exitTimeRaw || !duration) {
    msgEl.textContent = "Fill in every field.";
    return;
  }

  try {
    const data = await API.call("/api/requests", {
      method: "POST",
      body: {
        purpose,
        destination,
        exit_time: new Date(exitTimeRaw).toISOString(),
        expected_duration_min: duration,
      },
    });
    msgEl.style.color = "#38c172";
    msgEl.textContent = `Submitted (request #${data.requestId}). Risk flag: ${data.risk_flag}.`;
    document.getElementById("purpose").value = "";
    document.getElementById("destination").value = "";
    _lastReqSignature = ""; // force table refresh
    await refreshRequests();
  } catch (e) {
    msgEl.textContent = "Could not submit request. " + (e.data?.error || "");
  }
}

function renderRequestsTable(rows) {
  const el = document.getElementById("requestsTable");
  if (rows.length === 0) {
    el.innerHTML = `<div class="empty">No requests yet — submit one above.</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>#</th><th>Destination</th><th>Exit</th><th>Status</th><th>Risk</th><th></th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
              <td>${r.id}</td>
              <td>${escapeHtml(r.destination)}</td>
              <td>${fmtTime(r.exit_time)}</td>
              <td>${statusCell(r)}</td>
              <td>${riskBadge(r.risk_flag)}</td>
              <td>${timelineBtn(r.id)}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

async function refreshRequests() {
  try {
    const rows = await API.call("/api/requests");
    const signature = rows.map((r) => `${r.id}:${r.status}`).join(",");
    if (signature !== _lastReqSignature) {
      _lastReqSignature = signature;
      renderRequestsTable(rows);
    }

    // Find the active approved/used request to show QR for.
    const active = rows.find((r) => r.status === "approved" || r.status === "used");
    const qrCard = document.getElementById("activeQrCard");
    if (active) {
      qrCard.style.display = "block";
      if (currentQrRequestId !== active.id) {
        currentQrRequestId = active.id;
        startQrPolling(active.id);
      }
    } else {
      qrCard.style.display = "none";
      currentQrRequestId = null;
      if (qrPollTimer) clearInterval(qrPollTimer);
    }
  } catch (e) {
    console.warn("refreshRequests failed", e);
  }
}

async function fetchQr(requestId) {
  try {
    const data = await API.call(`/api/requests/${requestId}/qr`);
    const img = document.getElementById("qrImg");
    if (img.src !== data.dataUrl) img.src = data.dataUrl; // only touch DOM if it actually changed
    document.getElementById("qrMeta").textContent =
      "Live gate pass — rotates every 30s. Scanned copies stop working instantly.";
  } catch (e) {
    if (e.status === 410 || e.status === 409) {
      // QR no longer active (used or expired) — stop polling, table refresh will hide the card.
      if (qrPollTimer) clearInterval(qrPollTimer);
    }
  }
}

function startQrPolling(requestId) {
  if (qrPollTimer) clearInterval(qrPollTimer);
  fetchQr(requestId);
  qrPollTimer = setInterval(() => fetchQr(requestId), 8000);
}

async function triggerSos() {
  if (!currentQrRequestId) return;
  const message = prompt("Optional message to send with your SOS:", "Need assistance");
  try {
    await API.call(`/api/requests/${currentQrRequestId}/sos`, { method: "POST", body: { message } });
    alert("SOS sent to your warden and parent.");
  } catch {
    alert("Could not send SOS — check your connection.");
  }
}

document.getElementById("submitBtn").addEventListener("click", submitRequest);
document.getElementById("sosBtn").addEventListener("click", triggerSos);

API.call("/api/me/id-qr")
  .then((d) => { document.getElementById("idQrImg").src = d.dataUrl; })
  .catch(() => {});

refreshRequests();
pollNotifications("notifBox");
setInterval(refreshRequests, 5000);
setInterval(() => pollNotifications("notifBox"), 5000);
