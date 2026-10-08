// App state. It's cached in localStorage so the app works offline and loads instantly.
// In cloud mode the same state is also pushed to the person's Supabase workspace (see app.js boot).
// Uploaded files are handled separately (see docs.js).

export const LEGACY_KEY = 'nextmove:v1';

export const STAGES = [
  { id: 'spotted', label: 'Spotted', hint: 'Caught my eye' },
  { id: 'interested', label: 'Worth a shot', hint: 'Researching / tailoring' },
  { id: 'applied', label: 'Applied', hint: 'Ball is in their court' },
  { id: 'interviewing', label: 'Talking', hint: 'Screens & interviews' },
  { id: 'offer', label: 'Offer', hint: 'Get it in writing' },
  { id: 'closed', label: 'Closed', hint: 'Passed, declined, or ghosted' },
];

export const ENTRY_KINDS = [
  { id: 'thought', label: 'Thought' },
  { id: 'win', label: 'Win' },
  { id: 'prep', label: 'Interview prep' },
  { id: 'idea', label: 'Idea' },
];

export const DOC_KINDS = ['Resume', 'Cover letter', 'Portfolio', 'References', 'Offer / comp', 'Other'];

const DEFAULT_CRITERIA = [
  { id: 'direct', label: 'Direct hire', hint: 'The company itself. Not an agency, not a staffing contract.', weight: 3 },
  { id: 'pay', label: 'Pay clears my floor', hint: 'Base salary at or above my floor, before bonus.', weight: 3 },
  { id: 'place', label: 'No move, or a move worth it', hint: 'Remote, local, or a relocation package that makes sense.', weight: 2 },
  { id: 'build', label: 'I get to build things', hint: 'Real ownership: launch it, build it, improve it.', weight: 2 },
  { id: 'valued', label: "They'd actually value me", hint: 'Engaged manager, clear comp bands, people like me get promoted.', weight: 3 },
  { id: 'growth', label: 'Room to grow', hint: 'A next title exists and someone has gotten it.', weight: 2 },
  { id: 'new', label: 'Something new to learn', hint: 'A new industry or skill that keeps it interesting.', weight: 1 },
];

const DEFAULT_SNIPPETS = [
  {
    id: 'pitch',
    title: '30-second pitch',
    body: "I'm a [role] with [X] years in [industries]. My strength is [what you're known for]: I [how you work]. Most recently I [one result with a number].",
  },
  {
    id: 'why-looking',
    title: '"Why are you looking?"',
    body: "I've built a lot in my current role and I'm proud of it. I'm looking for a place where [your kind of work] is closer to the center of the business, where I can own [what you want to own] and grow with a team that invests in it.",
  },
  {
    id: 'outreach',
    title: 'Note to a hiring manager',
    body: "Hi [Name], I saw the [Role] opening at [Company]. I've spent [X years] [doing the thing], including [one result]. I'd love 15 minutes to hear what you need most from this role. Thanks!",
  },
];

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function defaults() {
  return {
    version: 1,
    onboarded: false,
    profile: {
      name: '',
      location: '',
      relocation: 'last-resort',
      salaryFloor: '',
      salaryTarget: '',
      yearsExperience: '',
      titles: [],
      keywords: [],
      mustHaves: '',
      dealbreakers: '',
    },
    criteria: DEFAULT_CRITERIA.map((c) => ({ ...c })),
    jobs: [],
    companies: [],
    entries: [],
    snippets: DEFAULT_SNIPPETS.map((s) => ({ ...s })),
    search: { posted: 'week', remote: false, noAgency: true },
  };
}

// Saved data wins, but nested settings objects pick up fields added in newer versions.
// Data saved before the first-run flag existed counts as already set up.
function merge(base, saved) {
  return {
    ...base,
    ...saved,
    onboarded: saved.onboarded ?? true,
    profile: { ...base.profile, ...saved.profile },
    search: { ...base.search, ...saved.search },
  };
}

export function hasContent(s) {
  return Boolean(s && (s.onboarded || s.jobs?.length || s.entries?.length));
}

// ---------- persistence ----------

let key = LEGACY_KEY;
let state = load();
const listeners = new Set();

// Sync bookkeeping, stored next to the cached state:
// dirty = local changes not yet confirmed by the cloud; remoteAt = cloud timestamp last seen.
let meta = readMeta();
let remote = null;
let pushTimer = null;
let syncStatus = 'local';
const syncListeners = new Set();

