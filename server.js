import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import * as store from './lib/store.js';
import { extractBlocks, extractQuestionPaperText, SUPPORTED_EXTENSIONS, UnsupportedFileError } from './lib/parse.js';
import { buildSections, countWords } from './lib/sections.js';
import {
  generateQuestions,
  extractQuestionBank,
  activeEngine,
  splitByType,
  GenerationError,
  MAX_PER_SECTION,
} from './lib/generator/index.js';
import { cleanAnswers, gradeAttempt, buildReview } from './lib/grading.js';
import * as auth from './lib/auth.js';
import { mailConfigured, sendMail, verifyMail, inviteEmail, codeEmail } from './lib/mailer.js';
import {
  GENDERS,
  CAPABILITIES,
  adminEmails,
  isAdmin,
  canSignIn,
  canSeeDocument,
  validateUser,
  normalizeEmail,
  isEmail,
  publicUser,
} from './lib/users.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// The address users open from their invite email.
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const MAX_FILE_MB = 25;
const MAX_FILES = 10;
const MAX_QUESTIONS = 300;
const SUBMIT_GRACE_MS = 30_000; // allowance for network delay on the final auto-submit
const JOB_TTL_MS = 60 * 60_000;

class HttpError extends Error {
  // `fields` maps form field names to messages, for forms that show errors next to each field.
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const SIGN_IN_MESSAGE = 'Please sign in to continue.';
const DISABLED_MESSAGE = 'Your access has been disabled. Contact your administrator.';
// Why a user's sessions were ended by an admin, shown on their next request.
const ENDED_MESSAGES = {
  disabled: DISABLED_MESSAGE,
  'email-changed': 'Your administrator changed your email address. Use the invite sent to the new address to sign in.',
};
const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: APP_URL.startsWith('https:'), path: '/' };

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(here, 'public')));

// Requests that change data must come from the portal's own pages (on top of the SameSite session cookie).
function isOwnOrigin(origin, host) {
  try {
    const url = new URL(origin);
    return url.host === host || url.origin === new URL(APP_URL).origin;
  } catch {
    return false;
  }
}
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers.origin && !isOwnOrigin(req.headers.origin, req.headers.host)) {
    throw new HttpError(403, 'Requests from other sites are not allowed.');
  }
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
});

// ---------- helpers ----------

