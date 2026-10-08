import * as store from './store.js';
import { STAGES, ENTRY_KINDS, DOC_KINDS, uid, fitScore } from './store.js';
import * as docs from './docs.js';
import * as localFiles from './files.js';
import * as cloud from './cloud.js';
import { INVITE_CONTACT } from './config.js';
import { COMPANY_PACKS, PACK_CATEGORIES, rankPacks, packAdded } from './packs.js';
import {
  ADJACENT_ROLES,
  POSTED_OPTIONS,
  boardLinks,
  companyCareersLink,
  companyLinkedinLink,
  encodeLead,
  decodeLead,
  safeUrl,
  showAdjacent,
} from './scout.js';
import { fetchFromUrl, fromText, fromClip, decodePayload, analyze, bookmarkletCode, extractWins, sourceFromUrl as sourceFromUrlSafe } from './parse.js';

const view = document.getElementById('view');
const drawer = document.getElementById('drawer');
const scrim = document.getElementById('scrim');
const toastEl = document.getElementById('toast');

let docsCache = [];
let openJobId = null;
let journalFilter = 'all';
let journalKind = 'thought';
let boardQuery = '';
let pendingImport = null; // { job, analysis } waiting for a yes on the Import page
let importError = '';
let packsOpen = false; // Scout's starter-list browser stays open across re-renders

// ---------- helpers ----------

