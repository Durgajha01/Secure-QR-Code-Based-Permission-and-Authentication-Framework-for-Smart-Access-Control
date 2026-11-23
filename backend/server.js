// server.js — the whole API. Kept in one file on purpose for a college
// project: easy to read top to bottom, easy to defend in a viva.
// Split into routers/ later if the codebase grows.

const express = require("express");
const cors = require("cors");
const path = require("path");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const { db, logAudit, notify, notifyAdmins, notifyWardens } = require("./db");
const qr = require("./qr");
const risk = require("./risk");
const timing = require("./timing");
const { startEscalationJob } = require("./escalation");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-session-secret";
const PORT = process.env.PORT || 4000;

// Passwords: salted scrypt (built into Node, no extra dependency).
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const a = Buffer.from(hash, "hex");
  const b = crypto.scryptSync(password, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Warden/admin sign-up is protected by an invite code so students can't make themselves wardens.
const STAFF_CODES = { warden: process.env.WARDEN_CODE || "WARDEN-2026", admin: process.env.ADMIN_CODE || "ADMIN-2026" };
const ID_PREFIX = { student: "STU", warden: "WRD", parent: "PAR", admin: "ADM" };
function nextId(role) {
  const p = ID_PREFIX[role];
  const rows = db.prepare(`SELECT id FROM users WHERE id LIKE ?`).all(p + "%");
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.id.slice(p.length), 10) || 0), 0);
  return p + String(max + 1).padStart(3, "0");
}

// ---------- Auth middleware ----------
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });
  try {
    req.user = jwt.verify(token, SESSION_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "invalid_or_expired_session" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "forbidden_role" });
    next();
  };
}

// ---------- LOGIN (email + password) ----------
function sessionFor(user) {
  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role, linked_student_id: user.linked_student_id },
    SESSION_SECRET,
    { expiresIn: "8h" }
  );
  return { token, id: user.id, name: user.name, email: user.email, role: user.role, linked_student_id: user.linked_student_id };
}

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email_and_password_required" });

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(String(email).trim().toLowerCase());
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    logAudit(email, "login_failed", {});
    return res.status(401).json({ error: "invalid_credentials" });
  }
  logAudit(user.id, "login_success", {});
  res.json(sessionFor(user));
});

