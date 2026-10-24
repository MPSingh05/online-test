// Practice Test Portal — single-page front end (hash routing, no build step).

const app = document.getElementById('app');
const modal = document.getElementById('modal');
const toastEl = document.getElementById('toast');
const LETTERS = 'ABCDEFGH';

// ---------- utilities ----------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: the app still works, it just won't remember drafts.
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

class ApiError extends Error {
  constructor(message, status, fields) {
    super(message);
    this.status = status;
    this.fields = fields; // form field name -> message, for forms that show errors per field
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const init = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('Cannot reach the server. Check that it is running and try again.', 0);
  }
  const data = await res.json().catch(() => ({}));
  // The session ended (signed out elsewhere, expired, or the user was disabled): back to the sign-in page.
  if (res.status === 401 && !path.startsWith('/api/auth/')) signedOut(data.error);
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`, res.status, data.fields);
  return data;
}

let toastTimer;
function toast(message, ms = 3000) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

const pad = (n) => String(n).padStart(2, '0');
function formatClock(totalSec) {
  const sec = Math.max(0, Math.ceil(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(sec % 60)}` : `${pad(m)}:${pad(sec % 60)}`;
}
function formatDuration(totalSec) {
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${pad(m)}m`;
  if (m) return `${m}m ${pad(sec % 60)}s`;
  return `${sec}s`;
}
const formatDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
const plural = (n, word, pluralWord = `${word}s`) => `${n} ${n === 1 ? word : pluralWord}`;
const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const fileExt = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const contactLine = (user) => [user.email, user.mobile].filter(Boolean).join(' · ');

// Shows the server's per-field messages next to each field; returns true if there were any.
function showFieldErrors(form, fields = {}) {
  for (const message of form.querySelectorAll('[data-error]')) {
    const text = fields[message.dataset.error] || '';
    message.textContent = text;
    message.hidden = !text;
    form.querySelectorAll(`[name="${message.dataset.error}"]`).forEach((input) => input.setAttribute('aria-invalid', text ? 'true' : 'false'));
  }
  const first = form.querySelector('[aria-invalid="true"]');
  first?.focus();
  return Boolean(first || Object.values(fields).some(Boolean));
}

function busy(button, label) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> ${esc(label)}`;
  return () => {
    button.disabled = false;
    button.innerHTML = original;
  };
}

// ---------- state ----------

const DEFAULT_SETTINGS = {
  questionType: 'mixed',
  difficulty: 'mixed',
  timeLimitMin: 20,
  timeAuto: true,
  passPercent: 60,
  title: '',
  quickTotal: 20,
  uploadKind: 'content', // Library upload: 'content' (study material) or 'questions' (question paper)
  uploadCourse: '', // Library upload: the course new documents go into
};

const isPaper = (doc) => doc.kind === 'questions';

const state = {
  config: null,
  user: null, // the signed-in user
  courses: [], // courses the user can see (all of them for admins)
  docs: [], // documents in those courses, from the server
  selectedDocs: [], // IDs of the documents ticked for the next test
  counts: {}, // "docId:sectionId" -> number of questions
  settings: { ...DEFAULT_SETTINGS },
  cleanup: [],
};

// The test being set up is remembered per user, so people sharing a browser don't see each other's choices.
const draftKey = (part) => `opt.${state.user.id}.${part}`;

function loadDraft() {
  // Drafts from before documents were shared by course referred to private uploads; they no longer apply.
  for (const old of ['opt.docs', 'opt.unusedDocs', 'opt.counts', 'opt.settings', 'opt.user', draftKey('docs'), draftKey('unusedDocs')]) {
    storage.remove(old);
  }
  state.selectedDocs = storage.get(draftKey('selectedDocs'), []);
  state.counts = storage.get(draftKey('counts'), {});
  state.settings = { ...DEFAULT_SETTINGS, ...storage.get(draftKey('settings'), {}) };
}

function saveDraft() {
  storage.set(draftKey('selectedDocs'), state.selectedDocs);
  storage.set(draftKey('counts'), state.counts);
  storage.set(draftKey('settings'), state.settings);
}

// Fetches the courses and documents this user can see, and forgets choices for documents that are gone.
async function loadLibrary() {
  const library = await api('/api/library');
  state.courses = library.courses;
  state.docs = library.documents;
  pruneCounts();
  saveDraft();
  return library;
}

// Documents ticked for the test being set up.
const inTest = (doc) => state.selectedDocs.includes(doc.id);
const testDocs = () => state.docs.filter(inTest);

// Section counts of the ticked documents. Counts of unticked documents are kept, so ticking one again restores them.
function testCounts() {
  const used = new Set(testDocs().map((d) => d.id));
  return Object.entries(state.counts).filter(([key]) => used.has(key.split(':')[0]));
}

const isAdminUser = () => state.user?.role === 'admin';

function renderHeader() {
  const user = state.user;
  document.body.classList.toggle('signed-out', !user);
  document.querySelectorAll('[data-admin]').forEach((link) => (link.hidden = !isAdminUser()));
  const el = document.getElementById('header-user');
  el.innerHTML = user
    ? `<span class="avatar" aria-hidden="true">${esc(initials(user.name))}</span>
       <span class="who-text"><strong>${esc(user.name)}</strong>${isAdminUser() ? ' <span class="badge info">Admin</span>' : ''}</span>
       <button class="btn ghost small" type="button" data-action="sign-out">Sign out</button>`
    : '';
  el.querySelector('[data-action="sign-out"]')?.addEventListener('click', signOut);
}

// ---------- modal ----------

function openModal(html, { dismissible = true, wide = false } = {}) {
  modal.innerHTML = `<div class="modal-body">${html}</div>`;
  modal.classList.toggle('wide', wide);
  modal.dataset.dismissible = dismissible ? 'yes' : '';
  if (!modal.open) modal.showModal();
  return modal;
}
function closeModal() {
  if (modal.open) modal.close();
}
modal.addEventListener('cancel', (event) => {
  if (!modal.dataset.dismissible) event.preventDefault();
});

function confirmModal({ title, body, confirmLabel, cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    openModal(`<h2 id="modal-title">${esc(title)}</h2>${body}
      <div class="btn-row"><button class="btn" type="button" data-answer="no">${esc(cancelLabel)}</button>
      <button class="btn primary" type="button" data-answer="yes">${esc(confirmLabel)}</button></div>`);
    const done = (answer) => {
      modal.removeEventListener('close', onClose);
      closeModal();
      resolve(answer);
    };
    const onClose = () => done(false);
    modal.addEventListener('close', onClose);
    modal.querySelector('[data-answer="yes"]').onclick = () => done(true);
    modal.querySelector('[data-answer="no"]').onclick = () => done(false);
    modal.querySelector('[data-answer="yes"]').focus();
  });
}

// ---------- router ----------

const routes = [
  { pattern: /^#?\/?$/, nav: 'new', view: viewNewTest },
  { pattern: /^#\/start\/([\w-]+)$/, nav: 'new', view: viewStart },
  { pattern: /^#\/paper\/([\w-]+)$/, nav: 'library', view: viewAnswerKey, admin: true },
  { pattern: /^#\/library$/, nav: 'library', view: viewLibrary, admin: true },
  { pattern: /^#\/attempt\/([\w-]+)$/, nav: null, view: viewAttempt },
  { pattern: /^#\/result\/([\w-]+)$/, nav: 'reports', view: viewResult },
  { pattern: /^#\/reports$/, nav: 'reports', view: viewReports },
  { pattern: /^#\/reports\/([\w-]+)$/, nav: 'users', view: viewReports, admin: true },
  { pattern: /^#\/users$/, nav: 'users', view: viewUsers, admin: true },
];

let routeToken = 0;
async function router() {
  for (const fn of state.cleanup.splice(0)) fn();
  closeModal();
  const token = ++routeToken;
  const ctx = { isActive: () => token === routeToken, onCleanup: (fn) => state.cleanup.push(fn) };

  if (!state.user) {
    viewSignIn(ctx);
    return;
  }
  const hash = location.hash || '#/';
  const route = routes.find((r) => r.pattern.test(hash));
  if (!route || (route.admin && !isAdminUser())) {
    location.replace('#/');
    return;
  }
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route.nav));
  window.scrollTo(0, 0);
  app.innerHTML = '<div class="loading"><span class="spinner"></span> Loading…</div>';
  try {
    await route.view(ctx, ...hash.match(route.pattern).slice(1));
  } catch (err) {
    if (!ctx.isActive()) return; // the page was left (or the session ended) while it loaded
    console.error(err);
    {
      app.innerHTML = `<div class="card narrow empty"><h2>Something went wrong</h2><p style="margin-top:8px">${esc(err.message)}</p><a class="btn primary" href="#/">Go to the start page</a></div>`;
    }
  }
}

// ---------- signing in and out ----------

function signedIn(user) {
  state.user = user;
  state.config = null;
  loadDraft();
  renderHeader();
}

// Called when the session ends for any reason; `notice` explains why (for example, access was disabled).
let signInNotice = '';
function signedOut(notice = '') {
  if (!state.user) return; // several requests can fail at once; the first one already showed the sign-in page
  state.user = null;
  signInNotice = notice;
  renderHeader();
  router();
}

async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // The cookie is cleared server-side when possible; either way, show the sign-in page.
  }
  signedOut();
  toast('You have signed out');
}

const RESEND_SEC = 60;

function viewSignIn(ctx) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.remove('active'));
  // Invite links carry the address (?email=...), so the user only has to ask for a code.
  const invited = new URLSearchParams(location.search).get('email');
  let email = invited || storage.get('opt.lastEmail', '');
  // Users sign in with an emailed code; administrators with a password.
  let mode = invited ? 'code' : storage.get('opt.signInMode', 'code');
  const notice = signInNotice;
  signInNotice = '';
  renderEmailStep();

  function renderEmailStep() {
    const password = mode === 'password';
    app.innerHTML = `<div class="card auth-card">
      <h1>${password ? 'Administrator sign-in' : 'Sign in'}</h1>
      <p class="muted">${password ? 'Sign in with your administrator email address and password.' : 'Use the email address your administrator invited. Each time you sign in, we email you a 6-digit code.'}</p>
      ${notice ? `<div class="callout warn" style="margin-top:14px">${esc(notice)}</div>` : ''}
      <form novalidate>
        <div class="field">
          <label for="signin-email">Email address</label>
          <input type="email" id="signin-email" name="email" autocomplete="${password ? 'username' : 'email'}" maxlength="254" required value="${esc(email)}" aria-describedby="signin-email-error">
          <span class="form-error" id="signin-email-error" data-error="email" hidden></span>
        </div>
        ${
          password
            ? `<div class="field">
          <label for="signin-password">Password</label>
          <input type="password" id="signin-password" name="password" autocomplete="current-password" maxlength="200" required aria-describedby="signin-password-error">
          <span class="form-error" id="signin-password-error" data-error="password" hidden></span>
        </div>`
            : ''
        }
        <button class="btn primary large block" type="submit">${password ? 'Sign in' : 'Email me a code'}</button>
      </form>
      <div class="auth-links"><button class="btn ghost small" type="button" data-action="mode">${password ? 'Sign in with an emailed code instead' : 'Administrator? Sign in with your password'}</button></div>
    </div>`;
    const form = app.querySelector('form');
    const input = form.elements.email;
    (password && email ? form.elements.password : input).focus();
    app.querySelector('[data-action="mode"]').onclick = () => {
      email = input.value.trim();
      mode = password ? 'code' : 'password';
      storage.set('opt.signInMode', mode);
      renderEmailStep();
    };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      email = input.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        showFieldErrors(form, { email: 'Enter a valid email address, such as name@example.com.' });
        return;
      }
      if (password && !form.elements.password.value) {
        showFieldErrors(form, { password: 'Enter your password.' });
        return;
      }
      const done = busy(form.querySelector('[type="submit"]'), password ? 'Signing in…' : 'Sending…');
      try {
        if (password) {
          const { user } = await api('/api/auth/password', { method: 'POST', body: { email, password: form.elements.password.value } });
          if (!ctx.isActive()) return;
          storage.set('opt.lastEmail', email);
          signedIn(user);
          router();
          return;
        }
        await api('/api/auth/request-code', { method: 'POST', body: { email } });
        if (!ctx.isActive()) return;
        storage.set('opt.lastEmail', email);
        renderCodeStep();
      } catch (err) {
        if (!ctx.isActive()) return;
        done();
        if (password) {
          showFieldErrors(form, { password: err.message });
          form.elements.password.select();
        } else {
          showFieldErrors(form, { email: err.fields?.email || err.message });
        }
      }
    });
  }

  function renderCodeStep() {
    app.innerHTML = `<div class="card auth-card">
      <h1>Check your email</h1>
      <p class="muted">If <strong>${esc(email)}</strong> has been invited, we've sent it a 6-digit code. The code expires in 10 minutes.</p>
      <form novalidate>
        <div class="field">
          <label for="signin-code">Sign-in code</label>
          <input type="text" id="signin-code" name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required aria-describedby="signin-code-error">
          <span class="form-error" id="signin-code-error" data-error="code" hidden></span>
        </div>
        <button class="btn primary large block" type="submit">Sign in</button>
      </form>
      <div class="auth-links">
        <button class="btn ghost small" type="button" data-action="resend" disabled></button>
        <button class="btn ghost small" type="button" data-action="change">Use a different email</button>
      </div>
      <p class="muted small" style="margin-top:12px">No email? Check your spam folder. If it still doesn't arrive, ask your administrator to check that your invite was sent and your access is enabled.</p>
    </div>`;
    const form = app.querySelector('form');
    const input = form.elements.code;
    const resend = app.querySelector('[data-action="resend"]');
    input.focus();

    let waitUntil = Date.now() + RESEND_SEC * 1000;
    const updateResend = () => {
      const left = Math.ceil((waitUntil - Date.now()) / 1000);
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code';
    };
    updateResend();
    const timer = setInterval(updateResend, 1000);
    ctx.onCleanup(() => clearInterval(timer));

    resend.onclick = async () => {
      const done = busy(resend, 'Sending…');
      try {
        await api('/api/auth/request-code', { method: 'POST', body: { email } });
        toast('We sent a new code. Use the latest email.');
        waitUntil = Date.now() + RESEND_SEC * 1000;
      } catch (err) {
        toast(err.message, 5000);
      }
      done();
      updateResend();
    };
    app.querySelector('[data-action="change"]').onclick = () => {
      clearInterval(timer);
      renderEmailStep();
    };

    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
      if (input.value.length === 6) form.requestSubmit();
    });
    let submitting = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submitting) return;
      if (!/^\d{6}$/.test(input.value)) {
        showFieldErrors(form, { code: 'Enter the 6-digit code from the email.' });
        return;
      }
      submitting = true;
      const done = busy(form.querySelector('[type="submit"]'), 'Signing in…');
      try {
        const { user } = await api('/api/auth/verify', { method: 'POST', body: { email, code: input.value } });
        if (!ctx.isActive()) return;
        // Drop ?email= from the address bar now that it has been used.
        history.replaceState(null, '', location.pathname + location.hash);
        signedIn(user);
        router();
      } catch (err) {
        if (!ctx.isActive()) return;
        submitting = false;
        done();
        showFieldErrors(form, { code: err.message });
        input.select();
      }
    });
  }
}