function h(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(n) {
  const v = Number(n);
  if (!v) return '';
  return v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`;
}

function payRange(job) {
  const a = money(job.salaryMin);
  const b = money(job.salaryMax);
  if (a && b) return `${a}–${b}`;
  return a || b || '';
}

function shortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function longDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function dayDiff(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d - today) / 86400000);
}

function dueLabel(dateStr) {
  const n = dayDiff(dateStr);
  if (n === null) return '';
  if (n < 0) return `${-n}d overdue`;
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  return `In ${n}d`;
}

function scoreClass(score) {
  if (score === null) return 'none';
  if (score >= 75) return 'good';
  if (score >= 50) return 'okay';
  return 'poor';
}

function scoreBadge(job, size = '') {
  const s = fitScore(job);
  return `<span class="score score-${scoreClass(s)} ${size}" title="Fit score">${s === null ? '—' : s}</span>`;
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

async function copy(text, msg = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    prompt('Copy this:', text);
  }
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  cur[keys.at(-1)] = value;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function activeJobs() {
  return store.get().jobs.filter((j) => j.stage !== 'closed');
}

function jobLabel(job) {
  return job.title || job.company ? `${job.title || 'Untitled role'}${job.company ? ` · ${job.company}` : ''}` : 'New job';
}

// ---------- router ----------

const routes = {
  brief: renderBrief,
  scout: renderScout,
  board: renderBoard,
  journal: renderJournal,
  files: renderFiles,
  setup: renderSetup,
  send: renderSend,
  lead: renderLead,
  import: renderImport,
  login: renderLogin,
  welcome: renderWelcome,
};

// ---------- accounts & routing guard ----------

let booted = false;
let session = null; // Supabase session when signed in (cloud mode only)
let enteredFor = null; // user id whose workspace is loaded
const login = { step: 'email', email: '', error: '', busy: false };
const RETURN_KEY = 'nextmove:returnTo';
const PUBLIC_ROUTES = ['send']; // friends sending a lead don't need an account
const PRE_SETUP_ROUTES = ['welcome', 'send', 'lead', 'import'];

function routeFor(name) {
  if (cloud.cloudEnabled && !session) return PUBLIC_ROUTES.includes(name) ? name : 'login';
  if (name === 'login') return 'brief';
  if (!store.get().onboarded && !PRE_SETUP_ROUTES.includes(name)) return 'welcome';
  return name;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { name: routes[path] ? path : 'brief', params: new URLSearchParams(query) };
}

async function render() {
  if (!booted) return;
  const parsed = parseHash();
  const name = routeFor(parsed.name);
  const params = parsed.params;
  // Signed out with a lead or clip in the link: come back to it after signing in
  if (name === 'login' && ['lead', 'import'].includes(parsed.name) && params.get('d')) {
    try {
      localStorage.setItem(RETURN_KEY, location.hash);
    } catch {}
  }
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === name);
    a.toggleAttribute('aria-current', a.dataset.route === name);
  });
  document.body.dataset.route = name;
  document.body.classList.toggle('pre-setup', !store.get().onboarded);
  if (name === 'files' || name === 'brief' || openJobId) docsCache = await docs.listDocs();
  view.innerHTML = routes[name](params);
  view.querySelectorAll('.reveal').forEach((el, i) => el.style.setProperty('--i', i));
  afterRender(name);
}

// Navigate, re-rendering even when the hash is already the target (no hashchange fires then).
function go(hash) {
  if (location.hash === hash) {
    closeDrawer(false);
    return render().then(() => window.scrollTo(0, 0));
  }
  location.hash = hash;
  return Promise.resolve();
}

window.addEventListener('hashchange', () => {
  closeDrawer(false);
  render().then(() => {
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
});

// ---------- views ----------

function pageHead(kicker, title, deck = '') {
  return `
    <header class="page-head reveal">
      <p class="kicker">${kicker}</p>
      <h1>${title}</h1>
      ${deck ? `<p class="deck">${deck}</p>` : ''}
    </header>`;
}

function renderBrief() {
  const s = store.get();
  const p = s.profile;
  const active = activeJobs();
  const counts = Object.fromEntries(STAGES.map((st) => [st.id, s.jobs.filter((j) => j.stage === st.id).length]));
  const upcoming = active
    .filter((j) => j.nextDate)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
    .slice(0, 6);
  const best = active
    .map((j) => ({ j, score: fitScore(j) }))
    .filter((x) => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const fromCrew = active.filter((j) => j.from && j.stage === 'spotted');
  const wins = s.entries.filter((e) => e.kind === 'win');
  const win = wins.length ? wins[Math.floor(Math.random() * wins.length)] : null;
  const weekAgo = Date.now() - 7 * 86400000;
  const addedThisWeek = s.jobs.filter((j) => j.createdAt > weekAgo).length;

  return `
    ${pageHead(
      longDate(Date.now()),
      p.name ? `${h(p.name)}’s next move` : 'Your next move',
      'You can learn anything fast. The job is finding the place that pays for it.'
    )}

    <section class="stat-strip reveal" aria-label="Pipeline">
      ${STAGES.filter((st) => st.id !== 'closed')
        .map(
          (st) => `
        <a class="stat" href="#/board">
          <span class="stat-num">${counts[st.id]}</span>
          <span class="stat-label">${st.label}</span>
        </a>`
        )
        .join('')}
      <div class="stat stat-accent">
        <span class="stat-num">${addedThisWeek}</span>
        <span class="stat-label">Added this week</span>
      </div>
    </section>

    <div class="brief-grid">
      <section class="panel reveal">
        <div class="panel-head"><h2>Up next</h2><a class="link" href="#/board">Board →</a></div>
        ${
          upcoming.length
            ? `<ul class="list">${upcoming
                .map(
                  (j) => `
              <li>
                <button class="row" data-act="open-job" data-id="${j.id}">
                  <span class="due ${dayDiff(j.nextDate) < 0 ? 'late' : ''}">${dueLabel(j.nextDate)}</span>
                  <span class="row-main"><strong>${h(j.nextStep || 'Follow up')}</strong><span class="muted">${h(jobLabel(j))}</span></span>
                </button>
              </li>`
                )
                .join('')}</ul>`
            : `<p class="empty">No follow-ups scheduled. Give each job a next step and a date, and they line up here.</p>`
        }
      </section>

      <section class="panel reveal">
        <div class="panel-head"><h2>Best fits</h2><span class="muted small">by scorecard</span></div>
        ${
          best.length
            ? `<ul class="list">${best
                .map(
                  ({ j }) => `
              <li>
                <button class="row" data-act="open-job" data-id="${j.id}">
                  ${scoreBadge(j)}
                  <span class="row-main"><strong>${h(j.title || 'Untitled role')}</strong><span class="muted">${h(j.company)}${payRange(j) ? ` · ${payRange(j)}` : ''}</span></span>
                </button>
              </li>`
                )
                .join('')}</ul>`
            : `<p class="empty">Score a job against your criteria and the strongest ones rise to the top.</p>`
        }
      </section>

      ${
        fromCrew.length
          ? `<section class="panel panel-crew reveal">
        <div class="panel-head"><h2>From the crew</h2><span class="muted small">${fromCrew.length} lead${fromCrew.length > 1 ? 's' : ''}</span></div>
        <ul class="list">${fromCrew
          .map(
            (j) => `
          <li><button class="row" data-act="open-job" data-id="${j.id}">
            <span class="from-tag">${h(j.from)}</span>
            <span class="row-main"><strong>${h(j.title || 'A lead')}</strong><span class="muted">${h(j.company)}</span></span>
          </button></li>`
          )
          .join('')}</ul>
      </section>`
          : ''
      }

      <section class="panel panel-proof reveal">
        <div class="panel-head"><h2>Proof file</h2><a class="link" href="#/journal">Journal →</a></div>
        ${
          win
            ? `<blockquote class="proof">${h(win.text)}</blockquote><p class="muted small">Logged ${shortDate(win.at)}. ${wins.length} win${wins.length > 1 ? 's' : ''} on file.</p>`
            : `<p class="proof-empty">Write down the things you’ve built, fixed, launched, and grown, with numbers if you have them. These become your interview answers, and a reminder of what you’re worth.</p>
               <a class="btn btn-ghost" href="#/journal">Log a win</a>`
        }
      </section>
    </div>

    <section class="quick reveal">
      <a class="btn" href="#/import">Import a posting</a>
      <button class="btn btn-ghost" data-act="new-job">+ Add by hand</button>
      <a class="btn btn-ghost" href="#/scout">Run today’s search</a>
      <a class="btn btn-ghost" href="#/journal">Write it down</a>
    </section>
  `;
}

function renderScout() {
  const s = store.get();
  const p = s.profile;
  const titles = p.titles;
  const sectors = [...new Set(s.companies.map((c) => c.sector || 'Other'))];

  return `
    ${pageHead('02 · Scout', 'Go find it', 'Every link opens a job board with your titles and filters already applied. Run it once a day; it takes five minutes.')}

    <section class="filters panel reveal">
      <label class="field">
        <span>Where</span>
        <input type="text" data-bind="profile.location" value="${h(p.location)}" placeholder="City, ST" ${s.search.remote ? 'disabled' : ''} />
      </label>
      <label class="field">
        <span>Posted</span>
        <select data-bind="search.posted">
          ${POSTED_OPTIONS.map((o) => `<option value="${o.id}" ${o.id === s.search.posted ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span>Salary floor</span>
        <input type="number" step="5000" min="0" data-bind="profile.salaryFloor" data-type="number" value="${h(p.salaryFloor)}" />
      </label>
      <label class="toggle"><input type="checkbox" data-bind="search.remote" data-type="bool" ${s.search.remote ? 'checked' : ''} /><span>Remote only</span></label>
      <label class="toggle"><input type="checkbox" data-bind="search.noAgency" data-type="bool" ${s.search.noAgency ? 'checked' : ''} /><span>Hide agencies &amp; staffing</span></label>
    </section>

    <section class="searches reveal">
      ${
        titles.length
          ? titles
              .map((t, i) => {
                const links = boardLinks(t, p, s.search);
                return `
          <article class="search-row">
            <div class="search-title">
              <h3>${h(t)}</h3>
              <button class="icon-btn" data-act="remove-title" data-index="${i}" aria-label="Remove ${h(t)}">×</button>
            </div>
            <div class="search-links">
              ${links
                .map(
                  (l) =>
                    `<a class="chip chip-link ${l.id === 'direct' ? 'chip-direct' : ''}" href="${h(l.url)}" target="_blank" rel="noopener" ${l.hint ? `title="${h(l.hint)}"` : ''}>${l.label} ↗</a>`
                )
                .join('')}
            </div>
          </article>`;
              })
              .join('')
          : '<p class="empty">Add a title to search for.</p>'
      }
      <form class="inline-form" data-form="add-title">
        <input type="text" name="title" placeholder="Add a job title to search…" required />
        <button class="btn btn-ghost" type="submit">Add title</button>
      </form>
      <p class="muted small">Tip: <strong>Direct employers</strong> searches company career sites only, so every hit is a direct hire.</p>
    </section>

    ${showAdjacent(titles) ? `<section class="reveal">
      <div class="section-head">
        <h2>Titles you might be overlooking</h2>
        <p class="muted">Same skills, different names. Some of these pay more than “marketing manager.”</p>
      </div>
      <div class="adjacent-grid">
        ${ADJACENT_ROLES.map((r) => {
          const added = titles.some((t) => t.toLowerCase() === r.title.toLowerCase());
          return `
          <article class="adjacent ${added ? 'is-added' : ''}">
            <h3>${h(r.title)}</h3>
            <p>${h(r.why)}</p>
            <button class="btn btn-small ${added ? 'btn-done' : 'btn-ghost'}" data-act="add-title" data-title="${h(r.title)}" ${added ? 'disabled' : ''}>${added ? 'In your search ✓' : '+ Add to search'}</button>
          </article>`;
        }).join('')}
      </div>
    </section>` : ''}

    <section class="reveal">
      <div class="section-head">
        <h2>Target companies</h2>
        <p class="muted">Go to the company directly. Check their career pages and find a person to talk to there.</p>
      </div>
      ${packBrowser(s)}
      ${sectors
        .map(
          (sector) => `
        <div class="sector">
          <h3 class="sector-name"><span>${h(sector)}</span><button class="link-btn sector-remove" data-act="remove-sector" data-sector="${h(sector)}">Remove list</button></h3>
          <div class="company-list">
            ${s.companies
              .filter((c) => (c.sector || 'Other') === sector)
              .map(
                (c) => `
              <div class="company status-${h(c.status)}">
                <div class="company-main">
                  <strong>${h(c.name)}</strong>
                  ${c.note ? `<span class="muted small">${h(c.note)}</span>` : ''}
                </div>
                <div class="company-actions">
                  <a class="chip chip-link" href="${h(companyCareersLink(c.name, titles))}" target="_blank" rel="noopener">Careers ↗</a>
                  <a class="chip chip-link" href="${h(companyLinkedinLink(c.name))}" target="_blank" rel="noopener">LinkedIn ↗</a>
                  <select data-act="company-status" data-id="${c.id}" aria-label="Status for ${h(c.name)}">
                    ${['watching', 'reached out', 'applied', 'not a fit']
                      .map((st) => `<option ${st === c.status ? 'selected' : ''}>${st}</option>`)
                      .join('')}
                  </select>
                  <button class="icon-btn" data-act="remove-company" data-id="${c.id}" aria-label="Remove ${h(c.name)}">×</button>
                </div>
              </div>`
              )
              .join('')}
          </div>
        </div>`
        )
        .join('')}
      <form class="inline-form company-form" data-form="add-company">
        <input type="text" name="name" placeholder="Company" required />
        <input type="text" name="sector" placeholder="Group (e.g. Tools & hardware)" list="sector-list" />
        <datalist id="sector-list">${sectors.map((x) => `<option value="${h(x)}"></option>`).join('')}</datalist>
        <input type="text" name="note" placeholder="Why it’s interesting" />
        <button class="btn btn-ghost" type="submit">Add company</button>
      </form>
    </section>
  `;
}

function packChip(pack, companies) {
  const added = packAdded(pack, companies);
  return `<button class="chip ${added ? 'chip-done' : 'chip-link'}" data-act="add-pack" data-id="${pack.id}" ${added ? 'disabled' : ''}>${added ? '✓' : '+'} ${h(pack.label)} <span class="chip-count">${pack.companies.length}</span></button>`;
}

function packBrowser(s) {
  const suggested = rankPacks(s.profile).slice(0, 6);
  const total = COMPANY_PACKS.reduce((n, pk) => n + pk.companies.length, 0);
  const near = s.profile.location
    ? `<a class="link" href="https://www.google.com/search?q=${encodeURIComponent(`largest employers in ${s.profile.location}`)}" target="_blank" rel="noopener">Biggest employers near ${h(s.profile.location)} ↗</a>`
    : '';
  return `
    <details class="packs" ${packsOpen || !s.companies.length ? 'open' : ''}>
      <summary><strong>Browse starter lists</strong> <span class="muted small">${COMPANY_PACKS.length} lists · ${total} companies</span></summary>
      ${
        suggested.length
          ? `<div class="pack-group pack-suggested"><h4>Suggested for you</h4><div class="pack-chips">${suggested.map((pk) => packChip(pk, s.companies)).join('')}</div></div>`
          : ''
      }
      ${PACK_CATEGORIES.map(
        (cat) => `
        <div class="pack-group">
          <h4>${cat}</h4>
          <div class="pack-chips">${COMPANY_PACKS.filter((pk) => pk.category === cat)
            .map((pk) => packChip(pk, s.companies))
            .join('')}</div>
        </div>`
      ).join('')}
    </details>
    ${near ? `<p class="near">${near}</p>` : ''}`;
}

function renderBoard() {
  const s = store.get();
  const q = boardQuery.trim().toLowerCase();
  const matches = (j) =>
    !q || [j.title, j.company, j.location, j.notes, j.from].some((v) => (v || '').toLowerCase().includes(q));

  return `
    ${pageHead('03 · Board', 'The pipeline', 'Drag cards between columns, or open one to score it, take notes, and attach the resume you sent.')}

    <div class="board-bar reveal">
      <a class="btn" href="#/import">Import a posting</a>
      <button class="btn btn-ghost" data-act="new-job">+ Add by hand</button>
      <input class="search-input" type="search" placeholder="Filter by title, company, notes…" value="${h(boardQuery)}" data-act="board-filter" />
    </div>

    <div class="board reveal">
      ${STAGES.map((st) => {
        const jobs = s.jobs.filter((j) => j.stage === st.id && matches(j));
        if (st.id !== 'closed') jobs.sort((a, b) => (fitScore(b) ?? -1) - (fitScore(a) ?? -1));
        return `
        <section class="col col-${st.id}" data-stage="${st.id}">
          <header class="col-head">
            <h2>${st.label}</h2>
            <span class="col-count">${jobs.length}</span>
          </header>
          <p class="col-hint">${st.hint}</p>
          <div class="col-body">
            ${jobs.map(cardHtml).join('') || '<div class="col-empty">Drop here</div>'}
          </div>
        </section>`;
      }).join('')}
    </div>
  `;
}

function cardHtml(j) {
  const due = j.nextDate ? dueLabel(j.nextDate) : '';
  return `
    <article class="card" draggable="true" data-id="${j.id}" data-act="open-job" tabindex="0" role="button" aria-label="${h(jobLabel(j))}">
      <div class="card-top">
        <div class="card-title">
          <strong>${h(j.title || 'Untitled role')}</strong>
          <span>${h(j.company || '—')}</span>
        </div>
        ${scoreBadge(j, 'score-sm')}
      </div>
      <div class="card-meta">
        ${payRange(j) ? `<span>${payRange(j)}</span>` : ''}
        ${j.workMode ? `<span>${h(j.workMode)}</span>` : ''}
        ${j.from ? `<span class="from-tag">via ${h(j.from)}</span>` : ''}
        ${due ? `<span class="due ${dayDiff(j.nextDate) < 0 ? 'late' : ''}">${due}</span>` : ''}
      </div>
    </article>`;
}

function renderJournal() {
  const s = store.get();
  const entries = s.entries.filter((e) => journalFilter === 'all' || e.kind === journalFilter);
  const kindLabel = (id) => ENTRY_KINDS.find((k) => k.id === id)?.label ?? id;
  const prompts = {
    thought: 'What’s on your mind about the search, or about work?',
    win: 'Something you built, fixed, launched, or grew. Add the number if there is one.',
    prep: 'A story to tell, a question to ask, a company to research…',
    idea: 'A company, a person to call, a different direction to try…',
  };

  return `
    ${pageHead('04 · Journal', 'Write it down', 'Get the thoughts out of your head. Log wins as they happen; that’s your interview prep and your proof.')}

    <form class="composer panel reveal" data-form="add-entry">
      <div class="pills" role="radiogroup" aria-label="Entry type">
        ${ENTRY_KINDS.map(
          (k) =>
            `<button type="button" class="pill ${k.id === journalKind ? 'on' : ''} pill-${k.id}" data-act="entry-kind" data-kind="${k.id}" role="radio" aria-checked="${k.id === journalKind}">${k.label}</button>`
        ).join('')}
      </div>
      <textarea name="text" rows="4" placeholder="${h(prompts[journalKind])}" required></textarea>
      <div class="composer-foot">
        <span class="muted small">⌘/Ctrl + Enter to save</span>
        <button class="btn" type="submit">Save</button>
      </div>
    </form>

    <div class="pills filter-pills reveal">
      <button class="pill ${journalFilter === 'all' ? 'on' : ''}" data-act="journal-filter" data-kind="all">All · ${s.entries.length}</button>
      ${ENTRY_KINDS.map((k) => {
        const n = s.entries.filter((e) => e.kind === k.id).length;
        return `<button class="pill ${journalFilter === k.id ? 'on' : ''}" data-act="journal-filter" data-kind="${k.id}">${k.label} · ${n}</button>`;
      }).join('')}
    </div>

    <section class="entries reveal">
      ${
        entries.length
          ? entries
              .map(
                (e) => `
        <article class="entry entry-${e.kind}">
          <header>
            <span class="entry-kind">${kindLabel(e.kind)}</span>
            <time>${shortDate(e.at)} · ${new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
            <button class="icon-btn" data-act="delete-entry" data-id="${e.id}" aria-label="Delete entry">×</button>
          </header>
          <p>${h(e.text).replace(/\n/g, '<br />')}</p>
        </article>`
              )
              .join('')
          : '<p class="empty">Nothing here yet.</p>'
      }
    </section>
  `;
}

function renderFiles() {
  const s = store.get();
  const byKind = DOC_KINDS.map((k) => ({ kind: k, docs: docsCache.filter((d) => d.kind === k) })).filter((g) => g.docs.length);
  const usedBy = (docId) => s.jobs.filter((j) => j.docIds?.includes(docId));

  return `
    ${pageHead('05 · Files', 'The folder', 'Resume versions, cover letters, portfolio pieces, offer letters. Attach them to jobs so you always know which version you sent where.')}

    <label class="dropzone reveal" data-drop>
      <input type="file" multiple data-act="upload" hidden />
      <span class="drop-big">Drop files here</span>
      <span class="muted">or click to choose · PDFs, Word docs, images, anything</span>
    </label>

    <section class="reveal">
      ${
        byKind.length
          ? byKind
              .map(
                (g) => `
        <div class="doc-group">
          <h2 class="sector-name">${g.kind}</h2>
          ${g.docs
            .map((d) => {
              const jobs = usedBy(d.id);
              return `
            <div class="doc">
              <span class="doc-ext">${h((d.name.split('.').pop() || 'file').slice(0, 4))}</span>
              <div class="doc-main">
                <input class="doc-label" value="${h(d.label || d.name)}" data-act="doc-label" data-id="${d.id}" aria-label="Label" />
                <span class="muted small">${h(d.name)} · ${docs.prettySize(d.size)} · ${shortDate(d.addedAt)}${
                  jobs.length ? ` · sent to ${jobs.map((j) => h(j.company || j.title)).join(', ')}` : ''
                }</span>
              </div>
              <select data-act="doc-kind" data-id="${d.id}" aria-label="Type">
                ${DOC_KINDS.map((k) => `<option ${k === d.kind ? 'selected' : ''}>${k}</option>`).join('')}
              </select>
              <button class="btn btn-small btn-ghost" data-act="doc-open" data-id="${d.id}">Open</button>
              <button class="icon-btn" data-act="doc-delete" data-id="${d.id}" aria-label="Delete ${h(d.name)}">×</button>
            </div>`;
            })
            .join('')}
        </div>`
              )
              .join('')
          : '<p class="empty">No files yet. Start with your current resume.</p>'
      }
    </section>

    <section class="reveal">
      <div class="section-head">
        <h2>Snippets</h2>
        <p class="muted">Answers you’ll type over and over. Write them once, then copy.</p>
      </div>
      <div class="snippets">
        ${s.snippets
          .map(
            (sn) => `
          <article class="snippet">
            <input class="snippet-title" value="${h(sn.title)}" data-act="snippet-title" data-id="${sn.id}" aria-label="Snippet title" />
            <textarea rows="5" data-act="snippet-body" data-id="${sn.id}" aria-label="Snippet text">${h(sn.body)}</textarea>
            <div class="snippet-foot">
              <button class="btn btn-small" data-act="snippet-copy" data-id="${sn.id}">Copy</button>
              <button class="icon-btn" data-act="snippet-delete" data-id="${sn.id}" aria-label="Delete snippet">×</button>
            </div>
          </article>`
          )
          .join('')}
        <button class="snippet snippet-add" data-act="snippet-add">+ New snippet</button>
      </div>
    </section>
  `;
}

function renderSetup() {
  const s = store.get();
  const p = s.profile;
  const sendUrl = `${location.origin}${location.pathname}#/send${p.name ? `?to=${encodeURIComponent(p.name)}` : ''}`;
  const account = cloud.currentUser();

  return `
    ${pageHead('06 · Setup', 'The brief', 'What you’re looking for and what you won’t accept. The scorecard is how every job gets judged, so make it honest.')}

    <section class="panel form-grid reveal">
      <label class="field"><span>Name</span><input data-bind="profile.name" value="${h(p.name)}" /></label>
      <label class="field"><span>Home base</span><input data-bind="profile.location" value="${h(p.location)}" placeholder="City, ST" /></label>
      <label class="field"><span>Relocation</span>
        <select data-bind="profile.relocation">
          ${[
            ['never', 'Not moving'],
            ['last-resort', 'Last resort, for the right role'],
            ['open', 'Open to it'],
            ['eager', 'Ready to go'],
          ]
            .map(([v, l]) => `<option value="${v}" ${v === p.relocation ? 'selected' : ''}>${l}</option>`)
            .join('')}
        </select>
      </label>
      <label class="field"><span>Salary floor</span><input type="number" step="5000" data-bind="profile.salaryFloor" data-type="number" value="${h(p.salaryFloor)}" /></label>
      <label class="field"><span>Salary target</span><input type="number" step="5000" data-bind="profile.salaryTarget" data-type="number" value="${h(p.salaryTarget)}" /></label>
      <label class="field"><span>Years of experience</span><input type="number" min="0" data-bind="profile.yearsExperience" data-type="number" value="${h(p.yearsExperience)}" /></label>
      <label class="field span-2"><span>Strength keywords <span class="muted">comma-separated · highlighted when found in a posting</span></span><textarea rows="3" data-bind="profile.keywords" data-type="list">${h((p.keywords || []).join(', '))}</textarea></label>
      <label class="field span-2"><span>Must-haves</span><textarea rows="4" data-bind="profile.mustHaves">${h(p.mustHaves)}</textarea></label>
      <label class="field span-2"><span>Dealbreakers</span><textarea rows="3" data-bind="profile.dealbreakers">${h(p.dealbreakers)}</textarea></label>
    </section>

    <section class="reveal">
      <div class="section-head">
        <h2>Fit scorecard</h2>
        <p class="muted">Each job gets rated No / Sort of / Yes on these. Weight 3 = matters most.</p>
      </div>
      <div class="criteria">
        ${s.criteria
          .map(
            (c, i) => `
          <div class="criterion">
            <span class="crit-num">${String(i + 1).padStart(2, '0')}</span>
            <div class="crit-main">
              <input class="crit-label" value="${h(c.label)}" data-act="crit-field" data-field="label" data-id="${c.id}" aria-label="Criterion" />
              <input class="crit-hint" value="${h(c.hint)}" data-act="crit-field" data-field="hint" data-id="${c.id}" aria-label="Hint" placeholder="What does a yes look like?" />
            </div>
            <div class="weight" role="radiogroup" aria-label="Weight">
              ${[1, 2, 3]
                .map(
                  (w) =>
                    `<button class="weight-btn ${c.weight === w ? 'on' : ''}" data-act="crit-weight" data-id="${c.id}" data-weight="${w}" aria-pressed="${c.weight === w}">${w}</button>`
                )
                .join('')}
            </div>
            <button class="icon-btn" data-act="crit-delete" data-id="${c.id}" aria-label="Remove criterion">×</button>
          </div>`
          )
          .join('')}
      </div>
      <button class="btn btn-ghost" data-act="crit-add">+ Add a criterion</button>
    </section>

    <section class="panel reveal">
      <div class="panel-head"><h2>Let your friends send you leads</h2></div>
      <p>Send this link to the people keeping an eye out for you. They fill in a job, then text you a link. When you open it, the job lands on your board.</p>
      <div class="share-row">
        <code class="share-url">${h(sendUrl)}</code>
        <button class="btn btn-small" data-act="copy" data-text="${h(sendUrl)}">Copy link</button>
      </div>
    </section>

    ${
      account
        ? `<section class="panel reveal">
      <div class="panel-head"><h2>Account</h2><a class="link" href="#/welcome">Run setup again →</a></div>
      <p>Signed in as <strong>${h(account.email)}</strong>. Your workspace syncs to your account, so it’s the same on your phone and laptop.</p>
      <div class="quick"><button class="btn btn-ghost" data-act="sign-out">Sign out</button></div>
    </section>`
        : ''
    }

    <section class="panel reveal">
      <div class="panel-head"><h2>Your data</h2>${account ? '' : '<a class="link" href="#/welcome">Run setup again →</a>'}</div>
      ${
        account
          ? '<p>Your jobs, notes, and files are stored in your private account. Only you can see them. Export a backup if you want your own copy.</p>'
          : '<p>Everything (jobs, notes, files) is saved in <strong>this browser only</strong>. Nothing is uploaded. Export a backup now and then, and use it to move to another device.</p>'
      }
      <div class="quick">
        <button class="btn" data-act="export">Export backup</button>
        <label class="btn btn-ghost">Import backup<input type="file" accept="application/json,.json" data-act="import" hidden /></label>
        <button class="btn btn-danger" data-act="reset">Erase everything</button>
      </div>
    </section>
  `;
}

function prepareImport(job) {
  return { job, analysis: analyze(job, store.get().profile) };
}

function findExisting(job) {
  const url = safeUrl(job.url);
  return store.get().jobs.find(
    (j) => (url && j.url === url) || (job.title && j.title === job.title && job.company && j.company === job.company)
  );
}

function notesHtml(parsed) {
  if (!parsed?.notes?.length && !parsed?.keywords?.length) return '';
  return `
    <div class="read-notes">
      <p class="read-notes-label">From the posting</p>
      <ul class="notes">${(parsed.notes || []).map((n) => `<li class="note note-${n.tone}">${h(n.text)}</li>`).join('')}</ul>
      ${
        parsed.keywords?.length
          ? `<p class="kw-line"><span class="muted small">Your strengths it mentions:</span> ${parsed.keywords.map((k) => `<span class="kw">${h(k)}</span>`).join('')}</p>`
          : ''
      }
    </div>`;
}

function renderImport(params) {
  const payload = params.get('d');
  if (payload) {
    const clip = decodePayload(payload);
    importError = '';
    if (clip) pendingImport = prepareImport(fromClip(clip));
    else importError = 'That clip didn’t come through. Try again, or paste the text.';
    // Drop the bulky payload from the address bar
    history.replaceState(null, '', '#/import');
  }

  const appUrl = `${location.origin}${location.pathname}`;
  const s = store.get();

  let preview = '';
  if (pendingImport) {
    const { job, analysis } = pendingImport;
    const ratings = {};
    s.criteria.forEach((c) => {
      if (analysis.suggestions[c.id] !== undefined) ratings[c.id] = analysis.suggestions[c.id];
    });
    const projected = fitScore({ ratings });
    const existing = findExisting(job);
    const url = safeUrl(job.url);
    const words = (job.description || '').split(/\s+/).filter(Boolean).length;
    const field = (label, value) => `<div><dt>${label}</dt><dd>${value ? h(value) : '<span class="muted">not found</span>'}</dd></div>`;
    preview = `
      <section class="panel import-preview reveal">
        <div class="panel-head">
          <h2>Here’s what I read</h2>
          <span class="muted small">${h(job.source || 'Pasted text')}</span>
        </div>
        <div class="import-top">
          <dl class="import-fields">
            ${field('Title', job.title)}
            ${field('Company', job.company)}
            ${field('Location', job.location)}
            ${field('Setup', job.workMode)}
            ${field('Pay', payRange(job))}
            <div><dt>Link</dt><dd>${url ? `<a class="link" href="${h(url)}" target="_blank" rel="noopener">${h(new URL(url).hostname)} ↗</a>` : '<span class="muted">none</span>'}</dd></div>
          </dl>
          <div class="import-score">
            <span class="score score-${scoreClass(projected)}">${projected === null ? '—' : projected}</span>
            <span class="muted small">Early fit score<br />${Object.keys(ratings).length} of ${s.criteria.length} criteria pre-rated</span>
          </div>
        </div>
        ${notesHtml(analysis)}
        ${words ? `<details class="import-desc"><summary>Posting text · ${words} words</summary><pre>${h(job.description)}</pre></details>` : ''}
        <div class="quick">
          ${
            existing
              ? `<button class="btn" data-act="open-job" data-id="${existing.id}">Already on your board · Open</button>`
              : `<button class="btn" data-act="import-add">Add to board</button>`
          }
          <button class="btn btn-ghost" data-act="import-clear">Start over</button>
        </div>
        <p class="muted small">Anything I got wrong, fix it on the card. Pre-ratings are a starting point; “would they value me” is your call.</p>
      </section>`;
  }

  return `
    ${pageHead('Import', 'Pull in a posting', 'Drop in a link or the posting text. I’ll pull out the title, company, pay, and location, and pre-score it against your scorecard.')}

    ${preview}
    ${importError ? `<p class="warn reveal">${h(importError)}</p>` : ''}

    <div class="import-grid reveal">
      <form class="panel" data-form="import-url">
        <h2 class="import-h">From a link</h2>
        <p class="muted small">Reads directly from company career sites on <strong>Greenhouse</strong>, <strong>Lever</strong>, and <strong>Ashby</strong>. For LinkedIn, Indeed, and others, use the clipper below.</p>
        <input type="url" name="url" placeholder="https://boards.greenhouse.io/…" required />
        <button class="btn" type="submit">Fetch it</button>
      </form>
      <form class="panel" data-form="import-text">
        <h2 class="import-h">Paste the text</h2>
        <p class="muted small">Works with any posting. Select all on the page, copy, paste. Extra junk is fine.</p>
        <textarea name="text" rows="6" placeholder="Paste the whole posting here…" required></textarea>
        <input type="url" name="url" placeholder="Link to the posting (optional)" />
        <button class="btn" type="submit">Read it</button>
      </form>
    </div>

    <section class="panel clipper reveal">
      <div class="clipper-main">
        <h2 class="import-h">One-click clipper</h2>
        <ol class="steps">
          <li>Drag this button to your bookmarks bar. Press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>B</kbd> if the bar is hidden.</li>
          <li>On any job posting (LinkedIn, Indeed, a company site), click it.</li>
          <li>The posting opens here, already read and pre-scored.</li>
        </ol>
        <p class="muted small">On LinkedIn, highlighting the description before you click gives the cleanest read. On your phone, copy the text and paste it above.</p>
      </div>
      <a class="bookmarklet" href="${h(bookmarkletCode(appUrl))}" data-act="bookmarklet-hint" draggable="true">✂ Clip to Next Move</a>
    </section>
  `;
}

function renderLogin() {
  const codeStep = login.step === 'code';
  return `
    <div class="login">
      <div class="login-card reveal">
        <p class="login-mark"><span>Next</span> Move<span class="wordmark-dot">.</span></p>
        <p class="login-tag">A private field guide to the job worth having.</p>
        ${
          codeStep
            ? `<form class="login-form" data-form="login-code">
          <p>We emailed a code to <strong>${h(login.email)}</strong>. Enter it here, or tap the link in that email.</p>
          <label class="field"><span>Sign-in code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required /></label>
          <button class="btn" type="submit" ${login.busy ? 'disabled' : ''}>${login.busy ? 'Checking…' : 'Sign in'}</button>
          <button type="button" class="link-btn" data-act="login-back">Use a different email</button>
        </form>`
            : `<form class="login-form" data-form="login-email">
          <label class="field"><span>Email</span><input type="email" name="email" value="${h(login.email)}" autocomplete="email" required /></label>
          <button class="btn" type="submit" ${login.busy ? 'disabled' : ''}>${login.busy ? 'Sending…' : 'Email me a sign-in code'}</button>
        </form>`
        }
        ${login.error ? `<p class="warn" role="alert">${h(login.error)}</p>` : ''}
        <p class="muted small login-foot">Invite-only. Ask ${h(INVITE_CONTACT)} if you need an invite.</p>
      </div>
    </div>`;
}

function renderWelcome() {
  const p = store.get().profile;
  const again = store.get().onboarded;
  const relocation = [
    ['never', 'No, staying put'],
    ['last-resort', 'Only for the right role'],
    ['open', 'Open to it'],
    ['eager', 'Ready to go'],
  ];
  return `
    ${pageHead(again ? 'Setup' : 'Welcome', again ? 'Tune your search' : 'Let’s set up your search', 'Takes about two minutes. You can change any of it later in Setup.')}
    <form class="welcome" data-form="welcome">
      <section class="welcome-step reveal">
        <span class="step-num">01</span>
        <div class="step-body">
          <h2>Who’s searching?</h2>
          <div class="form-grid">
            <label class="field"><span>First name</span><input name="name" value="${h(p.name)}" autocomplete="given-name" required /></label>
            <label class="field"><span>Home base</span><input name="location" value="${h(p.location)}" placeholder="City, ST" required /></label>
            <label class="field span-2"><span>Would you move for a job?</span>
              <select name="relocation">${relocation.map(([v, l]) => `<option value="${v}" ${v === p.relocation ? 'selected' : ''}>${l}</option>`).join('')}</select>
            </label>
          </div>
        </div>
      </section>

      <section class="welcome-step reveal">
        <span class="step-num">02</span>
        <div class="step-body">
          <h2>What are you looking for?</h2>
          <div class="form-grid">
            <label class="field span-2"><span>Job titles <span class="muted">one per line</span></span>
              <textarea name="titles" rows="4" placeholder="Channel Marketing Manager&#10;Brand Manager" required>${h(p.titles.join('\n'))}</textarea>
            </label>
            <label class="field"><span>Salary floor</span><input type="number" step="5000" min="0" name="salaryFloor" value="${h(p.salaryFloor)}" placeholder="85000" /></label>
            <label class="field"><span>Salary target</span><input type="number" step="5000" min="0" name="salaryTarget" value="${h(p.salaryTarget)}" placeholder="110000" /></label>
            <label class="field"><span>Years of experience</span><input type="number" min="0" name="yearsExperience" value="${h(p.yearsExperience)}" placeholder="8" /></label>
          </div>
        </div>
      </section>

      <section class="welcome-step reveal">
        <span class="step-num">03</span>
        <div class="step-body">
          <h2>What are you good at?</h2>
          <p class="muted">Skills and topics, comma-separated. When a posting mentions them, they get highlighted.</p>
          <textarea name="keywords" rows="3" placeholder="channel marketing, MDF, trade shows, e-commerce, social media, B2B">${h(p.keywords.join(', '))}</textarea>
        </div>
      </section>

      <section class="welcome-step reveal">
        <span class="step-num">04</span>
        <div class="step-body">
          <h2>Bring your wins <span class="optional">optional</span></h2>
          <p class="muted">Paste your LinkedIn Experience section or your resume. I’ll pull out the accomplishments with numbers in them for your Proof file.</p>
          <textarea name="experience" rows="5" placeholder="Paste here…"></textarea>
          <button type="button" class="btn btn-ghost btn-small" data-act="find-wins">Find my wins</button>
          <div id="win-list" class="win-list"></div>
        </div>
      </section>

      <section class="welcome-step reveal">
        <span class="step-num">05</span>
        <div class="step-body">
          <h2>Starter company lists <span class="optional">optional</span></h2>
          <p class="muted">Pick industries you’d consider. Each adds a handful of well-known employers to your target list in Scout.</p>
          <div class="pack-suggest" id="pack-suggest" hidden></div>
          <input type="search" class="pack-filter" data-act="pack-filter" placeholder="Filter lists or companies (e.g. pharma, Nike)…" aria-label="Filter starter lists" />
          ${PACK_CATEGORIES.map(
            (cat) => `
            <div class="pack-cat" data-cat>
              <h3 class="pack-cat-name">${cat}</h3>
              <div class="pack-picks">
                ${COMPANY_PACKS.filter((pk) => pk.category === cat)
                  .map(
                    (pk) => `<label class="check pack-pick" data-search="${h(`${pk.label} ${pk.tags.join(' ')} ${pk.companies.map((c) => c.name).join(' ')}`.toLowerCase())}"><input type="checkbox" name="packs" value="${pk.id}" /><span><strong>${h(pk.label)}</strong><span class="muted small">${pk.companies
                      .slice(0, 3)
                      .map((c) => h(c.name))
                      .join(', ')} +${pk.companies.length - 3}</span></span></label>`
                  )
                  .join('')}
              </div>
            </div>`
          ).join('')}
        </div>
      </section>

      <div class="welcome-foot reveal">
        <button class="btn" type="submit">${again ? 'Save' : 'Start my search →'}</button>
      </div>
    </form>
  `;
}

function recipientName(params) {
  return params.get('to') || (session || !cloud.cloudEnabled ? store.get().profile.name : '') || 'them';
}

function renderSend(params) {
  const name = recipientName(params);
  return `
    ${pageHead('For the crew', `Send ${h(name)} a lead`, `Found a role that fits? Fill this in and text ${h(name)} the link. Nothing is stored anywhere; the details travel inside the link.`)}
    <form class="panel form-grid reveal" data-form="send-lead">
      <label class="field span-2"><span>Link to the posting</span><input type="url" name="url" placeholder="https://…" /></label>
      <label class="field"><span>Job title</span><input name="title" placeholder="Channel Marketing Manager" required /></label>
      <label class="field"><span>Company</span><input name="company" placeholder="Acme Tools" /></label>
      <label class="field span-2"><span>Why you thought of ${h(name)}</span><textarea name="note" rows="3" placeholder="I know someone there, the pay looks right, etc."></textarea></label>
      <label class="field"><span>Your name</span><input name="from" placeholder="Dan" required /></label>
      <div class="field field-end"><button class="btn" type="submit">Make the link</button></div>
    </form>
    <section class="panel reveal" id="send-result" hidden></section>
  `;
}

function renderLead(params) {
  const lead = decodeLead(params.get('d') || '');
  if (!lead) {
    return `${pageHead('Lead', 'That link didn’t work', 'It may have been cut off when it was copied. Ask them to send it again.')}`;
  }
  const url = safeUrl(lead.url);
  const existing = store.get().jobs.find((j) => (url && j.url === url) || (j.title === lead.title && j.company === lead.company));
  return `
    ${pageHead(`A lead from ${h(lead.from || 'a friend')}`, h(lead.title || 'A role worth a look'), lead.company ? `at ${h(lead.company)}` : '')}
    <section class="panel lead-card reveal">
      ${lead.note ? `<blockquote class="proof">${h(lead.note)}</blockquote><p class="muted small">from ${h(lead.from)}</p>` : ''}
      ${url ? `<p><a class="link" href="${h(url)}" target="_blank" rel="noopener">Open the posting ↗</a></p>` : ''}
      <div class="quick">
        ${
          existing
            ? `<button class="btn" data-act="open-job" data-id="${existing.id}">Already on your board · Open</button>`
            : `<button class="btn" data-act="accept-lead">Add to my board</button>`
        }
        <a class="btn btn-ghost" href="#/brief">Not for me</a>
      </div>
    </section>
  `;
}

// ---------- drawer (job detail) ----------

function openDrawer(id) {
  openJobId = id;
  docs.listDocs().then((list) => {
    docsCache = list;
    drawer.innerHTML = drawerHtml();
    autosizeTitle();
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add('show'));
    const first = drawer.querySelector('[data-job-field="title"]');
    const job = store.get().jobs.find((j) => j.id === id);
    if (first && job && !job.title) first.focus();
    else drawer.querySelector('.drawer-close')?.focus();
  });
}

function autosizeTitle() {
  const el = drawer.querySelector('.drawer-title');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function closeDrawer(rerender = true) {
  if (!openJobId) return;
  openJobId = null;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  scrim.classList.remove('show');
  setTimeout(() => (scrim.hidden = true), 250);
  if (rerender) render();
}

function refreshDrawerScore() {
  const job = store.get().jobs.find((j) => j.id === openJobId);
  if (!job) return;
  const el = drawer.querySelector('.drawer-score');
  if (el) el.outerHTML = scoreBlock(job);
}

function scoreBlock(job) {
  const s = fitScore(job);
  const rated = store.ratedCount(job);
  const total = store.get().criteria.length;
  return `
    <div class="drawer-score score-${scoreClass(s)}">
      <span class="drawer-score-num">${s === null ? '—' : s}</span>
      <span class="drawer-score-label">Fit score<br /><span class="muted small">${rated}/${total} rated</span></span>
    </div>`;
}

function drawerHtml() {
  const s = store.get();
  const job = s.jobs.find((j) => j.id === openJobId);
  if (!job) return '';
  const url = safeUrl(job.url);
  const ratingNames = ['No', 'Sort of', 'Yes'];

  return `
    <div class="drawer-inner">
      <header class="drawer-head">
        <select class="stage-select" data-job-field="stage" aria-label="Stage">
          ${STAGES.map((st) => `<option value="${st.id}" ${st.id === job.stage ? 'selected' : ''}>${st.label}</option>`).join('')}
        </select>
        <button class="icon-btn drawer-close" data-act="close-drawer" aria-label="Close">×</button>
      </header>

      <textarea class="drawer-title" rows="1" data-job-field="title" placeholder="Job title" aria-label="Job title">${h(job.title)}</textarea>
      <input class="drawer-company" data-job-field="company" value="${h(job.company)}" placeholder="Company" aria-label="Company" />
      ${job.from ? `<p class="from-line">Sent by <span class="from-tag">${h(job.from)}</span></p>` : ''}

      <div class="form-grid compact">
        <label class="field span-2"><span>Posting link ${url ? `<a class="link" href="${h(url)}" target="_blank" rel="noopener">open ↗</a>` : ''}</span><input type="url" data-job-field="url" value="${h(job.url)}" placeholder="https://…" /></label>
        <label class="field"><span>Location</span><input data-job-field="location" value="${h(job.location)}" placeholder="City or Remote" /></label>
        <label class="field"><span>Setup</span>
          <select data-job-field="workMode">
            ${['', 'Remote', 'Hybrid', 'On-site', 'Relocation'].map((m) => `<option value="${m}" ${m === job.workMode ? 'selected' : ''}>${m || '—'}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Pay from</span><input type="number" step="5000" data-job-field="salaryMin" value="${h(job.salaryMin)}" placeholder="90000" /></label>
        <label class="field"><span>Pay to</span><input type="number" step="5000" data-job-field="salaryMax" value="${h(job.salaryMax)}" placeholder="120000" /></label>
        <label class="field"><span>Next step</span><input data-job-field="nextStep" value="${h(job.nextStep)}" placeholder="Follow up with recruiter" /></label>
        <label class="field"><span>By</span><input type="date" data-job-field="nextDate" value="${h(job.nextDate)}" /></label>
      </div>

      <section class="drawer-section">
        <div class="drawer-section-head">
          <h3>Scorecard</h3>
          ${scoreBlock(job)}
        </div>
        ${job.parsed ? notesHtml(job.parsed) : ''}
        ${!job.parsed && Number(job.salaryMin || job.salaryMax) && Number(s.profile.salaryFloor) && Number(job.salaryMax || job.salaryMin) < Number(s.profile.salaryFloor)
          ? `<p class="warn">Top of range is under your ${money(s.profile.salaryFloor)} floor.</p>`
          : ''}
        <div class="ratings">
          ${s.criteria
            .map((c) => {
              const r = job.ratings?.[c.id];
              return `
            <div class="rating">
              <div class="rating-text"><strong>${h(c.label)}</strong><span class="muted small">${h(c.hint)}</span></div>
              <div class="seg" role="radiogroup" aria-label="${h(c.label)}">
                ${[0, 1, 2]
                  .map(
                    (v) =>
                      `<button class="seg-btn seg-${v} ${r === v ? 'on' : ''}" data-act="rate" data-crit="${c.id}" data-value="${v}" role="radio" aria-checked="${r === v}">${ratingNames[v]}</button>`
                  )
                  .join('')}
              </div>
            </div>`;
            })
            .join('')}
        </div>
      </section>

      <section class="drawer-section">
        <h3>Notes</h3>
        <textarea rows="5" data-job-field="notes" placeholder="Gut feeling, red flags, questions to ask, what the recruiter said…">${h(job.notes)}</textarea>
      </section>

      <section class="drawer-section">
        <h3>People</h3>
        <textarea rows="3" data-job-field="contacts" placeholder="Recruiter, hiring manager, the friend who works there…">${h(job.contacts)}</textarea>
      </section>

      <section class="drawer-section">
        <div class="drawer-section-head">
          <h3>The posting</h3>
          <button class="btn btn-small btn-ghost" data-act="reparse" title="Fill empty fields and pre-score from the posting text">Read it</button>
        </div>
        <textarea rows="6" data-job-field="description" placeholder="Paste the job description. Postings disappear once the role is filled.">${h(job.description)}</textarea>
      </section>

      <section class="drawer-section">
        <h3>Files sent</h3>
        ${
          docsCache.length
            ? `<div class="doc-checks">${docsCache
                .map(
                  (d) => `
            <label class="check"><input type="checkbox" data-act="attach-doc" data-id="${d.id}" ${job.docIds?.includes(d.id) ? 'checked' : ''} /><span>${h(d.label || d.name)} <span class="muted small">${h(d.kind)}</span></span></label>`
                )
                .join('')}</div>`
            : `<p class="muted small">Upload resumes and cover letters in <a class="link" href="#/files">Files</a>, then check off which ones you sent here.</p>`
        }
      </section>

      <section class="drawer-section">
        <h3>Timeline</h3>
        <ul class="timeline">
          ${[...job.log]
            .reverse()
            .map((l) => `<li><time>${shortDate(l.at)}</time><span>${h(l.text)}</span></li>`)
            .join('')}
        </ul>
        <form class="inline-form" data-form="log">
          <input name="text" placeholder="Log something: phone screen, sent thank-you…" required />
          <button class="btn btn-small btn-ghost" type="submit">Log</button>
        </form>
      </section>

      <footer class="drawer-foot">
        <button class="btn btn-danger btn-small" data-act="delete-job">Delete job</button>
        <span class="muted small">Added ${shortDate(job.createdAt)}</span>
      </footer>
    </div>`;
}

// ---------- events ----------

function afterRender(name) {
  if (name === 'board') bindBoardDnD();
  if (name === 'files') bindDropzone();
  if (name === 'welcome') updatePackSuggestions();
}

function bindBoardDnD() {
  view.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  view.querySelectorAll('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drop-target');
    });
    col.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drop-target');
    });
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drop-target');
      const id = e.dataTransfer.getData('text/plain');
      const job = store.get().jobs.find((j) => j.id === id);
      if (job && job.stage !== col.dataset.stage) {
        store.patchJob(id, { stage: col.dataset.stage });
        if (col.dataset.stage === 'offer') toast('An offer. Get it in writing, then negotiate.');
        render();
      }
    });
  });
}

function bindDropzone() {
  const zone = view.querySelector('[data-drop]');
  if (!zone) return;
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('hover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('hover')));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });
}

async function addFiles(fileList) {
  const list = [...fileList];
  if (!list.length) return;
  for (const f of list) {
    if (f.size > 25 * 1024 * 1024) {
      toast(`${f.name} is over 25 MB, skipped`);
      continue;
    }
    try {
      await docs.addDoc(f, {
        id: uid(),
        name: f.name,
        type: f.type,
        size: f.size,
        kind: docs.guessKind(f.name),
        label: f.name.replace(/\.[^.]+$/, ''),
        addedAt: Date.now(),
      });
    } catch (err) {
      console.error(err);
      toast(`Couldn’t save ${f.name}`);
      return render();
    }
  }
  toast(`${list.length} file${list.length > 1 ? 's' : ''} saved`);
  render();
}

const actions = {
  'open-job': (el) => openDrawer(el.dataset.id),
  'close-drawer': () => closeDrawer(),
  'new-job': () => {
    const job = store.addJob();
    if (parseHash().name !== 'board' || document.body.dataset.route !== 'board') go('#/board');
    setTimeout(() => openDrawer(job.id), 50);
  },
  'delete-job': () => {
    const job = store.get().jobs.find((j) => j.id === openJobId);
    if (job && confirm(`Delete “${jobLabel(job)}”? This can’t be undone.`)) {
      store.removeJob(job.id);
      closeDrawer();
    }
  },
  rate: (el) => {
    const job = store.get().jobs.find((j) => j.id === openJobId);
    if (!job) return;
    const v = Number(el.dataset.value);
    const ratings = { ...job.ratings };
    ratings[el.dataset.crit] = ratings[el.dataset.crit] === v ? null : v;
    store.patchJob(job.id, { ratings });
    el.parentElement.querySelectorAll('.seg-btn').forEach((b) => {
      const on = Number(b.dataset.value) === ratings[el.dataset.crit];
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
    });
    refreshDrawerScore();
  },
  'add-title': (el) => {
    store.update((s) => {
      if (!s.profile.titles.includes(el.dataset.title)) s.profile.titles.push(el.dataset.title);
    });
    toast(`Added “${el.dataset.title}”`);
    render();
  },
  'remove-title': (el) => {
    store.update((s) => s.profile.titles.splice(Number(el.dataset.index), 1));
    render();
  },
  'remove-company': (el) => {
    store.update((s) => (s.companies = s.companies.filter((c) => c.id !== el.dataset.id)));
    render();
  },
  'entry-kind': (el) => {
    journalKind = el.dataset.kind;
    const ta = view.querySelector('.composer textarea');
    const text = ta?.value ?? '';
    render().then(() => {
      const next = view.querySelector('.composer textarea');
      if (next) {
        next.value = text;
        next.focus();
      }
    });
  },
  'journal-filter': (el) => {
    journalFilter = el.dataset.kind;
    render();
  },
  'delete-entry': (el) => {
    if (!confirm('Delete this entry?')) return;
    store.update((s) => (s.entries = s.entries.filter((e) => e.id !== el.dataset.id)));
    render();
  },
  'doc-open': async (el) => {
    const doc = docsCache.find((d) => d.id === el.dataset.id);
    if (!doc) return;
    // Open the tab now, while the click still counts as a user gesture; fill it once the file arrives
    const viewable = /pdf|image|text/.test(doc.type);
    const win = viewable ? window.open('', '_blank') : null;
    let blob;
    try {
      blob = await docs.getBlob(doc.id);
    } catch {
      blob = null;
    }
    if (!blob) {
      win?.close();
      return toast('Couldn’t open that file');
    }
    const url = URL.createObjectURL(blob);
    if (win) {
      win.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  'doc-delete': async (el) => {
    const doc = docsCache.find((d) => d.id === el.dataset.id);
    if (!doc || !confirm(`Delete ${doc.name}? This can’t be undone.`)) return;
    await docs.deleteDoc(doc.id);
    store.update((s) => s.jobs.forEach((j) => (j.docIds = (j.docIds || []).filter((id) => id !== doc.id))));
    render();
  },
  'snippet-copy': (el) => {
    const sn = store.get().snippets.find((x) => x.id === el.dataset.id);
    if (sn) copy(sn.body);
  },
  'snippet-add': () => {
    store.update((s) => s.snippets.push({ id: uid(), title: 'New snippet', body: '' }));
    render().then(() => view.querySelector('.snippet:nth-last-child(2) textarea')?.focus());
  },
  'snippet-delete': (el) => {
    if (!confirm('Delete this snippet?')) return;
    store.update((s) => (s.snippets = s.snippets.filter((x) => x.id !== el.dataset.id)));
    render();
  },
  'crit-weight': (el) => {
    store.update((s) => {
      const c = s.criteria.find((x) => x.id === el.dataset.id);
      if (c) c.weight = Number(el.dataset.weight);
    });
    render();
  },
  'crit-delete': (el) => {
    if (!confirm('Remove this criterion from the scorecard?')) return;
    store.update((s) => (s.criteria = s.criteria.filter((x) => x.id !== el.dataset.id)));
    render();
  },
  'crit-add': () => {
    store.update((s) => s.criteria.push({ id: uid(), label: 'New criterion', hint: '', weight: 2 }));
    render().then(() => {
      const inputs = view.querySelectorAll('.crit-label');
      inputs[inputs.length - 1]?.select();
    });
  },
  copy: (el) => copy(el.dataset.text),
  export: exportBackup,
  reset: async () => {
    const where = cloud.currentUser() ? 'in your account' : 'in this browser';
    if (!confirm(`Erase all jobs, notes, files, and settings ${where}? Export a backup first if you want to keep anything.`)) return;
    if (!confirm('Really erase everything?')) return;
    store.resetAll();
    await docs.clearDocs();
    toast('Erased. Fresh start.');
    render();
  },
  'import-add': () => {
    if (!pendingImport) return;
    const { job: p, analysis } = pendingImport;
    const ratings = {};
    store.get().criteria.forEach((c) => {
      if (analysis.suggestions[c.id] !== undefined) ratings[c.id] = analysis.suggestions[c.id];
    });
    const job = store.addJob({
      title: p.title || '',
      company: p.company || '',
      url: safeUrl(p.url || ''),
      location: p.location || '',
      workMode: p.workMode || '',
      salaryMin: p.salaryMin || '',
      salaryMax: p.salaryMax || '',
      description: p.description || '',
      source: p.source || '',
      ats: !!p.ats,
      ratings,
      parsed: { notes: analysis.notes, keywords: analysis.keywords, at: Date.now() },
      log: [{ at: Date.now(), text: `Imported from ${p.source || 'pasted text'}` }],
    });
    pendingImport = null;
    go('#/board');
    setTimeout(() => openDrawer(job.id), 80);
    toast('On the board. Rate the rest of the scorecard.');
  },
  'import-clear': () => {
    pendingImport = null;
    importError = '';
    render();
  },
  'bookmarklet-hint': () => toast('Drag this to your bookmarks bar. It works on job pages, not here.'),
  reparse: () => {
    const job = store.get().jobs.find((j) => j.id === openJobId);
    if (!job) return;
    const text = drawer.querySelector('[data-job-field="description"]')?.value ?? job.description;
    if (!text.trim()) return toast('Paste the posting text first');
    const read = fromText(text);
    const patch = { description: text };
    let filled = 0;
    for (const k of ['title', 'company', 'location', 'workMode', 'salaryMin', 'salaryMax']) {
      if (!job[k] && read[k]) {
        patch[k] = read[k];
        filled++;
      }
    }
    const analysis = analyze({ ...job, ...patch }, store.get().profile);
    const ratings = { ...job.ratings };
    let rated = 0;
    store.get().criteria.forEach((c) => {
      const cur = ratings[c.id];
      if ((cur === undefined || cur === null) && analysis.suggestions[c.id] !== undefined) {
        ratings[c.id] = analysis.suggestions[c.id];
        rated++;
      }
    });
    store.patchJob(job.id, { ...patch, ratings, parsed: { notes: analysis.notes, keywords: analysis.keywords, at: Date.now() } });
    const scroll = drawer.scrollTop;
    drawer.innerHTML = drawerHtml();
    autosizeTitle();
    drawer.scrollTop = scroll;
    toast(`Filled ${filled} field${filled === 1 ? '' : 's'}, pre-rated ${rated}`);
  },
  'sign-out': async () => {
    await store.pushNow();
    if (store.getMeta().dirty && !confirm('Some changes haven’t reached your account yet. Sign out anyway and lose them?')) return;
    const id = cloud.currentUser()?.id;
    await cloud.signOut();
    if (id) {
      localStorage.removeItem(`nextmove:v1:${id}`);
      localStorage.removeItem(`nextmove:v1:${id}:meta`);
    }
  },
  'login-back': () => {
    login.step = 'email';
    login.error = '';
    render();
  },
  'find-wins': () => {
    const text = view.querySelector('[name="experience"]')?.value || '';
    const wins = extractWins(text);
    const out = view.querySelector('#win-list');
    out.innerHTML = wins.length
      ? `<p class="muted small">Found ${wins.length}. Uncheck any you don’t want.</p>` +
        wins.map((w) => `<label class="check"><input type="checkbox" name="wins" value="${h(w)}" checked /><span>${h(w)}</span></label>`).join('')
      : '<p class="muted small">Didn’t find accomplishments with numbers. You can log wins in the Journal anytime.</p>';
  },
  'remove-sector': (el) => {
    const sector = el.dataset.sector;
    const n = store.get().companies.filter((c) => (c.sector || 'Other') === sector).length;
    if (!confirm(`Remove all ${n} companies in “${sector}”?`)) return;
    store.update((st) => (st.companies = st.companies.filter((c) => (c.sector || 'Other') !== sector)));
    render();
  },
  'pick-pack': (el) => {
    const box = view.querySelector(`[name="packs"][value="${el.dataset.id}"]`);
    if (box) {
      box.checked = !box.checked;
      el.classList.toggle('on', box.checked);
    }
  },
  'add-pack': (el) => {
    const pack = COMPANY_PACKS.find((pk) => pk.id === el.dataset.id);
    if (!pack) return;
    let added = 0;
    store.update((s) => {
      const have = new Set(s.companies.map((c) => c.name));
      pack.companies.forEach((c) => {
        if (!have.has(c.name)) {
          s.companies.push({ id: uid(), sector: pack.label, status: 'watching', ...c });
          added++;
        }
      });
    });
    toast(added ? `Added ${added} companies from ${pack.label}` : 'Already on your list');
    packsOpen = true;
    render();
  },
  'accept-lead': () => {
    const lead = decodeLead(parseHash().params.get('d') || '');
    if (!lead) return;
    const job = store.addJob({
      title: lead.title,
      company: lead.company,
      url: safeUrl(lead.url),
      from: lead.from,
      notes: lead.note ? `${lead.from}: ${lead.note}` : '',
      log: [{ at: Date.now(), text: `Lead from ${lead.from || 'a friend'}` }],
    });
    go('#/board');
    setTimeout(() => openDrawer(job.id), 80);
    toast(`Added. Tell ${lead.from || 'them'} thanks.`);
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.matches('input, select, textarea')) return;
  const fn = actions[el.dataset.act];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openJobId) closeDrawer();
  if (e.key === 'Enter' && e.target.matches('.card')) openDrawer(e.target.dataset.id);
  if (e.key === 'Enter' && e.target.matches('.drawer-title')) {
    e.preventDefault();
    e.target.blur();
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.closest('[data-form="add-entry"]')) {
    e.target.closest('form').requestSubmit();
  }
});

scrim.addEventListener('click', () => closeDrawer());

document.addEventListener(
  'toggle',
  (e) => {
    if (e.target.matches?.('details.packs')) packsOpen = e.target.open;
  },
  true
);

// Field changes. "input" saves quietly as you type; "change" also re-renders when the view depends on it.
const debouncers = new Map();
function debounce(key, fn, ms = 350) {
  clearTimeout(debouncers.get(key));
  debouncers.set(key, setTimeout(fn, ms));
}

function readValue(el) {
  if (el.dataset.type === 'bool') return el.checked;
  if (el.dataset.type === 'number') return el.value === '' ? '' : Number(el.value);
  if (el.dataset.type === 'list') return el.value.split(',').map((x) => x.trim()).filter(Boolean);
  return el.value;
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.bind) {
    debounce(el.dataset.bind, () => store.update((s) => setPath(s, el.dataset.bind, readValue(el))));
    return;
  }
  if (el.matches('.drawer-title')) autosizeTitle();
  if (el.dataset.jobField && openJobId && el.type !== 'checkbox') {
    const id = openJobId;
    const field = el.dataset.jobField;
    if (field === 'stage') return;
    debounce(`job:${field}`, () => store.patchJob(id, { [field]: el.value }));
    return;
  }
  if (el.closest('[data-form="welcome"]') && ['titles', 'keywords'].includes(el.name)) {
    debounce('pack-suggest', updatePackSuggestions, 300);
  }
  const act = el.dataset.act;
  if (act === 'pack-filter') {
    const q = el.value.trim().toLowerCase();
    view.querySelectorAll('.pack-pick').forEach((pick) => (pick.hidden = q && !pick.dataset.search.includes(q)));
    view.querySelectorAll('.pack-cat').forEach((cat) => (cat.hidden = ![...cat.querySelectorAll('.pack-pick')].some((p) => !p.hidden)));
    return;
  }
  if (act === 'board-filter') {
    boardQuery = el.value;
    debounce('board-filter', () => {
      const pos = el.selectionStart;
      render().then(() => {
        const input = view.querySelector('.search-input');
        input?.focus();
        input?.setSelectionRange(pos, pos);
      });
    }, 200);
  }
  if (act === 'snippet-body' || act === 'snippet-title') {
    const key = act === 'snippet-body' ? 'body' : 'title';
    debounce(`${act}:${el.dataset.id}`, () =>
      store.update((s) => {
        const sn = s.snippets.find((x) => x.id === el.dataset.id);
        if (sn) sn[key] = el.value;
      })
    );
  }
  if (act === 'crit-field') {
    debounce(`crit:${el.dataset.id}:${el.dataset.field}`, () =>
      store.update((s) => {
        const c = s.criteria.find((x) => x.id === el.dataset.id);
        if (c) c[el.dataset.field] = el.value;
      })
    );
  }
  if (act === 'doc-label') {
    debounce(`doc:${el.dataset.id}`, async () => {
      await docs.updateDoc(el.dataset.id, { label: el.value });
    });
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.bind) {
    clearTimeout(debouncers.get(el.dataset.bind));
    const before = getPath(store.get(), el.dataset.bind);
    const value = readValue(el);
    store.update((s) => setPath(s, el.dataset.bind, value));
    // Scout links depend on these, so redraw them
    if (parseHash().name === 'scout' && before !== value) render();
    return;
  }
  if (el.dataset.jobField && openJobId) {
    clearTimeout(debouncers.get(`job:${el.dataset.jobField}`));
    store.patchJob(openJobId, { [el.dataset.jobField]: el.value });
    if (['stage', 'url', 'salaryMin', 'salaryMax'].includes(el.dataset.jobField)) {
      const scroll = drawer.scrollTop;
      drawer.innerHTML = drawerHtml();
      autosizeTitle();
      drawer.scrollTop = scroll;
    }
    return;
  }
  const act = el.dataset.act;
  if (act === 'company-status') {
    store.update((s) => {
      const c = s.companies.find((x) => x.id === el.dataset.id);
      if (c) c.status = el.value;
    });
    el.closest('.company').className = `company status-${el.value}`;
  }
  if (act === 'attach-doc' && openJobId) {
    const job = store.get().jobs.find((j) => j.id === openJobId);
    const ids = new Set(job.docIds || []);
    el.checked ? ids.add(el.dataset.id) : ids.delete(el.dataset.id);
    store.patchJob(job.id, { docIds: [...ids] });
  }
  if (act === 'doc-kind') {
    await docs.updateDoc(el.dataset.id, { kind: el.value });
    render();
  }
  if (el.name === 'packs' && el.closest('[data-form="welcome"]')) updatePackSuggestions();
  if (act === 'upload') addFiles(el.files);
  if (act === 'import') importBackup(el.files[0]);
});

document.addEventListener('submit', (e) => {
  const form = e.target;
  const kind = form.dataset.form;
  if (!kind) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));

  if (kind === 'add-title') {
    const t = data.title.trim();
    if (t) actions['add-title']({ dataset: { title: t } });
  }
  if (kind === 'add-company') {
    store.update((s) =>
      s.companies.push({ id: uid(), name: data.name.trim(), sector: data.sector.trim() || 'My list', note: data.note.trim(), status: 'watching' })
    );
    render();
  }
  if (kind === 'add-entry') {
    const text = data.text.trim();
    if (!text) return;
    store.update((s) => s.entries.unshift({ id: uid(), at: Date.now(), kind: journalKind, text }));
    toast(journalKind === 'win' ? 'Win logged. Keep stacking them.' : 'Saved');
    render();
  }
  if (kind === 'log' && openJobId) {
    const job = store.get().jobs.find((j) => j.id === openJobId);
    store.patchJob(job.id, { log: [...job.log, { at: Date.now(), text: data.text.trim() }] });
    const scroll = drawer.scrollTop;
    drawer.innerHTML = drawerHtml();
    autosizeTitle();
    drawer.scrollTop = scroll;
  }
  if (kind === 'login-email') {
    login.email = data.email.trim();
    login.error = '';
    login.busy = true;
    render();
    cloud
      .sendCode(login.email)
      .then(() => (login.step = 'code'))
      .catch((err) => (login.error = err.message))
      .finally(() => {
        login.busy = false;
        render().then(() => view.querySelector('.login-form input')?.focus());
      });
    return;
  }
  if (kind === 'login-code') {
    login.error = '';
    login.busy = true;
    render();
    cloud
      .verifyCode(login.email, data.code.trim())
      .then(async (s) => {
        login.busy = false;
        login.step = 'email';
        await enterWorkspace(s);
        render();
      })
      .catch((err) => {
        login.busy = false;
        login.error = err.message;
        render().then(() => view.querySelector('.login-form input')?.focus());
      });
    return;
  }
  if (kind === 'welcome') {
    const fd = new FormData(form);
    const list = (v, sep) => String(v || '').split(sep).map((x) => x.trim()).filter(Boolean);
    const numOrBlank = (v) => (v === '' || v === null ? '' : Number(v));
    const wins = fd.getAll('wins');
    const packs = fd.getAll('packs');
    const name = String(fd.get('name')).trim();
    store.update((st) => {
      Object.assign(st.profile, {
        name,
        location: String(fd.get('location')).trim(),
        relocation: fd.get('relocation'),
        titles: list(fd.get('titles'), '\n'),
        salaryFloor: numOrBlank(fd.get('salaryFloor')),
        salaryTarget: numOrBlank(fd.get('salaryTarget')),
        yearsExperience: numOrBlank(fd.get('yearsExperience')),
        keywords: list(fd.get('keywords'), ','),
      });
      const now = Date.now();
      st.entries = [...wins.map((text, i) => ({ id: uid(), at: now - i * 1000, kind: 'win', text })), ...st.entries];
      const have = new Set(st.companies.map((c) => c.name));
      COMPANY_PACKS.filter((pk) => packs.includes(pk.id)).forEach((pk) =>
        pk.companies.forEach((c) => {
          if (!have.has(c.name)) st.companies.push({ id: uid(), sector: pk.label, status: 'watching', ...c });
        })
      );
      st.onboarded = true;
    });
    go('#/brief');
    toast(`You’re set${name ? `, ${name}` : ''}. Start with Scout.`);
    return;
  }
  if (kind === 'import-url') {
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Reading…';
    importError = '';
    fetchFromUrl(data.url)
      .then((job) => {
        pendingImport = prepareImport(job);
        render().then(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      })
      .catch((err) => {
        importError = err.message || 'Couldn’t read that link.';
        render().then(() => view.querySelector('[data-form="import-text"] textarea')?.focus());
      });
    return;
  }
  if (kind === 'import-text') {
    const url = safeUrl(data.url.trim());
    importError = '';
    pendingImport = prepareImport({ ...fromText(data.text), url, source: url ? sourceFromUrlSafe(url) : 'Pasted text' });
    render().then(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    return;
  }
  if (kind === 'send-lead') {
    const lead = {
      title: data.title.trim(),
      company: data.company.trim(),
      url: data.url.trim(),
      note: data.note.trim(),
      from: data.from.trim(),
    };
    const link = `${location.origin}${location.pathname}#/lead?d=${encodeLead(lead)}`;
    const name = recipientName(parseHash().params);
    const msg = `Saw this and thought of you: ${lead.title}${lead.company ? ` at ${lead.company}` : ''}. ${link}`;
    const out = view.querySelector('#send-result');
    out.hidden = false;
    out.innerHTML = `
      <div class="panel-head"><h2>Ready to send</h2></div>
      <p>Text or message this to ${h(name)}:</p>
      <div class="share-row"><code class="share-url">${h(link)}</code></div>
      <div class="quick">
        <button class="btn" data-act="copy" data-text="${h(msg)}">Copy message</button>
        <a class="btn btn-ghost" href="sms:?&body=${encodeURIComponent(msg)}">Open in Messages</a>
      </div>`;
    out.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

// Suggest starter lists on the setup page from the titles and strengths typed so far.
function updatePackSuggestions() {
  const form = view.querySelector('[data-form="welcome"]');
  const out = view.querySelector('#pack-suggest');
  if (!form || !out) return;
  const list = (v, sep) => String(v || '').split(sep).map((x) => x.trim()).filter(Boolean);
  const ranked = rankPacks({
    titles: list(form.titles.value, '\n'),
    keywords: list(form.keywords.value, ','),
    relocation: form.relocation.value,
  }).slice(0, 5);
  out.hidden = !ranked.length;
  out.innerHTML = ranked.length
    ? `<span class="muted small">Suggested from what you wrote:</span> ${ranked
        .map((pk) => {
          const on = form.querySelector(`[name="packs"][value="${pk.id}"]`)?.checked;
          return `<button type="button" class="pill ${on ? 'on' : ''}" data-act="pick-pack" data-id="${pk.id}">${h(pk.label)}</button>`;
        })
        .join('')}`
    : '';
}

// ---------- backup ----------

async function exportBackup() {
  toast('Packing your backup…');
  const list = await docs.listDocs();
  const packed = [];
  for (const meta of list) {
    const blob = await docs.getBlob(meta.id).catch(() => null);
    if (blob) packed.push({ ...meta, data: await docs.blobToDataUrl(blob) });
  }
  const payload = { app: 'next-move', exportedAt: new Date().toISOString(), state: store.get(), docs: packed };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `next-move-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('Backup downloaded');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload.app !== 'next-move' || !payload.state) throw new Error('Not a Next Move backup');
    if (!confirm(`Replace everything here with the backup from ${new Date(payload.exportedAt).toLocaleString()}?`)) return;
    store.replaceAll({ ...payload.state, onboarded: true });
    await docs.clearDocs();
    for (const d of payload.docs || []) {
      const { data, ...meta } = d;
      const blob = await docs.dataUrlToBlob(data);
      await docs.addDoc(new File([blob], meta.name, { type: meta.type }), meta);
    }
    toast('Backup restored');
    render();
  } catch (err) {
    alert(`Couldn’t import that file: ${err.message}`);
  }
}

// ---------- boot ----------

const railFoot = document.getElementById('rail-foot');

function updateRailFoot() {
  const user = cloud.currentUser();
  if (!user) {
    railFoot.innerHTML = '<span class="lock" aria-hidden="true">●</span> Everything stays in this browser. Back it up from Setup.';
    return;
  }
  const status = store.getSync();
  const labels = {
    synced: 'Saved to your account',
    saving: 'Saving…',
    error: 'Offline. Saved on this device; will retry.',
    local: 'Not syncing',
  };
  railFoot.innerHTML = `
    <span class="sync"><span class="sync-dot sync-${status}" aria-hidden="true"></span>${labels[status] || ''}</span>
    <span class="acct">${h(user.email)}</span>
    <button class="link-btn" data-act="sign-out">Sign out</button>`;
}

store.onSync(updateRailFoot);

// Loads the signed-in person's workspace: cloud copy, unless this device has newer unsynced edits.
async function enterWorkspace(s) {
  session = s;
  if (enteredFor === s.user.id) return;
  enteredFor = s.user.id;
  store.open(`nextmove:v1:${s.user.id}`);
  docs.useCloud(cloud.cloudDocs);

  let remote = null;
  let reachable = true;
  try {
    remote = await cloud.pullWorkspace();
  } catch (err) {
    console.error(err);
    reachable = false;
    toast('Offline. Showing what’s saved on this device.');
  }
  const meta = store.getMeta();
  // Timestamps here all come from the server, so they're comparable across devices.
  const remoteChanged = remote && Date.parse(remote.updated_at) !== meta.remoteAt;
  const keepLocal =
    remote &&
    meta.dirty &&
    (!remoteChanged ||
      confirm('This device has changes that didn’t finish syncing, and your account was also changed somewhere else. Keep this device’s version? (Cancel uses the account’s version.)'));
  if (remote && !keepLocal) {
    store.replaceAll(remote.data, { push: false });
    store.markClean(remote.updated_at);
  } else if (!remote && reachable && !store.hasContent(store.get())) {
    // First sign-in: offer to bring over anything from local-only use of this browser
    const legacy = store.readKey(store.LEGACY_KEY);
    if (store.hasContent(legacy) && confirm('This browser has Next Move data from before you signed in. Move it into your account?')) {
      store.replaceAll(legacy);
      const localDocs = await localFiles.listDocs();
      for (const d of localDocs) {
        const { blob, ...meta2 } = d;
        await cloud.cloudDocs.add(new File([blob], d.name, { type: d.type }), meta2).catch(console.error);
      }
    }
  }
  store.setRemote(cloud.pushWorkspace);
  if (store.getMeta().dirty) store.pushNow();
  updateRailFoot();

  const back = localStorage.getItem(RETURN_KEY);
  if (back) {
    localStorage.removeItem(RETURN_KEY);
    history.replaceState(null, '', back);
  }
}

function leaveWorkspace() {
  session = null;
  enteredFor = null;
  store.setRemote(null);
  store.open(store.LEGACY_KEY);
  docs.useLocal();
  closeDrawer(false);
  updateRailFoot();
}

// Pick up changes made on another device when this tab comes back into view.
async function refreshFromCloud() {
  if (!session || openJobId || store.getMeta().dirty) return;
  try {
    const stamp = await cloud.workspaceStamp();
    if (!stamp || Date.parse(stamp) <= store.getMeta().remoteAt) return;
    const remote = await cloud.pullWorkspace();
    store.replaceAll(remote.data, { push: false });
    store.markClean(remote.updated_at);
    if (!document.activeElement?.matches('input, textarea, select')) render();
  } catch (err) {
    console.error(err);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshFromCloud();
  else if (store.getMeta().dirty) store.pushNow();
});
// Switching back from another app on desktop doesn't change visibility, but it does focus the window
window.addEventListener('focus', refreshFromCloud);

async function boot() {
  if (cloud.cloudEnabled) {
    view.innerHTML = '<p class="boot muted">Loading…</p>';
    const hashParams = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
    const linkError = hashParams.get('error_description');
    try {
      const s = await cloud.init();
      if (s) await enterWorkspace(s);
    } catch (err) {
      console.error(err);
      login.error = 'Couldn’t reach the sign-in service. Check your connection and reload.';
    }
    if (linkError) login.error = /expired|invalid/i.test(linkError) ? 'That sign-in link expired. Enter your email for a new code.' : linkError;
    // Email links put auth tokens in the hash; clear them so they don't linger in history
    if (/access_token|error_description|refresh_token/.test(location.hash)) history.replaceState(null, '', '#/brief');
    cloud.onAuthChange((event, s) => {
      // Defer: Supabase calls made inside this callback can deadlock the client
      setTimeout(async () => {
        if (event === 'SIGNED_OUT') {
          leaveWorkspace();
          render();
        } else if (s && enteredFor !== s.user.id) {
          await enterWorkspace(s);
          render();
        } else if (s) {
          session = s;
        }
      }, 0);
    });
  }
  booted = true;
  if (!location.hash) history.replaceState(null, '', '#/brief');
  updateRailFoot();
  render();
}

boot();