function intInRange(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

// Browsers send UTF-8 file names, which busboy decodes as latin1.
function fixFileName(name) {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}

const isQuestionPaper = (doc) => doc.kind === 'questions';

// Tests belong to the user who made them; admins can open every test. Tests from before sign-in existed
// have no owner, so only admins see them. (Documents are shared by course: see canSeeDocument.)
const canUse = (user, record) => user.role === 'admin' || record.ownerId === user.id;

// Admins sign in with ADMIN_PASSWORD when it is set, and with an emailed code only when it isn't.
const usesPassword = (user) => isAdmin(user) && Boolean(process.env.ADMIN_PASSWORD);

// Attempts from before sign-in existed carry only the candidate's name and mobile number.
const ownsAttempt = (user, attempt) =>
  attempt.userId ? attempt.userId === user.id : Boolean(user.mobile) && attempt.user?.mobile === user.mobile;

const userContact = (user) => ({ name: user.name, email: user.email, mobile: user.mobile ?? '' });

const findUserByEmail = async (email) => (await store.list('users', (u) => u.email === email))[0];

function formatWait(seconds) {
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

const docSummary = (doc) =>
  isQuestionPaper(doc)
    ? {
        id: doc.id,
        name: doc.name,
        kind: 'questions',
        courseId: doc.courseId ?? null,
        size: doc.size,
        uploadedAt: doc.uploadedAt,
        questionCount: doc.sections.reduce((sum, s) => sum + s.questions.length, 0),
        extraction: doc.extraction,
        sections: doc.sections.map((s) => ({
          id: s.id,
          title: s.title,
          questionCount: s.questions.length,
          preview: s.questions[0].baseText.slice(0, 220),
        })),
      }
    : {
        id: doc.id,
        name: doc.name,
        kind: 'content',
        courseId: doc.courseId ?? null,
        size: doc.size,
        uploadedAt: doc.uploadedAt,
        wordCount: doc.sections.reduce((sum, s) => sum + s.wordCount, 0),
        sections: doc.sections.map((s) => ({
          id: s.id,
          title: s.title,
          wordCount: s.wordCount,
          preview: s.text.replace(/\s+/g, ' ').slice(0, 220),
        })),
      };

async function readStudyMaterial(name, buffer) {
  const sections = buildSections(await extractBlocks(name, buffer));
  if (!sections.length || sections.every((s) => countWords(s.text) < 20)) {
    throw new UnsupportedFileError('No readable text found. Scanned PDFs (images of pages) are not supported.');
  }
  return { kind: 'content', sections };
}

async function readQuestionPaper(id, name, buffer) {
  const { text, pages } = await extractQuestionPaperText(name, buffer);
  const isPdf = name.toLowerCase().endsWith('.pdf');
  if (countWords(text) < 5 && !isPdf) throw new UnsupportedFileError('No readable text found in this file.');
  const bank = await extractQuestionBank({ id, name }, text, isPdf ? { buffer, pages } : null);
  if (!bank.stats.found) {
    const reason = bank.stats.unanswered
      ? `${bank.stats.unanswered} question(s) were found but none had an answer. Add an answer line (e.g. "Answer: b") or an answer key, or set ANTHROPIC_API_KEY so Claude can work out the answers.`
      : 'Questions need answer options such as "a) ... b) ...". If this document is study material, upload it as Study material instead.';
    throw new UnsupportedFileError(`No multiple-choice questions were found. ${reason}`);
  }
  return { kind: 'questions', sections: bank.sections, extraction: { engine: bank.engine, ...bank.stats } };
}

const publicQuestion = (q) => ({
  id: q.id,
  docName: q.docName,
  sectionTitle: q.sectionTitle,
  text: q.text,
  options: q.options,
  multi: q.multi,
  selectCount: q.selectCount,
});

const testSummary = (test) => ({
  id: test.id,
  title: test.title,
  createdAt: test.createdAt,
  engine: test.engine,
  config: test.config,
  courses: test.courses ?? [],
  questionCount: test.questions.length,
  multiCount: test.questions.filter((q) => q.multi).length,
  sections: test.sections,
  warnings: test.warnings,
});

const isExpired = (attempt) => Date.now() > new Date(attempt.deadline).getTime() + SUBMIT_GRACE_MS;

// Admins may view anyone's attempt; only its owner may answer or submit it.
async function loadAttempt(id, user, { write = false } = {}) {
  const attempt = await store.get('attempts', id);
  if (!attempt || !(ownsAttempt(user, attempt) || (!write && user.role === 'admin'))) {
    throw new HttpError(404, 'Test attempt not found.');
  }
  const test = await store.get('tests', attempt.testId);
  if (!test) throw new HttpError(404, 'The test for this attempt no longer exists.');
  return { attempt, test };
}

async function finalize(test, attempt, answers, { auto = false } = {}) {
  attempt.answers = cleanAnswers(test, answers);
  attempt.status = 'submitted';
  attempt.autoSubmitted = auto;
  attempt.submittedAt = auto ? attempt.deadline : new Date().toISOString();
  attempt.result = gradeAttempt(test, attempt);
  await store.put('attempts', attempt);
  return attempt;
}

// An attempt left open past its deadline (closed tab, lost connection) is graded on its saved answers.
async function finalizeIfExpired(test, attempt) {
  if (attempt.status === 'in_progress' && isExpired(attempt)) await finalize(test, attempt, attempt.answers, { auto: true });
  return attempt;
}

const submittedView = (test, attempt) => ({
  status: 'submitted',
  attemptId: attempt.id,
  test: { id: test.id, title: test.title, engine: test.engine, config: test.config },
  user: attempt.user,
  startedAt: attempt.startedAt,
  submittedAt: attempt.submittedAt,
  autoSubmitted: attempt.autoSubmitted,
  result: attempt.result,
  review: buildReview(test, attempt),
});

// ---------- generation jobs (kept in memory; they only live while the client waits) ----------

const jobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}, 10 * 60_000).unref();

