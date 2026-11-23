// db.js — SQLite schema + connection.
// Using better-sqlite3: synchronous, zero-config, file-based (hostel.db).
// This replaces the need for a separate Postgres/MySQL install for the demo,
// but the query layer is plain SQL so swapping to Postgres later is a
// find/replace on the driver, not a rewrite.

const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "hostel.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,      -- login id, e.g. STU001 / WRD01 / PAR001 / ADM01
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('student','warden','parent','admin')),
  pin_hash      TEXT,                  -- legacy (ID+PIN); login now uses email + password_hash
  linked_student_id TEXT,              -- for parents: which student they approve for
  phone         TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id          TEXT NOT NULL,
  purpose             TEXT NOT NULL,
  destination         TEXT NOT NULL,
  exit_time           TEXT NOT NULL,       -- ISO timestamp, planned exit
  expected_duration_min INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending_warden'
                        CHECK(status IN (
                          'pending_warden','pending_parent','approved',
                          'rejected','used','expired','completed'
                        )),
  warden_id           TEXT,
  parent_id           TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  warden_decided_at   TEXT,
  parent_decided_at   TEXT,
  warden_escalated    INTEGER DEFAULT 0,
  parent_escalated    INTEGER DEFAULT 0,
  risk_score          REAL DEFAULT 0,
  risk_flag           TEXT,                 -- null | 'low' | 'medium' | 'high'
  used_at             TEXT,
  reminder_sent       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL,
  scanned_at  TEXT DEFAULT (datetime('now')),
  result      TEXT NOT NULL,   -- accepted | rejected_reason...
  gate_id     TEXT DEFAULT 'MAIN_GATE'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT DEFAULT (datetime('now')),
  actor     TEXT,
  action    TEXT NOT NULL,
  details   TEXT
);

CREATE TABLE IF NOT EXISTS sos_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL,
  ts          TEXT DEFAULT (datetime('now')),
  message     TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id TEXT NOT NULL,   -- user id who should see this
  ts          TEXT DEFAULT (datetime('now')),
  message     TEXT NOT NULL,
  read        INTEGER DEFAULT 0
);
`);

// Idempotent column migration (CREATE TABLE IF NOT EXISTS won't touch an
// existing hostel.db, so new columns are added here instead of editing the DDL).
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumnIfMissing("users", "email", "TEXT");
addColumnIfMissing("users", "password_hash", "TEXT");
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
addColumnIfMissing("requests", "returned_at", "TEXT");
addColumnIfMissing("requests", "late_minutes", "INTEGER DEFAULT 0");
addColumnIfMissing("requests", "late_alerted", "INTEGER DEFAULT 0");
addColumnIfMissing("requests", "risk_reasons", "TEXT");   // JSON array, stored so the timeline can show it later
addColumnIfMissing("requests", "reject_reason", "TEXT");
addColumnIfMissing("requests", "rejected_by", "TEXT");    // 'warden' | 'parent'

function logAudit(actor, action, details) {
  db.prepare(`INSERT INTO audit_log (actor, action, details) VALUES (?,?,?)`)
    .run(actor, action, typeof details === "string" ? details : JSON.stringify(details));
}

function notify(recipientId, message) {
  db.prepare(`INSERT INTO notifications (recipient_id, message) VALUES (?,?)`)
    .run(recipientId, message);
}

// Notify every admin account (new admins can register, so no hard-coded ADM01).
function notifyAdmins(message) {
  for (const a of db.prepare(`SELECT id FROM users WHERE role='admin'`).all()) notify(a.id, message);
}

// Notify every warden (anyone can have registered, not just WRD01).
function notifyWardens(message) {
  for (const w of db.prepare(`SELECT id FROM users WHERE role='warden'`).all()) notify(w.id, message);
}

module.exports = { db, logAudit, notify, notifyAdmins, notifyWardens };
