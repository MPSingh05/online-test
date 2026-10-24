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

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_MB = 25;
const MAX_FILES = 10;
const MAX_QUESTIONS = 300;
const SUBMIT_GRACE_MS = 30_000; // allowance for network delay on the final auto-submit
const JOB_TTL_MS = 60 * 60_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(here, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
});

// ---------- helpers ----------

function cleanMobile(value) {
  const mobile = String(value ?? '').replace(/[\s()-]/g, '');
  if (!/^\+?\d{10,15}$/.test(mobile)) {
    throw new HttpError(400, 'Enter a valid mobile number: 10–15 digits, optionally starting with +.');
  }
  return mobile;
}

function cleanUser(user) {
  const name = String(user?.name ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Enter your full name (2–60 characters).');
  return { name, mobile: cleanMobile(user?.mobile) };
}

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

const docSummary = (doc) =>
  isQuestionPaper(doc)
    ? {
        id: doc.id,
        name: doc.name,
        kind: 'questions',
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
  questionCount: test.questions.length,
  multiCount: test.questions.filter((q) => q.multi).length,
  sections: test.sections,
  warnings: test.warnings,
});

const isExpired = (attempt) => Date.now() > new Date(attempt.deadline).getTime() + SUBMIT_GRACE_MS;

async function loadAttempt(id) {
  const attempt = await store.get('attempts', id);
  if (!attempt) throw new HttpError(404, 'Test attempt not found.');
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

// ---------- routes ----------

app.get('/api/config', (req, res) => {
  res.json({
    engine: activeEngine(),
    limits: { maxFileMb: MAX_FILE_MB, maxFiles: MAX_FILES, maxQuestions: MAX_QUESTIONS, maxPerSection: MAX_PER_SECTION },
    supportedExtensions: SUPPORTED_EXTENSIONS,
  });
});

// `kind` says what the files are: study material to write new questions from ("content", the default)
// or question papers whose own questions are used as they are ("questions").
app.post('/api/documents', upload.array('files', MAX_FILES), async (req, res) => {
  if (!req.files?.length) throw new HttpError(400, 'Choose at least one file to upload.');
  const kind = req.body?.kind === 'questions' ? 'questions' : 'content';
  const documents = [];
  const errors = [];
  for (const file of req.files) {
    const name = fixFileName(file.originalname);
    const id = store.newId();
    try {
      const parsed = kind === 'questions' ? await readQuestionPaper(id, name, file.buffer) : await readStudyMaterial(name, file.buffer);
      const doc = { id, name, size: file.size, uploadedAt: new Date().toISOString(), ...parsed };
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

app.get('/api/documents/:id', async (req, res) => {
  const doc = await store.get('documents', req.params.id);
  if (!doc) throw new HttpError(404, 'Document not found.');
  res.json(docSummary(doc));
});

// The questions and answer key read from a question paper, so the user can check them before a test.
app.get('/api/documents/:id/questions', async (req, res) => {
  const doc = await store.get('documents', req.params.id);
  if (!doc) throw new HttpError(404, 'Document not found.');
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
  const user = cleanUser(body.user);
  const timeLimitMin = intInRange(body.timeLimitMin, 1, 300, 'Time limit (minutes)');
  const passPercent = intInRange(body.passPercent ?? 60, 1, 100, 'Passing score (%)');
  const questionType = ['mixed', 'single', 'multiple'].includes(body.questionType) ? body.questionType : 'mixed';
  const difficulty = ['mixed', 'easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'mixed';

  const picks = [];
  const docs = new Map();
  for (const sel of Array.isArray(body.selections) ? body.selections : []) {
    if (!docs.has(sel.docId)) docs.set(sel.docId, await store.get('documents', sel.docId));
    const doc = docs.get(sel.docId);
    const section = doc?.sections.find((s) => s.id === sel.sectionId);
    if (!section) throw new HttpError(400, 'A selected section no longer exists. Upload the document again.');
    const max = isQuestionPaper(doc) ? section.questions.length : MAX_PER_SECTION;
    const count = intInRange(sel.count, 0, max, `Questions from "${section.title}"`);
    if (count) picks.push({ doc, section, count });
  }
  const total = picks.reduce((sum, p) => sum + p.count, 0);
  if (!total) throw new HttpError(400, 'Choose how many questions to generate from at least one section.');
  if (total > MAX_QUESTIONS) throw new HttpError(400, `A test can have at most ${MAX_QUESTIONS} questions.`);

  const usedDocs = [...new Map(picks.map((p) => [p.doc.id, p.doc])).values()];
  const title = String(body.title ?? '').trim().slice(0, 100) || `Practice test: ${usedDocs.map((d) => d.name).join(', ')}`.slice(0, 100);

  const job = { id: store.newId(), status: 'running', completed: 0, total: picks.length, createdAt: Date.now() };
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
      createdBy: user,
      engine,
      config: { timeLimitMin, passPercent, questionType, difficulty },
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
  if (!job) throw new HttpError(404, 'Generation job not found. It may have expired; please generate the test again.');
  res.json(job);
});

app.get('/api/tests/:id', async (req, res) => {
  const test = await store.get('tests', req.params.id);
  if (!test) throw new HttpError(404, 'Test not found.');
  res.json(testSummary(test));
});

app.post('/api/tests/:id/attempts', async (req, res) => {
  const test = await store.get('tests', req.params.id);
  if (!test) throw new HttpError(404, 'Test not found.');
  const user = cleanUser(req.body?.user);
  const startedAt = new Date();
  const attempt = {
    id: store.newId(),
    testId: test.id,
    testTitle: test.title,
    user,
    status: 'in_progress',
    startedAt: startedAt.toISOString(),
    deadline: new Date(startedAt.getTime() + test.config.timeLimitMin * 60_000).toISOString(),
    answers: {},
  };
  await store.put('attempts', attempt);
  res.status(201).json({ attemptId: attempt.id });
});

app.get('/api/attempts/:id', async (req, res) => {
  const { attempt, test } = await loadAttempt(req.params.id);
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
  const { attempt, test } = await loadAttempt(req.params.id);
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
  const { attempt, test } = await loadAttempt(req.params.id);
  if (attempt.status === 'in_progress') {
    if (isExpired(attempt)) await finalizeIfExpired(test, attempt);
    else await finalize(test, attempt, req.body?.answers ?? attempt.answers, { auto: Boolean(req.body?.auto) });
  }
  res.json(submittedView(test, attempt));
});

app.get('/api/reports', async (req, res) => {
  const mobile = cleanMobile(req.query.mobile);
  const attempts = await store.list('attempts', (a) => a.user?.mobile === mobile);
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
  res.json({ attempts: rows });
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
  res.status(err.status || 500).json({ error: err instanceof HttpError ? err.message : 'Something went wrong on the server.' });
});

await store.initStore();
const server = app.listen(PORT, () => {
  const engine = activeEngine();
  console.log(`Online test practice portal running at http://localhost:${PORT}`);
  console.log(`Question generator: ${engine.label}`);
  if (engine.id === 'offline') console.log('Set ANTHROPIC_API_KEY in .env to generate questions with Claude.');
});
server.requestTimeout = 10 * 60_000;
