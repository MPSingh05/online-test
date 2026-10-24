// Builds the questions for a test: new questions written from study material, and questions taken
// as-is from question papers. Every question is validated and normalised here.
import { randomBytes } from 'node:crypto';
import { claudeConfigured, generateWithClaude, extractWithClaude, CLAUDE_MODEL, GenerationError } from './claude.js';
import { generateOffline } from './offline.js';
import { parseQuestionPaper, TYPE_LABEL } from '../questionPaper.js';

export { GenerationError };

export const MAX_PER_SECTION = 50;
const CLAUDE_CONCURRENCY = 3;
const MULTI_SHARE_IN_MIXED = 0.35;

export function activeEngine() {
  if (process.env.QUESTION_ENGINE === 'offline' || !claudeConfigured()) {
    return { id: 'offline', label: 'Basic offline generator' };
  }
  return { id: 'claude', label: `Claude (${CLAUDE_MODEL})` };
}

// How many single- and multiple-correct questions to ask for in one section.
export function splitByType(count, questionType) {
  if (questionType === 'single') return { single: count, multi: 0 };
  if (questionType === 'multiple') return { single: 0, multi: count };
  const multi = count < 2 ? 0 : Math.max(1, Math.round(count * MULTI_SHARE_IN_MIXED));
  return { single: count - multi, multi };
}

// ---------- question papers ----------

/**
 * Reads the questions in a question paper and groups them by the paper's own sections.
 * @param {{ id: string, name: string }} doc
 * @param {string} text  the paper as text
 * @param {{ buffer: Buffer, pages?: number } | null} pdf  the original PDF, when it is one
 */
export async function extractQuestionBank(doc, text, pdf = null) {
  const engine = activeEngine();
  const raw = engine.id === 'claude' ? await extractWithClaude({ docName: doc.name, text, pdf }) : parseQuestionPaper(text);

  const sections = [];
  const issues = [...(raw.issues ?? [])];
  let invalid = 0;
  for (const item of raw.questions) {
    const title = item.section?.trim() || 'All questions';
    let section = sections.find((s) => s.title === title);
    if (!section) {
      section = { id: `s${sections.length + 1}`, title, questions: [] };
      sections.push(section);
    }
    const name = item.number ? `Q${String(item.number).replace(/^q\.?\s*/i, '')}` : 'A question';
    if (item.issue) issues.push(`${name}: ${item.issue}`);
    // Keep the paper's option order so it reads exactly like the original.
    const q = normalizeQuestion(item, doc, section, { shuffle: false });
    if (!q) {
      invalid++;
      issues.push(`${name}: left out because its options or answer could not be used.`);
    } else if (section.questions.some((existing) => sameText(existing.baseText, q.baseText) && existing.options.join() === q.options.join())) {
      invalid++;
      issues.push(`${name}: left out because it repeats an earlier question word for word.`);
    } else {
      section.questions.push(q);
    }
  }
  const all = sections.flatMap((s) => s.questions);
  return {
    engine,
    sections,
    stats: {
      found: all.length,
      multi: all.filter((q) => q.multi).length,
      suggested: all.filter((q) => q.answerSuggested).length,
      skipped: raw.skipped,
      unanswered: raw.unanswered + invalid,
      issues,
    },
  };
}

// Takes `count` questions from a question-paper section: all of them, or a random selection kept in paper order.
function pickFromBank(section, count) {
  const indexes = section.questions.map((_, i) => i);
  for (let i = indexes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
  }
  return indexes
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((i) => ({ ...section.questions[i] }));
}

// ---------- tests ----------

/**
 * @param {object} args
 * @param {{doc: object, section: object, count: number}[]} args.picks
 * @param {'mixed'|'single'|'multiple'} args.questionType
 * @param {'mixed'|'easy'|'medium'|'hard'} args.difficulty
 * @param {(done: number, total: number) => void} [args.onProgress]
 */
