/**
 * SOF Bot — schedule admin auth
 * ─────────────────────────────────────────────────────────────────────────
 * One shared team password (SCHEDULE_PASSWORD) exchanged for an HMAC-signed
 * cookie. Deliberately not per-user accounts: this guards a workshop calendar
 * for a handful of teammates, and SSO would be a week of work for the same
 * outcome. No new dependencies — node:crypto plus manual cookie parsing.
 */

import crypto from "node:crypto";

const COOKIE = "sof_sched";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — this is a calendar, not a bank

function secret() {
  // Falls back to the password itself so there's one required env var, not two.
  return process.env.SCHEDULE_SESSION_SECRET || process.env.SCHEDULE_PASSWORD || "";
}

/**
 * Stable, unguessable key for the public .ics feed.
 *
 * A calendar feed can't carry a cookie — Google fetches it anonymously — so
 * the URL itself is the credential. Derived from the same secret rather than
 * stored as another env var, so it survives redeploys and never needs rotating
 * by hand. Read-only and future-dated: the worst case if it leaks is that
 * someone learns the workshop schedule, which is publicly advertised anyway.
 */
export function feedKey() {
  if (!secret()) return null;
  return crypto.createHmac("sha256", secret()).update("ics-feed-v1").digest("hex").slice(0, 32);
}

export function isConfigured() {
  return Boolean(process.env.SCHEDULE_PASSWORD);
}

function sign(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

/** Constant-time compare that tolerates unequal lengths. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still burn a comparison so length alone isn't a timing oracle.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function checkPassword(candidate) {
  if (!isConfigured()) return false;
  return safeEqual(candidate || "", process.env.SCHEDULE_PASSWORD);
}

/** Names are for the audit trail, not identity — keep them short and printable. */
export function cleanName(raw) {
  return String(raw || "")
    .replace(/[^\p{L}\p{N} .'\-]/gu, "")
    .trim()
    .slice(0, 40);
}

// Token layout: <expiry>.<base64url(name)>.<hmac of the first two parts>
// The name is signed along with the expiry, so nobody can edit the cookie to
// attribute their changes to a teammate.
export function issueToken(name) {
  const exp = String(Date.now() + TTL_MS);
  const nameB64 = Buffer.from(cleanName(name), "utf8").toString("base64url");
  const body = `${exp}.${nameB64}`;
  return `${body}.${sign(body)}`;
}

/** Returns { name } when valid, or null. */
export function verifyToken(token) {
  if (!token || !secret()) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [exp, nameB64, mac] = parts;
  if (!safeEqual(mac, sign(`${exp}.${nameB64}`))) return null;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) return null;
  let name = "";
  try { name = Buffer.from(nameB64, "base64url").toString("utf8"); } catch { name = ""; }
  return { name };
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function isAuthed(req) {
  return verifyToken(readCookie(req, COOKIE)) !== null;
}

/** The signed-in editor's name, for stamping onto rows. "" if not signed in. */
export function editorName(req) {
  const session = verifyToken(readCookie(req, COOKIE));
  return session ? session.name : "";
}

export function setCookie(res, req, name) {
  // Railway terminates TLS in front of the app, so trust the forwarded proto.
  const secure = (req.headers["x-forwarded-proto"] || "").split(",")[0] === "https";
  res.setHeader("Set-Cookie",
    `${COOKIE}=${issueToken(name)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}` +
    (secure ? "; Secure" : "")
  );
}

export function clearCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── Brute-force damping ────────────────────────────────────────────────────
// In-memory and per-instance, which is fine for a single Railway replica. It
// exists to make guessing a shared password slow, not to be a real WAF.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(ip); return false; }
  return rec.count >= MAX_ATTEMPTS;
}

export function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { first: Date.now(), count: 1 });
  } else {
    rec.count += 1;
  }
}

export function clearAttempts(ip) {
  attempts.delete(ip);
}

/** Express middleware for the JSON API. */
export function requireAuth(req, res, next) {
  if (!isConfigured()) {
    return res.status(503).json({ error: "SCHEDULE_PASSWORD is not set on this service" });
  }
  if (!isAuthed(req)) return res.status(401).json({ error: "Not signed in" });
  next();
}
