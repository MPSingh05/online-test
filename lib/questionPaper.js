// Rule-based reader for question papers, used when no Claude API key is configured.
//
// Questions: "1.", "1)", "Q1.", "Question 1:" followed by lettered options ("a)", "(A)", "B.", or several on
// one line). Answers can be given in any of these ways:
//   - an answer line under the question: "Answer: b", "Ans: A, C", "Answer: True"
//   - an answer key anywhere in the paper, usually at the end: "1-b 2-c", "4 - c, 5 - b", or table rows
//     such as "Q1 B Single" (PDF tables often lose the spaces: "Q2A, BMultiple")
//   - a marked option: "*", a tick, "(correct)", or bold (in Word files)
// Labels such as "(Single choice)" or "(Multiple choice – select two)" are removed from the question text;
// the stated number to select is checked against the answer.

const Q_PREFIXED = /^q(?:uestion)?\s*\.?\s*(\d{1,3})\s*[.):\-–]?\s*(\S.*)$/i;
const Q_NUMBERED = /^(\d{1,3})\s*[.)]\s*(\S.*)$/;
const OPTION = /^\(?([a-hA-H])\s*[.):\]]\s*(\S.*)$/;
const ANSWER = /^(?:correct\s+)?(?:answer|ans)\b\.?\s*(?:is\s*)?[:.\-–=)]?\s*(.+)$/i;
const KEY_HEADING = /^(?:answer\s*key|answers|answer\s*sheet|key\s+to\s+\w+(?:\s+\w+)?)\s*[:.\-–]?\s*$/i;
// One answer-key row: "Q1 B Single", "Q2A, BMultiple", "12. (c)", "7 - a, d".
const KEY_ROW = /^(?:q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.):\-–=|]?\s*\(?([a-h](?:\s*[,&/]\s*[a-h])*)\)?\s*(?:single|multiple|multi)?(?:\s*(?:choice|answers?|correct))?\s*\.?$/i;
// Several pairs on one line: "1-b 2-c 3-b 4-a,b". A pair never starts inside a number ("1945 (b)").
const KEY_PAIR = /(?<![\d.])(?:q\.?\s*)?(\d{1,3})(?!\d)\s*[.):\-–=|]?\s*\(?([a-h](?:\s*[,&]\s*[a-h])*)\)?(?![a-z])/gi;
const KEY_WORDS = /\b(?:q|question|ans(?:wer)?s?|key|single|multiple|type|choice|correct|marks?)\b/gi;
const EXPLANATION = /^(?:explanation|solution|reason|rationale|hint)\s*[:.\-–]\s*(.*)$/i;
const SECTION = /^(?:[Ss]ection|SECTION|[Pp]art|PART|[Uu]nit|UNIT|[Cc]hapter|CHAPTER|[Tt]opic|TOPIC|[Pp]aper|PAPER|[Mm]odule|MODULE)\s*(?:[A-Z]|\d{1,2}|[IVX]{1,4})\b/;
const RANGE_SUFFIX = /\s*\((?:q(?:uestions?)?\.?\s*)?\d+\s*[–\-—]\s*(?:q\.?\s*)?\d+\)\s*$/i;
// "(Single choice)", "(Multiple choice – select two)", "[Multiple answers]" at the end of a question.
export const TYPE_LABEL = /\s*[([]\s*(?:single|multiple|multi)[\s-]*(?:choice|answers?|correct|response)?[^)\]]*[)\]]\s*$/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

const stripBold = (s) => s.replace(/\*\*/g, '');
const isFullyBold = (s) => /^\*\*[^*]+\*\*[.]?$/.test(s.trim());
const letterIndex = (letter) => letter.toLowerCase().charCodeAt(0) - 97;
const splitLetters = (s) => s.split(/\s*[,&/]\s*/).map((l) => letterIndex(l.trim()));
const label = (num) => (num ? `Q${num}` : 'A question');

// How many options the question says to select, if it says so.
function statedSelectCount(text) {
  const m = text.match(/select\s+(one|two|three|four|five|six|\d)\b/i);
  if (m) return NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
  if (/\(\s*single[\s-]*(?:choice|answer|correct)/i.test(text)) return 1;
  return null;
}

function cleanQuestion(text) {
  return stripBold(text)
    .replace(/\s*[[(]\s*\d+(?:\.\d+)?\s*marks?\s*[\])]\s*$/i, '')
    .replace(TYPE_LABEL, '')
    .replace(/\s*[[(]\s*select\s+[^)\]]*[)\]]\s*$/i, '')
    .trim();
}

