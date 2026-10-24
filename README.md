# online-test

An online practice-test portal with invite-only access. An administrator uploads study documents into courses, adds users, gives each user access to courses and emails them an invite. Users sign in with their email address and a one-time code, choose documents from their courses, choose how many objective questions to take from each section, set a time limit, and take a timed test. When they submit, they get their score and can review every question with the right answer and an explanation. Past tests are listed on a reports page.

## Features

- **Courses and library**: only the administrator uploads documents, on the **Library** page, and each upload goes into a course. The administrator can add, rename and delete courses, and move or delete documents. Tests already built from a deleted document keep working.
- **Course access**: on the **Users** page, the administrator chooses which courses each user can see. Users see only those courses' documents, and only those can go into their tests. They can't upload, and can't see a question paper's answer key.
- **Two kinds of upload**: before uploading, the administrator chooses what the files are.
  - **Study material** (notes, chapters, summaries): new questions are generated from the content. Each document is split into sections using its headings (Markdown `#`, numbered headings such as `2.3 Transport Layer`, `Chapter`/`Unit` lines, ALL-CAPS lines, Word heading styles or short bold lines). Long documents without headings are split into parts.
  - **Question paper** (sample or previous questions): the paper's own questions are used exactly as written, with options in the original order. They are grouped by the paper's sections, and every question starts selected; choosing fewer gives a random selection kept in paper order.