// ---------- documents (shared by the new-test and library pages) ----------

const kindBadge = (doc) => (isPaper(doc) ? '<span class="badge info">Question paper</span>' : '<span class="badge">Study material</span>');

function docIcon(doc) {
  const ext = fileExt(doc.name);
  return `<span class="doc-icon ${esc(ext)}" aria-hidden="true">${esc(ext.toUpperCase().slice(0, 4))}</span>`;
}

// One line about a document. Admins also see what the question-paper reader skipped or flagged.
function docMeta(doc) {
  if (!isPaper(doc)) return `${plural(doc.sections.length, 'section')} · ${doc.wordCount.toLocaleString()} words`;
  const x = doc.extraction;
  const admin = isAdminUser();
  return [
    plural(doc.questionCount, 'question'),
    admin && x.suggested && `${x.suggested} ${x.suggested === 1 ? 'answer' : 'answers'} worked out by Claude`,
    admin && x.skipped && `${x.skipped} skipped (not multiple choice)`,
    admin && x.unanswered && `${x.unanswered} skipped (no answer found)`,
    admin && x.issues?.length && `<span class="badge warn">${plural(x.issues.length, 'item')} to check</span>`,
  ]
    .filter(Boolean)
    .join(' · ');
}

// Documents grouped by course, in course order. Documents outside any course (from before courses
// existed) come last; only admins have those.
function groupByCourse(courses, docs) {
  const groups = courses.map((course) => ({ course, docs: docs.filter((d) => d.courseId === course.id) }));
  const known = new Set(courses.map((c) => c.id));
  const loose = docs.filter((d) => !known.has(d.courseId));
  if (loose.length) groups.push({ course: null, docs: loose });
  return groups;
}

// ---------- view: create a new test ----------

