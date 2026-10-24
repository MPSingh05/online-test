// Reads uploaded files.
// - Study material becomes a flat list of blocks: { type: 'heading', level, text } | { type: 'para', text }.
// - Question papers become plain text lines, keeping list labels ("1.", "a)") and **bold** marks,
//   because both often carry meaning (question numbers, option letters, marked answers).
import { createRequire } from 'node:module';
import path from 'node:path';
import mammoth from 'mammoth';

const require = createRequire(import.meta.url);
// Import the library file directly: the package entry point runs a self-test that reads a missing file.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'];

export class UnsupportedFileError extends Error {}

function extensionOf(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new UnsupportedFileError(
      `Unsupported file type "${ext || 'unknown'}". Upload ${SUPPORTED_EXTENSIONS.join(', ')} files.`,
    );
  }
  return ext;
}

export async function extractBlocks(fileName, buffer) {
  switch (extensionOf(fileName)) {
    case '.pdf':
      return textToBlocks((await readPdf(buffer)).text);
    case '.docx':
      return htmlToBlocks((await mammoth.convertToHtml({ buffer })).value);
    default:
      return textToBlocks(buffer.toString('utf8').replace(/^﻿/, ''));
  }
}

/** @returns {Promise<{ text: string, pages?: number }>} */
export async function extractQuestionPaperText(fileName, buffer) {
  switch (extensionOf(fileName)) {
    case '.pdf': {
      const { text, pages } = await readPdf(buffer);
      return { text: dropPageNoise(text), pages };
    }
    case '.docx': {
      const blocks = walkHtml((await mammoth.convertToHtml({ buffer })).value, { keepBold: true });
      const lines = blocks.map((b) => (b.kind === 'heading' ? `# ${b.text}` : b.label ? `${b.label} ${b.text}` : b.text));
      return { text: lines.join('\n') };
    }
    default:
      return { text: dropPageNoise(buffer.toString('utf8').replace(/^﻿/, '')) };
  }
}

async function readPdf(buffer) {
  // Small Node buffers live inside a shared memory pool (non-zero byteOffset), which pdf.js
  // ignores and then reads the wrong bytes. Copy into a standalone array first.
  const data = new Uint8Array(buffer.byteLength);
  data.set(buffer);
  const result = await pdfParse(data);
  return { text: dropRunningHeaders(result.text, result.numpages), pages: result.numpages };
}

// Removes running headers and footers: lines repeated on most pages (e.g. the document title on every page).
// Option and numbered lines are kept even when repeated, since answer options legitimately recur.
export function dropRunningHeaders(text, pages) {
  if (!pages || pages < 3) return text;
  const lines = text.split('\n');
  const counts = new Map();
  for (const line of lines) {
    const key = line.trim();
    if (key.length >= 8) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const limit = Math.max(3, Math.ceil(pages * 0.6));
  const isContent = (line) => /^\(?[a-h][.):\]]\s/i.test(line) || /^(?:q\.?\s*)?\d/i.test(line);
  return lines.filter((line) => (counts.get(line.trim()) || 0) < limit || isContent(line.trim())).join('\n');
}

const PAGE_NOISE = [/^\d{1,4}$/, /^page\s+\d+(\s+of\s+\d+)?$/i, /^\d+\s+of\s+\d+$/i, /^[-–—]\s*\d+\s*[-–—]$/];
const isPageNoise = (line) => PAGE_NOISE.some((re) => re.test(line));

function dropPageNoise(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line && !isPageNoise(line))
    .join('\n');
}

export function textToBlocks(text) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'para', text: joinLines(para) });
    para = [];
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) {
      flush();
      continue;
    }
    if (isPageNoise(line)) continue;
    const heading = detectHeading(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', ...heading });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

// PDF text wraps mid-sentence; rejoin wrapped lines but keep list items and sentence ends on their own lines.
function joinLines(lines) {
  let out = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const startsItem = /^([•\-*–]|\d+[.)]|\(?[a-zA-Z][.)])\s/.test(line);
    const prevEnded = /[.!?:;]["')\]]?$/.test(out);
    out += startsItem || prevEnded ? `\n${line}` : ` ${line}`;
  }
  return out;
}