// ---------- REGISTER (one flow, role-specific rules) ----------
app.post("/api/register", (req, res) => {
  const b = req.body || {};
  const role = b.role;
  const name = String(b.name || "").trim().slice(0, 80);
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  const phone = String(b.phone || "").trim().slice(0, 20) || null;

  if (!ID_PREFIX[role]) return res.status(400).json({ error: "invalid_role" });
  if (name.length < 2) return res.status(400).json({ error: "name_required" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "invalid_email" });
  if (password.length < 8) return res.status(400).json({ error: "password_too_short" });
  if (db.prepare(`SELECT 1 FROM users WHERE email=?`).get(email)) return res.status(409).json({ error: "email_taken" });

  let linked = null;
  if (role === "parent") {
    const sEmail = String(b.student_email || "").trim().toLowerCase();
    const stu = db.prepare(`SELECT id FROM users WHERE role='student' AND email=?`).get(sEmail);
    if (!stu) return res.status(404).json({ error: "student_not_found" });
    if (db.prepare(`SELECT 1 FROM users WHERE role='parent' AND linked_student_id=?`).get(stu.id)) {
      return res.status(409).json({ error: "student_already_has_parent" });
    }
    linked = stu.id;
  }
  if (role === "warden" || role === "admin") {
    if (String(b.invite_code || "") !== STAFF_CODES[role]) return res.status(403).json({ error: "invalid_invite_code" });
  }

  const id = nextId(role);
  db.prepare(`INSERT INTO users (id, name, role, pin_hash, password_hash, email, linked_student_id, phone) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, name, role, "", hashPassword(password), email, linked, phone);
  logAudit(id, "registered", { role, email });
  if (role === "parent") notify(linked, `${name} registered as your parent account.`);

  res.json(sessionFor({ id, name, email, role, linked_student_id: linked }));
});

// Shared helpers for decisions / reads.
const parseReasons = (r) => { try { return r.risk_reasons ? JSON.parse(r.risk_reasons) : []; } catch { return []; } };
const shape = (r) => ({ ...r, risk_reasons: parseReasons(r) });
const cleanReason = (v) => String(v || "").trim().slice(0, 300);
const asUtcIso = (s) => (s ? s.replace(" ", "T") + "Z" : null); // SQLite datetime('now') is UTC

// ---------- STUDENT: create outing request ----------
app.post("/api/requests", authMiddleware, requireRole("student"), (req, res) => {
  const { purpose, destination, exit_time, expected_duration_min } = req.body || {};
  if (!purpose || !destination || !exit_time || !expected_duration_min) {
    return res.status(400).json({ error: "missing_fields" });
  }

  // Find the assigned warden (demo: single warden) and the student's linked parent.
  const warden = db.prepare(`SELECT id FROM users WHERE role='warden' LIMIT 1`).get();
  const parent = db.prepare(`SELECT id FROM users WHERE role='parent' AND linked_student_id = ?`).get(req.user.id);

  const { score, flag, reasons } = risk.scoreRequest(req.user.id, { destination, exit_time });

  const info = db
    .prepare(
      `INSERT INTO requests
        (student_id, purpose, destination, exit_time, expected_duration_min,
         status, warden_id, parent_id, risk_score, risk_flag, risk_reasons)
       VALUES (?,?,?,?,?, 'pending_warden', ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, purpose, destination, exit_time, expected_duration_min,
         warden?.id || null, parent?.id || null, score, flag, JSON.stringify(reasons));

  logAudit(req.user.id, "request_created", { requestId: info.lastInsertRowid, destination, risk: flag });
  notifyWardens(`New outing request from ${req.user.name} — risk: ${flag} (${reasons.join("; ")})`);

  res.json({ requestId: info.lastInsertRowid, risk_score: score, risk_flag: flag, risk_reasons: reasons });
});

// ---------- List requests (role-aware) ----------
app.get("/api/requests", authMiddleware, (req, res) => {
  let rows;
  if (req.user.role === "student") {
    rows = db.prepare(`SELECT * FROM requests WHERE student_id=? ORDER BY created_at DESC`).all(req.user.id);
  } else if (req.user.role === "warden") {
    rows = db.prepare(`SELECT * FROM requests ORDER BY created_at DESC`).all();
  } else if (req.user.role === "parent") {
    rows = db
      .prepare(`SELECT * FROM requests WHERE student_id=? ORDER BY created_at DESC`)
      .all(req.user.linked_student_id);
  } else if (req.user.role === "admin") {
    rows = db.prepare(`SELECT * FROM requests ORDER BY created_at DESC`).all();
  }
  res.json((rows || []).map(shape));
});

// ---------- Warden approve/reject ----------
app.post("/api/requests/:id/warden-decision", authMiddleware, requireRole("warden"), (req, res) => {
  const { decision } = req.body; // 'approve' | 'reject'
  if (!["approve", "reject"].includes(decision)) return res.status(400).json({ error: "invalid_decision" });
  const reason = cleanReason(req.body.reason);
  if (decision === "reject" && reason.length < 3) return res.status(400).json({ error: "reason_required" });
  const reqRow = db.prepare(`SELECT * FROM requests WHERE id=?`).get(req.params.id);
  if (!reqRow) return res.status(404).json({ error: "not_found" });
  if (reqRow.status !== "pending_warden") return res.status(409).json({ error: "not_pending_warden" });

  if (decision === "reject") {
    db.prepare(`UPDATE requests SET status='rejected', warden_decided_at=datetime('now'), rejected_by='warden', reject_reason=? WHERE id=?`)
      .run(reason, reqRow.id);
    notify(reqRow.student_id, `Your outing request #${reqRow.id} was rejected by the warden. Reason: ${reason}`);
    logAudit(req.user.id, "warden_reject", { requestId: reqRow.id, reason });
    return res.json({ ok: true, status: "rejected" });
  }

  const nextStatus = reqRow.parent_id ? "pending_parent" : "approved";
  db.prepare(`UPDATE requests SET status=?, warden_decided_at=datetime('now') WHERE id=?`).run(nextStatus, reqRow.id);
  logAudit(req.user.id, "warden_approve", { requestId: reqRow.id, nextStatus });

  if (nextStatus === "pending_parent") {
    notify(reqRow.parent_id, `Warden approved your child's outing request — your approval is needed.`);
  } else {
    qr.startRotation(reqRow.id);
    notify(reqRow.student_id, `Your outing request is fully approved. QR code is ready.`);
  }
  res.json({ ok: true, status: nextStatus });
});

// ---------- Parent approve/reject ----------
app.post("/api/requests/:id/parent-decision", authMiddleware, requireRole("parent"), (req, res) => {
  const { decision } = req.body;
  if (!["approve", "reject"].includes(decision)) return res.status(400).json({ error: "invalid_decision" });
  const reason = cleanReason(req.body.reason);
  const reqRow = db.prepare(`SELECT * FROM requests WHERE id=?`).get(req.params.id);
  if (!reqRow) return res.status(404).json({ error: "not_found" });
  if (reqRow.parent_id !== req.user.id) return res.status(403).json({ error: "not_your_child" });
  if (reqRow.status !== "pending_parent") return res.status(409).json({ error: "not_pending_parent" });

  if (decision === "reject") {
    db.prepare(`UPDATE requests SET status='rejected', parent_decided_at=datetime('now'), rejected_by='parent', reject_reason=? WHERE id=?`)
      .run(reason || null, reqRow.id);
    const why = reason ? ` Reason: ${reason}` : "";
    notify(reqRow.student_id, `Your outing request #${reqRow.id} was rejected by your parent.${why}`);
    notifyWardens(`Parent rejected request #${reqRow.id}.${why}`);
    logAudit(req.user.id, "parent_reject", { requestId: reqRow.id, reason });
    return res.json({ ok: true, status: "rejected" });
  }

  db.prepare(`UPDATE requests SET status='approved', parent_decided_at=datetime('now') WHERE id=?`).run(reqRow.id);
  logAudit(req.user.id, "parent_approve", { requestId: reqRow.id });
  qr.startRotation(reqRow.id);
  notify(reqRow.student_id, `Your outing request is fully approved. QR code is ready.`);
  notifyWardens(`Parent approved request #${reqRow.id}. QR issued.`);
  res.json({ ok: true, status: "approved" });
});

// ---------- Request timeline (who did what, when, and why) ----------
app.get("/api/requests/:id/timeline", authMiddleware, (req, res) => {
  const r = db.prepare(`SELECT * FROM requests WHERE id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: "not_found" });
  const u = req.user;
  const allowed =
    u.role === "warden" || u.role === "admin" ||
    (u.role === "student" && r.student_id === u.id) ||
    (u.role === "parent" && r.parent_id === u.id);
  if (!allowed) return res.status(403).json({ error: "forbidden" });

  const events = [];
  const add = (ts, tone, title, detail = null) => ts && events.push({ ts: asUtcIso(ts), tone, title, detail });

  add(r.created_at, "info", "Request submitted", `${r.purpose} → ${r.destination}`);
  const wRej = r.rejected_by === "warden", pRej = r.rejected_by === "parent";
  add(r.warden_decided_at, wRej ? "bad" : "good", wRej ? "Rejected by warden" : "Approved by warden", wRej ? r.reject_reason : null);
  add(r.parent_decided_at, pRej ? "bad" : "good", pRej ? "Rejected by parent" : "Approved by parent", pRej ? r.reject_reason : null);
  add(r.used_at, "info", "Left hostel (gate scan)");
  for (const s of db.prepare(`SELECT ts, message FROM sos_events WHERE request_id=?`).all(r.id)) add(s.ts, "bad", "SOS raised", s.message);
  for (const a of db.prepare(`SELECT ts, details FROM audit_log WHERE action='late_return_alert' AND json_extract(details,'$.requestId')=?`).all(r.id)) {
    add(a.ts, "warn", "Overdue alert sent", "Student had not returned past the grace period");
  }
  if (r.returned_at) {
    r.late_minutes > 0
      ? add(r.returned_at, "warn", "Returned late", `${r.late_minutes} min past due time`)
      : add(r.returned_at, "good", "Returned on time");
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));

  res.json({
    id: r.id, status: r.status,
    risk: { flag: r.risk_flag, score: r.risk_score, reasons: parseReasons(r) },
    events,
  });
});

// ---------- Student: fetch current rotating QR ----------
app.get("/api/requests/:id/qr", authMiddleware, requireRole("student"), async (req, res) => {
  const reqRow = db.prepare(`SELECT * FROM requests WHERE id=?`).get(req.params.id);
  if (!reqRow || reqRow.student_id !== req.user.id) return res.status(404).json({ error: "not_found" });
  if (!["approved", "used"].includes(reqRow.status)) {
    return res.status(409).json({ error: "not_approved_yet" });
  }
  const qrData = await qr.getCurrentQrDataUrl(reqRow.id);
  if (!qrData) return res.status(410).json({ error: "qr_no_longer_active" });
  res.json({ dataUrl: qrData.dataUrl, rotateEveryMs: qrData.expiresInMs });
});

// ---------- Gate: scan & burn ----------
app.post("/api/scan", (req, res) => {
  // Deliberately NOT behind student/parent auth — this is the gate device's
  // own endpoint. In a real deployment it would use a separate gate-device
  // API key; omitted here to keep the demo simple.
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "missing_token" });

  // A student ID code means "returning to hostel"; anything else is an exit pass.
  if (qr.isStudentCode(token)) return handleReturnScan(token, res);

  const result = qr.verifyAndBurn(token);
  if (!result.ok) {
    logAudit("gate", "scan_rejected", { reason: result.reason, requestId: result.requestId });
    if (result.requestId) {
      db.prepare(`INSERT INTO scans (request_id, result) VALUES (?,?)`).run(result.requestId, `rejected:${result.reason}`);
    }
    return res.status(400).json({ ok: false, reason: result.reason });
  }

  const reqRow = db.prepare(`SELECT * FROM requests WHERE id=?`).get(result.requestId);
  db.prepare(`UPDATE requests SET status='used', used_at=datetime('now') WHERE id=?`).run(reqRow.id);
  db.prepare(`INSERT INTO scans (request_id, result) VALUES (?, 'accepted')`).run(reqRow.id);
  logAudit("gate", "scan_accepted", { requestId: reqRow.id, student: reqRow.student_id });
  notifyWardens(`${reqRow.student_id} exited via gate scan (request #${reqRow.id}).`);

  res.json({
    ok: true,
    student: reqRow.student_id,
    destination: reqRow.destination,
    exit_time: reqRow.exit_time,
    expected_duration_min: reqRow.expected_duration_min,
  });
});

// ---------- Gate: return / re-entry ----------
function handleReturnScan(code, res) {
  const v = qr.verifyStudentCode(code);
  if (!v.ok) {
    logAudit("gate", "return_rejected", { reason: v.reason });
    return res.status(400).json({ ok: false, reason: v.reason });
  }

  // Newest outing that actually left and hasn't come back yet.
  const r = db
    .prepare(`SELECT * FROM requests WHERE student_id=? AND status='used' ORDER BY used_at DESC, id DESC LIMIT 1`)
    .get(v.studentId);
  if (!r) {
    logAudit("gate", "return_rejected", { reason: "no_active_outing", student: v.studentId });
    return res.status(400).json({ ok: false, reason: "no_active_outing" });
  }

  const late = timing.lateMinutes(r);
  // Guarded UPDATE: a double-scan can't complete (and alert) the same outing twice.
  const done = db
    .prepare(`UPDATE requests SET status='completed', returned_at=datetime('now'), late_minutes=?, late_alerted=1
              WHERE id=? AND status='used'`)
    .run(late, r.id);
  if (done.changes !== 1) return res.status(409).json({ ok: false, reason: "already_returned" });

  db.prepare(`INSERT INTO scans (request_id, result) VALUES (?,?)`)
    .run(r.id, late ? `return_late:${late}min` : "return_on_time");
  logAudit("gate", late ? "return_late" : "return_on_time", { requestId: r.id, student: r.student_id, late_minutes: late });

  const msg = late
    ? `${r.student_id} returned LATE by ${late} min (outing #${r.id}, after ${timing.LATE_GRACE_MIN}-min grace).`
    : `${r.student_id} returned on time (outing #${r.id}).`;
  [r.parent_id, r.student_id].filter(Boolean).forEach((id) => notify(id, msg));
  notifyWardens(msg);
  if (late) notifyAdmins(msg);

  res.json({ ok: true, type: "return", student: r.student_id, destination: r.destination, late, late_minutes: late });
}

app.get("/api/me/id-qr", authMiddleware, requireRole("student"), async (req, res) => {
  res.json({ dataUrl: await qr.studentIdDataUrl(req.user.id) });
});

// ---------- SOS / check-in ----------
app.post("/api/requests/:id/sos", authMiddleware, requireRole("student"), (req, res) => {
  const reqRow = db.prepare(`SELECT * FROM requests WHERE id=?`).get(req.params.id);
  if (!reqRow || reqRow.student_id !== req.user.id) return res.status(404).json({ error: "not_found" });

  const message = (req.body && req.body.message) || "SOS triggered — please check on me.";
  db.prepare(`INSERT INTO sos_events (request_id, message) VALUES (?,?)`).run(reqRow.id, message);
  logAudit(req.user.id, "sos", { requestId: reqRow.id, message });

  notifyWardens(`🚨 SOS from ${req.user.id}: "${message}"`);
  if (reqRow.parent_id) notify(reqRow.parent_id, `🚨 SOS from your child: "${message}"`);

  res.json({ ok: true });
});

// ---------- Notifications (simple poll-based inbox) ----------
app.get("/api/notifications", authMiddleware, (req, res) => {
  const rows = db
    .prepare(`SELECT * FROM notifications WHERE recipient_id=? ORDER BY ts DESC LIMIT 30`)
    .all(req.user.id);
  res.json(rows);
});

app.post("/api/notifications/:id/read", authMiddleware, (req, res) => {
  db.prepare(`UPDATE notifications SET read=1 WHERE id=? AND recipient_id=?`).run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- Admin: audit log + pattern analysis ----------
app.get("/api/admin/audit", authMiddleware, requireRole("admin"), (req, res) => {
  const rows = db.prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT 200`).all();
  res.json(rows);
});

app.get("/api/admin/students", authMiddleware, requireRole("admin"), (req, res) => {
  const rows = db.prepare(`SELECT id, name FROM users WHERE role='student'`).all();
  res.json(rows);
});

app.get("/api/admin/risk/:studentId", authMiddleware, requireRole("admin"), (req, res) => {
  res.json(risk.studentProfile(req.params.studentId));
});

app.get("/api/admin/scans", authMiddleware, requireRole("admin"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT scans.*, requests.student_id, requests.destination
       FROM scans JOIN requests ON requests.id = scans.request_id
       ORDER BY scanned_at DESC LIMIT 100`
    )
    .all();
  res.json(rows);
});

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

startEscalationJob();

app.listen(PORT, () => {
  console.log(`\n  Hostel QR backend running → http://localhost:${PORT}`);
  console.log(`  Frontend served from /public at the same address.\n`);
});
