// Rule-based fallback generator used when no Claude API key is configured.
// It builds questions only from sentences in the section: fill-in-the-blank questions on key terms, and
// "which statements are correct" questions whose false options swap a key term for another one.

const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both
  but by can could did do does doing down during each few for from further had has have having he her here hers him his
  how however i if in into is it its itself just many may might more most must my no nor not now of off on once only or
  other our ours out over own same she should so some such than that the their theirs them then there these they this
  those through thus to too under until up upon very was we were what when where whether which while who whom why will
  with within without would you your yours`.split(/\s+/),
);

const shuffle = (items) => {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRegExp = (term) => new RegExp(`(?<![\\w-])${escapeRegExp(term)}(?![\\w-])`);

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/)
    .map((s) => s.replace(/^[•\-*–]\s*/, '').trim())
    .filter((s) => {
      const words = s.split(' ').length;
      return words >= 6 && words <= 40 && /[.!?]["”)]?$/.test(s);
    });
}

// Key terms in a sentence, typed so that distractors are drawn from the same kind of term.
function termsIn(sentence) {
  const terms = [];
  const seen = new Set();
  const add = (text, type) => {
    const key = text.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      terms.push({ text, type });
    }
  };
  for (const m of sentence.matchAll(/(?<![\w.])\d+(?:[.,]\d+)?(?![\w.]*\w)/g)) add(m[0], 'number');
  for (const m of sentence.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[ -][A-Z][A-Za-z0-9]*)*\b/g)) {
    // A single capitalised word opening the sentence is usually just grammar, unless it is an acronym.
    const isAcronym = /^[A-Z][A-Z0-9]+$/.test(m[0]);
    if (m.index === 0 && !m[0].includes(' ') && !isAcronym) continue;
    if (STOPWORDS.has(m[0].toLowerCase())) continue;
    add(m[0], 'proper');
  }
  for (const m of sentence.matchAll(/\b[a-z][a-z-]{6,}\b/g)) {
    if (!STOPWORDS.has(m[0])) add(m[0], 'word');
  }
  return terms;
}

function buildPools(sentences) {
  const pools = { number: new Map(), proper: new Map(), word: new Map() };
  for (const s of sentences) {
    for (const t of termsIn(s)) pools[t.type].set(t.text.toLowerCase(), t.text);
  }
  return { number: [...pools.number.values()], proper: [...pools.proper.values()], word: [...pools.word.values()] };
}

const related = (a, b) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
};

// Plausible nearby numbers, used when the section has too few other numbers to borrow.
function nearbyNumbers(text) {
  const n = Number(text.replace(',', '.'));
  const decimals = (text.split(/[.,]/)[1] || '').length;
  const looksLikeYear = !decimals && n >= 1000 && n <= 2100;
  const unit = decimals ? 10 ** -decimals : looksLikeYear ? 5 : n < 20 ? 1 : Math.max(1, Math.round(n / 10));
  return shuffle([1, 2, 3, -1, -2, -3])
    .map((k) => n + k * unit)
    .filter((v) => v > 0)
    .map((v) => (decimals ? v.toFixed(decimals) : String(v)));
}

function distractorsFor(term, sentence, pools, count) {
  const picked = [];
  const consider = (candidate) => {
    if (picked.length < count && !related(candidate, term.text) && !termRegExp(candidate).test(sentence) && !picked.some((p) => related(p, candidate))) {
      picked.push(candidate);
    }
  };
  shuffle(pools[term.type]).forEach(consider);
  if (term.type === 'number') nearbyNumbers(term.text).forEach(consider);
  return picked.length === count ? picked : null;
}

function clozeQuestion(sentence, term, pools, title) {
  const distractors = distractorsFor(term, sentence, pools, 3);
  if (!distractors) return null;
  const blanked = sentence.replace(termRegExp(term.text), '_____');
  if (blanked === sentence) return null;
  return {
    text: `Fill in the blank: "${blanked}"`,
    options: [term.text, ...distractors],
    correct: [0],
    explanation: `The section "${title}" says "${term.text}" here.`,
    source: sentence,
  };
}

// Makes a false statement by swapping one key term for another term of the same kind.
// Names and numbers give more believable false statements than ordinary words, so try them first.
function falsify(sentence, pools, realSentences) {
  const terms = shuffle(termsIn(sentence)).sort((a, b) => (a.type === 'word') - (b.type === 'word'));
  for (const term of terms) {
    const replacement = distractorsFor(term, sentence, pools, 1);
    if (!replacement) continue;
    const altered = sentence.replace(termRegExp(term.text), replacement[0]);
    if (altered !== sentence && !realSentences.has(altered)) return { altered, original: sentence };
  }
  return null;
}

function statementsQuestion(trueSentences, falseItems, title) {
  const single = trueSentences.length === 1;
  return {
    text: single
      ? `Which of the following statements is correct according to "${title}"?`
      : `Which of the following statements are correct according to "${title}"?`,
    options: [...trueSentences, ...falseItems.map((f) => f.altered)],
    correct: trueSentences.map((_, i) => i),
    explanation: [
      `${single ? 'The correct statement is' : 'The correct statements are'} taken word for word from "${title}".`,
      ...falseItems.map((f) => `"${f.altered}" is wrong: the document says "${f.original}"`),
    ].join(' '),
    source: trueSentences.join(' '),
  };
}

export function generateOffline({ sectionTitle, text, single, multi }) {
  const sentences = splitSentences(text);
  const pools = buildPools(sentences);
  const realSentences = new Set(sentences);
  const usedClozeSentences = new Set();
  const usedStatementSets = new Set();
  const questions = [];

  // Names, numbers and acronyms make better blanks than ordinary long words.
  const clozeCandidates = shuffle(sentences.flatMap((s) => termsIn(s).map((term) => ({ s, term }))))
    .sort((a, b) => (a.term.type === 'word') - (b.term.type === 'word'));

  const nextCloze = () => {
    for (const { s, term } of clozeCandidates) {
      if (usedClozeSentences.has(s)) continue;
      const q = clozeQuestion(s, term, pools, sectionTitle);
      if (q) {
        usedClozeSentences.add(s);
        return q;
      }
    }
    return null;
  };

  const nextStatements = (trueCount, falseCount) => {
    for (let attempt = 0; attempt < 25; attempt++) {
      const picked = shuffle(sentences);
      const truths = picked.slice(0, trueCount);
      if (truths.length < trueCount) return null;
      const key = [...truths].sort().join('|');
      if (usedStatementSets.has(key)) continue;
      const falses = [];
      for (const s of picked.slice(trueCount)) {
        if (falses.length === falseCount) break;
        const f = falsify(s, pools, realSentences);
        if (f && !falses.some((x) => x.altered === f.altered)) falses.push(f);
      }
      if (falses.length < falseCount) continue;
      usedStatementSets.add(key);
      return statementsQuestion(truths, falses, sectionTitle);
    }
    return null;
  };

  // Single-answer questions alternate between fill-in-the-blank and "which statement is correct".
  for (let i = 0; i < single; i++) {
    const q = i % 2 === 0 ? nextCloze() || nextStatements(1, 3) : nextStatements(1, 3) || nextCloze();
    if (!q) break;
    questions.push(q);
  }
  for (let i = 0; i < multi; i++) {
    const optionCount = Math.random() < 0.5 ? 4 : 5;
    const correctCount = optionCount === 4 ? 2 : 2 + Math.floor(Math.random() * 2);
    const q = nextStatements(correctCount, optionCount - correctCount);
    if (!q) break;
    questions.push(q);
  }
  return questions;
}
