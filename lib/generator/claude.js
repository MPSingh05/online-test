// Claude calls: writing questions from study material, and extracting questions from a question paper.
// Both use structured output (a JSON schema), so the response always parses.
import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const GENERATE_EFFORT = process.env.CLAUDE_EFFORT || 'high';
// Extraction is mostly careful copying, so it runs at a lower effort to keep uploads quick.
const EXTRACT_EFFORT = process.env.CLAUDE_EXTRACT_EFFORT || 'medium';
// Server-side refusal fallbacks are only accepted for these models.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
// PDFs are sent as documents (Claude sees layout, bold and tick marks) when they fit the request limits.
const MAX_NATIVE_PDF_BYTES = 20 * 1024 * 1024;
const MAX_NATIVE_PDF_PAGES = 500;

let client;
const getClient = () => (client ??= new Anthropic());

export const claudeConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

export class GenerationError extends Error {}

const escapeAttr = (s) => String(s).replace(/"/g, "'");

async function callClaude({ system, content, schema, effort, maxTokens, subject }) {
  const request = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  };
  if (FALLBACK_MODELS.has(CLAUDE_MODEL)) {
    // If a safety classifier declines the request, the API retries it on a fallback model.
    request.betas = ['server-side-fallback-2026-07-01'];
    request.fallbacks = 'default';
  }

  let message;
  try {
    message = await getClient().beta.messages.stream(request).finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new GenerationError('The Claude API key was rejected. Check ANTHROPIC_API_KEY in your .env file.');
    } else if (err instanceof Anthropic.PermissionDeniedError) {
      throw new GenerationError(`This API key cannot use the model ${CLAUDE_MODEL}.`);
    } else if (err instanceof Anthropic.RateLimitError) {
      throw new GenerationError('The Claude API rate limit was reached. Wait a minute and try again.');
    } else if (err instanceof Anthropic.BadRequestError) {
      throw new GenerationError(`The Claude API rejected the request for ${subject}: ${err.message}`);
    } else if (err instanceof Anthropic.APIError) {
      throw new GenerationError(`The Claude API returned an error (${err.status ?? 'network'}): ${err.message}`);
    }
    throw err;
  }

  if (message.stop_reason === 'refusal') throw new GenerationError(`Claude declined to process ${subject}.`);
  if (message.stop_reason === 'max_tokens') {
    throw new GenerationError(`The response for ${subject} was too long and got cut off. Try a smaller document or fewer questions.`);
  }
  const json = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return JSON.parse(json);
}

// ---------- writing new questions from study material ----------

const GENERATED_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correct_options: { type: 'array', items: { type: 'integer' } },
          explanation: { type: 'string' },
          source_quote: { type: 'string' },
        },
        required: ['question', 'options', 'correct_options', 'explanation', 'source_quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

const GENERATE_SYSTEM = `You write objective (multiple-choice) practice-test questions from study material the user uploads.

Ground every question in the supplied section text only. The question, every correct option, every distractor's wrongness, and the explanation must all be checkable against that text; if the text does not state something, do not ask about it, even if you know it to be true.

What makes a good question here:
- It tests an important fact, definition, process, cause and effect, comparison or rule from the text, not trivia such as page numbers, headings or formatting.
- It stands on its own: name the concept being asked about rather than saying "the passage" or "the text above".
- Distractors are plausible, similar in length and style to the correct option, and clearly wrong according to the text. Do not use "All of the above" or "None of the above".
- No two questions test the same fact.
- It is written in the same language as the section text.

Field notes:
- correct_options holds the 0-based indexes of every correct option.
- source_quote is a short verbatim excerpt (one or two sentences) from the section that proves the answer.
- explanation says briefly why the correct options are right and, where useful, why a tempting distractor is wrong.
- Do not write how many options to select in the question text; the application adds that itself.`;

const DIFFICULTY_GUIDE = {
  easy: 'Make the questions easy: direct recall of clearly stated facts and definitions.',
  medium: 'Make the questions medium difficulty: understanding and applying what the text says, not just recall.',
  hard: 'Make the questions hard: connecting several statements in the text, careful distinctions between similar concepts, and closely matched distractors.',
  mixed: 'Mix the difficulty: roughly a third easy, a third medium and a third hard.',
};

function buildGeneratePrompt({ docName, sectionTitle, text, single, multi, difficulty, avoid }) {
  const asks = [];
  if (single) asks.push(`${single} question${single > 1 ? 's' : ''} with exactly one correct option out of 4 options`);
  if (multi) {
    asks.push(
      `${multi} question${multi > 1 ? 's' : ''} with two or more correct options out of 4 or 5 options (vary how many are correct, but never make every option correct)`,
    );
  }
  let prompt = `<document title="${escapeAttr(docName)}" section="${escapeAttr(sectionTitle)}">
${text}
</document>

Write exactly ${single + multi} questions from the section above: ${asks.join(', and ')}.
${DIFFICULTY_GUIDE[difficulty] || DIFFICULTY_GUIDE.mixed}
If the section does not contain enough distinct facts for that many good questions, write fewer rather than repeating facts or going beyond the text.`;
  if (avoid.length) {
    prompt += `\n\nThese questions already exist for this section, so do not repeat or rephrase them:\n${avoid
      .map((q) => `- ${q}`)
      .join('\n')}`;
  }
  return prompt;
}

export async function generateWithClaude(params) {
  const data = await callClaude({
    system: GENERATE_SYSTEM,
    content: buildGeneratePrompt(params),
    schema: GENERATED_SCHEMA,
    effort: GENERATE_EFFORT,
    maxTokens: 64000,
    subject: `"${params.sectionTitle}"`,
  });
  return data.questions.map((q) => ({
    text: q.question,
    options: q.options,
    correct: q.correct_options,
    explanation: q.explanation,
    source: q.source_quote,
  }));
}

// ---------- extracting the questions in a question paper ----------

const EXTRACTED_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'string' },
          section: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correct_options: { type: 'array', items: { type: 'integer' } },
          answer_in_document: { type: 'boolean' },
          explanation: { type: 'string' },
          issue: { type: 'string' },
        },
        required: ['number', 'section', 'question', 'options', 'correct_options', 'answer_in_document', 'explanation', 'issue'],
        additionalProperties: false,
      },
    },
    skipped_count: { type: 'integer' },
  },
  required: ['questions', 'skipped_count'],
  additionalProperties: false,
};