// ---------- sign-in (email + one-time code) ----------

async function currentSession(req) {
  const session = await auth.findSession(auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE]);
  if (!session) return {};
  return { session, user: await store.get('users', session.userId) };
}

// Why a session can no longer be used, or null if it can.
function sessionRefusal(session, user) {
  if (session.ended) return ENDED_MESSAGES[session.ended] ?? SIGN_IN_MESSAGE;
  if (!user || !canSignIn(user)) return user?.enabled === false ? DISABLED_MESSAGE : SIGN_IN_MESSAGE;
  return null;
}

async function dropSession(res, session) {
  await auth.endSession(session.id);
  res.clearCookie(auth.SESSION_COOKIE, cookieOptions);
}

app.get('/api/auth/me', async (req, res) => {
  const { session, user } = await currentSession(req);
  if (!session) return res.json({ user: null, notice: null });
  const refusal = sessionRefusal(session, user);
  if (!refusal) return res.json({ user: publicUser(user) });
  await dropSession(res, session);
  res.json({ user: null, notice: refusal });
});

async function startSession(res, user) {
  user.lastLoginAt = new Date().toISOString();
  await store.put('users', user);
  res.cookie(auth.SESSION_COOKIE, await auth.createSession(user.id), { ...cookieOptions, maxAge: auth.SESSION_TTL_MS });
}

// Answers the same way whether or not the address has an invite, so the form can't be used to find out
// who has an account. Only invited, enabled users are sent a code (and admins, if no password is set).
app.post('/api/auth/request-code', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.', { email: 'Enter a valid email address.' });
  const user = await findUserByEmail(email);
  if (!user || !canSignIn(user) || usesPassword(user)) return res.json({ ok: true });
  const issued = auth.issueCode(user.id);
  if (!issued.code) throw new HttpError(429, `Please wait ${formatWait(issued.retryAfterSec)} before asking for another code.`);
  try {
    await sendMail({ to: user.email, ...codeEmail({ name: user.name, code: issued.code, minutes: auth.CODE_TTL_MS / 60_000 }) });
  } catch (err) {
    auth.withdrawCode(user.id);
    console.error(`Could not email a sign-in code to ${user.email}:`, err.message);
    throw new HttpError(502, 'The email could not be sent right now. Please try again in a few minutes.');
  }
  res.json({ ok: true });
});

app.post('/api/auth/verify', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const user = isEmail(email) ? await findUserByEmail(email) : null;
  const outcome = user && canSignIn(user) && !usesPassword(user) ? auth.checkCode(user.id, req.body?.code) : 'expired';
  if (outcome === 'expired') throw new HttpError(400, 'This code has expired or has already been used. Request a new code.');
  if (outcome === 'locked') throw new HttpError(400, 'Too many incorrect codes. Request a new code.');
  if (outcome !== 'ok') throw new HttpError(400, 'That code is not correct. Check the latest email and try again.');
  await startSession(res, user);
  res.json({ user: publicUser(user) });
});

// Administrators: email + ADMIN_PASSWORD. The password is checked even for unknown addresses, so the
// response time doesn't reveal which addresses are admins.
app.post('/api/auth/password', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const wait = auth.passwordRetryAfter(email);
  if (wait) throw new HttpError(429, `Too many incorrect attempts. Try again in ${formatWait(wait)}.`);
  const passwordOk = auth.checkPassword(req.body?.password, process.env.ADMIN_PASSWORD);
  const user = isEmail(email) && adminEmails().includes(email) ? await findUserByEmail(email) : null;
  if (!user || !passwordOk) {
    auth.recordPasswordFailure(email);
    throw new HttpError(400, 'Incorrect email or password.');
  }
  auth.clearPasswordFailures(email);
  await startSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  const { session } = await currentSession(req);
  if (session) await auth.endSession(session.id);
  res.clearCookie(auth.SESSION_COOKIE, cookieOptions);
  res.json({ ok: true });
});

