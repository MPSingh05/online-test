// Reference question paper: "Jutro Associate Exam – Objective Question Bank" (29-page PDF, 111 questions in
// four sections, answer key as tables at the end). The PDF and the values expected from it (answer key, section
// titles and sample question text, in jutro-expected.json) are exam material, so both live in test/fixtures and
// are not committed; these tests are skipped when either is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractQuestionPaperText } from '../lib/parse.js';
import { parseQuestionPaper } from '../lib/questionPaper.js';
import { extractQuestionBank } from '../lib/generator/index.js';
import { gradeAttempt } from '../lib/grading.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/jutro-question-bank.pdf', import.meta.url));
const EXPECTED = fileURLToPath(new URL('./fixtures/jutro-expected.json', import.meta.url));
const missing = [FIXTURE, EXPECTED].filter((file) => !existsSync(file)).map((file) => basename(file));
const skip = missing.length ? `reference files not present in test/fixtures: ${missing.join(', ')}` : false;

// expected.answerKey is the answer key printed at the end of the paper, typed in independently of the parser,
// as { "1": "B", "2": "AB", ... }. paperChecks and bankChecks are sample questions that cover tricky layouts.
const expected = skip ? null : JSON.parse(readFileSync(EXPECTED, 'utf8'));
const ANSWER_KEY = skip ? [] : Object.entries(expected.answerKey);

const letters = (correct) => correct.map((i) => 'ABCDEFGH'[i]).join('');

// Checks one question against a sample: exact text, text fragment, all options, or options by index.
function assertQuestion(q, check) {
  const label = `Q${check.number} (${check.covers})`;
  assert.ok(q, `${label} not found`);
  if (check.text !== undefined) assert.equal(q.text, check.text, label);
  if (check.textIncludes !== undefined) assert.ok(q.text.includes(check.textIncludes), `${label}: ${q.text}`);
  if (check.optionCount !== undefined) assert.equal(q.options.length, check.optionCount, label);
  if (Array.isArray(check.options)) assert.deepEqual(q.options, check.options, label);
  else for (const [i, option] of Object.entries(check.options ?? {})) assert.equal(q.options[i], option, label);
}

let parsed;
async function paper() {
  if (!parsed) {
    const { text } = await extractQuestionPaperText('jutro-question-bank.pdf', await readFile(FIXTURE));
    parsed = parseQuestionPaper(text);
  }
  return parsed;
}

test('reads all 111 questions with nothing skipped or flagged', { skip }, async () => {
  const { questions, skipped, unanswered, issues } = await paper();
  assert.equal(questions.length, 111);
  assert.equal(skipped, 0);
  assert.equal(unanswered, 0);
  assert.deepEqual(issues, []);
  assert.deepEqual(
    questions.map((q) => q.number),
    Array.from({ length: 111 }, (_, i) => String(i + 1)),
  );
});

test('every answer matches the answer key at the end of the paper', { skip }, async () => {
  const { questions } = await paper();
  const byNumber = new Map(questions.map((q) => [q.number, q]));
  assert.equal(ANSWER_KEY.length, 111);
  for (const [number, key] of ANSWER_KEY) assert.equal(letters(byNumber.get(number).correct), key, `Q${number}`);
});

test('groups questions into the four sections, without the question ranges in the titles', { skip }, async () => {
  const { questions } = await paper();
  const counts = {};
  for (const q of questions) counts[q.section] = (counts[q.section] || 0) + 1;
  assert.deepEqual(Object.values(counts), [19, 48, 17, 27]);
  assert.deepEqual(counts, expected.sections);
});

test('question and option text is clean: no running header, page numbers or type labels', { skip }, async () => {
  const { questions } = await paper();
  for (const q of questions) {
    for (const text of [q.text, ...q.options]) {
      assert.doesNotMatch(text, /Objective Question Bank|Page \d+ of \d+/, `Q${q.number}: ${text}`);
    }
    assert.doesNotMatch(q.text, /\((?:Single|Multiple) choice/, `Q${q.number}`);
  }
  const byNumber = new Map(questions.map((q) => [q.number, q]));
  for (const check of expected.paperChecks) assertQuestion(byNumber.get(check.number), check);
});

test('question bank keeps the paper order and adds "(Select N answers)" to multiple-answer questions', { skip }, async () => {
  const { text } = await extractQuestionPaperText('jutro-question-bank.pdf', await readFile(FIXTURE));
  const previous = process.env.QUESTION_ENGINE;
  process.env.QUESTION_ENGINE = 'offline';
  try {
    const bank = await extractQuestionBank({ id: 'doc-1', name: 'jutro-question-bank.pdf' }, text);
    assert.equal(bank.stats.found, 111);
    assert.equal(bank.stats.multi, ANSWER_KEY.filter(([, key]) => key.length > 1).length);
    assert.deepEqual(bank.sections.map((s) => s.questions.length), [19, 48, 17, 27]);
    const all = bank.sections.flatMap((s) => s.questions);
    const byNumber = new Map(all.map((q) => [q.number, q]));
    for (const [number, key] of ANSWER_KEY) {
      const q = byNumber.get(number);
      assert.equal(letters(q.correct), key, `Q${number}`);
      if (key.length > 1) assert.ok(q.text.endsWith(`(Select ${key.length} answers)`), `Q${number}: ${q.text}`);
    }
    for (const check of expected.bankChecks) assertQuestion(byNumber.get(check.number), check);

    // Marking against the stored key: all correct, then partial answers on multiple-answer questions.
    const testRecord = { config: { timeLimitMin: 60, passPercent: 70 }, questions: all };
    const timing = { startedAt: '2026-10-24T10:00:00Z', submittedAt: '2026-10-24T10:30:00Z' };
    const perfect = gradeAttempt(testRecord, { ...timing, answers: Object.fromEntries(all.map((q) => [q.id, q.correct])) });
    assert.equal(perfect.correct, 111);
    assert.equal(perfect.passed, true);
    const partial = gradeAttempt(testRecord, { ...timing, answers: Object.fromEntries(all.map((q) => [q.id, q.correct.slice(0, 1)])) });
    assert.equal(partial.correct, all.filter((q) => !q.multi).length);
    assert.equal(partial.wrong, all.filter((q) => q.multi).length);
  } finally {
    if (previous === undefined) delete process.env.QUESTION_ENGINE;
    else process.env.QUESTION_ENGINE = previous;
  }
});