export function detectHeading(line) {
  const words = line.split(' ');
  if (line.length > 100 || words.length > 14) return null;

  let m = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
  if (m) return { level: m[1].length, text: m[2] };

  if (/^(chapter|unit|module|lesson|part|section|topic)\s+([0-9]+|[ivxlc]+|[a-z])\b/i.test(line) && !/[.,;]$/.test(line)) {
    return { level: 1, text: line };
  }

  m = line.match(/^(\d{1,2}(?:\.\d{1,2}){0,3})[.)]?\s+(\S.*)$/);
  if (m) {
    const rest = m[2];
    if (/^[A-Z]/.test(rest) && !/[.,;:?]$/.test(rest) && rest.split(' ').length <= 10) {
      return { level: m[1].split('.').filter(Boolean).length, text: line };
    }
    return null;
  }

  const letters = line.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 4 && letters === letters.toUpperCase() && words.length <= 10 && !/[.,;]$/.test(line)) {
    return { level: 2, text: line };
  }
  return null;
}

export function htmlToBlocks(html) {
  return walkHtml(html).map((block) => {
    if (block.kind === 'heading') return { type: 'heading', level: block.level, text: block.text };
    if (block.kind === 'li') return { type: 'para', text: `${block.label} ${block.text}` };
    // Many documents fake headings with a short, fully bold paragraph.
    const heading =
      detectHeading(block.text) ||
      (block.fullyBold && block.text.split(' ').length <= 12 && !/[.,;:]$/.test(block.text) ? { level: 3, text: block.text } : null);
    return heading ? { type: 'heading', ...heading } : { type: 'para', text: block.text };
  });
}

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'];
function listLabel(list, depth) {
  if (!list.ordered) return '•';
  const n = list.count;
  if (depth === 1) return `${n}.`;
  if (depth === 2) return n <= 26 ? `${String.fromCharCode(96 + n)})` : `${n})`;
  return `(${ROMAN[n - 1] || n})`;
}

// A small HTML walker for mammoth's output. Mammoth renders Word's automatic numbering as nested
// <ol>/<li> without the numbers, so labels are rebuilt here: "1." for top-level items and "a)" below.
export function walkHtml(html, { keepBold = false } = {}) {
  const blocks = [];
  const lists = [];
  let current = null;
  let boldDepth = 0;
  let cellDepth = 0;

  // Bold marks are written as ** around the visible text only, so "<b> Paris </b>" becomes " **Paris** ".
  const closeBoldMark = () => {
    if (current?.boldOpen) {
      const trailing = current.text.match(/\s*$/)[0];
      current.text = `${current.text.slice(0, current.text.length - trailing.length)}**${trailing}`;
    }
    if (current) current.boldOpen = current.boldPending = false;
  };
  const flush = () => {
    if (current) {
      closeBoldMark();
      const text = current.text.replace(/\s+/g, ' ').trim();
      if (text) blocks.push({ kind: current.kind, level: current.level, label: current.label, text, fullyBold: current.chars > 0 && current.boldChars === current.chars });
    }
    current = null;
  };
  const start = (kind, extra = {}) => {
    flush();
    current = { kind, ...extra, text: '', chars: 0, boldChars: 0, boldPending: keepBold && boldDepth > 0, boldOpen: false };
  };

  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)[^>]*>|([^<]+)/g)) {
    if (m[3] !== undefined) {
      let text = decodeEntities(m[3]);
      if (!current) start('p');
      const visible = text.replace(/\s/g, '').length;
      current.chars += visible;
      if (boldDepth) current.boldChars += visible;
      if (current.boldPending && visible) {
        const leading = text.match(/^\s*/)[0];
        text = `${leading}**${text.slice(leading.length)}`;
        current.boldPending = false;
        current.boldOpen = true;
      }
      current.text += text;
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      if (closing) flush();
      else start('heading', { level: Number(tag[1]) });
    } else if (tag === 'p') {
      if (cellDepth) continue;
      if (closing) flush();
      else if (!(current?.kind === 'li' && !current.text.trim())) start('p');
    } else if (tag === 'ol' || tag === 'ul') {
      flush();
      if (closing) lists.pop();
      else lists.push({ ordered: tag === 'ol', count: 0 });
    } else if (tag === 'li') {
      if (closing) {
        flush();
      } else {
        const list = lists[lists.length - 1] || { ordered: false, count: 0 };
        list.count++;
        start('li', { label: listLabel(list, Math.max(1, lists.length)) });
      }
    } else if (tag === 'tr') {
      if (closing) flush();
      else start('p');
    } else if (tag === 'td' || tag === 'th') {
      if (closing) cellDepth--;
      else {
        cellDepth++;
        if (current?.text.trim()) current.text += ' | ';
      }
    } else if (tag === 'strong' || tag === 'b') {
      if (closing) {
        boldDepth = Math.max(0, boldDepth - 1);
        if (keepBold && !boldDepth) closeBoldMark();
      } else {
        if (keepBold && !boldDepth && current) current.boldPending = true;
        boldDepth++;
      }
    } else if (tag === 'br' && current) {
      current.text += ' ';
    }
  }
  flush();
  return blocks;
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
