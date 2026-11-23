// risk.js — lightweight pattern-analysis risk scoring.
// Deliberately simple (z-score style heuristic, not a trained model) —
// good enough to flag outliers for a warden's attention, not to auto-block
// anyone. This is "Objective 9" made real: compare a new request against
// the STUDENT'S OWN history, not a fixed rulebook.

const { db } = require("./db");

function hourOf(isoTime) {
  return new Date(isoTime).getHours();
}

function baseScore(studentId, { destination, exit_time }) {
  const history = db
    .prepare(
      `SELECT destination, exit_time, created_at FROM requests
       WHERE student_id = ? AND status IN ('approved','used','completed')
       ORDER BY created_at DESC LIMIT 30`
    )
    .all(studentId);

  if (history.length < 3) {
    // Not enough history to judge — flag as "new pattern" but low severity.
    return { score: 0.2, flag: "low", reasons: ["Not enough history yet to establish a baseline"] };
  }

  const reasons = [];
  let score = 0;

  // 1) Unusual time-of-day
  const hours = history.map((h) => hourOf(h.exit_time));
  const meanHour = hours.reduce((a, b) => a + b, 0) / hours.length;
  const variance = hours.reduce((a, b) => a + (b - meanHour) ** 2, 0) / hours.length;
  const stdHour = Math.sqrt(variance) || 1;
  const newHour = hourOf(exit_time);
  const hourZ = Math.abs(newHour - meanHour) / stdHour;
  if (hourZ > 1.5) {
    score += 0.35;
    reasons.push(`Exit time (${newHour}:00) is unusual vs this student's typical ${meanHour.toFixed(0)}:00`);
  }

  // 2) Unfamiliar destination
  const destCounts = {};
  for (const h of history) destCounts[h.destination] = (destCounts[h.destination] || 0) + 1;
  const seenBefore = destCounts[destination] || 0;
  if (seenBefore === 0) {
    score += 0.3;
    reasons.push(`First recorded outing to "${destination}"`);
  }

  // 3) Frequency spike in last 7 days
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const recentCount = history.filter((h) => new Date(h.created_at).getTime() > weekAgo).length;
  if (recentCount >= 5) {
    score += 0.25;
    reasons.push(`${recentCount} outing requests in the last 7 days (above usual pace)`);
  }

  // 4) Late-night flag (independent of personal baseline — a safety floor)
  if (newHour >= 22 || newHour < 5) {
    score += 0.2;
    reasons.push("Late-night exit window (10pm–5am)");
  }

  score = Math.min(1, score);
  const flag = score >= 0.6 ? "high" : score >= 0.3 ? "medium" : "low";
  if (reasons.length === 0) reasons.push("Consistent with usual pattern");

  return { score: Number(score.toFixed(2)), flag, reasons };
}

const flagFor = (s) => (s >= 0.6 ? "high" : s >= 0.3 ? "medium" : "low");

// Baseline score + late-return history: repeat latecomers get a closer look.
function scoreRequest(studentId, reqData) {
  const base = baseScore(studentId, reqData);
  const recent = db
    .prepare(`SELECT late_minutes FROM requests WHERE student_id=? AND status='completed' ORDER BY returned_at DESC, id DESC LIMIT 5`)
    .all(studentId);
  const late = recent.filter((r) => r.late_minutes > 0).length;
  if (!late) return base;

  const score = Math.min(1, base.score + (late >= 2 ? 0.3 : 0.15));
  const reasons = base.reasons.filter((x) => x !== "Consistent with usual pattern");
  reasons.push(`Returned late on ${late} of last ${recent.length} completed outings`);
  return { score: Number(score.toFixed(2)), flag: flagFor(score), reasons };
}

// Summary panel for Admin: per-student behaviour profile.
function studentProfile(studentId) {
  const history = db
    .prepare(
      `SELECT destination, exit_time, expected_duration_min, status, created_at, risk_flag
       FROM requests WHERE student_id = ? ORDER BY created_at DESC LIMIT 20`
    )
    .all(studentId);

  const destFreq = {};
  for (const h of history) destFreq[h.destination] = (destFreq[h.destination] || 0) + 1;
  const topDestinations = Object.entries(destFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([destination, count]) => ({ destination, count }));

  const flaggedCount = history.filter((h) => h.risk_flag === "high" || h.risk_flag === "medium").length;

  return {
    studentId,
    totalRequests: history.length,
    topDestinations,
    flaggedCount,
    recent: history.slice(0, 10),
  };
}

module.exports = { scoreRequest, studentProfile };