const EXTRACT_SYSTEM = `You extract the objective questions from a question paper (sample questions, a previous exam, a quiz) so they can be used in a practice test exactly as written.

- Include every objective question in the document, in document order. Copy the question and its options as written: do not reword, shorten, merge, split or invent anything. Only repair obvious text-extraction damage such as words broken across lines, stray page numbers or running headers.
- number: the question's number as printed ("12" for "Q12." or "12)"), or an empty string if it has none. Leave the number and the option labels ("(a)", "B)") out of the question and option text, and keep the options in the document's order.
- Leave out labels that state the question type or how many options to select, such as "(Single choice)" or "(Multiple choice – select two)"; the application shows its own.
- Keep any material the question depends on, such as numbered statements, a short passage or a table rendered as text, in the question text.
- correct_options holds the 0-based indexes of every correct option. Take them from the document whenever it gives the answer, in any form: an answer line under the question, an answer key or answer sheet elsewhere (often a table at the end listing question numbers and option letters; match it to the questions by number), or a marked option (bold, asterisk, tick, highlight, "(correct)"). Set answer_in_document to true in that case.
- When the document does not give the answer, work out the correct option or options yourself and set answer_in_document to false.
- issue: an empty string, unless something about the question needs the reader's attention. For example, the question says to select two but the answer key lists three options, the answer key names an option the question does not have, or two entries in the key share a number. Describe it in one sentence.
- explanation: the document's explanation or solution when it has one; otherwise one or two sentences on why the answer is correct.
- section: the heading the question sits under, without any question-number range in it ("Section B: Biology" for "Section B: Biology (Q20–Q40)"), or an empty string when the paper has no headings.
- A true/false question becomes two options, "True" and "False".
- Leave out anything that is not objective (essay, short-answer or fill-in questions without options to choose from) and count those in skipped_count.`;

export async function extractWithClaude({ docName, text, pdf }) {
  const instruction = 'Extract every objective question from this question paper.';
  const useNativePdf = pdf && pdf.buffer.length <= MAX_NATIVE_PDF_BYTES && (pdf.pages ?? 0) <= MAX_NATIVE_PDF_PAGES;
  const content = useNativePdf
    ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.buffer.toString('base64') }, title: docName },
        { type: 'text', text: instruction },
      ]
    : `<document title="${escapeAttr(docName)}">\n${text}\n</document>\n\nBold text is marked with **. ${instruction}`;

  const data = await callClaude({
    system: EXTRACT_SYSTEM,
    content,
    schema: EXTRACTED_SCHEMA,
    effort: EXTRACT_EFFORT,
    maxTokens: 128000,
    subject: `"${docName}"`,
  });
  return {
    questions: data.questions.map((q) => ({
      number: q.number,
      section: q.section,
      text: q.question,
      options: q.options,
      correct: q.correct_options,
      explanation: q.explanation,
      answerInDocument: q.answer_in_document,
      issue: q.issue.trim(),
    })),
    skipped: data.skipped_count,
    unanswered: 0,
    issues: [],
  };
}