function headingText(line) {
  if (line.startsWith('# ')) return line.slice(2).trim();
  const plain = stripBold(line).trim();
  const words = plain.split(/\s+/).length;
  if (SECTION.test(plain) && words <= 14 && !plain.endsWith('?')) return plain;
  const letters = plain.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 4 && letters === letters.toUpperCase() && words <= 10 && !/[.?]$/.test(plain)) return plain;
  return null;
}

// The answer-key entries on a line, or null when the line is not part of an answer key.
function keyEntries(line) {
  const plain = stripBold(line).trim();
  const row = plain.match(KEY_ROW);
  if (row) return [{ num: Number(row[1]), letters: splitLetters(row[2]) }];
  const pairs = [...plain.matchAll(KEY_PAIR)];
  if (!pairs.length) return null;
  // Only accept lines that are (almost) nothing but pairs, so prose like "Q6 (A, B) is confirmed" is ignored.
  const leftover = plain.replace(KEY_PAIR, ' ').replace(KEY_WORDS, ' ').replace(/[^A-Za-z]/g, '');
  if (leftover.length > 2) return null;
  return pairs.map((m) => ({ num: Number(m[1]), letters: splitLetters(m[2]) }));
}

// "(a) Paris (b) London" or "A. Paris  B. London" on one line -> ['Paris', 'London'].
function splitInlineOptions(text) {
  const marks = [...text.matchAll(/(?:^|\s)\(?([a-hA-H])[.)]\s+/g)];
  if (marks.length < 2) return null;
  const firstA = marks.findIndex((m) => m[1].toLowerCase() === 'a');
  if (firstA < 0) return null;
  const run = [];
  for (const m of marks.slice(firstA)) {
    if (letterIndex(m[1]) !== run.length) break;
    run.push(m);
  }
  if (run.length < 2) return null;
  const before = text.slice(0, run[0].index).trim();
  const options = run.map((m, i) => text.slice(m.index + m[0].length, i + 1 < run.length ? run[i + 1].index : undefined).trim());
  return { before, options };
}

function parseAnswerValue(value, options) {
  const v = stripBold(value).trim().replace(/[.;]$/, '');
  const tokens = v.split(/\s*(?:,|&|\band\b|\s)\s*/i).map((t) => t.replace(/[()[\]]/g, '')).filter(Boolean);
  if (tokens.length && tokens.every((t) => /^[a-h]$/i.test(t))) return tokens.map(letterIndex);
  if (/^[a-h]{2,6}$/i.test(v) && v.length <= options.length) return [...v].map(letterIndex);
  const lettered = v.match(/^\(?([a-h])[.)]\s+/i);
  if (lettered) return [letterIndex(lettered[1])];
  const byText = options.findIndex((o) => o.toLowerCase() === v.toLowerCase());
  if (byText >= 0) return [byText];
  return null;
}

/**
 * @returns {{ questions: object[], skipped: number, unanswered: number, issues: string[] }}
 */