async function viewNewTest(ctx) {
  state.config ??= await api('/api/config');
  await loadLibrary();
  if (!ctx.isActive()) return;

  const { limits, engine } = state.config;
  const groups = groupByCourse(state.courses, state.docs);

  app.innerHTML = `
    <div class="page-head">
      <h1>Create a practice test</h1>
      <p>Choose documents from your courses, pick how many questions to take from each section, set a time limit, and start practising. Questions come only from these documents.</p>
    </div>
    ${
      engine.id === 'offline'
        ? `<div class="callout warn" style="margin-bottom:16px"><strong>Basic question generator in use.</strong> No Claude API key is configured, so questions from study material are built by simple rules (fill-in-the-blank and correct-statement questions taken from the text).${isAdminUser() ? ' For better questions, add <code>ANTHROPIC_API_KEY</code> to the <code>.env</code> file and restart the server.' : ''}</div>`
        : `<div class="callout info" style="margin-bottom:16px">Questions are written by ${esc(engine.label)} using only the text of the documents.</div>`
    }
    <div class="steps">
      <section class="card" id="step-docs" aria-labelledby="step-docs-title"></section>
      <section class="card" id="step-config" aria-labelledby="step-config-title"></section>
    </div>
    <div class="action-bar" id="action-bar"></div>`;

  renderDocsStep();
  renderConfigStep();
  renderActionBar();

  function stepHead(id, number, done, title, description) {
    return `<div class="step-head"><span class="step-num${done ? ' done' : ''}" aria-hidden="true">${done ? '✓' : number}</span>
      <div><h2 id="${id}">${title}</h2><p class="muted">${description}</p></div></div>`;
  }

  function renderDocsStep() {
    const el = document.getElementById('step-docs');
    const head = stepHead(
      'step-docs-title',
      1,
      testDocs().length > 0,
      'Choose documents',
      isAdminUser()
        ? 'Tick the documents to use in this test. Add documents and courses on the <a href="#/library">Library</a> page.'
        : 'Tick the documents to use in this test. You see the courses your administrator has given you.',
    );
    if (!state.docs.length) {
      el.innerHTML = `${head}${
        isAdminUser()
          ? '<p class="muted">The library is empty. <a href="#/library">Upload documents in the Library</a> first.</p>'
          : `<div class="callout">${
              state.courses.length
                ? 'Your courses have no documents yet. Please check again later or ask your administrator.'
                : "You don't have access to any courses yet. Ask your administrator to give you a course."
            }</div>`
      }`;
      return;
    }
    el.innerHTML = `${head}
      <p class="small docs-used" id="docs-used">${docsUsedText()}</p>
      ${groups.map(courseGroupHtml).join('')}`;

    el.querySelectorAll('[data-use]').forEach((box) => {
      box.onchange = () => setDocsInTest([box.dataset.use], box.checked);
    });
    el.querySelectorAll('[data-use-all], [data-use-none]').forEach((btn) => {
      const group = groups[Number(btn.dataset.useAll ?? btn.dataset.useNone)];
      btn.onclick = () => setDocsInTest(group.docs.map((d) => d.id), 'useAll' in btn.dataset);
    });
  }

  function docsUsedText() {
    return `<strong>${testDocs().length} of ${plural(state.docs.length, 'document')}</strong> ticked for this test`;
  }

  function courseGroupHtml({ course, docs }, index) {
    const actions =
      docs.length > 1
        ? `<button class="btn small" type="button" data-use-all="${index}">Select all</button>
           <button class="btn ghost small" type="button" data-use-none="${index}">None</button>`
        : '';
    return `<div class="course-group">
      <div class="course-head"><h3>${course ? esc(course.name) : 'Not in a course'}</h3>
        <span class="muted small">${plural(docs.length, 'document')}</span>${actions}</div>
      ${docs.length ? `<ul class="doc-list">${docs.map(docPickHtml).join('')}</ul>` : '<p class="muted small">No documents in this course yet.</p>'}
    </div>`;
  }

  function docPickHtml(doc) {
    const used = inTest(doc);
    return `<li class="doc-item${used ? ' selected' : ''}">
      <label class="doc-pick">
        <input type="checkbox" data-use="${esc(doc.id)}"${used ? ' checked' : ''} aria-label="Use ${esc(doc.name)} in this test">
        ${docIcon(doc)}
        <span class="doc-meta"><strong title="${esc(doc.name)}">${esc(doc.name)}</strong>
        <span class="muted small">${kindBadge(doc)} ${docMeta(doc)}</span></span>
      </label>
      ${isAdminUser() && isPaper(doc) ? `<a class="btn small" href="#/paper/${esc(doc.id)}">Answer key</a>` : ''}</li>`;
  }

  // Ticks or unticks documents. The list is updated in place so keyboard focus stays on the checkbox.
  function setDocsInTest(ids, use) {
    const selected = new Set(state.selectedDocs);
    const added = ids.filter((id) => use && !selected.has(id));
    for (const id of ids) {
      if (use) selected.add(id);
      else selected.delete(id);
    }
    state.selectedDocs = state.docs.map((d) => d.id).filter((id) => selected.has(id));
    prefillCounts(added);
    const el = document.getElementById('step-docs');
    el.querySelectorAll('[data-use]').forEach((box) => {
      box.checked = selected.has(box.dataset.use);
      box.closest('.doc-item').classList.toggle('selected', box.checked);
    });
    el.querySelector('#docs-used').innerHTML = docsUsedText();
    const stepNum = el.querySelector('.step-num');
    stepNum.classList.toggle('done', testDocs().length > 0);
    stepNum.textContent = testDocs().length > 0 ? '✓' : '1';
    renderConfigStep();
    afterCountsChange();
  }

  // A newly ticked document starts with questions chosen: every question of a question paper, and a share
  // of the quick-fill total for study material when no study-material questions are chosen yet.
  // Counts chosen earlier for a document are kept, so unticking and ticking it again restores them.
  function prefillCounts(ids) {
    const docs = state.docs.filter((d) => ids.includes(d.id));
    for (const doc of docs.filter(isPaper)) {
      if (doc.sections.some((s) => state.counts[`${doc.id}:${s.id}`])) continue;
      for (const s of doc.sections) state.counts[`${doc.id}:${s.id}`] = s.questionCount;
    }
    if (docs.some((d) => !isPaper(d)) && materialQuestionTotal() === 0) distribute(state.settings.quickTotal);
  }

  function renderConfigStep() {
    const el = document.getElementById('step-config');
    const head = stepHead('step-config-title', 2, false, 'Choose questions and settings', 'Pick how many questions to take from each section, or spread a total across all sections in proportion to their length.');
    const docs = testDocs();
    if (!docs.length) {
      el.innerHTML = `${head}<p class="muted">Tick at least one document in step 1 to choose its questions here.</p>`;
      return;
    }
    const s = state.settings;
    const hasMaterial = docs.some((d) => !isPaper(d));
    const hasPapers = docs.some(isPaper);
    el.innerHTML = `${head}
      ${
        hasMaterial
          ? `<div class="quick-fill">
              <div class="field"><label for="quick-total">Questions from study material</label><input type="number" id="quick-total" min="1" max="${limits.maxQuestions}" value="${s.quickTotal}"></div>
              <button class="btn" type="button" data-action="distribute">Spread across study material</button>
              <button class="btn ghost" type="button" data-action="clear">Set all to 0</button>
            </div>`
          : ''
      }
      ${hasPapers ? '<p class="muted small" style="margin-bottom:12px">Question papers start with every question selected. Choose fewer to get a random selection, kept in the paper\'s order.</p>' : ''}
      ${docs.map(docGroupHtml).join('')}
      <div class="settings-grid">
        ${
          hasMaterial
            ? `<div class="field"><label for="set-type">Question type${hasPapers ? ' <span class="hint">(study material)</span>' : ''}</label>
          <select id="set-type">
            <option value="mixed">Mixed (single + multiple)</option>
            <option value="single">Single correct only</option>
            <option value="multiple">Multiple correct only</option>
          </select></div>
        <div class="field"><label for="set-difficulty">Difficulty${hasPapers ? ' <span class="hint">(study material)</span>' : ''}</label>
          <select id="set-difficulty">
            <option value="mixed">Mixed</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
          </select></div>`
            : ''
        }
        <div class="field"><label for="set-time">Time limit (minutes)</label>
          <input type="number" id="set-time" min="1" max="300" value="${s.timeLimitMin}"><span class="hint" id="time-hint"></span></div>
        <div class="field"><label for="set-pass">Pass mark (%)</label>
          <input type="number" id="set-pass" min="1" max="100" value="${s.passPercent}"></div>
        <div class="field"><label for="set-title">Test name <span class="hint">(optional)</span></label>
          <input type="text" id="set-title" maxlength="100" placeholder="e.g. Biology chapter 3 revision" value="${esc(s.title)}"></div>
      </div>`;

    updateTimeHint();

    if (hasMaterial) {
      el.querySelector('#set-type').value = s.questionType;
      el.querySelector('#set-difficulty').value = s.difficulty;
      el.querySelector('#set-type').onchange = (e) => {
        s.questionType = e.target.value;
        saveDraft();
      };
      el.querySelector('#set-difficulty').onchange = (e) => {
        s.difficulty = e.target.value;
        saveDraft();
      };
      el.querySelector('#quick-total').addEventListener('change', (e) => {
        s.quickTotal = clampInt(e.target.value, 1, limits.maxQuestions, DEFAULT_SETTINGS.quickTotal);
        e.target.value = s.quickTotal;
        saveDraft();
      });
      el.querySelector('[data-action="distribute"]').onclick = () => {
        s.quickTotal = clampInt(el.querySelector('#quick-total').value, 1, limits.maxQuestions, DEFAULT_SETTINGS.quickTotal);
        const placed = distribute(s.quickTotal);
        saveDraft();
        renderConfigStep();
        renderActionBar();
        if (placed < s.quickTotal) toast(`Your study material supports about ${placed} questions, so ${placed} were assigned.`, 5000);
      };
      el.querySelector('[data-action="clear"]').onclick = () => {
        setMaterialCounts({});
        afterCountsChange();
        renderConfigStep();
      };
    }

    // The section container outlives re-renders, so assign (not add) its delegated handlers.
    el.onclick = (e) => {
      const stepBtn = e.target.closest('[data-step]');
      if (stepBtn) {
        const row = stepBtn.closest('.section-row');
        const key = row.dataset.key;
        setCount(key, (state.counts[key] || 0) + Number(stepBtn.dataset.step), row);
        return;
      }
      const allBtn = e.target.closest('[data-paper-all], [data-paper-none]');
      if (allBtn) {
        const doc = state.docs.find((d) => d.id === (allBtn.dataset.paperAll || allBtn.dataset.paperNone));
        for (const sec of doc.sections) {
          const key = `${doc.id}:${sec.id}`;
          setCount(key, allBtn.dataset.paperAll ? sec.questionCount : 0, el.querySelector(`.section-row[data-key="${key}"]`));
        }
      }
    };
    el.onchange = (e) => {
      const input = e.target.closest('[data-count]');
      if (input) setCount(input.dataset.count, input.value, input.closest('.section-row'));
    };
    el.querySelector('#set-time').onchange = (e) => {
      s.timeLimitMin = clampInt(e.target.value, 1, 300, suggestedTime());
      s.timeAuto = false;
      e.target.value = s.timeLimitMin;
      updateTimeHint();
      saveDraft();
      renderActionBar();
    };
    el.querySelector('#set-pass').onchange = (e) => {
      s.passPercent = clampInt(e.target.value, 1, 100, DEFAULT_SETTINGS.passPercent);
      e.target.value = s.passPercent;
      saveDraft();
    };
    el.querySelector('#set-title').oninput = (e) => {
      s.title = e.target.value;
      saveDraft();
    };
  }

  function docGroupHtml(doc) {
    const paperActions = isPaper(doc)
      ? `<button class="btn small" type="button" data-paper-all="${esc(doc.id)}">Select all</button>
         <button class="btn ghost small" type="button" data-paper-none="${esc(doc.id)}">None</button>`
      : '';
    return `<div class="doc-group">
      <div class="doc-group-head"><h3><span class="chip">${esc(fileExt(doc.name).toUpperCase())}</span>${esc(doc.name)}</h3>${kindBadge(doc)}${paperActions}</div>
      ${doc.sections.map((sec) => sectionRowHtml(doc, sec)).join('')}
    </div>`;
  }

  function sectionRowHtml(doc, sec) {
    const key = `${doc.id}:${sec.id}`;
    const n = state.counts[key] || 0;
    const paper = isPaper(doc);
    const max = paper ? sec.questionCount : limits.maxPerSection;
    return `<div class="section-row${n ? ' active' : ''}" data-key="${esc(key)}">
      <div class="section-info">
        <div class="section-title">${esc(sec.title)}</div>
        <div class="muted small">${paper ? `${plural(sec.questionCount, 'question')} available` : `${sec.wordCount.toLocaleString()} words`}</div>
        <p class="section-preview">${paper ? 'First question: ' : ''}${esc(sec.preview)}</p>
      </div>
      <div class="stepper">
        <button type="button" data-step="-1" aria-label="Fewer questions from ${esc(sec.title)}">−</button>
        <input type="number" min="0" max="${max}" value="${n}" data-count="${esc(key)}" aria-label="Questions from ${esc(sec.title)}">
        <button type="button" data-step="1" aria-label="More questions from ${esc(sec.title)}">+</button>
      </div>
    </div>`;
  }

  function setCount(key, value, row) {
    const n = clampInt(value, 0, Number(row.querySelector('[data-count]').max), 0);
    if (n) state.counts[key] = n;
    else delete state.counts[key];
    row.querySelector('[data-count]').value = n;
    row.classList.toggle('active', n > 0);
    afterCountsChange();
  }

  function afterCountsChange() {
    if (state.settings.timeAuto) {
      state.settings.timeLimitMin = suggestedTime();
      const timeInput = document.getElementById('set-time');
      if (timeInput) timeInput.value = state.settings.timeLimitMin;
    }
    updateTimeHint();
    saveDraft();
    renderActionBar();
  }

  function suggestedTime() {
    return Math.min(300, Math.max(5, totalQuestions()));
  }

  function updateTimeHint() {
    const hint = document.getElementById('time-hint');
    if (!hint) return;
    hint.textContent = state.settings.timeAuto
      ? 'Set automatically: 1 minute per question (at least 5).'
      : `Suggested: ${suggestedTime()} min, 1 per question.`;
  }

  // Replaces the counts for study-material sections of the ticked documents, leaving question papers
  // and unticked documents as they are.
  function setMaterialCounts(counts) {
    const replaced = new Set(testDocs().filter((d) => !isPaper(d)).flatMap((d) => d.sections.map((s) => `${d.id}:${s.id}`)));
    state.counts = {
      ...Object.fromEntries(Object.entries(state.counts).filter(([key]) => !replaced.has(key))),
      ...Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)),
    };
  }

  // Spread `total` questions over the ticked study-material sections in proportion to their length,
  // capped by what each can support. Returns how many were placed.
  function distribute(total) {
    const sections = testDocs()
      .filter((d) => !isPaper(d))
      .flatMap((d) => d.sections.map((s) => ({ key: `${d.id}:${s.id}`, words: Math.max(1, s.wordCount) })));
    const cap = (s) => Math.min(limits.maxPerSection, Math.max(1, Math.floor(s.words / 15)));
    const result = Object.fromEntries(sections.map((s) => [s.key, 0]));
    let remaining = Math.min(total, sections.reduce((sum, s) => sum + cap(s), 0));
    while (remaining > 0) {
      const open = sections.filter((s) => result[s.key] < cap(s));
      if (!open.length) break;
      const words = open.reduce((sum, s) => sum + s.words, 0);
      const shares = open.map((s) => ({ s, exact: (remaining * s.words) / words }));
      for (const share of shares) {
        const add = Math.min(Math.floor(share.exact), cap(share.s) - result[share.s.key]);
        result[share.s.key] += add;
        remaining -= add;
        share.rest = share.exact - Math.floor(share.exact);
      }
      shares.sort((a, b) => b.rest - a.rest);
      for (const share of shares) {
        if (remaining <= 0) break;
        if (result[share.s.key] < cap(share.s)) {
          result[share.s.key]++;
          remaining--;
        }
      }
    }
    setMaterialCounts(result);
    if (state.settings.timeAuto) state.settings.timeLimitMin = suggestedTime();
    return Object.values(result).reduce((sum, n) => sum + n, 0);
  }

  function renderActionBar() {
    const el = document.getElementById('action-bar');
    const total = totalQuestions();
    const chosen = testCounts();
    const docCount = new Set(chosen.map(([key]) => key.split(':')[0])).size;
    const todo = [];
    if (!state.docs.length) todo.push(isAdminUser() ? 'upload documents in the Library' : 'ask your administrator for access to a course');
    else if (!testDocs().length) todo.push('tick at least one document');
    else if (!total) todo.push('choose at least one question');
    if (total > limits.maxQuestions) todo.push(`reduce the total to ${limits.maxQuestions} questions or fewer`);
    el.innerHTML = `<div class="summary">
        <strong>${plural(total, 'question')}</strong>
        <span class="muted"> from ${plural(chosen.length, 'section')}${docCount > 1 ? ` in ${docCount} documents` : ''} · ${state.settings.timeLimitMin} min</span>
        ${todo.length ? `<div class="small muted">To continue, ${todo.join(', ')}.</div>` : ''}
      </div>
      <button class="btn primary large" type="button" id="generate-btn"${todo.length ? ' disabled' : ''}>Generate test</button>`;
    el.querySelector('#generate-btn').onclick = generateTest;
  }

  async function generateTest() {
    const s = state.settings;
    const selections = testCounts().map(([key, count]) => {
      const [docId, sectionId] = key.split(':');
      return { docId, sectionId, count };
    });
    const total = totalQuestions();
    const progress = (done, of) => `
      <h2 id="modal-title">Generating your test</h2>
      <div class="progress-steps">
        <span class="spinner large" aria-hidden="true"></span>
        <p>Writing ${plural(total, 'question')} from your documents.${state.config.engine.id === 'claude' ? ' This can take a minute or two.' : ''}</p>
        <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${of}" aria-valuenow="${done}"><span style="width:${of ? (done / of) * 100 : 0}%"></span></div>
        <p class="muted small">${done} of ${plural(of, 'section')} done</p>
      </div>`;
    openModal(progress(0, selections.length), { dismissible: false });
    try {
      const { jobId } = await api('/api/tests', {
        method: 'POST',
        body: {
          title: s.title,
          selections,
          timeLimitMin: s.timeLimitMin,
          passPercent: s.passPercent,
          questionType: s.questionType,
          difficulty: s.difficulty,
        },
      });
      let job;
      do {
        await new Promise((r) => setTimeout(r, 1200));
        if (!ctx.isActive()) return;
        job = await api(`/api/jobs/${jobId}`);
        if (modal.open) modal.querySelector('.modal-body').innerHTML = progress(job.completed, job.total);
      } while (job.status === 'running');
      if (job.status === 'error') throw new ApiError(job.error, 500);
      closeModal();
      location.hash = `#/start/${job.testId}`;
    } catch (err) {
      if (!ctx.isActive()) return;
      openModal(`<h2 id="modal-title">Could not generate the test</h2><p style="margin-top:8px">${esc(err.message)}</p>
        <div class="btn-row"><button class="btn primary" type="button" data-action="close">Close</button></div>`);
      modal.querySelector('[data-action="close"]').onclick = closeModal;
    }
  }
}

