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
  constructor(message, status) {
    super(message);
    this.status = status;
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
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`, res.status);
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

function validateUser({ name, mobile }) {
  const user = {
    name: String(name ?? '').replace(/\s+/g, ' ').trim(),
    mobile: String(mobile ?? '').replace(/[\s()-]/g, ''),
  };
  const errors = {};
  if (user.name.length < 2 || user.name.length > 60) errors.name = 'Enter your full name (2–60 characters).';
  if (!/^\+?\d{10,15}$/.test(user.mobile)) errors.mobile = 'Enter a valid mobile number: 10–15 digits, optionally starting with +.';
  return { user, errors };
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
  uploadKind: 'content', // 'content' (study material) or 'questions' (question paper)
};

const isPaper = (doc) => doc.kind === 'questions';

const state = {
  config: null,
  user: storage.get('opt.user', null),
  docs: storage.get('opt.docs', []),
  unusedDocs: storage.get('opt.unusedDocs', []), // IDs of uploaded documents left out of the next test
  counts: storage.get('opt.counts', {}), // "docId:sectionId" -> number of questions
  settings: { ...DEFAULT_SETTINGS, ...storage.get('opt.settings', {}) },
  cleanup: [],
};

function saveDraft() {
  storage.set('opt.docs', state.docs);
  storage.set('opt.unusedDocs', state.unusedDocs);
  storage.set('opt.counts', state.counts);
  storage.set('opt.settings', state.settings);
}

// Documents ticked for the test being set up. New uploads start ticked.
const inTest = (doc) => !state.unusedDocs.includes(doc.id);
const testDocs = () => state.docs.filter(inTest);

// Section counts of the ticked documents. Counts of unticked documents are kept, so ticking one again restores them.
function testCounts() {
  const used = new Set(testDocs().map((d) => d.id));
  return Object.entries(state.counts).filter(([key]) => used.has(key.split(':')[0]));
}

function setUser(user) {
  state.user = user;
  storage.set('opt.user', user);
  renderHeaderUser();
}

function renderHeaderUser() {
  const el = document.getElementById('header-user');
  el.innerHTML = state.user
    ? `<span class="avatar" aria-hidden="true">${esc(initials(state.user.name))}</span><span class="who-text"><strong>${esc(state.user.name)}</strong></span>`
    : '';
}

// ---------- modal ----------

function openModal(html, { dismissible = true } = {}) {
  modal.innerHTML = `<div class="modal-body">${html}</div>`;
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

// ---------- details form (name + mobile) ----------

let formSeq = 0;
function detailsFormHtml({ user, submitLabel = 'Save details', cancellable = false, large = false } = {}) {
  const id = `df${++formSeq}`;
  return `<form class="details-form" novalidate>
    <div class="form-grid">
      <div class="field">
        <label for="${id}-name">Full name</label>
        <input type="text" id="${id}-name" name="name" autocomplete="name" maxlength="60" required value="${esc(user?.name)}" aria-describedby="${id}-name-error">
        <span class="form-error" id="${id}-name-error" data-error="name" hidden></span>
      </div>
      <div class="field">
        <label for="${id}-mobile">Mobile number</label>
        <input type="tel" id="${id}-mobile" name="mobile" autocomplete="tel" inputmode="tel" maxlength="20" required placeholder="e.g. 9876543210" value="${esc(user?.mobile)}" aria-describedby="${id}-mobile-error">
        <span class="form-error" id="${id}-mobile-error" data-error="mobile" hidden></span>
      </div>
    </div>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn primary${large ? ' large' : ''}" type="submit">${esc(submitLabel)}</button>
      ${cancellable ? '<button class="btn ghost" type="button" data-action="cancel">Cancel</button>' : ''}
    </div>
  </form>`;
}

function bindDetailsForm(form, onValid) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const { user, errors } = validateUser(Object.fromEntries(new FormData(form)));
    for (const field of ['name', 'mobile']) {
      const message = form.querySelector(`[data-error="${field}"]`);
      form.elements[field].setAttribute('aria-invalid', errors[field] ? 'true' : 'false');
      message.textContent = errors[field] || '';
      message.hidden = !errors[field];
    }
    if (errors.name || errors.mobile) {
      form.querySelector('[aria-invalid="true"]').focus();
      return;
    }
    onValid(user, form);
  });
}

// ---------- router ----------

const routes = [
  { pattern: /^#?\/?$/, nav: 'new', view: viewNewTest },
  { pattern: /^#\/start\/([\w-]+)$/, nav: 'new', view: viewStart },
  { pattern: /^#\/paper\/([\w-]+)$/, nav: 'new', view: viewAnswerKey },
  { pattern: /^#\/attempt\/([\w-]+)$/, nav: null, view: viewAttempt },
  { pattern: /^#\/result\/([\w-]+)$/, nav: 'reports', view: viewResult },
  { pattern: /^#\/reports$/, nav: 'reports', view: viewReports },
];

let routeToken = 0;
async function router() {
  for (const fn of state.cleanup.splice(0)) fn();
  closeModal();
  const token = ++routeToken;
  const ctx = { isActive: () => token === routeToken, onCleanup: (fn) => state.cleanup.push(fn) };

  const hash = location.hash || '#/';
  const route = routes.find((r) => r.pattern.test(hash));
  if (!route) {
    location.replace('#/');
    return;
  }
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route.nav));
  window.scrollTo(0, 0);
  app.innerHTML = '<div class="loading"><span class="spinner"></span> Loading…</div>';
  try {
    await route.view(ctx, ...hash.match(route.pattern).slice(1));
  } catch (err) {
    console.error(err);
    if (ctx.isActive()) {
      app.innerHTML = `<div class="card narrow empty"><h2>Something went wrong</h2><p style="margin-top:8px">${esc(err.message)}</p><a class="btn primary" href="#/">Go to the start page</a></div>`;
    }
  }
}

// ---------- view: create a new test ----------

async function viewNewTest(ctx) {
  state.config ??= await api('/api/config');
  // Forget uploaded documents the server no longer has (e.g. its data folder was cleared).
  const stillThere = await Promise.all(
    state.docs.map((d) => api(`/api/documents/${d.id}`).then(() => true, (err) => err.status !== 404)),
  );
  if (!ctx.isActive()) return;
  state.docs = state.docs.filter((_, i) => stillThere[i]);
  pruneCounts();
  saveDraft();

  const { limits, engine } = state.config;
  let editingDetails = !state.user;

  app.innerHTML = `
    <div class="page-head">
      <h1>Create a practice test</h1>
      <p>Upload your study material, choose how many questions to take from each section, set a time limit, and start practising. Questions come only from your documents.</p>
    </div>
    ${
      engine.id === 'offline'
        ? `<div class="callout warn" style="margin-bottom:16px"><strong>Basic question generator in use.</strong> No Claude API key is configured, so questions are built by simple rules (fill-in-the-blank and correct-statement questions taken from your text). For better questions, add <code>ANTHROPIC_API_KEY</code> to the <code>.env</code> file and restart the server.</div>`
        : `<div class="callout info" style="margin-bottom:16px">Questions are written by ${esc(engine.label)} using only the text of your documents.</div>`
    }
    <div class="steps">
      <section class="card" id="step-details" aria-labelledby="step-details-title"></section>
      <section class="card" id="step-upload" aria-labelledby="step-upload-title"></section>
      <section class="card" id="step-config" aria-labelledby="step-config-title"></section>
    </div>
    <div class="action-bar" id="action-bar"></div>`;

  renderDetailsStep();
  renderUploadStep();
  renderConfigStep();
  renderActionBar();

  function stepHead(id, number, done, title, description) {
    return `<div class="step-head"><span class="step-num${done ? ' done' : ''}" aria-hidden="true">${done ? '✓' : number}</span>
      <div><h2 id="${id}">${title}</h2><p class="muted">${description}</p></div></div>`;
  }

  function renderDetailsStep() {
    const el = document.getElementById('step-details');
    const done = Boolean(state.user) && !editingDetails;
    el.innerHTML =
      stepHead('step-details-title', 1, done, 'Your details', 'Required before you start a test. Your results are saved to reports under your mobile number.') +
      (done
        ? `<div class="user-summary"><span class="avatar" aria-hidden="true">${esc(initials(state.user.name))}</span>
            <div class="who"><strong>${esc(state.user.name)}</strong><span class="muted small">${esc(state.user.mobile)}</span></div>
            <button class="btn small" type="button" data-action="edit">Change</button></div>`
        : detailsFormHtml({ user: state.user, cancellable: Boolean(state.user) }));

    if (done) {
      el.querySelector('[data-action="edit"]').onclick = () => {
        editingDetails = true;
        renderDetailsStep();
        el.querySelector('input').focus();
      };
      return;
    }
    const form = el.querySelector('form');
    bindDetailsForm(form, (user) => {
      setUser(user);
      editingDetails = false;
      renderDetailsStep();
      renderActionBar();
      toast('Details saved');
    });
    form.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
      editingDetails = false;
      renderDetailsStep();
    });
  }

  function dropzoneText(kind) {
    if (kind === 'content') {
      return { title: 'Drop study material here or click to browse', hint: 'You can select several files at once.' };
    }
    return {
      title: 'Drop question papers here or click to browse',
      hint:
        engine.id === 'claude'
          ? 'Each question needs answer options (a, b, c…). If the paper has no answers, Claude works them out.'
          : 'Each question needs answer options (a, b, c…) and an answer: under the question, in an answer key, or by marking the option.',
    };
  }

  function renderUploadStep(statusHtml = '') {
    const el = document.getElementById('step-upload');
    const kind = state.settings.uploadKind;
    const text = dropzoneText(kind);
    const kindOption = (value, title, description) => `<label class="kind-option">
        <input type="radio" name="upload-kind" value="${value}"${kind === value ? ' checked' : ''}>
        <span class="kind-body"><strong>${title}</strong><span>${description}</span></span></label>`;
    el.innerHTML = `
      ${stepHead('step-upload-title', 2, state.docs.length > 0, 'Upload documents', `PDF, Word (.docx), text or Markdown files with selectable text. Up to ${limits.maxFiles} files at a time, ${limits.maxFileMb} MB each. Tick the documents to use in this test.`)}
      <fieldset class="kind-picker">
        <legend>What are you uploading?</legend>
        ${kindOption('content', 'Study material', 'Notes, chapters, summaries or any content describing a topic. New questions are generated from the content.')}
        ${kindOption('questions', 'Question paper', 'Sample or previous questions with options. The same questions are used in your test.')}
      </fieldset>
      <label class="dropzone" id="dropzone">
        <input type="file" id="file-input" class="visually-hidden" multiple accept="${esc(state.config.supportedExtensions.join(','))}">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4l4 4"/><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>
        <strong id="dropzone-title">${esc(text.title)}</strong>
        <span class="muted small" id="dropzone-hint">${esc(text.hint)}</span>
      </label>
      <div id="upload-status" role="status" style="margin-top:12px">${statusHtml}</div>
      ${state.docs.length ? docListHtml() : ''}`;

    el.querySelectorAll('input[name="upload-kind"]').forEach((radio) => {
      radio.onchange = () => {
        state.settings.uploadKind = radio.value;
        saveDraft();
        const next = dropzoneText(radio.value);
        el.querySelector('#dropzone-title').textContent = next.title;
        el.querySelector('#dropzone-hint').textContent = next.hint;
      };
    });
    const dropzone = el.querySelector('#dropzone');
    el.querySelector('#file-input').addEventListener('change', (e) => uploadFiles(e.target.files));
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
    el.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.onclick = () => {
        state.docs = state.docs.filter((d) => d.id !== btn.dataset.remove);
        pruneCounts();
        saveDraft();
        renderUploadStep();
        renderConfigStep();
        renderActionBar();
      };
    });
    el.querySelectorAll('[data-use]').forEach((box) => {
      box.onchange = () => setDocsInTest([box.dataset.use], box.checked);
    });
    el.querySelectorAll('[data-use-all], [data-use-none]').forEach((btn) => {
      btn.onclick = () => setDocsInTest(state.docs.map((d) => d.id), 'useAll' in btn.dataset);
    });
  }

  function docListHtml() {
    const head =
      state.docs.length > 1
        ? `<div class="doc-list-head"><span id="docs-used">${docsUsedText()}</span>
            <button class="btn small" type="button" data-use-all>Use all</button>
            <button class="btn ghost small" type="button" data-use-none>None</button></div>`
        : '';
    return `${head}<ul class="doc-list">${state.docs.map(docItemHtml).join('')}</ul>`;
  }

  const docsUsedText = () => `<strong>${testDocs().length} of ${state.docs.length}</strong> documents used in this test`;

  // Ticks or unticks documents. The list is updated in place so keyboard focus stays on the checkbox.
  function setDocsInTest(ids, use) {
    const unused = new Set(state.unusedDocs);
    for (const id of ids) {
      if (use) unused.delete(id);
      else unused.add(id);
    }
    state.unusedDocs = state.docs.map((d) => d.id).filter((id) => unused.has(id));
    const el = document.getElementById('step-upload');
    el.querySelectorAll('[data-use]').forEach((box) => {
      box.checked = !unused.has(box.dataset.use);
      box.closest('.doc-item').classList.toggle('unused', !box.checked);
    });
    const count = el.querySelector('#docs-used');
    if (count) count.innerHTML = docsUsedText();
    renderConfigStep();
    afterCountsChange();
  }

  function docItemHtml(doc) {
    const ext = fileExt(doc.name);
    let meta;
    if (isPaper(doc)) {
      const x = doc.extraction;
      meta = [
        plural(doc.questionCount, 'question'),
        x.suggested && `${x.suggested} ${x.suggested === 1 ? 'answer' : 'answers'} worked out by Claude`,
        x.skipped && `${x.skipped} skipped (not multiple choice)`,
        x.unanswered && `${x.unanswered} skipped (no answer found)`,
        x.issues?.length && `<span class="badge warn">${plural(x.issues.length, 'item')} to check</span>`,
      ]
        .filter(Boolean)
        .join(' · ');
    } else {
      meta = `${plural(doc.sections.length, 'section')} · ${doc.wordCount.toLocaleString()} words`;
    }
    const used = inTest(doc);
    return `<li class="doc-item${used ? '' : ' unused'}">
      <label class="doc-pick">
        <input type="checkbox" data-use="${esc(doc.id)}"${used ? ' checked' : ''} aria-label="Use ${esc(doc.name)} in this test">
        <span class="doc-icon ${esc(ext)}" aria-hidden="true">${esc(ext.toUpperCase().slice(0, 4))}</span>
        <span class="doc-meta"><strong title="${esc(doc.name)}">${esc(doc.name)}</strong>
        <span class="muted small">${kindBadge(doc)} ${meta}</span></span>
      </label>
      ${isPaper(doc) ? `<a class="btn small" href="#/paper/${esc(doc.id)}">Answer key</a>` : ''}
      <button class="btn ghost small" type="button" data-remove="${esc(doc.id)}" aria-label="Remove ${esc(doc.name)}">Remove</button></li>`;
  }

  function kindBadge(doc) {
    return isPaper(doc) ? '<span class="badge info">Question paper</span>' : '<span class="badge">Study material</span>';
  }

  async function uploadFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
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
      renderUploadStep(problemList(problems));
      return;
    }

    const kind = state.settings.uploadKind;
    const reading =
      kind === 'questions' && engine.id === 'claude'
        ? `Reading the questions in ${plural(accepted.length, 'file')} with Claude… This can take a minute or two.`
        : `Reading ${plural(accepted.length, 'file')}…`;
    renderUploadStep(`<div class="callout" style="display:flex;gap:10px;align-items:center"><span class="spinner"></span> ${esc(reading)}</div>`);
    const form = new FormData();
    form.append('kind', kind);
    accepted.forEach((f) => form.append('files', f));
    try {
      const { documents, errors } = await api('/api/documents', { method: 'POST', body: form });
      if (!ctx.isActive()) return;
      const hadMaterialQuestions = materialQuestionTotal() > 0;
      state.docs.push(...documents);
      // Question papers start with every question selected; study material gets a share of the quick-fill total.
      for (const doc of documents.filter(isPaper)) {
        for (const s of doc.sections) state.counts[`${doc.id}:${s.id}`] = s.questionCount;
      }
      if (!hadMaterialQuestions && documents.some((d) => !isPaper(d))) distribute(state.settings.quickTotal);
      if (state.settings.timeAuto) state.settings.timeLimitMin = suggestedTime();
      saveDraft();
      problems.push(...errors.map((e) => `${e.name}: ${e.error}`));
      const added = documents.length
        ? `<div class="callout info">Added ${plural(documents.length, 'document')}. ${plural(totalQuestions(), 'question')} ${totalQuestions() === 1 ? 'is' : 'are'} now selected below; adjust them as you like.</div>`
        : '';
      renderUploadStep(added + (problems.length ? problemList(problems) : ''));
      renderConfigStep();
      renderActionBar();
    } catch (err) {
      if (ctx.isActive()) renderUploadStep(problemList([...problems, err.message]));
    }
  }

  const problemList = (items) =>
    `<div class="callout error" style="margin-top:8px"><strong>Some files could not be added</strong><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`;

  function renderConfigStep() {
    const el = document.getElementById('step-config');
    const head = stepHead('step-config-title', 3, false, 'Choose questions and settings', 'Pick how many questions to take from each section, or spread a total across all sections in proportion to their length.');
    if (!state.docs.length) {
      el.innerHTML = `${head}<p class="muted">Upload at least one document to see its sections here.</p>`;
      return;
    }
    const docs = testDocs();
    if (!docs.length) {
      el.innerHTML = `${head}<p class="muted">No documents are ticked. In step 2, tick the documents to use in this test.</p>`;
      return;
    }
    const s = state.settings;
    const hasMaterial = docs.some((d) => !isPaper(d));
    const hasPapers = docs.some(isPaper);
    const leftOut = state.docs.length - docs.length;
    el.innerHTML = `${head}
      ${leftOut ? `<p class="muted small" style="margin-bottom:12px">Showing the ${plural(docs.length, 'document')} ticked in step 2. ${plural(leftOut, 'uploaded document')} ${leftOut === 1 ? 'is' : 'are'} not used in this test.</p>` : ''}
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
    if (!state.user) todo.push('add your details');
    if (!state.docs.length) todo.push('upload a document');
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
          user: state.user,
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

// Drops counts and unticked marks that belong to documents no longer in the list.
function pruneCounts() {
  const valid = new Set(state.docs.flatMap((d) => d.sections.map((s) => `${d.id}:${s.id}`)));
  for (const key of Object.keys(state.counts)) if (!valid.has(key)) delete state.counts[key];
  state.unusedDocs = state.unusedDocs.filter((id) => state.docs.some((d) => d.id === id));
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
    <h2 style="margin-top:22px">Confirm your details</h2>
    <p class="muted small" style="margin-top:4px">Update them if needed. Your result is saved to the reports for this mobile number.</p>
    <div id="start-form" style="margin-top:14px"></div>
    <p class="muted small" style="margin-top:18px">Question source: ${esc(test.engine.label.charAt(0).toUpperCase() + test.engine.label.slice(1))}. Created ${esc(formatDate(test.createdAt))}.</p>
  </div>`;

  const holder = document.getElementById('start-form');
  holder.innerHTML = detailsFormHtml({ user: state.user, submitLabel: 'Start test', large: true });
  holder.querySelector('.btn-row').insertAdjacentHTML('beforeend', '<a class="btn ghost" href="#/">Back</a>');
  bindDetailsForm(holder.querySelector('form'), async (user, form) => {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Starting…';
    try {
      setUser(user);
      const { attemptId } = await api(`/api/tests/${testId}/attempts`, { method: 'POST', body: { user } });
      location.hash = `#/attempt/${attemptId}`;
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Start test';
      toast(err.message, 5000);
    }
  });
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
      <div class="title-wrap"><p class="eyebrow">${esc(data.user.name)} · ${esc(data.user.mobile)}</p><h1 class="attempt-title">${esc(data.test.title)}</h1></div>
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
        <p class="muted">${esc(data.user.name)} · ${esc(data.user.mobile)} · ${esc(formatDate(data.submittedAt))}</p>
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
    <div class="btn-row" style="margin-top:20px"><a class="btn primary" href="#/">Back to create a test</a></div>`;
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

async function viewReports(ctx) {
  if (!state.user) {
    app.innerHTML = `<div class="page-head"><h1>My reports</h1><p>Enter the details you used for your tests to see your past results.</p></div>
      <section class="card narrow" id="report-details"></section>`;
    const holder = document.getElementById('report-details');
    holder.innerHTML = detailsFormHtml({ submitLabel: 'Show my reports' });
    bindDetailsForm(holder.querySelector('form'), (user) => {
      setUser(user);
      router();
    });
    return;
  }

  const { attempts } = await api(`/api/reports?mobile=${encodeURIComponent(state.user.mobile)}`);
  if (!ctx.isActive()) return;
  const done = attempts.filter((a) => a.status === 'submitted');
  const average = done.length ? done.reduce((sum, a) => sum + a.result.percentage, 0) / done.length : 0;
  const best = done.length ? Math.max(...done.map((a) => a.result.percentage)) : 0;
  const passed = done.filter((a) => a.result.passed).length;
  const stat = (label, value, sub = '') =>
    `<div class="stat"><span class="label">${label}</span><span class="value">${esc(value)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>`;

  app.innerHTML = `
    <div class="page-head">
      <h1>My reports</h1>
      <p>Practice tests taken by <strong>${esc(state.user.name)}</strong> (${esc(state.user.mobile)}). <a href="#/reports" data-action="switch">Not you?</a></p>
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
            <tbody>${attempts.map(reportRowHtml).join('')}</tbody>
          </table></div></section>`
        : `<div class="card empty"><h2>No practice tests yet</h2><p style="margin-top:6px">Tests you take with this mobile number will appear here.</p><a class="btn primary" href="#/">Create a practice test</a></div>`
    }`;

  app.querySelector('[data-action="switch"]').onclick = (e) => {
    e.preventDefault();
    openModal(`<h2 id="modal-title">Switch user</h2><p class="muted small" style="margin:6px 0 14px">Enter the details used for the tests you want to see.</p>${detailsFormHtml({ submitLabel: 'Show reports', cancellable: true })}`);
    const form = modal.querySelector('form');
    bindDetailsForm(form, (user) => {
      setUser(user);
      closeModal();
      router();
    });
    form.querySelector('[data-action="cancel"]').onclick = closeModal;
  };
}