export function parseQuestionPaper(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const questions = [];
  const keyByNumber = new Map(); // question number -> list of answers, in the order they appear
  let section = '';
  let q = null;
  let mode = 'question'; // question | option | explanation
  let inKey = false; // inside answer-key rows: other lines are notes, not questions
  let openHeading = false; // a heading whose "(Q20–" range continues on the next line

  const finish = () => {
    if (q) questions.push(q);
    q = null;
    mode = 'question';
  };
  const begin = (num, body) => {
    finish();
    q = { num, section, text: '', options: [], bold: [], correct: [], explanation: '', answered: false };
    addQuestionText(body);
  };
  const addQuestionText = (body) => {
    const inline = splitInlineOptions(body);
    if (inline) {
      q.text = `${q.text} ${inline.before}`.trim();
      inline.options.forEach(addOption);
    } else {
      q.text = `${q.text} ${body}`.trim();
    }
  };
  const addOption = (raw) => {
    let option = raw.trim();
    const bold = isFullyBold(option);
    option = stripBold(option).trim();
    let marked = false;
    for (const re of [/^\*\s*/, /\s*\*$/, /\s*\(\s*correct\s*\)\s*$/i, /\s*[✓✔]\s*$/, /^[✓✔]\s*/]) {
      if (re.test(option)) {
        marked = true;
        option = option.replace(re, '').trim();
      }
    }
    if (marked) q.correct.push(q.options.length);
    q.bold.push(bold);
    q.options.push(option);
    mode = 'option';
  };

  for (const line of lines) {
    if (openHeading) {
      openHeading = false;
      if (line.split(/\s+/).length <= 4) {
        section = `${section} ${line}`.replace(RANGE_SUFFIX, '').trim();
        continue;
      }
    }

    const entries = keyEntries(line);
    if (entries) {
      finish();
      inKey = true;
      for (const { num, letters } of entries) {
        if (!keyByNumber.has(num)) keyByNumber.set(num, []);
        keyByNumber.get(num).push(letters);
      }
      continue;
    }

    if (KEY_HEADING.test(stripBold(line))) {
      finish();
      continue;
    }

    const heading = headingText(line);
    if (heading && !OPTION.test(line)) {
      finish();
      inKey = false;
      section = heading.replace(RANGE_SUFFIX, '').trim();
      openHeading = (heading.match(/\(/g) || []).length > (heading.match(/\)/g) || []).length;
      continue;
    }
    if (inKey) continue;

    const answer = q && line.match(ANSWER);
    if (answer) {
      const value = answer[1];
      let correct = parseAnswerValue(value, q.options);
      if (!q.options.length && /^(true|false)\b/i.test(stripBold(value))) {
        q.options = ['True', 'False'];
        q.bold = [false, false];
        correct = [/^true/i.test(stripBold(value)) ? 0 : 1];
      }
      if (correct) {
        q.correct = correct;
        q.answered = true;
      }
      mode = 'question';
      continue;
    }

    const explanation = q && line.match(EXPLANATION);
    if (explanation) {
      q.explanation = explanation[1];
      mode = 'explanation';
      continue;
    }

    const start = line.match(Q_PREFIXED) || line.match(Q_NUMBERED);
    // A numbered line is a new question unless the current one has no options yet: question papers
    // often list numbered statements inside a question ("Consider the following: 1. ... 2. ...").
    if (start && (!q || q.options.length || q.answered || /^q/i.test(line))) {
      begin(Number(start[1]), start[2]);
      continue;
    }

    const option = q && line.match(OPTION);
    if (option && letterIndex(option[1]) === q.options.length) {
      const inline = splitInlineOptions(line);
      if (inline && !inline.before) inline.options.forEach(addOption);
      else addOption(option[2]);
      continue;
    }

    // Continuation of whatever came before (wrapped lines in PDFs).
    if (!q) continue;
    if (mode === 'explanation') q.explanation += ` ${line}`;
    else if (mode === 'option' && q.options.length) q.options[q.options.length - 1] += ` ${stripBold(line)}`;
    else addQuestionText(line);
  }
  finish();

  // Match answer-key entries to questions by number. If the numbering restarts (per section),
  // the n-th question numbered 5 takes the n-th key entry for 5.
  const seen = new Map();
  let skipped = 0;
  let unanswered = 0;
  const issues = [];
  const result = [];
  for (const item of questions) {
    const occurrence = seen.get(item.num) ?? 0;
    seen.set(item.num, occurrence + 1);
    if (item.options.length < 2) {
      skipped++;
      continue;
    }
    let correct = item.correct;
    if (!correct.length) correct = keyByNumber.get(item.num)?.[occurrence] ?? [];
    if (!correct.length) {
      // Bold options mark the answer only when some, not all, options are bold.
      const boldIdx = item.bold.flatMap((b, i) => (b ? [i] : []));
      if (boldIdx.length && boldIdx.length < item.options.length) correct = boldIdx;
    }
    const outOfRange = correct.filter((i) => i < 0 || i >= item.options.length);
    if (outOfRange.length) {
      issues.push(`${label(item.num)}: the answer ${outOfRange.map((i) => String.fromCharCode(65 + i)).join(', ')} is not one of its ${item.options.length} options.`);
      unanswered++;
      continue;
    }
    correct = [...new Set(correct)];
    if (!correct.length) {
      issues.push(`${label(item.num)}: no answer found in the document.`);
      unanswered++;
      continue;
    }
    const stated = statedSelectCount(item.text);
    if (stated && stated !== correct.length) {
      issues.push(`${label(item.num)}: the question says to select ${stated}, but the answer gives ${correct.length}. The answer from the document is used.`);
    }
    result.push({
      number: item.num ? String(item.num) : '',
      section: item.section,
      text: cleanQuestion(item.text),
      options: item.options.map((o) => stripBold(o).trim()),
      correct,
      explanation: stripBold(item.explanation).trim(),
      answerInDocument: true,
    });
  }
  return { questions: result, skipped, unanswered, issues };
}