function totalQuestions() {
  return testCounts().reduce((sum, [, n]) => sum + n, 0);
}

function materialQuestionTotal() {
  const materialKeys = new Set(testDocs().filter((d) => !isPaper(d)).flatMap((d) => d.sections.map((s) => `${d.id}:${s.id}`)));
  return Object.entries(state.counts)
    .filter(([key]) => materialKeys.has(key))
    .reduce((sum, [, n]) => sum + n, 0);
}

// Drops counts and ticks that belong to documents no longer in the list.
function pruneCounts() {
  const valid = new Set(state.docs.flatMap((d) => d.sections.map((s) => `${d.id}:${s.id}`)));
  for (const key of Object.keys(state.counts)) if (!valid.has(key)) delete state.counts[key];
  state.selectedDocs = state.selectedDocs.filter((id) => state.docs.some((d) => d.id === id));
}

// ---------- view: instructions + start ----------

async function viewStart(ctx, testId) {
  const test = await api(`/api/tests/${testId}`);
  if (!ctx.isActive()) return;
  const c = test.config;
  const fact = (value, label) => `<div class="fact"><span class="value">${esc(value)}</span><span class="label">${esc(label)}</span></div>`;

  app.innerHTML = `<div class="card narrow">
    <p class="eyebrow">Ready when you are</p>
    <h1 style="margin-top:4px;overflow-wrap:anywhere">${esc(test.title)}</h1>
    <div class="facts">
      ${fact(test.questionCount, 'Questions')}
      ${fact(`${c.timeLimitMin} min`, 'Time limit')}
      ${fact(`${c.passPercent}%`, 'Pass mark')}
      ${fact(test.multiCount, 'Multiple-correct questions')}
    </div>
    ${
      test.warnings.length
        ? `<div class="callout warn"><strong>Fewer questions than requested</strong><ul>${test.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
        : ''
    }
    <h2 style="margin-top:22px">Instructions</h2>
    <ul class="rules">
      <li>The timer starts when you press <strong>Start test</strong> and keeps running even if you leave the page. When it reaches zero, your answers are submitted automatically.</li>
      <li>Questions ending in <strong>(Select N answers)</strong> have more than one correct option. You score them only by selecting all of the correct options and nothing else.</li>
      <li>Every other question has exactly one correct option.</li>
      <li>There is no negative marking; unanswered questions score zero.</li>
      <li>You can move between questions, change answers, and mark questions for review before submitting.</li>
    </ul>
    <details class="sections-detail" style="margin-top:16px">
      <summary>Sections in this test (${test.sections.length})</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Section</th><th>Document</th><th class="num">Questions</th></tr></thead>
        <tbody>${test.sections
          .map((s) => `<tr><td>${esc(s.sectionTitle)}</td><td>${esc(s.docName)}</td><td class="num">${s.generated}</td></tr>`)
          .join('')}</tbody>
      </table></div>
    </details>
    <h2 style="margin-top:22px">Taking this test as</h2>
    <div class="user-summary" style="margin-top:10px"><span class="avatar" aria-hidden="true">${esc(initials(state.user.name))}</span>
      <div class="who"><strong>${esc(state.user.name)}</strong><span class="muted small">${esc(contactLine(state.user))}</span></div></div>
    <p class="muted small" style="margin-top:6px">Your result is saved to your reports. ${isAdminUser() ? 'You can change your details on the Users page.' : 'Ask your administrator if these details need changing.'}</p>
    <div class="btn-row" style="margin-top:18px">
      <button class="btn primary large" type="button" id="start-btn">Start test</button>
      <a class="btn ghost" href="#/">Back</a>
    </div>
    <p class="muted small" style="margin-top:18px">Question source: ${esc(test.engine.label.charAt(0).toUpperCase() + test.engine.label.slice(1))}. Created ${esc(formatDate(test.createdAt))}.</p>
  </div>`;

  const button = document.getElementById('start-btn');
  button.onclick = async () => {
    const done = busy(button, 'Starting…');
    try {
      const { attemptId } = await api(`/api/tests/${testId}/attempts`, { method: 'POST' });
      location.hash = `#/attempt/${attemptId}`;
    } catch (err) {
      if (!ctx.isActive()) return;
      done();
      toast(err.message, 5000);
    }
  };
}

// ---------- view: take the test ----------