// Every other API route needs a signed-in user who is still allowed in, checked on every request, so
// disabling a user takes effect on their very next click.
app.use('/api', async (req, res, next) => {
  const { session, user } = await currentSession(req);
  if (!session) throw new HttpError(401, SIGN_IN_MESSAGE);
  const refusal = sessionRefusal(session, user);
  if (refusal) {
    await dropSession(res, session);
    throw new HttpError(401, refusal);
  }
  req.user = { ...user, role: isAdmin(user) ? 'admin' : 'user' };
  next();
});

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can do this.');
  next();
};

// ---------- user management (admins) ----------

async function checkUserInput(body) {
  const { user, errors } = validateUser(body);
  if (Object.keys(errors).length) throw new HttpError(400, 'Check the highlighted fields.', errors);
  const courseIds = new Set((await store.list('courses')).map((c) => c.id));
  user.courses = user.courses.filter((id) => courseIds.has(id));
  return user;
}

async function loadUser(id) {
  const user = await store.get('users', id);
  if (!user) throw new HttpError(404, 'User not found.');
  return user;
}

async function sendInvite(user, admin) {
  const link = `${APP_URL}/?email=${encodeURIComponent(user.email)}`;
  const { delivery } = await sendMail({
    to: user.email,
    ...inviteEmail({ name: user.name, email: user.email, link, invitedBy: admin.name }),
  });
  user.invitedAt = new Date().toISOString();
  user.invitedBy = admin.id;
  user.inviteCount = (user.inviteCount ?? 0) + 1;
  await store.put('users', user);
  return delivery;
}

// Admins first, then everyone else with the newest first.
const userOrder = (a, b) => isAdmin(b) - isAdmin(a) || String(b.createdAt).localeCompare(String(a.createdAt));

app.get('/api/users', requireAdmin, async (req, res) => {
  const users = (await store.list('users')).sort(userOrder);
  res.json({ users: users.map(publicUser), emailConfigured: mailConfigured() });
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const input = await checkUserInput(req.body);
  if (await findUserByEmail(input.email)) {
    throw new HttpError(409, 'Check the highlighted fields.', { email: 'A user with this email address already exists.' });
  }
  const now = new Date().toISOString();
  const user = { id: store.newId(), ...input, enabled: true, invitedAt: null, createdAt: now, createdBy: req.user.id, updatedAt: now };
  await store.put('users', user);
  // The user is saved even if the invite email fails; the admin can send it again from the list.
  let invite = null;
  if (req.body?.sendInvite) {
    try {
      invite = { delivery: await sendInvite(user, req.user) };
    } catch (err) {
      console.error(`Could not email an invite to ${user.email}:`, err.message);
      invite = { error: `The invite email could not be sent: ${err.message}` };
    }
  }
  res.status(201).json({ user: publicUser(user), invite });
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const user = await loadUser(req.params.id);
  const input = await checkUserInput(req.body);
  if (input.email !== user.email) {
    if (isAdmin(user)) {
      throw new HttpError(400, 'Check the highlighted fields.', { email: "An administrator's address is set by ADMIN_EMAIL in the server's .env file." });
    }
    if (await findUserByEmail(input.email)) {
      throw new HttpError(409, 'Check the highlighted fields.', { email: 'A user with this email address already exists.' });
    }
    // The invite went to the old address, so the new one needs its own invite before it can be used.
    user.invitedAt = null;
    await auth.endUserSessions(user.id, 'email-changed');
  }
  Object.assign(user, input, { updatedAt: new Date().toISOString() });
  await store.put('users', user);
  res.json({ user: publicUser(user) });
});

app.post('/api/users/:id/invite', requireAdmin, async (req, res) => {
  const user = await loadUser(req.params.id);
  if (isAdmin(user)) throw new HttpError(400, 'Administrators sign in without an invite.');
  if (user.enabled === false) throw new HttpError(409, 'Enable this user before sending an invite.');
  let delivery;
  try {
    delivery = await sendInvite(user, req.user);
  } catch (err) {
    console.error(`Could not email an invite to ${user.email}:`, err.message);
    throw new HttpError(502, `The invite email could not be sent: ${err.message}`);
  }
  res.json({ user: publicUser(user), delivery });
});

