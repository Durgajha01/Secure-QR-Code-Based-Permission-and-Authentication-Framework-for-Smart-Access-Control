# Smart Hostel Access Control — Secure QR Permission System

A working full-stack implementation: real login and registration (email + password, role-checked),
a two-step warden → parent approval chain with auto-escalation, a
cryptographically signed and **rotating** (every 30s) single-use QR gate
pass, a lightweight pattern-analysis risk score, SOS/check-in, and a full
audit trail — all backed by a real SQLite database.

This was built and smoke-tested end-to-end (login → request → warden
approve → parent approve → QR generated → QR scanned by an independent
decoder → gate accepts it once, rejects the replay) before being handed to
you.

DEMO 

https://github.com/user-attachments/assets/a5249667-ce8b-4e0b-9c8b-08356b7d512f


## Stack
- **Backend:** Node.js + Express + `better-sqlite3` (file-based SQL database,
  `backend/hostel.db`, created automatically). No external services (no
  Redis, no Postgres) needed to run it — see "Scaling notes" below for what
  to swap in for production.
- **QR:** signed JWTs (`jsonwebtoken`) rendered as real scannable PNGs
  (`qrcode` library), rotated server-side every 30 seconds, burned
  (single-use) the instant they're scanned.
- **Frontend:** plain HTML/CSS/JS, no framework, no build step. Every
  polling loop does a *targeted* DOM update (diff-and-skip) instead of
  full-page re-renders — this is what fixes the "page blinking constantly"
  issue you had before.

## Running it

```bash
cd backend
npm install
npm run seed      # creates backend/hostel.db and demo accounts (run once)
npm start         # starts the server on http://localhost:4000
```

Then open **http://localhost:4000** in a browser. The Express server also
serves the whole `public/` frontend, so there's nothing else to start.

### Demo accounts (created by `npm run seed`)

| Role    | Email               | Password  | Notes             |
|---------|---------------------|-----------|-------------------|
| Student | stu001@hostel.test  | 11111111  |                   |
| Student | stu002@hostel.test  | 22222222  |                   |
| Student | stu003@hostel.test  | 33333333  |                   |
| Warden  | wrd01@hostel.test   | 55555555  |                   |
| Parent  | par001@hostel.test  | 66666666  | linked to STU001  |
| Parent  | par002@hostel.test  | 77777777  | linked to STU002  |
| Parent  | par003@hostel.test  | 88888888  | linked to STU003  |
| Admin   | adm01@hostel.test   | 99999999  |                   |

### Registration

Every role has its own tab with **Log in / Register**:
- **Student** – name, email, password (min 8). A login ID (STU004…) is auto-assigned.
- **Parent** – same, plus the student's registered email; the student must register first, and each student can have one parent.
- **Warden / Admin** – same, plus an invite code (default `WARDEN-2026` / `ADMIN-2026`;
  override with env vars `WARDEN_CODE` / `ADMIN_CODE`).

Passwords are stored as salted scrypt hashes. Role checks are still enforced server-side.

## Walking through the full flow

1. **Log in as STU001** (Student tab) → submit an outing request (purpose,
   destination, planned exit time, expected duration).
2. **Log in as WRD01** (Warden tab, different browser/incognito window) →
   see the request under "Pending Your Approval" with a computed risk badge
   → Approve.
3. **Log in as PAR001** (Parent tab) → approve the same request.
4. Back on the **student** dashboard, a live QR code appears and
   auto-refreshes. It's a genuinely scannable QR — every 30 seconds the
   backend signs a brand-new token and the image updates to match; the
   previous QR image stops working the moment the new one is issued.
5. Open **`/scanner.html`** on a phone (or the same machine with a webcam)
   while logged in as the warden, allow camera access, and point it at the
   student's QR on another screen — it decodes and calls `/api/scan`
   automatically. There's also a paste-token box on the warden dashboard
   for testing without a camera.
6. The gate scan **burns** the token: scanning the same QR again is
   rejected (`already_used` / `no_active_qr_for_request`), and the request
   flips to `used`.
7. Try **SOS** from the student dashboard while a QR is active — it fires a
   notification to both the warden and the parent.
8. **Log in as ADM01** (Admin tab) to see the full audit log, the gate scan
   log, and the per-student pattern-analysis panel (top destinations,
   flagged-request count).
9. To see **escalation** fire, submit a request and just leave it: after 2
   minutes unaddressed by the warden (3 minutes for a parent), the system
   auto-flags it (⚠️ in the Warden/Admin tables) and pushes a reminder
   notification. Timers are short on purpose so this is demoable live
   instead of requiring you to wait realistically.

## Where each requirement from your synopsis lives

- **Signed, single-use QR tokens** → `backend/qr.js`. JWT signed with a
  server secret, `{requestId, nonce, exp}`, verified on scan, nonce burned
  immediately so it can never be replayed even within its validity window.
- **Rotating QR (30s)** → same file, `startRotation()` — a fresh nonce is
  minted every 30 seconds for the life of an approved request; the gate
  only accepts whichever nonce is currently "live."
- **Two-step approval + escalation timers** → `backend/server.js`
  (warden/parent decision routes) + `backend/escalation.js` (the sweep job
  that flags stalled requests and fires reminders).
- **Risk-scored requests** → `backend/risk.js` — a transparent, explainable
  heuristic (deviation from the student's own historical exit time,
  first-time destination, request frequency spike, late-night flag) rather
  than a black-box model. It computes a score per request and a behaviour
  profile per student for the Admin panel — deliberately not over-built,
  since your brief said not to over-invest here.
- **SOS / check-in** → one endpoint (`POST /api/requests/:id/sos`), fans out
  a notification to warden + parent.
- **Real login gate / RBAC** → `POST /api/login` checks ID+PIN against the
  `users` table and returns a role-scoped session JWT; every subsequent
  route checks `req.user.role` server-side (`requireRole(...)` middleware)
  — the frontend tabs are just UX, the actual enforcement is in the API.
- **Full audit trail** → `audit_log` table, written on every login,
  request, decision, scan, escalation, and SOS event; browsable on the
  Admin dashboard.
- **No more page blinking** → every poll (`public/js/*.js`) computes a
  signature of the fetched data and only touches the DOM if that signature
  actually changed, and only replaces the specific container involved
  (a table body, a notification list, an image `src`) — never the whole
  page.

## Scaling notes (for your report's "future work" section)

- Swap the in-memory nonce map in `qr.js` for real Redis
  (`SET nonce used EX ttl`) — the interface is already isolated to that one
  file, so it's a redis client + a few line changes, not a rewrite.
- Swap `better-sqlite3` for Postgres/MySQL by changing `db.js`'s connection
  and using an async driver (`pg`) — the SQL itself is portable.
- Escalation timers here run on `setInterval`; in production use
  `node-cron` or a proper job queue so the sweep survives process restarts.
- Notifications are poll-based (`GET /api/notifications` every few
  seconds) for simplicity; swap for WebSockets/FCM push for real mobile
  delivery.
- The gate `/api/scan` endpoint is intentionally open (no auth) to
  represent a dedicated gate-device client; in production it should carry
  its own device API key, separate from student/warden/parent sessions.
