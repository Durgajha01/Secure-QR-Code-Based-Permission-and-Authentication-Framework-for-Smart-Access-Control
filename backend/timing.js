// timing.js — one definition of "due back" and "late", shared by the gate
// (return scan) and the escalation sweep so they can never disagree.

const LATE_GRACE_MIN = Number(process.env.LATE_GRACE_MIN ?? 30);

function dueBackMs(r) {
  return new Date(r.exit_time).getTime() + r.expected_duration_min * 60 * 1000;
}

// Minutes past the due-back time, but only once the grace period is exceeded;
// 0 means "not late". Returning 20 min after due time with 30 min grace -> 0.
function lateMinutes(r, nowMs = Date.now()) {
  const over = Math.round((nowMs - dueBackMs(r)) / 60000);
  return over > LATE_GRACE_MIN ? over : 0;
}

module.exports = { LATE_GRACE_MIN, dueBackMs, lateMinutes };