function reportRowHtml(a) {
  const title = `<td class="title-cell"><strong>${esc(a.title)}</strong><div class="muted small">${plural(a.questionCount, 'question')} · ${esc(a.documents.join(', '))}</div></td>`;
  if (a.status === 'in_progress') {
    const leftSec = (new Date(a.deadline) - Date.now()) / 1000;
    return `<tr>
      <td data-label="Started">${esc(formatDate(a.startedAt))}</td>${title}
      <td class="num" data-label="Score">—</td>
      <td data-label="Result"><span class="badge warn">In progress</span></td>
      <td class="num" data-label="Time left">${formatDuration(leftSec)} left</td>
      <td><a class="btn small primary" href="#/attempt/${esc(a.attemptId)}">Resume</a></td></tr>`;
  }
  const r = a.result;
  return `<tr>
    <td data-label="Date">${esc(formatDate(a.submittedAt))}</td>${title}
    <td class="num" data-label="Score"><strong>${r.percentage}%</strong> <span class="muted small">(${r.correct}/${r.total})</span></td>
    <td data-label="Result"><span class="badge ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'Passed' : 'Not passed'}</span></td>
    <td class="num" data-label="Time taken">${formatDuration(r.timeTakenSec)}</td>
    <td><a class="btn small" href="#/result/${esc(a.attemptId)}">View</a></td></tr>`;
}

// ---------- start ----------

renderHeaderUser();
window.addEventListener('hashchange', router);
router();
