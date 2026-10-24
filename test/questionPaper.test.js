import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestionPaper } from '../lib/questionPaper.js';
import { walkHtml } from '../lib/parse.js';
import { normalizeQuestion } from '../lib/generator/index.js';

const PAPER = `GENERAL SCIENCE - MODEL PAPER
SECTION A: PHYSICS
1. What is the SI unit of force? (1 mark)
a) Joule
b) Newton
c) Watt
d) Pascal
Answer: b
Explanation: Force is measured in newtons.
2. Which of the following are vector quantities?
(A) Velocity (B) Speed (C) Force (D) Mass
Ans: A, C
Q3. Light travels fastest in
A. water
B. glass
C. vacuum *
D. air
SECTION B: BIOLOGY
4. Consider the following statements:
1. Mitochondria produce energy.
2. Ribosomes make proteins.
Which of the statements given above is/are correct?
a) 1 only
b) 2 only
c) Both 1 and 2
d) Neither 1 nor 2
5. Photosynthesis takes place in the
a) mitochondria b) chloroplast c) nucleus d) ribosome
6. The heart has four chambers.
Answer: True
7. Describe the structure of a cell.
ANSWER KEY
4 - c   5 - b`;

test('parseQuestionPaper reads the common question paper layouts', () => {
  const { questions, skipped, unanswered } = parseQuestionPaper(PAPER);
  assert.equal(skipped, 1, 'the descriptive question is skipped');
  assert.equal(unanswered, 0);
  const summary = questions.map((q) => [q.section, q.text, q.options.length, q.correct]);
  assert.deepEqual(summary, [
    ['SECTION A: PHYSICS', 'What is the SI unit of force?', 4, [1]],
    ['SECTION A: PHYSICS', 'Which of the following are vector quantities?', 4, [0, 2]],
    ['SECTION A: PHYSICS', 'Light travels fastest in', 4, [2]],
    [
      'SECTION B: BIOLOGY',
      'Consider the following statements: 1. Mitochondria produce energy. 2. Ribosomes make proteins. Which of the statements given above is/are correct?',
      4,
      [2],
    ],
    ['SECTION B: BIOLOGY', 'Photosynthesis takes place in the', 4, [1]],
    ['SECTION B: BIOLOGY', 'The heart has four chambers.', 2, [0]],
  ]);
  assert.equal(questions[0].explanation, 'Force is measured in newtons.');
  assert.equal(questions[2].options[2], 'vacuum', 'the * marker is removed');
});

test('parseQuestionPaper uses bold options as answers only when some options are bold', () => {
  const marked = parseQuestionPaper('1. Capital of France?\na) London\nb) **Paris**\nc) Rome');
  assert.deepEqual(marked.questions[0].correct, [1]);
  assert.deepEqual(marked.questions[0].options, ['London', 'Paris', 'Rome']);
  const allBold = parseQuestionPaper('1. Capital of France?\na) **London**\nb) **Paris**');
  assert.equal(allBold.questions.length, 0);
  assert.equal(allBold.unanswered, 1);
});

test('parseQuestionPaper keeps option text that looks like a label', () => {
  const { questions } = parseQuestionPaper('1. Who was the first Prime Minister of India?\n(a) Sardar Patel (b) Jawaharlal Nehru (c) B. R. Ambedkar\nAnswer key\n1-b');
  assert.deepEqual(questions[0].options, ['Sardar Patel', 'Jawaharlal Nehru', 'B. R. Ambedkar']);
  assert.deepEqual(questions[0].correct, [1]);
});

test('walkHtml rebuilds Word list numbering and keeps bold marks', () => {
  const html = '<ol><li>Which is a planet?<ol><li>Moon</li><li><strong>Mars</strong></li></ol></li></ol>';
  const lines = walkHtml(html, { keepBold: true }).map((b) => `${b.label} ${b.text}`);
  assert.deepEqual(lines, ['1. Which is a planet?', 'a) Moon', 'b) **Mars**']);
});

test('question paper questions keep their option order and flag AI-worked answers', () => {
  const q = normalizeQuestion(
    { text: 'Pick the even numbers', options: ['1', '2', '3', '4'], correct: [1, 3], answerInDocument: false },
    { id: 'd', name: 'paper.pdf' },
    { id: 's1', title: 'All questions' },
    { shuffle: false },
  );
  assert.deepEqual(q.options, ['1', '2', '3', '4']);
  assert.deepEqual(q.correct, [1, 3]);
  assert.equal(q.text, 'Pick the even numbers (Select 2 answers)');
  assert.equal(q.answerSuggested, true);
});