async function viewAttempt(ctx, attemptId) {
  const data = await api(`/api/attempts/${attemptId}`);
  if (!ctx.isActive()) return;
  if (data.status === 'submitted') {
    location.replace(`#/result/${attemptId}`);
    return;
  }

  const questions = data.questions;
  const backupKey = `opt.attempt.${attemptId}`;
  const backup = storage.get(backupKey, null);
  const s = {
    current: clampInt(backup?.current ?? 0, 0, questions.length - 1, 0),
    answers: backup?.answers ?? data.answers ?? {},
    marked: new Set(backup?.marked ?? []),
    clockOffset: new Date(data.serverNow).getTime() - Date.now(),
    deadline: new Date(data.deadline).getTime(),
    submitting: false,
    warned5: false,
    warned1: false,
  };
  const remainingSec = () => (s.deadline - (Date.now() + s.clockOffset)) / 1000;
  const answeredCount = () => questions.filter((q) => s.answers[q.id]?.length).length;

  app.innerHTML = `<div class="attempt">
    <div class="attempt-bar">
      <div class="title-wrap"><p class="eyebrow">${esc([data.user.name, data.user.email || data.user.mobile].join(' · '))}</p><h1 class="attempt-title">${esc(data.test.title)}</h1></div>
      <div class="timer" id="timer" role="timer" aria-label="Time remaining">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/></svg>
        <span id="timer-text">--:--</span>
      </div>
      <button class="btn primary" type="button" id="submit-btn">Submit test</button>
    </div>
    <div class="attempt-body">
      <article class="card" id="question-card"></article>
      <aside class="card palette-card" aria-label="Question navigator">
        <h2>Questions</h2>
        <div class="palette-stats" id="palette-stats"></div>
        <div class="palette" id="palette"></div>
        <div class="legend">
          <span><i class="answered"></i>Answered</span><span><i></i>Not answered</span>
          <span><i class="marked"></i>Marked for review</span><span><i class="current"></i>Current question</span>
        </div>
      </aside>
    </div>
  </div>`;

  const card = document.getElementById('question-card');
  const palette = document.getElementById('palette');
  const timerEl = document.getElementById('timer');
  const timerText = document.getElementById('timer-text');

  function renderQuestion() {
    const q = questions[s.current];
    const selected = s.answers[q.id] || [];
    const full = q.multi && selected.length >= q.selectCount;
    const marked = s.marked.has(q.id);
    const last = s.current === questions.length - 1;
    card.innerHTML = `
      <div class="q-meta">
        <span class="q-number">Question ${s.current + 1} of ${questions.length}</span>
        <span class="chip" title="${esc(q.docName)} › ${esc(q.sectionTitle)}">${esc(q.sectionTitle)}</span>
        ${q.multi ? '<span class="badge info">Multiple correct</span>' : ''}
      </div>
      <h2 class="q-text" id="q-text">${esc(q.text)}</h2>
      <p class="q-hint">${q.multi ? `Select ${q.selectCount} answers · ${selected.length} of ${q.selectCount} selected` : 'Select one answer.'}</p>
      <div class="options" role="${q.multi ? 'group' : 'radiogroup'}" aria-labelledby="q-text">
        ${q.options
          .map((option, i) => {
            const checked = selected.includes(i);
            const disabled = full && !checked;
            return `<label class="option${q.multi ? ' multi' : ''}${checked ? ' selected' : ''}${disabled ? ' disabled' : ''}">
              <input type="${q.multi ? 'checkbox' : 'radio'}" name="answer" value="${i}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
              <span class="opt-letter" aria-hidden="true">${LETTERS[i]}</span><span class="opt-text">${esc(option)}</span></label>`;
          })
          .join('')}
      </div>
      <div class="q-actions">
        <button class="btn" type="button" data-action="prev"${s.current === 0 ? ' disabled' : ''}>← Previous</button>
        <button class="btn ghost" type="button" data-action="clear"${selected.length ? '' : ' disabled'}>Clear response</button>
        <button class="btn mark-btn" type="button" data-action="mark" aria-pressed="${marked}">${marked ? '★ Marked for review' : '☆ Mark for review'}</button>
        <span class="spacer"></span>
        <button class="btn primary" type="button" data-action="${last ? 'finish' : 'next'}">${last ? 'Review and submit' : 'Next →'}</button>
      </div>`;
  }

  function renderPalette() {
    const answered = answeredCount();
    document.getElementById('palette-stats').innerHTML = `
      <div><strong>${answered}</strong><span>Answered</span></div>
      <div><strong>${questions.length - answered}</strong><span>Not answered</span></div>
      <div><strong>${s.marked.size}</strong><span>Marked</span></div>`;
    palette.innerHTML = questions
      .map((q, i) => {
        const isAnswered = Boolean(s.answers[q.id]?.length);
        const isMarked = s.marked.has(q.id);
        const cls = [isAnswered && 'answered', isMarked && 'marked', i === s.current && 'current'].filter(Boolean).join(' ');
        const label = `Question ${i + 1}, ${isAnswered ? 'answered' : 'not answered'}${isMarked ? ', marked for review' : ''}`;
        return `<button type="button" class="${cls}" data-goto="${i}" aria-label="${label}"${i === s.current ? ' aria-current="true"' : ''}>${i + 1}</button>`;
      })
      .join('');
  }

  function render() {
    renderQuestion();
    renderPalette();
  }

  function goTo(index) {
    s.current = clampInt(index, 0, questions.length - 1, 0);
    persist(false);
    render();
    card.querySelector('.q-text').scrollIntoView({ block: 'nearest' });
  }

  let saveTimer = null;
  function persist(sync = true) {
    storage.set(backupKey, { answers: s.answers, marked: [...s.marked], current: s.current });
    if (!sync) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(syncAnswers, 800);
  }
  async function syncAnswers() {
    try {
      await api(`/api/attempts/${attemptId}/answers`, { method: 'PUT', body: { answers: s.answers } });
    } catch (err) {
      // 409: already submitted (time ran out or submitted in another tab). Other errors: the local
      // copy is kept and the final submit sends every answer anyway.
      if (err.status === 409 && ctx.isActive()) {
        storage.remove(backupKey);
        location.replace(`#/result/${attemptId}`);
      }
    }
  }

  card.addEventListener('change', (e) => {
    if (e.target.name !== 'answer') return;
    const q = questions[s.current];
    const i = Number(e.target.value);
    const selected = new Set(s.answers[q.id] || []);
    if (!q.multi) selected.clear();
    if (e.target.checked && (!q.multi || selected.size < q.selectCount)) selected.add(i);
    else selected.delete(i);
    if (selected.size) s.answers[q.id] = [...selected].sort((a, b) => a - b);
    else delete s.answers[q.id];
    persist();
    render();
    card.querySelector(`input[value="${i}"]`)?.focus();
  });

  card.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    const q = questions[s.current];
    if (action === 'prev') goTo(s.current - 1);
    else if (action === 'next') goTo(s.current + 1);
    else if (action === 'finish') submit();
    else if (action === 'clear') {
      delete s.answers[q.id];
      persist();
      render();
    } else if (action === 'mark') {
      if (s.marked.has(q.id)) s.marked.delete(q.id);
      else s.marked.add(q.id);
      persist(false);
      render();
      card.querySelector('[data-action="mark"]').focus();
    }
  });

  palette.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-goto]');
    if (btn) goTo(Number(btn.dataset.goto));
  });
  document.getElementById('submit-btn').onclick = () => submit();

  function tick() {
    const left = remainingSec();
    timerText.textContent = formatClock(left);
    timerEl.classList.toggle('warn', left <= 300 && left > 60);
    timerEl.classList.toggle('danger', left <= 60);
    if (left <= 300 && left > 60 && !s.warned5) {
      s.warned5 = true;
      toast('5 minutes left');
    }
    if (left <= 60 && left > 0 && !s.warned1) {
      s.warned1 = true;
      toast('1 minute left');
    }
    if (left <= 0) submit({ auto: true });
  }
  const interval = setInterval(tick, 1000);
  ctx.onCleanup(() => {
    clearInterval(interval);
    clearTimeout(saveTimer);
  });

  async function submit({ auto = false } = {}) {
    if (s.submitting) return;
    if (!auto) {
      const answered = answeredCount();
      const unanswered = questions.length - answered;
      const notes = [
        unanswered && `${plural(unanswered, 'question')} ${unanswered === 1 ? 'is' : 'are'} unanswered.`,
        s.marked.size && `${plural(s.marked.size, 'question')} ${s.marked.size === 1 ? 'is' : 'are'} marked for review.`,
      ].filter(Boolean);
      const ok = await confirmModal({
        title: 'Submit your test?',
        body: `<p style="margin-top:6px">You have answered <strong>${answered} of ${questions.length}</strong> questions. ${notes.join(' ')}</p>
          <p class="muted small" style="margin-top:8px">You can't change your answers after submitting.</p>`,
        confirmLabel: 'Submit test',
        cancelLabel: 'Keep working',
      });
      if (!ok || s.submitting || !ctx.isActive()) return;
    }
    s.submitting = true;
    clearInterval(interval);
    clearTimeout(saveTimer);
    openModal(
      `<h2 id="modal-title">${auto ? 'Time is up' : 'Submitting'}</h2>
       <div class="progress-steps"><span class="spinner large" aria-hidden="true"></span><p>Submitting your answers…</p></div>`,
      { dismissible: false },
    );
    try {
      await api(`/api/attempts/${attemptId}/submit`, { method: 'POST', body: { answers: s.answers, auto } });
      storage.remove(backupKey);
      closeModal();
      location.hash = `#/result/${attemptId}`;
    } catch (err) {
      if (!ctx.isActive()) return;
      s.submitting = false;
      openModal(
        `<h2 id="modal-title">Could not submit</h2><p style="margin-top:8px">${esc(err.message)}</p>
         <p class="muted small" style="margin-top:8px">Your answers are saved on this device. Check your connection and try again.</p>
         <div class="btn-row"><button class="btn primary" type="button" data-action="retry">Try again</button></div>`,
        { dismissible: false },
      );
      modal.querySelector('[data-action="retry"]').onclick = () => submit({ auto: true });
    }
  }

  render();
  tick();
}

// ---------- view: result + answer review ----------

