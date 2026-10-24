// Groups parsed blocks into the sections a user picks question counts from.

const MAX_SECTIONS = 30; // prefer a coarser heading level once a finer one would exceed this
const MIN_SECTION_WORDS = 15; // smaller sections (often numbered list items mistaken for headings) are folded into the previous one
const PART_WORDS = 1200; // target size when a long heading-less stretch is split into parts

export const countWords = (text) => (text.match(/\S+/g) || []).length;

export function buildSections(blocks) {
  const headings = blocks.filter((b) => b.type === 'heading');
  const splitLevel = chooseSplitLevel(headings);

  // 1. Cut at every heading at or above the split level; deeper headings stay in the body.
  const raw = [];
  let current = { title: null, lines: [] };
  for (const block of blocks) {
    if (block.type === 'heading' && block.level <= splitLevel) {
      raw.push(current);
      current = { title: block.text, lines: [] };
    } else {
      current.lines.push(block.text);
    }
  }
  raw.push(current);

  // 2. A heading with no body (e.g. "Chapter 2" directly above "2.1 ...") becomes a prefix of the next
  //    title; a section too small to question on its own is folded into the previous one.
  const merged = [];
  let pendingTitle = null;
  for (const section of raw) {
    const text = section.lines.join('\n').trim();
    const words = countWords(text);
    let title = section.title;
    if (pendingTitle) {
      title = title ? `${pendingTitle} › ${title}` : pendingTitle;
      pendingTitle = null;
    }
    if (words === 0) {
      if (title) pendingTitle = title;
      continue;
    }
    const prev = merged[merged.length - 1];
    if (words < MIN_SECTION_WORDS && prev) {
      prev.text += `\n${title ? `${title}\n` : ''}${text}`;
      prev.words += words;
      continue;
    }
    merged.push({ title, text, words });
  }
  // A tiny leading section (e.g. a title page line) joins the section after it.
  if (merged.length > 1 && merged[0].words < MIN_SECTION_WORDS) {
    const [first, second] = merged;
    second.text = `${first.title ? `${first.title}\n` : ''}${first.text}\n${second.text}`;
    second.words += first.words;
    merged.shift();
  }

  // 3. Name untitled text and split oversized sections into parts.
  const hasHeadings = merged.some((s) => s.title);
  const sections = [];
  for (const section of merged) {
    const title = section.title || (hasHeadings ? 'Introduction' : 'Full document');
    if (section.words <= PART_WORDS * 2) {
      sections.push({ title, text: section.text, words: section.words });
      continue;
    }
    const parts = chunkText(section.text, PART_WORDS);
    const base = title === 'Full document' ? 'Part' : `${title} — Part`;
    parts.forEach((text, i) => sections.push({ title: `${base} ${i + 1}`, text, words: countWords(text) }));
  }

  return sections.map((s, i) => ({ id: `s${i + 1}`, title: s.title, text: s.text, wordCount: s.words }));
}

// Deepest heading level that still yields at most MAX_SECTIONS sections.
function chooseSplitLevel(headings) {
  const levels = [...new Set(headings.map((h) => h.level))].sort((a, b) => a - b);
  if (!levels.length) return 0;
  let chosen = levels[0];
  for (const level of levels) {
    if (headings.filter((h) => h.level <= level).length <= MAX_SECTIONS) chosen = level;
  }
  return chosen;
}

function chunkText(text, targetWords) {
  const units = [];
  for (const para of text.split('\n')) {
    if (countWords(para) <= targetWords) units.push(para);
    else units.push(...para.split(/(?<=[.!?])\s+/));
  }
  const chunks = [];
  let buf = [];
  let words = 0;
  for (const unit of units) {
    const w = countWords(unit);
    if (words + w > targetWords && words > 0) {
      chunks.push(buf.join('\n'));
      buf = [];
      words = 0;
    }
    buf.push(unit);
    words += w;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  // Avoid a tiny trailing part.
  if (chunks.length > 1 && countWords(chunks[chunks.length - 1]) < targetWords / 4) {
    const last = chunks.pop();
    chunks[chunks.length - 1] += `\n${last}`;
  }
  return chunks;
}
