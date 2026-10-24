// Sign-in: one-time codes for users, the admin password, and session cookies.
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import * as store from './store.js';

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_TRIES = 5;
export const CODE_RESEND_MS = 60_000;
export const CODE_MAX_PER_HOUR = 5;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const SESSION_COOKIE = 'opt_session';
const HOUR_MS = 60 * 60_000;

const sha256 = (value) => createHash('sha256').update(value).digest();
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// ---------- one-time codes ----------

// Kept in memory: codes only live for minutes, so a restart simply means requesting a new one.
// userId -> { hash, expiresAt, tries, sent: [timestamps of codes sent in the last hour] }
const codes = new Map();

// Creates a code for the user, or says how long to wait when they have asked too often.
export function issueCode(userId, now = Date.now()) {
  const sent = (codes.get(userId)?.sent ?? []).filter((t) => now - t < HOUR_MS);
  const last = sent.at(-1);
  if (last !== undefined && now - last < CODE_RESEND_MS) return { retryAfterSec: Math.ceil((CODE_RESEND_MS - (now - last)) / 1000) };
  if (sent.length >= CODE_MAX_PER_HOUR) return { retryAfterSec: Math.ceil((HOUR_MS - (now - sent[0])) / 1000) };
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  codes.set(userId, { hash: sha256(code), expiresAt: now + CODE_TTL_MS, tries: 0, sent: [...sent, now] });
  return { code };
}

// Withdraws the code just issued (its email could not be sent), so it doesn't count against the limits.
export function withdrawCode(userId) {
  const entry = codes.get(userId);
  if (!entry) return;
  entry.hash = null;
  entry.sent.pop();
}

// Returns 'ok', 'wrong', 'expired' (no live code) or 'locked' (too many wrong tries; the code is cancelled).
export function checkCode(userId, code, now = Date.now()) {
  const entry = codes.get(userId);
  if (!entry?.hash || now > entry.expiresAt) return 'expired';
  if (sameHash(entry.hash, sha256(String(code ?? '').replace(/\s/g, '')))) {
    entry.hash = null;
    return 'ok';
  }
  entry.tries += 1;
  if (entry.tries < CODE_MAX_TRIES) return 'wrong';
  entry.hash = null;
  return 'locked';
}

export function pruneCodes(now = Date.now()) {
  for (const [userId, entry] of codes) {
    if (!entry.sent.some((t) => now - t < HOUR_MS)) codes.delete(userId);
  }
  for (const [key, times] of passwordFailures) {
    if (!times.some((t) => now - t < PASSWORD_LOCK_MS)) passwordFailures.delete(key);
  }
}

// ---------- admin password ----------

export const PASSWORD_MAX_FAILS = 5;
export const PASSWORD_LOCK_MS = 15 * 60_000;

// Both sides are hashed with scrypt before a constant-time comparison, so the check takes the same time
// whatever is typed. The expected hash is worked out once per process.
const passwordSalt = randomBytes(16);
let expectedHash = { secret: null, hash: null };
export function checkPassword(given, secret) {
  const hash = scryptSync(String(given ?? ''), passwordSalt, 32);
  if (!secret) return false;
  if (expectedHash.secret !== secret) expectedHash = { secret, hash: scryptSync(secret, passwordSalt, 32) };
  return timingSafeEqual(hash, expectedHash.hash);
}

// key (the email address) -> times of wrong passwords in the last PASSWORD_LOCK_MS.
// After PASSWORD_MAX_FAILS of them, further tries are refused until the oldest one is that old.
const passwordFailures = new Map();

export function passwordRetryAfter(key, now = Date.now()) {
  const recent = (passwordFailures.get(key) ?? []).filter((t) => now - t < PASSWORD_LOCK_MS);
  passwordFailures.set(key, recent);
  if (recent.length < PASSWORD_MAX_FAILS) return 0;
  return Math.ceil((PASSWORD_LOCK_MS - (now - recent[recent.length - PASSWORD_MAX_FAILS])) / 1000);
}

export function recordPasswordFailure(key, now = Date.now()) {
  passwordFailures.set(key, [...(passwordFailures.get(key) ?? []), now]);
}

export const clearPasswordFailures = (key) => passwordFailures.delete(key);

// ---------- sessions ----------

// The cookie holds "<session id>.<secret>"; only a hash of the secret is stored.
export async function createSession(userId, now = Date.now()) {
  const id = store.newId();
  const secret = randomBytes(32).toString('base64url');
  await store.put('sessions', {
    id,
    userId,
    secretHash: sha256(secret).toString('hex'),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  });
  return `${id}.${secret}`;
}

export async function findSession(token, now = Date.now()) {
  const [id, secret, extra] = String(token ?? '').split('.');
  if (!id || !secret || extra !== undefined) return null;
  const session = await store.get('sessions', id);
  if (!session || !sameHash(Buffer.from(session.secretHash, 'hex'), sha256(secret))) return null;
  if (now > Date.parse(session.expiresAt)) {
    await store.remove('sessions', id);
    return null;
  }
  return session;
}

export const endSession = (id) => store.remove('sessions', id);

// With a `reason`, the sessions are kept but marked as ended, so the user's next request can be told why
// they were signed out (it then removes the session). Without one, they are simply removed.
export async function endUserSessions(userId, reason) {
  for (const session of await store.list('sessions', (s) => s.userId === userId)) {
    if (reason) await store.put('sessions', { ...session, ended: reason });
    else await store.remove('sessions', session.id);
  }
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    const name = part.slice(0, Math.max(at, 0)).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      // Ignore malformed values.
    }
  }
  return cookies;
}