app.put('/api/users/:id/enabled', requireAdmin, async (req, res) => {
  const user = await loadUser(req.params.id);
  if (isAdmin(user)) throw new HttpError(400, 'Administrators cannot be disabled here. Remove the address from ADMIN_EMAIL instead.');
  if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'Say whether the user should be enabled.');
  user.enabled = req.body.enabled;
  user.updatedAt = new Date().toISOString();
  await store.put('users', user);
  if (!user.enabled) await auth.endUserSessions(user.id, 'disabled');
  res.json({ user: publicUser(user) });
});

app.get('/api/config', (req, res) => {
  res.json({
    engine: activeEngine(),
    limits: { maxFileMb: MAX_FILE_MB, maxFiles: MAX_FILES, maxQuestions: MAX_QUESTIONS, maxPerSection: MAX_PER_SECTION },
    supportedExtensions: SUPPORTED_EXTENSIONS,
    userOptions: { genders: GENDERS, capabilities: CAPABILITIES },
  });
});

// ---------- courses and documents ----------
// Admins upload documents into courses and give users access to courses. Users see, and build tests
// from, the documents of their courses only.

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

function cleanCourseName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Check the course name.', { name: 'Enter a course name of 2–80 characters.' });
  return name;
}

async function checkCourseNameFree(name, exceptId) {
  const taken = await store.list('courses', (c) => c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase());
  if (taken.length) throw new HttpError(409, 'Check the course name.', { name: 'A course with this name already exists.' });
}

async function loadCourse(id) {
  const course = await store.get('courses', id);
  if (!course) throw new HttpError(404, 'Course not found.');
  return course;
}

// The courses and documents the signed-in user may see. Admins also get how many users have each course.
app.get('/api/library', async (req, res) => {
  const admin = req.user.role === 'admin';
  const allowed = new Set(req.user.courses ?? []);
  const courses = (await store.list('courses', (c) => admin || allowed.has(c.id))).sort(byName);
  const documents = (await store.list('documents', (d) => canSeeDocument(req.user, d))).sort(byName);
  const users = admin ? await store.list('users', (u) => !isAdmin(u)) : [];
  res.json({
    courses: courses.map((c) => ({
      id: c.id,
      name: c.name,
      documentCount: documents.filter((d) => d.courseId === c.id).length,
      ...(admin ? { userCount: users.filter((u) => (u.courses ?? []).includes(c.id)).length } : {}),
    })),
    documents: documents.map(docSummary),
  });
});

app.post('/api/courses', requireAdmin, async (req, res) => {
  const name = cleanCourseName(req.body?.name);
  await checkCourseNameFree(name);
  const course = { id: store.newId(), name, createdAt: new Date().toISOString(), createdBy: req.user.id };
  await store.put('courses', course);
  res.status(201).json({ course });
});

app.put('/api/courses/:id', requireAdmin, async (req, res) => {
  const course = await loadCourse(req.params.id);
  const name = cleanCourseName(req.body?.name);
  await checkCourseNameFree(name, course.id);
  course.name = name;
  await store.put('courses', course);
  res.json({ course });
});

// Only an empty course can be deleted; it is also taken off every user who had it.
app.delete('/api/courses/:id', requireAdmin, async (req, res) => {
  const course = await loadCourse(req.params.id);
  if ((await store.list('documents', (d) => d.courseId === course.id)).length) {
    throw new HttpError(409, 'Move or delete the documents in this course before deleting it.');
  }
  for (const user of await store.list('users', (u) => (u.courses ?? []).includes(course.id))) {
    user.courses = user.courses.filter((id) => id !== course.id);
    await store.put('users', user);
  }
  await store.remove('courses', course.id);
  res.json({ ok: true });
});

