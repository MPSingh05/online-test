import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHeading, textToBlocks, htmlToBlocks } from '../lib/parse.js';
import { buildSections } from '../lib/sections.js';
import { normalizeQuestion, splitByType } from '../lib/generator/index.js';
import { generateOffline } from '../lib/generator/offline.js';
import { questionStatus, gradeAttempt } from '../lib/grading.js';

const sentence = (topic, i) => `${topic} fact number ${i} explains an important idea that students should remember for the exam.`;
const paragraph = (topic, n) => Array.from({ length: n }, (_, i) => sentence(topic, i + 1)).join(' ');

test('detectHeading recognises common heading styles', () => {
  assert.deepEqual(detectHeading('## Cell Structure'), { level: 2, text: 'Cell Structure' });
  assert.equal(detectHeading('1. Introduction to Networks').level, 1);
  assert.equal(detectHeading('2.3 Transport Layer').level, 2);
  assert.equal(detectHeading('Chapter 4: Genetics').level, 1);
  assert.equal(detectHeading('INNER PLANETS').level, 2);
  assert.equal(detectHeading('The cell is the basic unit of life.'), null);
  assert.equal(detectHeading('3 apples were eaten by the students'), null);
  assert.equal(detectHeading('2019 was a year of change'), null);
});

test('buildSections splits on headings and keeps titles', () => {
  const text = `# Topic One\n${paragraph('Alpha', 3)}\n\n# Topic Two\n${paragraph('Beta', 3)}`;
  const sections = buildSections(textToBlocks(text));
  assert.deepEqual(sections.map((s) => s.title), ['Topic One', 'Topic Two']);
  assert.ok(sections[0].text.includes('Alpha fact number 1'));
  assert.ok(!sections[0].text.includes('Beta'));
});

test('buildSections folds tiny sections into the previous one and prefixes empty parent headings', () => {
  const text = `CHAPTER 1 BASICS\n1.1 Overview\n${paragraph('Alpha', 3)}\n1.2 Note\nShort note only.\n1.3 Details\n${paragraph('Gamma', 3)}`;
  const sections = buildSections(textToBlocks(text));
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'CHAPTER 1 BASICS › 1.1 Overview');
  assert.ok(sections[0].text.includes('Short note only.'));
  assert.equal(sections[1].title, '1.3 Details');
});

test('buildSections splits long heading-less text into parts', () => {
  const text = paragraph('Delta', 200);
  const sections = buildSections(textToBlocks(text));
  assert.ok(sections.length > 1);
  assert.match(sections[0].title, /^Part 1$/);
  assert.equal(sections.reduce((n, s) => n + s.wordCount, 0), text.split(/\s+/).length, 'no words lost');
});

test('htmlToBlocks treats headings and fully bold short paragraphs as headings', () => {
  const blocks = htmlToBlocks('<h1>Networks</h1><p>Plain text &amp; more.</p><p><strong>Key Terms</strong></p><ul><li>Router</li></ul>');
  assert.deepEqual(blocks, [
    { type: 'heading', level: 1, text: 'Networks' },
    { type: 'para', text: 'Plain text & more.' },
    { type: 'heading', level: 3, text: 'Key Terms' },
    { type: 'para', text: '• Router' },
  ]);
});

const doc = { id: 'd1', name: 'notes.pdf' };
const section = { id: 's1', title: 'Basics' };

test('normalizeQuestion appends the select count to multiple-correct questions and keeps the key aligned', () => {
  const q = normalizeQuestion(
    { text: 'Which are planets?', options: ['Mars', 'Moon', 'Venus', 'Sun'], correct: [0, 2], explanation: 'x', source: 'y' },
    doc,
    section,
  );
  assert.equal(q.text, 'Which are planets? (Select 2 answers)');
  assert.equal(q.multi, true);
  assert.deepEqual(q.correct.map((i) => q.options[i]).sort(), ['Mars', 'Venus']);
});

test('normalizeQuestion leaves single-answer questions without a suffix and strips model-added ones', () => {
  const q = normalizeQuestion({ text: 'Q1. Largest planet? (Select one)', options: ['Jupiter', 'Mars'], correct: [0] }, doc, section);
  assert.equal(q.text, 'Largest planet?');
  assert.equal(q.multi, false);
});

