// escalation.js — scheduled sweep that stops approvals from silently
// stalling. In production this is Celery beat / node-cron on a real clock;
// here it's a plain setInterval sweep, which is all a demo needs.
//
// Timers are intentionally short (minutes, not hours) so escalation is
// visible during a live demo instead of requiring you to wait realistically.

const { db, logAudit, notify, notifyAdmins, notifyWardens } = require("./db");
const timing = require("./timing");

const WARDEN_ESCALATE_MS = 2 * 60 * 1000;   // 2 min pending -> escalate
const PARENT_ESCALATE_MS = 3 * 60 * 1000;   // 3 min pending -> escalate
const SWEEP_INTERVAL_MS = 15 * 1000;        // check every 15s

function sweep() {
  const now = Date.now();

  const pendingWarden = db
    .prepare(`SELECT * FROM requests WHERE status='pending_warden' AND warden_escalated=0`)
    .all();
  for (const r of pendingWarden) {
    if (now - new Date(r.created_at).getTime() > WARDEN_ESCALATE_MS) {
      db.prepare(`UPDATE requests SET warden_escalated=1 WHERE id=?`).run(r.id);
      logAudit("system", "escalate_warden", { requestId: r.id, student: r.student_id });
      notifyWardens(`Request #${r.id} from ${r.student_id} has been pending too long — please review.`);
      notifyAdmins(`Escalation: request #${r.id} unaddressed by warden.`);
    }
  }

  const pendingParent = db
    .prepare(`SELECT * FROM requests WHERE status='pending_parent' AND parent_escalated=0`)
    .all();
  for (const r of pendingParent) {
    if (now - new Date(r.created_at).getTime() > PARENT_ESCALATE_MS) {
      db.prepare(`UPDATE requests SET parent_escalated=1 WHERE id=?`).run(r.id);
      logAudit("system", "escalate_parent", { requestId: r.id, student: r.student_id });
      if (r.parent_id) {
        notify(r.parent_id, `Reminder: outing request #${r.id} from your child is awaiting your approval.`);
      }
      notifyAdmins(`Escalation: request #${r.id} unaddressed by parent.`);
    }
  }

  // Return reminders: fire ~before the outing window ends.
  const approved = db
    .prepare(`SELECT * FROM requests WHERE status IN ('approved','used') AND reminder_sent=0`)
    .all();
  for (const r of approved) {
    const exitMs = new Date(r.exit_time).getTime();
    const dueBackMs = exitMs + r.expected_duration_min * 60 * 1000;
    const remindAt = dueBackMs - 2 * 60 * 1000; // remind 2 min before due (compressed demo timescale)
    if (now > remindAt) {
      db.prepare(`UPDATE requests SET reminder_sent=1 WHERE id=?`).run(r.id);
      notify(r.student_id, `Reminder: your permission window for outing #${r.id} ends soon — please return.`);
      notifyWardens(`Heads up: ${r.student_id}'s outing #${r.id} is due back soon.`);
      logAudit("system", "return_reminder", { requestId: r.id });
    }
  }
}

// Overdue alert: left, not back, and past due + grace. Fires once per outing
// (late_alerted); the return scan sets it too so no duplicate alert follows.
function sweepOverdue() {
  const out = db.prepare(`SELECT * FROM requests WHERE status='used' AND late_alerted=0`).all();
  for (const r of out) {
    const late = timing.lateMinutes(r);
    if (!late) continue;
    db.prepare(`UPDATE requests SET late_alerted=1 WHERE id=?`).run(r.id);
    const msg = `OVERDUE: ${r.student_id} has not returned — ${late} min past due (outing #${r.id}).`;
    [r.parent_id, r.student_id].filter(Boolean).forEach((id) => notify(id, msg));
    notifyWardens(msg);
    notifyAdmins(msg);
    logAudit("system", "late_return_alert", { requestId: r.id, late_minutes: late });
  }
}

function startEscalationJob() {
  setInterval(() => { sweep(); sweepOverdue(); }, SWEEP_INTERVAL_MS);
}

module.exports = { startEscalationJob };