async function viewResult(ctx, attemptId) {
  const data = await api(`/api/attempts/${attemptId}`);
  if (!ctx.isActive()) return;
  if (data.status !== 'submitted') {
    location.replace(`#/attempt/${attemptId}`);
    return;
  }
  const r = data.result;
  const outcome = r.passed ? 'pass' : 'fail';
  const stat = (cls, label, value, sub = '') =>
    `<div class="stat ${cls}"><span class="label">${label}</span><span class="value">${esc(value)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>`;

  app.innerHTML = `
    <section class="card result-hero">
      <div class="score-ring ${outcome}" style="--pct:${r.percentage}" role="img" aria-label="Score ${r.percentage} percent">
        <div><strong>${r.percentage}%</strong><span>score</span></div>
      </div>
      <div class="hero-text">
        <span class="badge ${outcome}">${r.passed ? 'Passed' : 'Not passed'}</span>
        <h1>${esc(data.test.title)}</h1>
        <p class="muted">${esc([data.user.name, data.user.email || data.user.mobile, formatDate(data.submittedAt)].join(' · '))}</p>
        <p class="lead">You answered <strong>${r.correct} of ${r.total}</strong> questions correctly. The pass mark is ${r.passPercent}%.</p>
        ${data.autoSubmitted ? '<p class="small muted" style="margin-top:6px">Submitted automatically when the time ran out.</p>' : ''}
      </div>
    </section>
    <div class="stat-grid">
      ${stat('correct', 'Correct', r.correct)}
      ${stat('wrong', 'Wrong', r.wrong)}
      ${stat('', 'Unanswered', r.unanswered)}
      ${stat('', 'Time taken', formatDuration(r.timeTakenSec), `of ${data.test.config.timeLimitMin} min allowed`)}
    </div>
    <section class="card">
      <h2>Section-wise performance</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Section</th><th class="num">Questions</th><th class="num">Correct</th><th class="num">Wrong</th><th class="num">Unanswered</th><th>Score</th></tr></thead>
        <tbody>${r.bySection
          .map(
            (s) => `<tr>
              <td><div class="section-title">${esc(s.sectionTitle)}</div><div class="muted small">${esc(s.docName)}</div></td>
              <td class="num">${s.total}</td><td class="num">${s.correct}</td><td class="num">${s.wrong}</td><td class="num">${s.unanswered}</td>
              <td><span class="small">${s.percentage}%</span><div class="bar"><span style="width:${s.percentage}%"></span></div></td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </section>
    <section class="card" style="margin-top:16px">
      <h2>Answer review</h2>
      <div class="tabs" role="tablist" aria-label="Filter questions" id="review-tabs"></div>
      <div class="review-list" id="review-list" role="tabpanel"></div>
    </section>
    <div class="btn-row" style="margin-top:20px">
      <a class="btn primary" href="#/start/${esc(data.test.id)}">Retake this test</a>
      <a class="btn" href="#/">Create a new test</a>
      <a class="btn ghost" href="#/reports">View all reports</a>
    </div>`;

  const filters = [
    ['all', 'All'],
    ['correct', 'Correct'],
    ['wrong', 'Wrong'],
    ['unanswered', 'Unanswered'],
  ];
  let filter = r.wrong ? 'wrong' : 'all';
  const tabs = document.getElementById('review-tabs');
  const list = document.getElementById('review-list');

  function renderReview() {
    tabs.innerHTML = filters
      .map(([id, label]) => {
        const count = id === 'all' ? data.review.length : data.review.filter((q) => q.status === id).length;
        return `<button type="button" role="tab" data-filter="${id}" aria-selected="${filter === id}">${label} (${count})</button>`;
      })
      .join('');
    const items = data.review.filter((q) => filter === 'all' || q.status === filter);
    list.innerHTML = items.length ? items.map(reviewItemHtml).join('') : '<p class="empty">No questions in this group.</p>';
  }
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    filter = btn.dataset.filter;
    renderReview();
  });
  renderReview();
}

function reviewItemHtml(item) {
  const statusLabel = { correct: 'Correct', wrong: 'Wrong', unanswered: 'Not answered' }[item.status];
  const options = item.options
    .map((option, i) => {
      const isCorrect = item.correct.includes(i);
      const picked = item.selected.includes(i);
      const cls = isCorrect ? 'is-correct' : picked ? 'is-wrong-pick' : '';
      const tags = [isCorrect && '<span class="tag ok">Correct answer</span>', picked && '<span class="tag you">Your answer</span>']
        .filter(Boolean)
        .join('');
      return `<li class="${cls}"><span class="opt-letter" aria-hidden="true">${LETTERS[i]}</span>
        <div class="opt-body">${esc(option)}${tags ? `<div class="tags">${tags}</div>` : ''}</div></li>`;
    })
    .join('');
  return `<article class="review-item ${item.status}">
    <header>
      <span class="q-number">Q${item.number}</span>
      <span class="badge ${item.status === 'unanswered' ? '' : item.status}">${statusLabel}</span>
      ${item.multi ? '<span class="badge info">Multiple correct</span>' : ''}
      <span class="chip" title="${esc(item.docName)}">${esc(item.sectionTitle)}</span>
      ${item.paperNumber ? `<span class="chip" title="Question number in ${esc(item.docName)}">Paper Q${esc(item.paperNumber)}</span>` : ''}
    </header>
    <p class="q-text">${esc(item.text)}</p>
    <ul class="review-options">${options}</ul>
    ${item.status === 'unanswered' ? '<p class="muted small" style="margin-top:8px">You did not answer this question.</p>' : ''}
    ${
      item.explanation || item.source || item.answerSuggested
        ? `<div class="explanation">${
            item.answerSuggested
              ? '<p class="small" style="margin-bottom:6px"><span class="badge warn">Answer worked out by Claude</span> The question paper did not include an answer for this question.</p>'
              : ''
          }${item.explanation ? `<strong>Explanation</strong><p>${esc(item.explanation)}</p>` : ''}${
            item.source ? `<blockquote>From the document: “${esc(item.source)}”</blockquote>` : ''
          }</div>`
        : ''
    }
  </article>`;
}

// ---------- view: answer key of a question paper ----------

async function viewAnswerKey(ctx, docId) {
  const paper = await api(`/api/documents/${docId}/questions`);
  if (!ctx.isActive()) return;
  const x = paper.extraction;
  const stat = (label, value) => `<div class="stat"><span class="label">${label}</span><span class="value">${esc(value)}</span></div>`;
  const notes = [
    x.suggested && `The paper did not give ${plural(x.suggested, 'answer')}, so Claude worked ${x.suggested === 1 ? 'it' : 'them'} out. ${x.suggested === 1 ? 'It is' : 'They are'} marked below.`,
    x.skipped && `${plural(x.skipped, 'item')} ${x.skipped === 1 ? 'was' : 'were'} left out because ${x.skipped === 1 ? 'it is' : 'they are'} not multiple-choice.`,
    x.unanswered && `${plural(x.unanswered, 'question')} ${x.unanswered === 1 ? 'was' : 'were'} left out because no usable answer was found.`,
  ].filter(Boolean);

  app.innerHTML = `
    <div class="page-head">
      <p class="eyebrow">Question paper · answer key</p>
      <h1 style="margin-top:4px;overflow-wrap:anywhere">${esc(paper.name)}</h1>
      <p>These are the questions and answers read from the paper. Tests built from it use this answer key to mark every response and to produce your reports.</p>
    </div>
    <div class="stat-grid">
      ${stat('Questions', x.found)}
      ${stat('Single answer', x.found - (x.multi ?? 0))}
      ${stat('Multiple answers', x.multi ?? 0)}
      ${stat('Sections', paper.sections.length)}
    </div>
    ${
      x.issues?.length
        ? `<div class="callout warn" style="margin-bottom:12px"><strong>${plural(x.issues.length, 'item')} to check</strong><ul>${x.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`
        : '<div class="callout info" style="margin-bottom:12px">Every question has an answer, and nothing in the paper needs checking.</div>'
    }
    ${notes.length ? `<div class="callout" style="margin-bottom:12px">${notes.map(esc).join(' ')}</div>` : ''}
    ${paper.sections
      .map(
        (s) => `<section class="card" style="margin-top:16px">
          <h2>${esc(s.title)} <span class="muted small">(${plural(s.questions.length, 'question')})</span></h2>
          <div class="review-list" style="margin-top:12px">${s.questions.map(answerKeyItemHtml).join('')}</div>
        </section>`,
      )
      .join('')}
    <div class="btn-row" style="margin-top:20px"><a class="btn primary" href="#/library">Back to the library</a></div>`;
}

function answerKeyItemHtml(q) {
  const letters = q.correct.map((i) => LETTERS[i]).join(', ');
  return `<article class="review-item key-item">
    <header>
      <span class="q-number">${q.number ? `Q${esc(q.number)}` : 'Question'}</span>
      <span class="badge correct">Answer: ${letters}</span>
      ${q.multi ? `<span class="badge info">${q.correct.length} answers</span>` : ''}
      ${q.answerSuggested ? '<span class="badge warn">Answer worked out by Claude</span>' : ''}
    </header>
    <p class="q-text">${esc(q.text)}</p>
    <ul class="review-options">${q.options
      .map(
        (option, i) => `<li class="${q.correct.includes(i) ? 'is-correct' : ''}"><span class="opt-letter" aria-hidden="true">${LETTERS[i]}</span>
          <div class="opt-body">${esc(option)}</div></li>`,
      )
      .join('')}</ul>
    ${q.explanation ? `<div class="explanation"><strong>Explanation</strong><p>${esc(q.explanation)}</p></div>` : ''}
  </article>`;
}

// ---------- view: reports ----------

// The signed-in user's reports, or (for admins, via #/reports/<userId>) another user's.
async function viewReports(ctx, userId) {
  const { user, attempts } = await api(`/api/reports${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`);
  if (!ctx.isActive()) return;
  const own = user.id === state.user.id;
  const done = attempts.filter((a) => a.status === 'submitted');
  const average = done.length ? done.reduce((sum, a) => sum + a.result.percentage, 0) / done.length : 0;
  const best = done.length ? Math.max(...done.map((a) => a.result.percentage)) : 0;
  const passed = done.filter((a) => a.result.passed).length;
  const stat = (label, value, sub = '') =>
    `<div class="stat"><span class="label">${label}</span><span class="value">${esc(value)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>`;

  app.innerHTML = `
    <div class="page-head">
      ${own ? '' : '<p class="eyebrow"><a href="#/users">Users</a> › Reports</p>'}
      <h1>${own ? 'My reports' : esc(user.name)}</h1>
      <p>Practice tests taken by <strong>${esc(user.name)}</strong> (${esc(contactLine(user))}).</p>
    </div>
    ${
      attempts.length
        ? `<div class="stat-grid">
            ${stat('Tests completed', done.length)}
            ${stat('Average score', done.length ? `${average.toFixed(1)}%` : '—')}
            ${stat('Best score', done.length ? `${best}%` : '—')}
            ${stat('Passed', done.length ? `${passed} of ${done.length}` : '—')}
          </div>
          <section class="card"><div class="table-wrap"><table class="reports-table">
            <thead><tr><th>Date</th><th>Test</th><th class="num">Score</th><th>Result</th><th class="num">Time taken</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>${attempts.map((a) => reportRowHtml(a, own)).join('')}</tbody>
          </table></div></section>`
        : own
          ? `<div class="card empty"><h2>No practice tests yet</h2><p style="margin-top:6px">Tests you take will appear here.</p><a class="btn primary" href="#/">Create a practice test</a></div>`
          : `<div class="card empty"><h2>No practice tests yet</h2><p style="margin-top:6px">${esc(user.name)} hasn't taken a test yet.</p><a class="btn" href="#/users">Back to users</a></div>`
    }`;
}

// Only the person taking a test can resume it.
function reportRowHtml(a, own = true) {
  const courses = (a.courses ?? []).map((name) => `<span class="chip">${esc(name)}</span>`).join(' ');
  const title = `<td class="title-cell"><strong>${esc(a.title)}</strong>${courses ? ` ${courses}` : ''}<div class="muted small">${plural(a.questionCount, 'question')} · ${esc(a.documents.join(', '))}</div></td>`;
  if (a.status === 'in_progress') {
    const leftSec = (new Date(a.deadline) - Date.now()) / 1000;
    return `<tr>
      <td data-label="Started">${esc(formatDate(a.startedAt))}</td>${title}
      <td class="num" data-label="Score">—</td>
      <td data-label="Result"><span class="badge warn">In progress</span></td>
      <td class="num" data-label="Time left">${formatDuration(leftSec)} left</td>
      <td>${own ? `<a class="btn small primary" href="#/attempt/${esc(a.attemptId)}">Resume</a>` : ''}</td></tr>`;
  }
  const r = a.result;
  return `<tr>
    <td data-label="Date">${esc(formatDate(a.submittedAt))}</td>${title}
    <td class="num" data-label="Score"><strong>${r.percentage}%</strong> <span class="muted small">(${r.correct}/${r.total})</span></td>
    <td data-label="Result"><span class="badge ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'Passed' : 'Not passed'}</span></td>
    <td class="num" data-label="Time taken">${formatDuration(r.timeTakenSec)}</td>
    <td><a class="btn small" href="#/result/${esc(a.attemptId)}">View</a></td></tr>`;
}

// ---------- view: library (admins) ----------

const NEW_COURSE = '__new';

async function viewLibrary(ctx) {
  state.config ??= await api('/api/config');
  let { courses, documents } = await api('/api/library');
  if (!ctx.isActive()) return;
  const { limits, engine } = state.config;
  const s = state.settings;
  if (!courses.some((c) => c.id === s.uploadCourse)) s.uploadCourse = courses[0]?.id ?? '';

  app.innerHTML = `
    <div class="page-head page-head-row">
      <div>
        <h1>Library</h1>
        <p>Upload documents into courses. Users see only the courses you give them on the <a href="#/users">Users</a> page. They can build tests from those documents, but can't upload documents or see answer keys.</p>
      </div>
      <button class="btn" type="button" data-action="add-course">Add course</button>
    </div>
    <section class="card" aria-labelledby="upload-title">
      <h2 id="upload-title">Upload documents</h2>
      <p class="muted small" style="margin-top:4px">PDF, Word (.docx), text or Markdown files with selectable text. Up to ${limits.maxFiles} files at a time, ${limits.maxFileMb} MB each.</p>
      <div class="field upload-course"><label for="upload-course">Course</label><select id="upload-course"></select></div>
      <fieldset class="kind-picker">
        <legend>What are you uploading?</legend>
        ${kindOption('content', 'Study material', 'Notes, chapters, summaries or any content describing a topic. New questions are generated from the content.')}
        ${kindOption('questions', 'Question paper', 'Sample or previous questions with options. The same questions are used in tests.')}
      </fieldset>
      <label class="dropzone" id="dropzone">
        <input type="file" id="file-input" class="visually-hidden" multiple accept="${esc(state.config.supportedExtensions.join(','))}">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4l4 4"/><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>
        <strong id="dropzone-title"></strong>
        <span class="muted small" id="dropzone-hint"></span>
      </label>
      <div id="upload-status" role="status" style="margin-top:12px"></div>
    </section>
    <div id="course-list"></div>`;

  const courseSelect = document.getElementById('upload-course');
  const status = document.getElementById('upload-status');
  const list = document.getElementById('course-list');

  function kindOption(value, title, description) {
    return `<label class="kind-option">
      <input type="radio" name="upload-kind" value="${value}"${s.uploadKind === value ? ' checked' : ''}>
      <span class="kind-body"><strong>${title}</strong><span>${description}</span></span></label>`;
  }

  function renderDropzoneText() {
    const paper = s.uploadKind === 'questions';
    document.getElementById('dropzone-title').textContent = paper ? 'Drop question papers here or click to browse' : 'Drop study material here or click to browse';
    document.getElementById('dropzone-hint').textContent = !paper
      ? 'You can select several files at once.'
      : engine.id === 'claude'
        ? 'Each question needs answer options (a, b, c…). If the paper has no answers, Claude works them out.'
        : 'Each question needs answer options (a, b, c…) and an answer: under the question, in an answer key, or by marking the option.';
  }

  function renderCourseSelect() {
    courseSelect.innerHTML = `${courses.length ? '' : '<option value="">Add a course first</option>'}${courses
      .map((c) => `<option value="${esc(c.id)}"${c.id === s.uploadCourse ? ' selected' : ''}>${esc(c.name)}</option>`)
      .join('')}<option value="${NEW_COURSE}">+ New course…</option>`;
  }

  function render() {
    renderCourseSelect();
    const groups = groupByCourse(courses, documents);
    list.innerHTML = groups.length
      ? groups.map(courseCardHtml).join('')
      : '<div class="card empty" style="margin-top:16px"><h2>No courses yet</h2><p style="margin-top:6px">Add a course, then upload its documents.</p></div>';
  }

  function courseCardHtml({ course, docs }) {
    const head = course
      ? `<h2>${esc(course.name)}</h2>
         <span class="muted small">${plural(docs.length, 'document')} · ${course.userCount === 1 ? '1 user has' : `${course.userCount} users have`} access</span>
         <span class="spacer"></span>
         <button class="btn small" type="button" data-rename="${esc(course.id)}">Rename</button>
         <button class="btn ghost small" type="button" data-delete-course="${esc(course.id)}"${docs.length ? ' disabled title="Move or delete its documents first"' : ''}>Delete</button>`
      : `<h2>Not in a course</h2><span class="muted small">Users can't see these documents. Move each one into a course.</span>`;
    return `<section class="card course-card">
      <div class="course-head">${head}</div>
      ${
        docs.length
          ? `<ul class="doc-list">${docs
              .map(
                (doc) => `<li class="doc-item">
                  ${docIcon(doc)}
                  <span class="doc-meta"><strong title="${esc(doc.name)}">${esc(doc.name)}</strong>
                  <span class="muted small">${kindBadge(doc)} ${docMeta(doc)} · added ${esc(formatDate(doc.uploadedAt))}</span></span>
                  ${isPaper(doc) ? `<a class="btn small" href="#/paper/${esc(doc.id)}">Answer key</a>` : ''}
                  <button class="btn small" type="button" data-move="${esc(doc.id)}">Move</button>
                  <button class="btn ghost small" type="button" data-delete-doc="${esc(doc.id)}">Delete</button></li>`,
              )
              .join('')}</ul>`
          : '<p class="muted small">No documents yet. Choose this course above and upload some.</p>'
      }
    </section>`;
  }

  async function refresh() {
    ({ courses, documents } = await api('/api/library'));
    if (ctx.isActive()) render();
  }

  // ---- courses ----

  function openCourseForm(existing = null) {
    return new Promise((resolve) => {
      openModal(`<h2 id="modal-title">${existing ? 'Rename course' : 'Add course'}</h2>
        <form class="course-form" novalidate>
          <div class="field"><label for="course-name">Course name</label>
            <input type="text" id="course-name" name="name" maxlength="80" required value="${esc(existing?.name ?? '')}" placeholder="e.g. Jutro Digital Platform" aria-describedby="course-name-error">
            <span class="form-error" id="course-name-error" data-error="name" hidden></span></div>
          <div class="btn-row"><button class="btn" type="button" data-action="cancel">Cancel</button>
            <button class="btn primary" type="submit">${existing ? 'Save' : 'Add course'}</button></div>
        </form>`);
      const form = modal.querySelector('form');
      form.elements.name.select();
      let saved = null;
      const onClose = () => {
        modal.removeEventListener('close', onClose);
        resolve(saved);
      };
      modal.addEventListener('close', onClose);
      form.querySelector('[data-action="cancel"]').onclick = closeModal;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const done = busy(form.querySelector('[type="submit"]'), 'Saving…');
        try {
          const body = { name: form.elements.name.value };
          const result = existing ? await api(`/api/courses/${existing.id}`, { method: 'PUT', body }) : await api('/api/courses', { method: 'POST', body });
          saved = result.course;
          closeModal();
        } catch (err) {
          done();
          showFieldErrors(form, err.fields ?? { name: err.message });
        }
      });
    });
  }

  async function addCourse() {
    const course = await openCourseForm();
    if (!course || !ctx.isActive()) return null;
    s.uploadCourse = course.id;
    saveDraft();
    await refresh();
    toast(`Course "${course.name}" added`);
    return course;
  }

  app.querySelector('[data-action="add-course"]').onclick = addCourse;

  courseSelect.onchange = async () => {
    if (courseSelect.value === NEW_COURSE) {
      if (!(await addCourse())) renderCourseSelect(); // cancelled: put the previous choice back
      return;
    }
    s.uploadCourse = courseSelect.value;
    saveDraft();
  };

  // ---- documents and course actions ----

  list.addEventListener('click', async (e) => {
    const button = e.target.closest('button');
    if (!button || button.disabled) return;
    const { rename, deleteCourse, move, deleteDoc } = button.dataset;
    try {
      if (rename) {
        const course = await openCourseForm(courses.find((c) => c.id === rename));
        if (course) {
          await refresh();
          toast('Course renamed');
        }
      } else if (deleteCourse) {
        const course = courses.find((c) => c.id === deleteCourse);
        const ok = await confirmModal({
          title: `Delete ${course.name}?`,
          body: `<p style="margin-top:6px">${course.userCount ? `${plural(course.userCount, 'user')} will lose access to it. ` : ''}Tests already taken are kept.</p>`,
          confirmLabel: 'Delete course',
        });
        if (!ok) return;
        await api(`/api/courses/${course.id}`, { method: 'DELETE' });
        await refresh();
        toast('Course deleted');
      } else if (move) {
        await moveDocument(documents.find((d) => d.id === move));
      } else if (deleteDoc) {
        const doc = documents.find((d) => d.id === deleteDoc);
        const ok = await confirmModal({
          title: `Delete ${doc.name}?`,
          body: '<p style="margin-top:6px">Users can no longer choose it for new tests. Tests already built from it keep working, and their results are kept.</p>',
          confirmLabel: 'Delete document',
        });
        if (!ok) return;
        await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
        await refresh();
        toast('Document deleted');
      }
    } catch (err) {
      if (ctx.isActive()) toast(err.message, 6000);
    }
  });

  async function moveDocument(doc) {
    if (!courses.length) {
      toast('Add a course first.', 4000);
      return;
    }
    openModal(`<h2 id="modal-title">Move ${esc(doc.name)}</h2>
      <form novalidate>
        <div class="field"><label for="move-course">Course</label>
          <select id="move-course" name="courseId">${courses
            .map((c) => `<option value="${esc(c.id)}"${c.id === doc.courseId ? ' selected' : ''}>${esc(c.name)}</option>`)
            .join('')}</select></div>
        <div class="btn-row"><button class="btn" type="button" data-action="cancel">Cancel</button>
          <button class="btn primary" type="submit">Move</button></div>
      </form>`);
    const form = modal.querySelector('form');
    form.querySelector('[data-action="cancel"]').onclick = closeModal;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const done = busy(form.querySelector('[type="submit"]'), 'Moving…');
      try {
        await api(`/api/documents/${doc.id}`, { method: 'PUT', body: { courseId: form.elements.courseId.value } });
        closeModal();
        await refresh();
        toast('Document moved');
      } catch (err) {
        done();
        toast(err.message, 6000);
      }
    });
  }

  // ---- upload ----

  app.querySelectorAll('input[name="upload-kind"]').forEach((radio) => {
    radio.onchange = () => {
      s.uploadKind = radio.value;
      saveDraft();
      renderDropzoneText();
    };
  });
  const dropzone = document.getElementById('dropzone');
  document.getElementById('file-input').addEventListener('change', (e) => {
    uploadFiles(e.target.files);
    e.target.value = '';
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    uploadFiles(e.dataTransfer.files);
  });

  const problemList = (items) =>
    `<div class="callout error" style="margin-top:8px"><strong>Some files could not be added</strong><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`;

  async function uploadFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const course = courses.find((c) => c.id === s.uploadCourse);
    if (!course) {
      status.innerHTML = '<div class="callout error">Choose the course these documents belong to first, or add a new course.</div>';
      courseSelect.focus();
      return;
    }
    const problems = [];
    const accepted = files.filter((f) => {
      if (!state.config.supportedExtensions.includes(`.${fileExt(f.name)}`)) {
        problems.push(`${f.name}: unsupported file type. Use ${state.config.supportedExtensions.join(', ')}.`);
        return false;
      }
      if (f.size > limits.maxFileMb * 1024 * 1024) {
        problems.push(`${f.name}: larger than ${limits.maxFileMb} MB.`);
        return false;
      }
      return true;
    });
    if (accepted.length > limits.maxFiles) {
      problems.push(`Only the first ${limits.maxFiles} files were uploaded; add the rest in another batch.`);
      accepted.length = limits.maxFiles;
    }
    if (!accepted.length) {
      status.innerHTML = problemList(problems);
      return;
    }
    const reading =
      s.uploadKind === 'questions' && engine.id === 'claude'
        ? `Reading the questions in ${plural(accepted.length, 'file')} with Claude… This can take a minute or two.`
        : `Reading ${plural(accepted.length, 'file')}…`;
    status.innerHTML = `<div class="callout" style="display:flex;gap:10px;align-items:center"><span class="spinner"></span> ${esc(reading)}</div>`;
    const form = new FormData();
    form.append('kind', s.uploadKind);
    form.append('courseId', course.id);
    accepted.forEach((f) => form.append('files', f));
    try {
      const result = await api('/api/documents', { method: 'POST', body: form });
      if (!ctx.isActive()) return;
      problems.push(...result.errors.map((err) => `${err.name}: ${err.error}`));
      await refresh();
      status.innerHTML =
        (result.documents.length ? `<div class="callout info">Added ${plural(result.documents.length, 'document')} to ${esc(course.name)}.</div>` : '') +
        (problems.length ? problemList(problems) : '');
    } catch (err) {
      if (ctx.isActive()) status.innerHTML = problemList([...problems, err.message]);
    }
  }

  renderDropzoneText();
  render();
}