test('normalizeQuestion rejects invalid questions', () => {
  assert.equal(normalizeQuestion({ text: 'Q?', options: ['a', 'A'], correct: [0] }, doc, section), null);
  assert.equal(normalizeQuestion({ text: 'Q?', options: ['a', 'b'], correct: [0, 1] }, doc, section), null);
  assert.equal(normalizeQuestion({ text: 'Q?', options: ['a', 'b'], correct: [2] }, doc, section), null);
  assert.equal(normalizeQuestion({ text: 'Q?', options: ['a', 'b'], correct: [] }, doc, section), null);
});

test('normalizeQuestion strips A)/B) labels only when every option has them', () => {
  const labelled = normalizeQuestion({ text: 'Q?', options: ['A) one', 'B) two', 'C) three'], correct: [1] }, doc, section);
  assert.deepEqual([...labelled.options].sort(), ['one', 'three', 'two']);
  const names = normalizeQuestion({ text: 'Who?', options: ['A. P. J. Abdul Kalam', 'C. V. Raman'], correct: [0] }, doc, section);
  assert.ok(names.options.includes('A. P. J. Abdul Kalam'));
});

test('splitByType mixes single and multiple correct questions', () => {
  assert.deepEqual(splitByType(10, 'single'), { single: 10, multi: 0 });
  assert.deepEqual(splitByType(10, 'multiple'), { single: 0, multi: 10 });
  assert.deepEqual(splitByType(10, 'mixed'), { single: 6, multi: 4 });
  assert.deepEqual(splitByType(1, 'mixed'), { single: 1, multi: 0 });
});

test('offline generator only uses sentences from the section', () => {
  const text =
    'The Sun contains about 99.8 percent of the mass of the Solar System. Mercury is the closest planet to the Sun and has no moons. ' +
    'Venus is the hottest planet because its thick atmosphere traps heat. Mars is called the Red Planet because of iron oxide on its surface. ' +
    'Jupiter is the largest planet and has a storm called the Great Red Spot. Neptune was discovered in 1846 through mathematical prediction.';
  const questions = generateOffline({ sectionTitle: 'Planets', text, single: 3, multi: 2 });
  assert.ok(questions.length >= 3);
  for (const q of questions) {
    assert.ok(q.correct.length >= 1 && q.correct.length < q.options.length);
    if (q.text.startsWith('Which')) {
      for (const i of q.correct) assert.ok(text.includes(q.options[i]), `true statement must be verbatim: ${q.options[i]}`);
    } else {
      assert.ok(text.includes(q.source));
    }
  }
});

test('grading requires the exact set of correct options', () => {
  const q = { correct: [0, 2] };
  assert.equal(questionStatus(q, []), 'unanswered');
  assert.equal(questionStatus(q, [0]), 'wrong');
  assert.equal(questionStatus(q, [0, 1, 2]), 'wrong');
  assert.equal(questionStatus(q, [0, 2]), 'correct');
});

test('gradeAttempt totals, percentage, pass flag and capped time', () => {
  const testRecord = {
    config: { timeLimitMin: 1, passPercent: 50 },
    questions: [
      { id: 'a', docId: 'd', sectionId: 's1', docName: 'D', sectionTitle: 'One', correct: [1] },
      { id: 'b', docId: 'd', sectionId: 's1', docName: 'D', sectionTitle: 'One', correct: [0, 1] },
      { id: 'c', docId: 'd', sectionId: 's2', docName: 'D', sectionTitle: 'Two', correct: [2] },
    ],
  };
  const result = gradeAttempt(testRecord, {
    answers: { a: [1], b: [0] },
    startedAt: '2026-01-01T00:00:00Z',
    submittedAt: '2026-01-01T00:05:00Z',
  });
  assert.deepEqual([result.correct, result.wrong, result.unanswered, result.total], [1, 1, 1, 3]);
  assert.equal(result.percentage, 33.3);
  assert.equal(result.passed, false);
  assert.equal(result.timeTakenSec, 60);
  assert.deepEqual(result.bySection.map((s) => [s.sectionTitle, s.total, s.correct]), [['One', 2, 1], ['Two', 1, 0]]);
});