- **Supported file types**: PDF, Word (`.docx`), plain text and Markdown, several at a time.
- **Questions from the chosen documents only**: tick documents from your courses, then choose the number of questions per section, or spread a total across all study-material sections in proportion to their length. You can also pick the question type (single correct, multiple correct, or mixed) and difficulty for study material, plus the time limit, the pass mark and a test name.
- **Multiple-correct questions**: these end with `(Select N answers)`. A question scores only when the candidate selects exactly the correct options, and the test screen stops them selecting more than N.
- **Invite-only sign-in**: an administrator adds each user (name, age, gender, email, mobile number, capability: Digital, Core or both, and courses) and emails them an invite. The invite links to the portal with the user's email filled in. Each time they sign in, the user asks for a 6-digit code, which is emailed to them. Only invited users who are enabled can sign in. Administrators sign in with their email address and a password.
- **User management**: the administrator's **Users** page lists everyone with their invite and sign-in status, and can send or resend invites, edit details, and enable or disable a user at any time. Disabling signs the user out straight away. The administrator can also open any user's reports.
- **Timed tests**: a countdown with 5-minute and 1-minute warnings, a question palette (answered, not answered, marked for review), and automatic submission at zero. Answers are saved as you go, so a reload or closed tab can be resumed. An attempt left open past its deadline is graded on its saved answers.
- **Results**: score, pass/fail, correct, wrong and unanswered counts, time taken, a section-wise breakdown, and an answer review that can be filtered by correct, wrong or unanswered. Each question shows your answer, the correct answer, an explanation and the supporting quote from the document.
- **Phones, tablets and desktops**: the layout adapts to every screen. On phones, navigation moves to a tab bar along the bottom and the header scrolls away; during a test, the tab bar is hidden so the question gets the whole screen. Forms use 16px text so iPhones don't zoom in, and controls are finger-sized on touch screens.
- **Installable app**: the portal installs on Android, iPhone, iPad and desktop like an app, with its own icon, a full-screen window and a startup screen. See [Installing the app](#installing-the-app).
- **Reports**: every test the signed-in user has taken, with its course, score and result, average and best scores, pass count, links to each result, and a Resume button for tests still in progress. Each user sees only their own tests and results.

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
cp .env.example .env      # then set ADMIN_EMAIL and ADMIN_PASSWORD, and optionally your Claude API key and SMTP settings
npm start                 # http://localhost:3000
```

Without a Claude key the app still runs, using the basic offline generator.

### Users and sign-in

1. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` and start the server. The administrator gets an account automatically. (`ADMIN_EMAIL` can list several addresses separated by commas; they share the password.)
2. Open the portal, choose **Administrator? Sign in with your password**, and sign in.
3. On **Library**, add a course, choose it, and upload its documents.
4. On **Users**, choose **Add user**, fill in the details, tick the courses the user may see, and leave **Email the invite now** ticked (or send the invite later from the list).
5. The user opens the link in the invite, asks for a code and signs in. Next time, they go to the portal and do the same.

Codes expire after 10 minutes and allow 5 tries; a new code can be requested after 60 seconds, up to 5 an hour. After 5 wrong administrator passwords in 15 minutes, that address is locked out for 15 minutes. Sessions last 30 days, or until the user signs out, is disabled, or has their email address changed (which also cancels their invite, so the new address needs one). Administrators are managed only through `ADMIN_EMAIL`: they need no invite and can't be disabled from the Users page. Without `ADMIN_PASSWORD`, administrators sign in with an emailed code like everyone else.

**Production**: `.env` is not committed, so set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (and `APP_URL`, `SMTP_*`, `ANTHROPIC_API_KEY`) in your host's environment variables or secrets settings, or in a `.env` file on the server. Never put the password in the code or the repository.

**Email**: set `SMTP_HOST` and the other `SMTP_` settings to send invites and codes through your mail provider. For Gmail, use `smtp.gmail.com`, port 587 and an [app password](https://support.google.com/accounts/answer/185833). Without `SMTP_HOST`, each email is printed in the server's console instead, so you can try everything locally by copying the code or invite link from there. The server checks the SMTP settings at startup and logs the result.

`APP_URL` is the address put in invite emails. Set it to the portal's public address (for example `https://tests.example.com`) when users aren't on the same machine; with an `https` address, the session cookie is marked secure.

Other commands:

```bash
npm run dev    # restart automatically when files change
npm test       # unit tests (parsing, sections, question papers, question checks, grading, sign-in)
```

`test/jutroQuestionBank.test.js` checks the question-paper reader against a real 29-page, 111-question paper with its answer key at the end. It verifies all 111 answers, the four sections and clean question text, and grades against the stored key. The PDF goes in `test/fixtures/jutro-question-bank.pdf`, and the expected answer key, section titles and sample question text go in `test/fixtures/jutro-expected.json`. Both are git-ignored because they are exam material; without them, these tests are skipped.

### Installing the app

The portal is a Progressive Web App: people install it from the browser, with no app store. The installed app opens full-screen from its own icon, shows a startup screen, and always loads the latest version from the server. Without a connection it still opens, and asks the user to reconnect.

- **Android** (Chrome, Edge, Samsung Internet): an **Install the app** banner appears in the portal; or use the browser menu, **Install app**.
- **iPhone and iPad** (Safari): the portal shows how. Tap **Share**, then **Add to Home Screen**.
- **Desktop** (Chrome, Edge): an install button appears in the banner and in the address bar.

Installing needs the portal to be served over **https**. Browsers allow it on `http://localhost` only, so a phone opening `http://192.168.x.x:3000` can use the site but not install it. Deploy the portal behind https (and set `APP_URL` to that address), or try it from a phone through an https tunnel such as Cloudflare Tunnel or ngrok.

To publish it in **Google Play** or the **App Store**, wrap the deployed https site: for example with [PWABuilder](https://www.pwabuilder.com/), which packages a PWA for both stores. This needs a Google Play developer account, and an Apple developer account plus a Mac to build the iOS app.

### Settings (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Enables Claude question generation |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used to write questions |
| `CLAUDE_EFFORT` | `high` | Effort for writing questions, `low` to `max`: higher is more careful but slower |
| `CLAUDE_EXTRACT_EFFORT` | `medium` | Effort for reading question papers |
| `QUESTION_ENGINE` | auto | Set to `offline` to force the basic generator |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `data` | Where documents, tests, results, users and sessions are stored |
| `ADMIN_EMAIL` | none | Administrator address(es), comma-separated. Required: nobody can sign in without one |
| `ADMIN_PASSWORD` | none | Administrator password. Without it, administrators sign in with an emailed code |
| `APP_URL` | `http://localhost:PORT` | Portal address used in invite emails |
| `SMTP_HOST` | none | Mail server. Without it, emails are printed in the server console |
| `SMTP_PORT` | `587` | Mail server port |
| `SMTP_SECURE` | `true` for port 465 | `true` to use TLS from the start (port 465), `false` for STARTTLS |
| `SMTP_USER`, `SMTP_PASS` | none | Mail account login |
| `MAIL_FROM` | `Practice Test Portal <SMTP_USER>` | Sender shown on emails |

## How it works

```
public/            Single-page front end (plain HTML, CSS and JavaScript; no build step)
public/manifest.webmanifest, sw.js   App manifest and service worker that make the portal installable
public/icons/, public/splash/        App icons (from icons/icon.svg) and iOS startup screens
server.js          Express API: sign-in, users, courses and library, uploads, test generation jobs, attempts, grading, reports
lib/parse.js       PDF, DOCX and text to headings and paragraphs (study material) or text lines (question papers)
lib/sections.js    Headings and paragraphs to sections
lib/questionPaper.js  Offline question-paper reader
lib/generator/     Claude and offline question generators, validation and shuffling
lib/grading.js     Scoring and answer review
lib/store.js       JSON-file storage in data/
lib/users.js       User details validation, administrators, who may sign in and see which documents
lib/auth.js        One-time sign-in codes, the admin password check and session cookies
lib/mailer.js      Invite and sign-in code emails over SMTP
```

- The browser never receives the answer key while a test is running; the server grades the submission.
- Storage is one JSON file per document, test and attempt under `data/`. That is enough for personal or small-group use; switch to a database for many users.
- Every API route except sign-in needs a session, and each request checks that the user is still enabled. Session cookies are `HttpOnly` and `SameSite=Lax`, and requests from other sites that change data are refused. Sign-in codes are kept only as hashes in the server's memory, so after a restart users ask for a new code. Sessions are stored as hashes in `data/sessions`.
- The sign-in form gives the same answer whether or not an address has an invite, so it can't be used to find out who has an account.
- Documents uploaded before courses existed appear on the Library page under **Not in a course**; users can't see them until the administrator moves them into a course. Tests and attempts from before sign-in have no owner, so only administrators see them, except that results saved under a mobile number appear in the reports of the user with that mobile number.
- The administrator password is never stored: the server hashes it from `ADMIN_PASSWORD` when it starts and compares hashes in constant time.
- Scanned PDFs (page images without a text layer) are not supported as study material, or as question papers without a Claude key; use a PDF with selectable text.