// `kind` says what the files are: study material to write new questions from ("content", the default)
// or question papers whose own questions are used as they are ("questions"). `courseId` is required.
app.post('/api/documents', requireAdmin, upload.array('files', MAX_FILES), async (req, res) => {
  if (!req.files?.length) throw new HttpError(400, 'Choose at least one file to upload.');
  const course = req.body?.courseId ? await store.get('courses', req.body.courseId) : null;
  if (!course) throw new HttpError(400, 'Choose the course these documents belong to.');
  const kind = req.body?.kind === 'questions' ? 'questions' : 'content';
  const documents = [];
  const errors = [];
  for (const file of req.files) {
    const name = fixFileName(file.originalname);
    const id = store.newId();
    try {
      const parsed = kind === 'questions' ? await readQuestionPaper(id, name, file.buffer) : await readStudyMaterial(name, file.buffer);
      const doc = { id, name, courseId: course.id, size: file.size, uploadedAt: new Date().toISOString(), uploadedBy: req.user.id, ...parsed };
      await store.put('documents', doc);
      documents.push(docSummary(doc));
    } catch (err) {
      const known = err instanceof UnsupportedFileError || err instanceof GenerationError;
      if (!known) console.error(`Could not read ${name}:`, err);
      errors.push({ name, error: known ? err.message : 'This file could not be read. Is it a valid, unprotected document?' });
    }
  }
  res.json({ documents, errors });
});

async function loadDocument(id, user) {
  const doc = await store.get('documents', id);
  if (!doc || !canSeeDocument(user, doc)) throw new HttpError(404, 'Document not found.');
  return doc;
}

app.get('/api/documents/:id', async (req, res) => {
  res.json(docSummary(await loadDocument(req.params.id, req.user)));
});

// Moves a document to another course.
app.put('/api/documents/:id', requireAdmin, async (req, res) => {
  const doc = await loadDocument(req.params.id, req.user);
  doc.courseId = (await loadCourse(String(req.body?.courseId ?? ''))).id;
  await store.put('documents', doc);
  res.json({ document: docSummary(doc) });
});

// Tests already built from the document keep their own copy of its questions, so they still work.
app.delete('/api/documents/:id', requireAdmin, async (req, res) => {
  const doc = await loadDocument(req.params.id, req.user);
  await store.remove('documents', doc.id);
  res.json({ ok: true });
});

// The questions and answer key read from a question paper, for admins to check. Users never see it,
// since they take tests built from these questions.
app.get('/api/documents/:id/questions', requireAdmin, async (req, res) => {
  const doc = await loadDocument(req.params.id, req.user);
  if (!isQuestionPaper(doc)) throw new HttpError(400, 'This document is study material, not a question paper.');
  res.json({
    ...docSummary(doc),
    sections: doc.sections.map((s) => ({
      id: s.id,
      title: s.title,
      questions: s.questions.map((q) => ({
        id: q.id,
        number: q.number,
        text: q.text,
        options: q.options,
        correct: q.correct,
        multi: q.multi,
        answerSuggested: q.answerSuggested,
        explanation: q.explanation,
      })),
    })),
  });
});