export async function generateQuestions({ picks, questionType, difficulty, onProgress = () => {} }) {
  const engine = activeEngine();
  const results = new Array(picks.length);
  const warnings = [];
  let done = 0;

  const work = picks.map((pick, index) => async () => {
    const questions =
      pick.doc.kind === 'questions'
        ? pickFromBank(pick.section, pick.count)
        : await generateForSection(engine.id, pick, questionType, difficulty);
    if (questions.length < pick.count) {
      warnings.push(
        `"${pick.section.title}" (${pick.doc.name}) only had enough material for ${questions.length} of the ${pick.count} questions requested.`,
      );
    }
    results[index] = questions;
    onProgress(++done, picks.length);
  });
  await runWithConcurrency(work, engine.id === 'claude' ? CLAUDE_CONCURRENCY : 1);

  return { engine: describeSource(engine, picks), questions: results.flat(), warnings };
}

function describeSource(engine, picks) {
  const fromPapers = picks.some((p) => p.doc.kind === 'questions');
  const fromMaterial = picks.some((p) => p.doc.kind !== 'questions');
  if (!fromMaterial) return { id: 'paper', label: 'your question papers' };
  if (!fromPapers) return engine;
  return { id: `${engine.id}+paper`, label: `${engine.label} and your question papers` };
}

async function generateForSection(engineId, { doc, section, count }, questionType, difficulty) {
  const accepted = [];
  // One top-up round if validation drops questions or the model returns fewer than asked.
  for (let round = 0; round < 2 && accepted.length < count; round++) {
    const missing = count - accepted.length;
    const { single, multi } = splitByType(missing, questionType);
    const params = {
      docName: doc.name,
      sectionTitle: section.title,
      text: section.text,
      single,
      multi,
      difficulty,
      avoid: accepted.map((q) => q.text),
    };
    const raw = engineId === 'claude' ? await generateWithClaude(params) : generateOffline(params);
    for (const candidate of raw) {
      if (accepted.length === count) break;
      const q = normalizeQuestion(candidate, doc, section);
      if (q && !accepted.some((a) => sameText(a.baseText, q.baseText))) accepted.push(q);
    }
    if (engineId === 'offline') break; // a second offline pass finds nothing new
  }
  return accepted;
}

const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function normalizeQuestion(raw, doc, section, { shuffle = true } = {}) {
  const baseText = String(raw.text ?? '')
    .replace(/^\s*(?:q(?:uestion)?\s*)?\d+\s*[.):-]\s*/i, '')
    .replace(TYPE_LABEL, '')
    .replace(/\s*\((?:select|choose|pick)[^)]*\)\s*$/i, '')
    .trim();
  let options = (raw.options ?? []).map((o) => String(o).trim());
  // Drop "A) ", "B) " ... labels, but only when every option carries the matching label.
  const labelled = options.every((o, i) => new RegExp(`^\\(?${'ABCDEFGH'[i]}[.)]\\s+`, 'i').test(o));
  if (labelled) options = options.map((o) => o.replace(/^\(?[A-H][.)]\s+/i, '').trim());
  if (!baseText || options.length < 2 || options.length > 8 || options.some((o) => !o)) return null;
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;

  const correct = [...new Set(raw.correct ?? [])];
  if (!correct.length || correct.length === options.length) return null;
  if (correct.some((i) => !Number.isInteger(i) || i < 0 || i >= options.length)) return null;

  // Shuffle generated options so the answer position carries no signal, then remap the answer key.
  const order = options.map((_, i) => i);
  if (shuffle) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  const newCorrect = correct.map((i) => order.indexOf(i)).sort((a, b) => a - b);
  const multi = newCorrect.length > 1;

  return {
    id: randomBytes(6).toString('hex'),
    docId: doc.id,
    docName: doc.name,
    sectionId: section.id,
    sectionTitle: section.title,
    baseText,
    // Multiple-correct questions state how many options must be selected to score.
    text: multi ? `${baseText} (Select ${newCorrect.length} answers)` : baseText,
    options: order.map((i) => options[i]),
    correct: newCorrect,
    multi,
    selectCount: newCorrect.length,
    explanation: String(raw.explanation ?? '').trim(),
    source: String(raw.source ?? '').trim(),
    // Question papers without an answer for this question: Claude worked the answer out.
    answerSuggested: raw.answerInDocument === false,
    // The question's number in the original paper, e.g. "12".
    number: raw.number ? String(raw.number).replace(/^q(?:uestion)?\.?\s*/i, '').trim() : '',
  };
}

async function runWithConcurrency(tasks, limit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  });
  await Promise.all(workers);
}
