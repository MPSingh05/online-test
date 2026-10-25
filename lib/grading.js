// Scoring: a question counts as correct only when the selected options exactly match the answer key.

export function cleanAnswers(test, answers) {
  const clean = {};
  for (const q of test.questions) {
    const picked = Array.isArray(answers?.[q.id]) ? answers[q.id] : [];
    const valid = [...new Set(picked.map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < q.options.length);
    if (valid.length) clean[q.id] = valid.sort((a, b) => a - b);
  }
  return clean;
}

export function questionStatus(q, selected = []) {
  if (!selected.length) return 'unanswered';
  return selected.length === q.correct.length && selected.every((i) => q.correct.includes(i)) ? 'correct' : 'wrong';
}

export function gradeAttempt(test, attempt) {
  const bySection = new Map();
  const totals = { total: 0, correct: 0, wrong: 0, unanswered: 0 };

  for (const q of test.questions) {
    const status = questionStatus(q, attempt.answers[q.id]);
    const key = `${q.docId}:${q.sectionId}`;
    if (!bySection.has(key)) {
      bySection.set(key, { docName: q.docName, sectionTitle: q.sectionTitle, total: 0, correct: 0, wrong: 0, unanswered: 0 });
    }
    const section = bySection.get(key);
    for (const bucket of [totals, section]) {
      bucket.total++;
      bucket[status]++;
    }
  }

  const percentage = totals.total ? Math.round((totals.correct / totals.total) * 1000) / 10 : 0;
  const limitMs = test.config.timeLimitMin * 60_000;
  // Time spent paused doesn't count.
  const elapsedMs = new Date(attempt.submittedAt) - new Date(attempt.startedAt) - (attempt.pausedMs ?? 0);
  return {
    ...totals,
    percentage,
    passPercent: test.config.passPercent,
    passed: percentage >= test.config.passPercent,
    timeTakenSec: Math.round(Math.max(0, Math.min(elapsedMs, limitMs)) / 1000),
    bySection: [...bySection.values()].map((s) => ({
      ...s,
      percentage: Math.round((s.correct / s.total) * 1000) / 10,
    })),
  };
}

export function buildReview(test, attempt) {
  return test.questions.map((q, index) => {
    const selected = attempt.answers[q.id] || [];
    return {
      number: index + 1,
      id: q.id,
      docName: q.docName,
      sectionTitle: q.sectionTitle,
      text: q.text,
      options: q.options,
      multi: q.multi,
      selectCount: q.selectCount,
      correct: q.correct,
      selected,
      status: questionStatus(q, selected),
      explanation: q.explanation,
      source: q.source,
      answerSuggested: Boolean(q.answerSuggested),
      paperNumber: q.number || '',
    };
  });
}
