// qr.js — signed, single-use, rotating QR tokens.
//
// Design:
//  - Each approved request gets a rotation loop: every ROTATE_MS a fresh
//    JWT {requestId, nonce, exp} is signed and becomes the "current" token
//    for that request. The previous nonce is immediately invalidated.
//  - A nonce is also burned permanently the instant it's scanned, so even
//    within its ~35s validity window it can't be reused (single-use).
//  - This nonce map plays the role Redis would play in production
//    (`SET nonce used EX ttl`). It's an in-memory Map here so the whole
//    thing runs with zero external services for the demo. Swapping in
//    real Redis later is a one-file change (see comments below).

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const QRCode = require("qrcode");

const QR_SECRET = process.env.QR_SECRET || "dev-only-secret-change-me";
const ROTATE_MS = 30 * 1000;      // rotate every 30s, as requested
const TOKEN_TTL_SEC = 35;         // slightly longer than rotation interval

// requestId -> { currentNonce, timer, usedNonces:Set }
const activeRequests = new Map();

function signToken(requestId, nonce) {
  return jwt.sign({ requestId, nonce }, QR_SECRET, { expiresIn: TOKEN_TTL_SEC });
}

function startRotation(requestId) {
  stopRotation(requestId); // safety: never double-schedule

  const state = { currentNonce: null, timer: null, usedNonces: new Set() };
  activeRequests.set(requestId, state);

  const rotate = () => {
    state.currentNonce = crypto.randomUUID();
  };

  rotate(); // issue first nonce immediately
  state.timer = setInterval(rotate, ROTATE_MS);
}

function stopRotation(requestId) {
  const state = activeRequests.get(requestId);
  if (state?.timer) clearInterval(state.timer);
  activeRequests.delete(requestId);
}

async function getCurrentQrDataUrl(requestId) {
  const state = activeRequests.get(requestId);
  if (!state) return null;
  const token = signToken(requestId, state.currentNonce);
  const dataUrl = await QRCode.toDataURL(token, { margin: 1, width: 260 });
  return { dataUrl, expiresInMs: ROTATE_MS, token };
}

// Verifies a scanned token: signature -> expiry -> matches current live
// nonce for that request -> not already used. Burns the nonce on success.
function verifyAndBurn(rawToken) {
  let payload;
  try {
    payload = jwt.verify(rawToken, QR_SECRET);
  } catch (e) {
    if (e.name === "TokenExpiredError") return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid_signature" };
  }

  const { requestId, nonce } = payload;
  const state = activeRequests.get(requestId);
  if (!state) return { ok: false, reason: "no_active_qr_for_request" };

  if (state.usedNonces.has(nonce)) {
    return { ok: false, reason: "already_used", requestId };
  }
  if (nonce !== state.currentNonce) {
    return { ok: false, reason: "stale_or_rotated", requestId };
  }

  state.usedNonces.add(nonce);
  stopRotation(requestId); // one-time use: gate pass consumed, no more QR
  return { ok: true, requestId };
}

// ---- Permanent student ID code (used for the RETURN scan) ----
// Static on purpose (no rotation) but HMAC-signed, so a code can't be forged
// by typing a student id into any QR generator. Format: HQR1:<studentId>:<sig>
const ID_PREFIX = "HQR1:";
const idSig = (studentId) =>
  crypto.createHmac("sha256", QR_SECRET).update(`id:${studentId}`).digest("hex").slice(0, 24);

const isStudentCode = (raw) => typeof raw === "string" && raw.startsWith(ID_PREFIX);

function verifyStudentCode(raw) {
  const [, studentId, sig] = String(raw).split(":");
  if (!studentId || !sig) return { ok: false, reason: "malformed_id_code" };
  const a = Buffer.from(sig), b = Buffer.from(idSig(studentId));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "invalid_id_signature" };
  return { ok: true, studentId };
}

const studentIdDataUrl = (studentId) =>
  QRCode.toDataURL(`${ID_PREFIX}${studentId}:${idSig(studentId)}`, { margin: 1, width: 280 });

module.exports = { isStudentCode, verifyStudentCode, studentIdDataUrl, startRotation, stopRotation, getCurrentQrDataUrl, verifyAndBurn };
