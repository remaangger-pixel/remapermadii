const crypto = require('crypto');

/**
 * Server-side VIP PIN gate.
 *
 * Replaces the old client-side scheme (PIN hash + a token derived from that same hash,
 * both shipped straight to the browser) which anyone could forge from devtools without ever
 * knowing the PIN. Here the PIN hash and the signing secret never leave the server, so the
 * only way to get a valid token is to actually submit the correct PIN to /api/vip.
 *
 * This only gates *who can get a token*. It does not by itself hide is18 rows from the anon
 * key — that's enforced by the "Public read Movies" RLS policy (see enable_rls.sql), which
 * must be restricted to is18 = false. This module's token is then required to read is18 = true
 * rows through /api/vip, which uses the Supabase service role key to bypass RLS once the token
 * checks out.
 */

// sha256("<the real PIN>") — unchanged from the previous client-side constant, kept here as the
// one place that actually enforces it.
const VIP_PIN_HASH = '8ffe8459134b46975acd31df13a50c51dbeacf1c19a764bf1602ba7c73ffc8fb';

// Random, server-only signing key for session tokens. Safe to hardcode (never sent to a client),
// but rotating it invalidates every outstanding VIP session, so prefer SESSION_SECRET from the
// environment where one is set.
const SESSION_SECRET = process.env.VIP_SESSION_SECRET || '4674e3733d06214ea719b502b4f0259c5c935b65ec6315caa23b663d7f815282';

const SESSION_MS = 2 * 60 * 60 * 1000; // matches the previous VIP_SESSION_MS in index.html

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function sign(exp) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex');
}

/** True only if `pin` hashes to the configured VIP_PIN_HASH. Constant-time compare. */
function checkPin(pin) {
  if (typeof pin !== 'string' || !pin) return false;
  const got = Buffer.from(sha256Hex(pin), 'hex');
  const want = Buffer.from(VIP_PIN_HASH, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Issues a { exp, token } pair for a correct PIN. */
function issueSession() {
  const exp = Date.now() + SESSION_MS;
  return { exp, token: sign(exp) };
}

/** True only if `token` was actually issued by this server for this `exp`, and it hasn't expired. */
function verifySession(exp, token) {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= Date.now()) return false;
  if (typeof token !== 'string' || !token) return false;
  const got = Buffer.from(token, 'hex');
  const want = Buffer.from(sign(expNum), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = { checkPin, issueSession, verifySession, SESSION_MS };