// ---------- view: users (admins) ----------

async function viewUsers(ctx) {
  state.config ??= await api('/api/config');
  let [{ users, emailConfigured }, { courses }] = await Promise.all([api('/api/users'), api('/api/library')]);
  if (!ctx.isActive()) return;
  const { genders, capabilities } = state.config.userOptions;
  const courseName = new Map(courses.map((c) => [c.id, c.name]));
  let query = '';

  app.innerHTML = `
    <div class="page-head page-head-row">
      <div>
        <h1>Users</h1>
        <p>Add the people who may use the portal and email them an invite. Only invited users who are enabled can sign in, using their email address and a one-time code.</p>
      </div>
      <button class="btn primary" type="button" data-action="add">Add user</button>
    </div>
    ${
      emailConfigured
        ? ''
        : '<div class="callout warn" style="margin-bottom:16px"><strong>Email is not set up.</strong> Invites and sign-in codes are written to the server log instead of being sent. Add the <code>SMTP_</code> settings to the <code>.env</code> file and restart the server to send real emails.</div>'
    }
    <div class="stat-grid" id="user-stats"></div>
    <section class="card">
      <div class="toolbar"><input type="search" id="user-search" placeholder="Search by name, email or mobile" aria-label="Search users"></div>
      <div id="user-table"></div>
    </section>`;

  const table = document.getElementById('user-table');
  const findUser = (id) => users.find((u) => u.id === id);
  const replaceUser = (updated) => {
    const at = users.findIndex((u) => u.id === updated.id);
    if (at === -1) users.splice(users.filter((u) => u.role === 'admin').length, 0, updated);
    else users[at] = updated;
    render();
  };

  function render() {
    const people = users.filter((u) => u.role !== 'admin');
    const stat = (label, value) => `<div class="stat"><span class="label">${label}</span><span class="value">${value}</span></div>`;
    document.getElementById('user-stats').innerHTML = [
      stat('Users', people.length),
      stat('Can sign in', people.filter((u) => u.enabled && u.invitedAt).length),
      stat('Not invited yet', people.filter((u) => u.enabled && !u.invitedAt).length),
      stat('Disabled', people.filter((u) => !u.enabled).length),
    ].join('');

    const q = query.trim().toLowerCase();
    const shown = users.filter((u) => !q || [u.name, u.email, u.mobile].some((v) => String(v ?? '').toLowerCase().includes(q)));
    table.innerHTML = shown.length
      ? `<div class="table-wrap"><table class="users-table">
          <thead><tr><th>User</th><th class="num">Age</th><th>Gender</th><th>Capability</th><th>Courses</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>${shown.map(userRowHtml).join('')}</tbody></table></div>`
      : '<p class="empty">No users match your search.</p>';
  }

  function statusHtml(u) {
    if (u.role === 'admin') return '<span class="badge info">Administrator</span>';
    const note = u.lastLoginAt ? `Last sign-in ${formatDate(u.lastLoginAt)}` : u.invitedAt ? `Invited ${formatDate(u.invitedAt)}` : '';
    const badge = !u.enabled
      ? '<span class="badge fail">Disabled</span>'
      : !u.invitedAt
        ? '<span class="badge">Not invited</span>'
        : u.lastLoginAt
          ? '<span class="badge pass">Active</span>'
          : '<span class="badge warn">Invited</span>';
    return `${badge}${note ? `<div class="muted small">${esc(note)}</div>` : ''}`;
  }

  function coursesHtml(u) {
    if (u.role === 'admin') return '<span class="muted small">All courses</span>';
    const names = u.courses.map((id) => courseName.get(id)).filter(Boolean);
    return names.length ? `<div class="badges">${names.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</div>` : '<span class="muted small">None</span>';
  }

  function userRowHtml(u) {
    const id = esc(u.id);
    const admin = u.role === 'admin';
    const actions = [
      !admin && u.enabled && `<button class="btn small${u.invitedAt ? '' : ' primary'}" type="button" data-action="invite" data-id="${id}">${u.invitedAt ? 'Resend invite' : 'Send invite'}</button>`,
      `<button class="btn small" type="button" data-action="edit" data-id="${id}">Edit</button>`,
      !admin && `<button class="btn small${u.enabled ? ' ghost' : ''}" type="button" data-action="toggle" data-id="${id}">${u.enabled ? 'Disable' : 'Enable'}</button>`,
      `<a class="btn ghost small" href="#/reports/${id}">Reports</a>`,
    ].filter(Boolean);
    return `<tr class="${u.enabled ? '' : 'is-disabled'}">
      <td class="title-cell"><strong>${esc(u.name)}</strong>${u.id === state.user.id ? ' <span class="muted small">(you)</span>' : ''}<div class="muted small">${esc(contactLine(u))}</div></td>
      <td class="num" data-label="Age">${esc(u.age ?? '—')}</td>
      <td data-label="Gender">${esc(genders[u.gender] ?? '—')}</td>
      <td data-label="Capability"><div class="badges">${u.capabilities.length ? u.capabilities.map((c) => `<span class="badge info">${esc(capabilities[c] ?? c)}</span>`).join('') : '—'}</div></td>
      <td data-label="Courses">${coursesHtml(u)}</td>
      <td data-label="Status">${statusHtml(u)}</td>
      <td class="actions-cell"><div class="actions">${actions.join('')}</div></td></tr>`;
  }

  document.getElementById('user-search').addEventListener('input', (e) => {
    query = e.target.value;
    render();
  });
  app.querySelector('[data-action="add"]').onclick = () => openUserForm();
  table.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-action]');
    const user = button && findUser(button.dataset.id);
    if (!user) return;
    if (button.dataset.action === 'invite') sendInvite(user, button);
    else if (button.dataset.action === 'edit') openUserForm(user);
    else if (button.dataset.action === 'toggle') toggleEnabled(user, button);
  });

  async function sendInvite(user, button) {
    const done = busy(button, 'Sending…');
    try {
      const result = await api(`/api/users/${user.id}/invite`, { method: 'POST' });
      if (!ctx.isActive()) return;
      replaceUser(result.user);
      toast(result.delivery === 'email' ? `Invite emailed to ${user.email}` : "Invite written to the server log (email isn't set up)", 5000);
    } catch (err) {
      if (!ctx.isActive()) return;
      done();
      toast(err.message, 7000);
    }
  }

  async function toggleEnabled(user, button) {
    if (user.enabled) {
      const ok = await confirmModal({
        title: `Disable ${user.name}?`,
        body: `<p style="margin-top:6px">${esc(user.name)} will be signed out straight away and can't sign in until you enable them again. Their test results are kept.</p>`,
        confirmLabel: 'Disable user',
      });
      if (!ok || !ctx.isActive()) return;
    }
    const done = busy(button, user.enabled ? 'Disabling…' : 'Enabling…');
    try {
      const result = await api(`/api/users/${user.id}/enabled`, { method: 'PUT', body: { enabled: !user.enabled } });
      if (!ctx.isActive()) return;
      replaceUser(result.user);
      toast(result.user.enabled ? `${user.name} can sign in again` : `${user.name} has been disabled`);
    } catch (err) {
      if (!ctx.isActive()) return;
      done();
      toast(err.message, 6000);
    }
  }

  function openUserForm(existing = null) {
    const isNew = !existing;
    const adminRow = existing?.role === 'admin';
    const v = existing ?? { name: '', age: '', gender: '', email: '', mobile: '', capabilities: [], courses: [] };
    const field = (name, label, input, { full = false, hint = '' } = {}) => `<div class="field${full ? ' full' : ''}">
        <label for="uf-${name}">${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</label>${input}
        <span class="form-error" id="uf-${name}-error" data-error="${name}" hidden></span></div>`;
    const emailHint = adminRow
      ? '(set by ADMIN_EMAIL)'
      : existing?.invitedAt
        ? '(changing it cancels the current invite)'
        : '';
    openModal(
      `<h2 id="modal-title">${isNew ? 'Add user' : `Edit ${esc(existing.name)}`}</h2>
      <form class="user-form" novalidate>
        <div class="form-grid">
          ${field('name', 'Full name', `<input type="text" id="uf-name" name="name" maxlength="60" autocomplete="off" required value="${esc(v.name)}" aria-describedby="uf-name-error">`, { full: true })}
          ${field('age', 'Age', `<input type="number" id="uf-age" name="age" min="10" max="100" step="1" required value="${esc(v.age ?? '')}" aria-describedby="uf-age-error">`)}
          ${field(
            'gender',
            'Gender',
            `<select id="uf-gender" name="gender" required aria-describedby="uf-gender-error"><option value="">Choose…</option>${Object.entries(genders)
              .map(([key, label]) => `<option value="${esc(key)}"${v.gender === key ? ' selected' : ''}>${esc(label)}</option>`)
              .join('')}</select>`,
          )}
          ${field('email', 'Email address', `<input type="email" id="uf-email" name="email" maxlength="254" autocomplete="off" required value="${esc(v.email)}"${adminRow ? ' readonly' : ''} aria-describedby="uf-email-error">`, { full: true, hint: emailHint })}
          ${field('mobile', 'Mobile number', `<input type="tel" id="uf-mobile" name="mobile" inputmode="tel" maxlength="20" required placeholder="e.g. 9876543210" value="${esc(v.mobile)}" aria-describedby="uf-mobile-error">`)}
          <fieldset class="field field-set">
            <legend>Capability</legend>
            <div class="check-group">${Object.entries(capabilities)
              .map(
                ([key, label]) => `<label class="check-option"><input type="checkbox" name="capabilities" value="${esc(key)}"${v.capabilities.includes(key) ? ' checked' : ''}> ${esc(label)}</label>`,
              )
              .join('')}</div>
            <span class="form-error" data-error="capabilities" hidden></span>
          </fieldset>
          ${
            adminRow
              ? ''
              : `<fieldset class="field field-set full">
            <legend>Courses <span class="hint">(the user sees only these courses' documents)</span></legend>
            ${
              courses.length
                ? `<div class="check-group">${courses
                    .map(
                      (c) => `<label class="check-option"><input type="checkbox" name="courses" value="${esc(c.id)}"${v.courses.includes(c.id) ? ' checked' : ''}> ${esc(c.name)}</label>`,
                    )
                    .join('')}</div>`
                : '<p class="muted small" style="font-weight:400">No courses yet. Add them on the <a href="#/library">Library</a> page, then give them to users here.</p>'
            }
          </fieldset>`
          }
        </div>
        ${isNew ? '<label class="check"><input type="checkbox" name="sendInvite" checked> Email the invite now</label>' : ''}
        <div class="callout error" data-error="form" hidden style="margin-top:14px"></div>
        <div class="btn-row">
          <button class="btn" type="button" data-action="cancel">Cancel</button>
          <button class="btn primary" type="submit">${isNew ? 'Add user' : 'Save changes'}</button>
        </div>
      </form>`,
      { wide: true },
    );
    const form = modal.querySelector('form');
    form.elements.name.focus();
    form.querySelector('[data-action="cancel"]').onclick = closeModal;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const body = {
        name: data.get('name'),
        age: data.get('age'),
        gender: data.get('gender'),
        email: data.get('email'),
        mobile: data.get('mobile'),
        capabilities: data.getAll('capabilities'),
        courses: data.getAll('courses'),
        sendInvite: data.has('sendInvite'),
      };
      const done = busy(form.querySelector('[type="submit"]'), isNew ? 'Adding…' : 'Saving…');
      try {
        const result = isNew
          ? await api('/api/users', { method: 'POST', body })
          : await api(`/api/users/${existing.id}`, { method: 'PUT', body });
        if (!ctx.isActive()) return;
        closeModal();
        replaceUser(result.user);
        if (result.user.id === state.user.id) {
          state.user = result.user;
          renderHeader();
        }
        toast(savedMessage(result, existing), 7000);
      } catch (err) {
        if (!ctx.isActive()) return;
        done();
        showFieldErrors(form, err.fields ?? { form: err.message });
      }
    });
  }

  function savedMessage({ user, invite }, existing) {
    if (existing) {
      return existing.invitedAt && !user.invitedAt ? 'Changes saved. Send an invite to the new email address.' : 'Changes saved';
    }
    if (!invite) return `${user.name} added. Send the invite when you're ready.`;
    if (invite.error) return `${user.name} was added, but ${invite.error.charAt(0).toLowerCase()}${invite.error.slice(1)}`;
    return invite.delivery === 'email' ? `${user.name} added and invited by email` : `${user.name} added. The invite was written to the server log (email isn't set up).`;
  }

  render();
}

// ---------- start ----------

async function start() {
  window.addEventListener('hashchange', router);
  try {
    const { user, notice } = await api('/api/auth/me');
    if (user) signedIn(user);
    else signInNotice = notice ?? '';
  } catch (err) {
    app.innerHTML = `<div class="card narrow empty"><h2>Cannot reach the portal</h2><p style="margin-top:8px">${esc(err.message)}</p><button class="btn primary" type="button" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  renderHeader();
  router();
}

start();