export function readKey(k) {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function load() {
  const saved = readKey(key);
  return saved ? merge(defaults(), saved) : defaults();
}

function readMeta() {
  return readKey(`${key}:meta`) || { dirty: false, savedAt: 0, remoteAt: 0 };
}

function writeMeta() {
  try {
    localStorage.setItem(`${key}:meta`, JSON.stringify(meta));
  } catch {}
}

// Switch to a different cache, e.g. one per signed-in account.
export function open(nextKey) {
  key = nextKey;
  state = load();
  meta = readMeta();
}

export function getMeta() {
  return meta;
}

export function get() {
  return state;
}

function setSync(status) {
  syncStatus = status;
  syncListeners.forEach((fn) => fn(status));
}

export function getSync() {
  return syncStatus;
}

export function onSync(fn) {
  syncListeners.add(fn);
}

// remote: async (state) => cloudTimestampIso. Pass null to go local-only.
export function setRemote(fn) {
  remote = fn;
  clearTimeout(pushTimer);
  setSync(fn ? (meta.dirty ? 'saving' : 'synced') : 'local');
}

function schedulePush(delay = 1200) {
  if (!remote) return;
  setSync('saving');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, delay);
}

export async function pushNow() {
  if (!remote) return;
  clearTimeout(pushTimer);
  const pushedAt = meta.savedAt;
  try {
    const stamp = await remote(state);
    meta.remoteAt = Date.parse(stamp);
    // Only clean if nothing changed while the request was in flight
    if (meta.savedAt === pushedAt) meta.dirty = false;
    writeMeta();
    setSync(meta.dirty ? 'saving' : 'synced');
    if (meta.dirty) schedulePush();
  } catch (err) {
    console.error('Sync failed', err);
    setSync('error');
    pushTimer = setTimeout(pushNow, 15000);
  }
}

export function markClean(remoteIso) {
  meta.dirty = false;
  meta.remoteAt = Date.parse(remoteIso);
  writeMeta();
  setSync(remote ? 'synced' : 'local');
}

export function save({ push = true } = {}) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch (err) {
    console.error('Could not save', err);
  }
  if (push) {
    meta.dirty = true;
    meta.savedAt = Date.now();
    writeMeta();
    schedulePush();
  }
  listeners.forEach((fn) => fn(state));
}

export function update(mutator) {
  mutator(state);
  save();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function replaceAll(next, { push = true } = {}) {
  state = merge(defaults(), next);
  save({ push });
}

export function resetAll() {
  state = defaults();
  save();
}

// ---------- jobs ----------

export function addJob(fields = {}) {
  const now = Date.now();
  const job = {
    id: uid(),
    title: '',
    company: '',
    url: '',
    location: '',
    workMode: '',
    salaryMin: '',
    salaryMax: '',
    source: '',
    stage: 'spotted',
    nextStep: '',
    nextDate: '',
    ratings: {},
    notes: '',
    description: '',
    contacts: '',
    docIds: [],
    from: '',
    parsed: null,
    log: [{ at: now, text: 'Added' }],
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
  update((s) => s.jobs.unshift(job));
  return job;
}

export function patchJob(id, patch) {
  update((s) => {
    const job = s.jobs.find((j) => j.id === id);
    if (!job) return;
    if (patch.stage && patch.stage !== job.stage) {
      const label = STAGES.find((st) => st.id === patch.stage)?.label ?? patch.stage;
      job.log.push({ at: Date.now(), text: `Moved to ${label}` });
    }
    Object.assign(job, patch, { updatedAt: Date.now() });
  });
}

export function removeJob(id) {
  update((s) => {
    s.jobs = s.jobs.filter((j) => j.id !== id);
  });
}

export function fitScore(job, criteria = state.criteria) {
  let got = 0;
  let max = 0;
  for (const c of criteria) {
    const r = job.ratings?.[c.id];
    if (r === undefined || r === null || r === '') continue;
    got += Number(r) * c.weight;
    max += 2 * c.weight;
  }
  if (!max) return null;
  return Math.round((got / max) * 100);
}

export function ratedCount(job) {
  return state.criteria.filter((c) => job.ratings?.[c.id] !== undefined && job.ratings?.[c.id] !== null).length;
}
