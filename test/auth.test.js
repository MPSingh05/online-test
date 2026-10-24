import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The store reads DATA_DIR when it is first imported, so point it at a scratch folder before loading it.
const dataDir = await mkdtemp(path.join(tmpdir(), 'online-test-auth-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_EMAIL = 'Boss@Example.com, not-an-email';
const store = await import('../lib/store.js');
const auth = await import('../lib/auth.js');
const { validateUser, isEmail, isAdmin, canSignIn, canSeeDocument, adminEmails, publicUser } = await import('../lib/users.js');
const { inviteEmail, codeEmail } = await import('../lib/mailer.js');
await store.initStore();
test.after(() => rm(dataDir, { recursive: true, force: true }));

const validInput = {
  name: '  Asha   Rao ',
  age: '29',
  gender: 'female',
  email: ' Asha.Rao@Example.COM ',
  mobile: '+91 98765-43210',
  capabilities: ['core', 'digital', 'other'],
  courses: ['11111111-2222-4333-8444-555555555555', '../../etc', '11111111-2222-4333-8444-555555555555'],
};

test('validateUser cleans valid details', () => {
  const { user, errors } = validateUser(validInput);
  assert.deepEqual(errors, {});
  assert.deepEqual(user, {
    name: 'Asha Rao',
    age: 29,
    gender: 'female',
    email: 'asha.rao@example.com',
    mobile: '+919876543210',
    capabilities: ['digital', 'core'],
    courses: ['11111111-2222-4333-8444-555555555555'],
  });
  assert.deepEqual(validateUser({ ...validInput, courses: undefined }).user.courses, []);
});

test('users see only the documents of their courses; admins see all', () => {
  const user = { email: 'u@example.com', courses: ['course-a'] };
  assert.ok(canSeeDocument(user, { courseId: 'course-a' }));
  assert.equal(canSeeDocument(user, { courseId: 'course-b' }), false);
  assert.equal(canSeeDocument(user, { courseId: null }), false, 'documents outside any course are for admins only');
  assert.equal(canSeeDocument({ email: 'u@example.com' }, { courseId: 'course-a' }), false);
  assert.ok(canSeeDocument({ email: 'boss@example.com' }, { courseId: null }));
});

test('the admin password check and its lockout', () => {
  assert.ok(auth.checkPassword('Secret@123', 'Secret@123'));
  assert.equal(auth.checkPassword('secret@123', 'Secret@123'), false);
  assert.equal(auth.checkPassword('', 'Secret@123'), false);
  assert.equal(auth.checkPassword('anything', ''), false, 'no password configured: nothing matches');
  assert.equal(auth.checkPassword(undefined, undefined), false);

  const now = Date.now();
  for (let i = 0; i < auth.PASSWORD_MAX_FAILS; i++) {
    assert.equal(auth.passwordRetryAfter('boss@example.com', now), 0);
    auth.recordPasswordFailure('boss@example.com', now);
  }
  assert.equal(auth.passwordRetryAfter('boss@example.com', now), auth.PASSWORD_LOCK_MS / 1000);
  assert.equal(auth.passwordRetryAfter('other@example.com', now), 0, 'other addresses are not affected');
  assert.equal(auth.passwordRetryAfter('boss@example.com', now + auth.PASSWORD_LOCK_MS), 0, 'unlocked after the lock period');
  auth.recordPasswordFailure('boss@example.com', now);
  auth.clearPasswordFailures('boss@example.com');
  assert.equal(auth.passwordRetryAfter('boss@example.com', now), 0);
});

test('validateUser reports each invalid field', () => {
  const { errors } = validateUser({ name: 'A', age: '9.5', gender: 'toString', email: 'asha@', mobile: '12345', capabilities: [] });
  assert.deepEqual(Object.keys(errors).sort(), ['age', 'capabilities', 'email', 'gender', 'mobile', 'name']);
  assert.ok(validateUser({ ...validInput, age: '' }).errors.age);
  assert.ok(validateUser({ ...validInput, age: '101' }).errors.age);
  assert.deepEqual(validateUser({ ...validInput, capabilities: 'digital' }).user.capabilities, ['digital']);
});

test('isEmail rejects addresses a mailer could split into several recipients', () => {
  assert.ok(isEmail('first.last+tag@mail.example.co.in'));
  for (const bad of ['"a;b"@example.com', 'a@example.com>b@evil.com', 'a,b@example.com', 'a b@example.com', 'a@example', 'a@-example.com']) {
    assert.equal(isEmail(bad), false, bad);
  }
});

test('admins come from ADMIN_EMAIL; users need an invite and must be enabled', () => {
  assert.deepEqual(adminEmails(), ['boss@example.com']);
  assert.ok(isAdmin({ email: 'boss@example.com' }));
  assert.ok(canSignIn({ email: 'boss@example.com', enabled: false }));
  assert.equal(canSignIn({ email: 'u@example.com', enabled: true, invitedAt: null }), false);
  assert.equal(canSignIn({ email: 'u@example.com', enabled: false, invitedAt: '2026-10-24T10:00:00Z' }), false);
  assert.ok(canSignIn({ email: 'u@example.com', enabled: true, invitedAt: '2026-10-24T10:00:00Z' }));
  assert.equal(publicUser({ id: 'x', email: 'boss@example.com', name: 'Boss' }).role, 'admin');
  assert.equal(publicUser({ id: 'y', email: 'u@example.com', name: 'U' }).role, 'user');
});

test('a sign-in code works once, and wrong codes are limited', () => {
  const now = Date.now();
  const { code } = auth.issueCode('user-1', now);
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal(auth.checkCode('user-1', wrong, now), 'wrong');
  assert.equal(auth.checkCode('user-1', ` ${code} `, now), 'ok');
  assert.equal(auth.checkCode('user-1', code, now), 'expired');

  const second = auth.issueCode('user-2', now).code;
  for (let i = 1; i < auth.CODE_MAX_TRIES; i++) assert.equal(auth.checkCode('user-2', wrong === second ? '222222' : wrong, now), 'wrong');
  assert.equal(auth.checkCode('user-2', wrong === second ? '222222' : wrong, now), 'locked');
  assert.equal(auth.checkCode('user-2', second, now), 'expired');
});

test('sign-in codes expire, and new codes are rate limited', () => {
  const now = Date.now();
  const { code } = auth.issueCode('user-3', now);
  assert.equal(auth.checkCode('user-3', code, now + auth.CODE_TTL_MS + 1), 'expired');

  assert.equal(auth.issueCode('user-3', now + 10_000).retryAfterSec, 50);
  let t = now;
  for (let i = 1; i < auth.CODE_MAX_PER_HOUR; i++) {
    t += auth.CODE_RESEND_MS;
    assert.ok(auth.issueCode('user-3', t).code);
  }
  t += auth.CODE_RESEND_MS;
  assert.ok(auth.issueCode('user-3', t).retryAfterSec > 0, 'hourly limit');
  assert.ok(auth.issueCode('user-3', now + 60 * 60_000 + 1).code, 'allowed again an hour after the first code');

  // A code whose email could not be sent doesn't count.
  const later = now + 3 * 60 * 60_000;
  auth.issueCode('user-4', later);
  auth.withdrawCode('user-4');
  assert.ok(auth.issueCode('user-4', later + 1000).code);
});

test('sessions are found by their cookie value, expire, and end', async () => {
  const token = await auth.createSession('user-5');
  const session = await auth.findSession(token);
  assert.equal(session.userId, 'user-5');
  assert.equal(await auth.findSession(`${token.split('.')[0]}.forged`), null);
  assert.equal(await auth.findSession('not-a-session'), null);
  assert.equal(await auth.findSession(`${token}.extra`), null);
  assert.equal(await auth.findSession(token, Date.now() + auth.SESSION_TTL_MS + 1), null);
  assert.equal(await auth.findSession(token), null, 'an expired session is deleted');

  const a = await auth.createSession('user-6');
  const b = await auth.createSession('user-6');
  const other = await auth.createSession('user-7');
  await auth.endUserSessions('user-6');
  assert.equal(await auth.findSession(a), null);
  assert.equal(await auth.findSession(b), null);
  assert.ok(await auth.findSession(other));
  // Ended with a reason: the session is kept, marked, so the next request can say why.
  const c = await auth.createSession('user-8');
  await auth.endUserSessions('user-8', 'disabled');
  assert.equal((await auth.findSession(c)).ended, 'disabled');
  await auth.endSession((await auth.findSession(other)).id);
  assert.equal(await auth.findSession(other), null);
});

test('parseCookies reads the session cookie among others', () => {
  assert.deepEqual(auth.parseCookies('a=1; opt_session=abc.def%3D; broken; =x; bad=%E0%A4%A'), { a: '1', opt_session: 'abc.def=' });
  assert.deepEqual(auth.parseCookies(undefined), {});
});

test('emails escape names and carry the link or code', () => {
  const invite = inviteEmail({ name: '<b>Asha</b>', email: 'asha@example.com', link: 'http://localhost:3000/?email=asha%40example.com', invitedBy: 'Admin' });
  assert.match(invite.html, /&lt;b&gt;Asha&lt;\/b&gt;/);
  assert.doesNotMatch(invite.html, /<b>Asha/);
  assert.match(invite.text, /http:\/\/localhost:3000\/\?email=asha%40example\.com/);
  const code = codeEmail({ name: 'Asha', code: '042917', minutes: 10 });
  assert.match(code.text, /042917/);
  assert.match(code.html, /042917/);
  assert.match(code.text, /10 minutes/);
});