app.post('/api/tests', async (req, res) => {
  const body = req.body ?? {};
  const timeLimitMin = intInRange(body.timeLimitMin, 1, 300, 'Time limit (minutes)');
  const passPercent = intInRange(body.passPercent ?? 60, 1, 100, 'Passing score (%)');
  const questionType = ['mixed', 'single', 'multiple'].includes(body.questionType) ? body.questionType : 'mixed';
  const difficulty = ['mixed', 'easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'mixed';

  const picks = [];
  const docs = new Map();
  for (const sel of Array.isArray(body.selections) ? body.selections : []) {
    if (!docs.has(sel.docId)) docs.set(sel.docId, await store.get('documents', sel.docId));
    const doc = docs.get(sel.docId);
    const section = doc && canSeeDocument(req.user, doc) ? doc.sections.find((s) => s.id === sel.sectionId) : null;
    if (!section) throw new HttpError(400, 'A selected document is no longer available to you. Reload the page and choose again.');
    const max = isQuestionPaper(doc) ? section.questions.length : MAX_PER_SECTION;
    const count = intInRange(sel.count, 0, max, `Questions from "${section.title}"`);
    if (count) picks.push({ doc, section, count });
  }
  const total = picks.reduce((sum, p) => sum + p.count, 0);
  if (!total) throw new HttpError(400, 'Choose how many questions to generate from at least one section.');
  if (total > MAX_QUESTIONS) throw new HttpError(400, `A test can have at most ${MAX_QUESTIONS} questions.`);

  const usedDocs = [...new Map(picks.map((p) => [p.doc.id, p.doc])).values()];
  const title = String(body.title ?? '').trim().slice(0, 100) || `Practice test: ${usedDocs.map((d) => d.name).join(', ')}`.slice(0, 100);
  const courseNames = [];
  for (const courseId of new Set(usedDocs.map((d) => d.courseId).filter(Boolean))) {
    const course = await store.get('courses', courseId);
    if (course) courseNames.push(course.name);
  }

  const job = { id: store.newId(), userId: req.user.id, status: 'running', completed: 0, total: picks.length, createdAt: Date.now() };
  jobs.set(job.id, job);
  res.status(202).json({ jobId: job.id, engine: activeEngine() });

  try {
    const { engine, questions, warnings } = await generateQuestions({
      picks,
      questionType,
      difficulty,
      onProgress: (done) => (job.completed = done),
    });
    if (!questions.length) throw new GenerationError('No questions could be generated from the selected sections.');
    const test = {
      id: store.newId(),
      title,
      createdAt: new Date().toISOString(),
      ownerId: req.user.id,
      createdBy: userContact(req.user),
      engine,
      config: { timeLimitMin, passPercent, questionType, difficulty },
      courses: courseNames,
      documents: usedDocs.map((d) => ({ id: d.id, name: d.name })),
      sections: picks.map((p) => ({
        docName: p.doc.name,
        kind: isQuestionPaper(p.doc) ? 'questions' : 'content',
        sectionTitle: p.section.title,
        requested: p.count,
        generated: questions.filter((q) => q.docId === p.doc.id && q.sectionId === p.section.id).length,
        ...(isQuestionPaper(p.doc) ? {} : splitByType(p.count, questionType)),
      })),
      warnings,
      questions,
    };
    await store.put('tests', test);
    Object.assign(job, { status: 'done', testId: test.id, warnings });
  } catch (err) {
    console.error('Question generation failed:', err);
    Object.assign(job, {
      status: 'error',
      error: err instanceof GenerationError ? err.message : 'Question generation failed. Check the server log for details.',
    });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.userId !== req.user.id) {
    throw new HttpError(404, 'Generation job not found. It may have expired; please generate the test again.');
  }
  res.json(job);
});

async function loadTest(id, user) {
  const test = await store.get('tests', id);
  if (!test || !canUse(user, test)) throw new HttpError(404, 'Test not found.');
  return test;
}

app.get('/api/tests/:id', async (req, res) => {
  res.json(testSummary(await loadTest(req.params.id, req.user)));
});

app.post('/api/tests/:id/attempts', async (req, res) => {
  const test = await loadTest(req.params.id, req.user);
  const startedAt = new Date();
  const attempt = {
    id: store.newId(),
    testId: test.id,
    testTitle: test.title,
    userId: req.user.id,
    user: userContact(req.user),
    status: 'in_progress',
    startedAt: startedAt.toISOString(),
    deadline: new Date(startedAt.getTime() + test.config.timeLimitMin * 60_000).toISOString(),
    answers: {},
  };
  await store.put('attempts', attempt);
  res.status(201).json({ attemptId: attempt.id });
});

app.get('/api/attempts/:id', async (req, res) => {
  const { attempt, test } = await loadAttempt(req.params.id, req.user);
  await finalizeIfExpired(test, attempt);
  if (attempt.status === 'submitted') return res.json(submittedView(test, attempt));
  res.json({
    status: 'in_progress',
    attemptId: attempt.id,
    test: { id: test.id, title: test.title, config: test.config },
    user: attempt.user,
    startedAt: attempt.startedAt,
    deadline: attempt.deadline,
    serverNow: new Date().toISOString(),
    answers: attempt.answers,
    questions: test.questions.map(publicQuestion),
  });
});

app.put('/api/attempts/:id/answers', async (req, res) => {
  const { attempt, test } = await loadAttempt(req.params.id, req.user, { write: true });
  if (attempt.status !== 'in_progress') throw new HttpError(409, 'This test has already been submitted.');
  if (isExpired(attempt)) {
    await finalizeIfExpired(test, attempt);
    throw new HttpError(409, 'Time is up. The test was submitted automatically.');
  }
  attempt.answers = cleanAnswers(test, req.body?.answers);
  await store.put('attempts', attempt);
  res.json({ ok: true });
});

app.post('/api/attempts/:id/submit', async (req, res) => {
  const { attempt, test } = await loadAttempt(req.params.id, req.user, { write: true });
  if (attempt.status === 'in_progress') {
    if (isExpired(attempt)) await finalizeIfExpired(test, attempt);
    else await finalize(test, attempt, req.body?.answers ?? attempt.answers, { auto: Boolean(req.body?.auto) });
  }
  res.json(submittedView(test, attempt));
});

// The signed-in user's own attempts; admins can pass ?userId= to see anyone's.
app.get('/api/reports', async (req, res) => {
  let subject = req.user;
  if (req.query.userId && req.query.userId !== req.user.id) {
    if (req.user.role !== 'admin') throw new HttpError(403, 'You can only see your own reports.');
    subject = await loadUser(String(req.query.userId));
  }
  const attempts = await store.list('attempts', (a) => ownsAttempt(subject, a));
  const tests = new Map();
  const rows = [];
  for (const attempt of attempts) {
    if (!tests.has(attempt.testId)) tests.set(attempt.testId, await store.get('tests', attempt.testId));
    const test = tests.get(attempt.testId);
    if (!test) continue;
    await finalizeIfExpired(test, attempt);
    rows.push({
      attemptId: attempt.id,
      testId: test.id,
      title: test.title,
      courses: test.courses ?? [],
      documents: test.documents.map((d) => d.name),
      questionCount: test.questions.length,
      timeLimitMin: test.config.timeLimitMin,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadline: attempt.deadline,
      submittedAt: attempt.submittedAt ?? null,
      autoSubmitted: attempt.autoSubmitted ?? false,
      result: attempt.result ?? null,
    });
  }
  rows.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json({ user: publicUser(subject), attempts: rows });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Each file must be ${MAX_FILE_MB} MB or smaller.`
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? `Upload at most ${MAX_FILES} files at a time.`
          : err.message;
    return res.status(400).json({ error: message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON in request body.' });
  if (!(err instanceof HttpError)) console.error(err);
  if (!(err instanceof HttpError)) return res.status(500).json({ error: 'Something went wrong on the server.' });
  res.status(err.status).json({ error: err.message, ...(err.fields ? { fields: err.fields } : {}) });
});

// Every address in ADMIN_EMAIL gets an account, so admins can sign in without an invite.
async function ensureAdmins() {
  const emails = adminEmails();
  for (const email of emails) {
    if (await findUserByEmail(email)) continue;
    const now = new Date().toISOString();
    await store.put('users', { id: store.newId(), name: 'Administrator', email, enabled: true, capabilities: [], createdAt: now, updatedAt: now });
  }
  return emails;
}

await store.initStore();
const admins = await ensureAdmins();
setInterval(() => auth.pruneCodes(), 10 * 60_000).unref();
const server = app.listen(PORT, () => {
  const engine = activeEngine();
  console.log(`Online test practice portal running at http://localhost:${PORT}`);
  console.log(`Question generator: ${engine.label}`);
  if (engine.id === 'offline') console.log('Set ANTHROPIC_API_KEY in .env to generate questions with Claude.');
  console.log(admins.length ? `Administrators: ${admins.join(', ')}` : 'No administrator: set ADMIN_EMAIL in .env to the address that manages users, then restart.');
  if (admins.length) {
    console.log(
      process.env.ADMIN_PASSWORD
        ? 'Administrators sign in with ADMIN_PASSWORD.'
        : 'ADMIN_PASSWORD is not set, so administrators sign in with an emailed code. Set it in .env to use a password.',
    );
  }
  console.log(`Invite emails link to ${APP_URL}`);
  if (!mailConfigured()) {
    console.log('Email is not configured (SMTP_HOST in .env): invites and sign-in codes are printed here instead of being sent.');
  } else {
    verifyMail().then((check) =>
      console.log(check.ok ? `Email is sent through ${process.env.SMTP_HOST}.` : `Email: could not connect to ${process.env.SMTP_HOST}: ${check.error}`),
    );
  }
});
server.requestTimeout = 10 * 60_000;
