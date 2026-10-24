# online-test

An online practice-test portal. Upload one or more study documents, choose how many objective questions to take from each section, set a time limit, and take a timed test. When you submit, you get your score and can review every question with the right answer and an explanation. Past tests are listed on a reports page.

## Features

- **Two kinds of upload**: before uploading, choose what the files are.
  - **Study material** (notes, chapters, summaries): new questions are generated from the content. Each document is split into sections using its headings (Markdown `#`, numbered headings such as `2.3 Transport Layer`, `Chapter`/`Unit` lines, ALL-CAPS lines, Word heading styles or short bold lines). Long documents without headings are split into parts.
  - **Question paper** (sample or previous questions): the paper's own questions are used exactly as written, with options in the original order. They are grouped by the paper's sections, and every question starts selected; choosing fewer gives a random selection kept in paper order.
- **Supported file types**: PDF, Word (`.docx`), plain text and Markdown, several at a time.
- **Questions from your documents only**: choose the number of questions per section, or spread a total across all study-material sections in proportion to their length. You can also pick the question type (single correct, multiple correct, or mixed) and difficulty for study material, plus the time limit, the pass mark and a test name.
- **Multiple-correct questions**: these end with `(Select N answers)`. A question scores only when the candidate selects exactly the correct options, and the test screen stops them selecting more than N.
- **Candidate details**: name and mobile number are required before a test starts. They are confirmed on the instructions screen, and results are saved under the mobile number.
- **Timed tests**: a countdown with 5-minute and 1-minute warnings, a question palette (answered, not answered, marked for review), and automatic submission at zero. Answers are saved as you go, so a reload or closed tab can be resumed. An attempt left open past its deadline is graded on its saved answers.
- **Results**: score, pass/fail, correct, wrong and unanswered counts, time taken, a section-wise breakdown, and an answer review that can be filtered by correct, wrong or unanswered. Each question shows your answer, the correct answer, an explanation and the supporting quote from the document.
- **Reports**: every test taken with a mobile number, with average and best scores, pass count, links to each result, and a Resume button for tests still in progress.

## Question generation

| Engine | When it is used | What you get |
|---|---|---|
| Claude (`claude-opus-5-5` by default) | `ANTHROPIC_API_KEY` is set | Questions on the important facts, definitions and processes in each section. Plausible distractors, explanations and a supporting quote, using only the document text. |
| Basic offline generator | No API key, or `QUESTION_ENGINE=offline` | Rule-based fill-in-the-blank and "which statements are correct" questions made from sentences in the document. Works without internet access, but the questions are simpler. |

### Question papers

| Engine | How the paper is read |
|---|---|
| Claude | Copies every objective question and its options as written. Answers are taken from the paper wherever it gives them: an answer line, an answer key elsewhere, or an option marked in bold, with an asterisk, a tick or "(correct)". If the paper has no answer for a question, Claude works it out, and the review flags that answer as "worked out by Claude". PDFs are sent as the original file, so layout and marked answers survive, and scanned papers can work. |
| Offline reader | Recognises numbered questions (`1.`, `Q1`, `Question 1:`) and lettered options (`a)`, `(A)`, `B.`, also several on one line). It reads answers from `Answer: b` or `Ans: A, C` lines, or from an answer key anywhere in the paper, usually at the end: pairs such as `1-b 2-c 4-a,b`, or table rows such as `Q2 A, B Multiple`. It also uses options marked with `*`, a tick or `(correct)`, and bold options in Word files. True/false questions with `Answer: True` work too. Key entries are matched to questions by number; if numbering restarts in each section, they are matched in order. Labels like `(Single choice)` or `(Multiple choice – select two)` are removed, and the stated count is checked against the key. PDF running headers, page numbers and section titles that wrap onto two lines are handled. Questions without options or without an answer are skipped and listed. Word's automatic list numbering is supported. |

Once uploaded, a question paper's questions and answer key are stored with the document and reused for every test and retake built from it. **Answer key** (next to the paper in the upload list) shows every question with its answer, the paper's section and question number, and any items to check: a missing answer, an answer letter the question doesn't have, or a stated number to select that disagrees with the key. The answer review after a test shows each question's number in the paper ("Paper Q12").

### Generation and checks

With Claude, each section's request uses structured JSON output, so responses always parse. Every question is then checked: options must be unique, answer indexes valid, and multiple-correct questions must not mark every option correct. Options are shuffled so the correct answer's position gives no hint. If a section yields fewer valid questions than requested, a second request fills the gap, and any remaining shortfall is shown on the instructions screen. Requests opt into the API's server-side refusal fallback (`fallbacks: "default"`), which retries a request declined by a safety classifier on another model.

## Getting started

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env      # then put your Claude API key in .env
npm start                 # http://localhost:3000
```

Without a key the app still runs, using the basic offline generator.

Other commands:

```bash
npm run dev    # restart automatically when files change
npm test       # unit tests (parsing, sections, question papers, question checks, grading)
```

`test/jutroQuestionBank.test.js` checks the question-paper reader against a real 29-page, 111-question paper with its answer key at the end. It verifies all 111 answers, the four sections and clean question text, and grades against the stored key. The PDF goes in `test/fixtures/jutro-question-bank.pdf`, and the expected answer key, section titles and sample question text go in `test/fixtures/jutro-expected.json`. Both are git-ignored because they are exam material; without them, these tests are skipped.

### Settings (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Enables Claude question generation |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used to write questions |
| `CLAUDE_EFFORT` | `high` | Effort for writing questions, `low` to `max`: higher is more careful but slower |
| `CLAUDE_EXTRACT_EFFORT` | `medium` | Effort for reading question papers |
| `QUESTION_ENGINE` | auto | Set to `offline` to force the basic generator |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `data` | Where documents, tests and results are stored |

## How it works

```
public/            Single-page front end (plain HTML, CSS and JavaScript; no build step)
server.js          Express API: uploads, test generation jobs, attempts, grading, reports
lib/parse.js       PDF, DOCX and text to headings and paragraphs (study material) or text lines (question papers)
lib/sections.js    Headings and paragraphs to sections
lib/questionPaper.js  Offline question-paper reader
lib/generator/     Claude and offline question generators, validation and shuffling
lib/grading.js     Scoring and answer review
lib/store.js       JSON-file storage in data/
```

- The browser never receives the answer key while a test is running; the server grades the submission.
- Storage is one JSON file per document, test and attempt under `data/`. That is enough for personal or small-group use; switch to a database for many users.
- There is no login: reports are looked up by mobile number, so anyone who knows a number can see its results. Add authentication (for example an OTP to the mobile number) before exposing the app publicly.
- Scanned PDFs (page images without a text layer) are not supported as study material, or as question papers without a Claude key; use a PDF with selectable text.
