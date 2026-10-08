// Supabase accounts, workspace sync, and file storage.
// Loaded only when js/config.js has a project URL and key. Otherwise the app stays local-only.

import { SUPABASE_URL, SUPABASE_ANON_KEY, INVITE_CONTACT } from './config.js';

export const cloudEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const BUCKET = 'documents';

let sb = null;
let user = null;

export function appUrl() {
  return `${location.origin}${location.pathname}`;
}

// Starts the client. If the page was opened from an email link, the SDK reads the tokens from the URL.
export async function init() {
  const { createClient } = await import(SDK);
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true, storageKey: 'nextmove-auth' },
  });
  const { data } = await sb.auth.getSession();
  user = data.session?.user ?? null;
  return data.session;
}

export function onAuthChange(fn) {
  sb.auth.onAuthStateChange((event, session) => {
    user = session?.user ?? null;
    fn(event, session);
  });
}

export function currentUser() {
  return user;
}

function friendly(error) {
  const msg = error?.message || String(error);
  if (/signups? not allowed|not allowed for otp|user not found/i.test(msg)) {
    return new Error(`That email isn’t set up yet. If you got an invite email, tap its link first. Otherwise ask ${INVITE_CONTACT} for an invite.`);
  }
  if (/expired|invalid/i.test(msg)) return new Error('That code is wrong or expired. Request a new one.');
  if (/rate limit|too many/i.test(msg)) return new Error('Too many tries. Wait a minute and try again.');
  return new Error(msg);
}

export async function sendCode(email) {
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: appUrl() },
  });
  if (error) throw friendly(error);
}

export async function verifyCode(email, token) {
  const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw friendly(error);
  user = data.session?.user ?? user;
  return data.session;
}

export async function signOut() {
  await sb.auth.signOut();
  user = null;
}

// ---------- workspace (the whole app state as one JSON row) ----------

export async function pullWorkspace() {
  const { data, error } = await sb.from('workspaces').select('data, updated_at').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function workspaceStamp() {
  const { data, error } = await sb.from('workspaces').select('updated_at').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  return data?.updated_at ?? null;
}

// Returns the server's timestamp for this save (set by a database trigger).
export async function pushWorkspace(state) {
  const { data, error } = await sb.from('workspaces').upsert({ user_id: user.id, data: state }).select('updated_at').single();
  if (error) throw error;
  return data.updated_at;
}

// ---------- documents (metadata row + private storage object) ----------

const path = (id) => `${user.id}/${id}`;

function toMeta(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    size: Number(row.size),
    kind: row.kind,
    label: row.label,
    addedAt: Date.parse(row.added_at),
  };
}

export const cloudDocs = {
  async list() {
    const { data, error } = await sb.from('documents').select('*').order('added_at', { ascending: false });
    if (error) throw error;
    return data.map(toMeta);
  },
  async add(file, meta) {
    const up = await sb.storage.from(BUCKET).upload(path(meta.id), file, {
      contentType: file.type || 'application/octet-stream',
      upsert: true,
    });
    if (up.error) throw up.error;
    const { error } = await sb.from('documents').insert({
      id: meta.id,
      name: meta.name,
      type: meta.type || '',
      size: meta.size || 0,
      kind: meta.kind,
      label: meta.label,
      added_at: new Date(meta.addedAt || Date.now()).toISOString(),
    });
    if (error) throw error;
  },
  async update(id, patch) {
    const row = {};
    if ('label' in patch) row.label = patch.label;
    if ('kind' in patch) row.kind = patch.kind;
    const { error } = await sb.from('documents').update(row).eq('id', id);
    if (error) throw error;
  },
  async blob(id) {
    const { data, error } = await sb.storage.from(BUCKET).download(path(id));
    if (error) throw error;
    return data;
  },
  async remove(id) {
    await sb.storage.from(BUCKET).remove([path(id)]);
    const { error } = await sb.from('documents').delete().eq('id', id);
    if (error) throw error;
  },
  async clear() {
    const all = await this.list();
    if (all.length) await sb.storage.from(BUCKET).remove(all.map((d) => path(d.id)));
    const { error } = await sb.from('documents').delete().eq('user_id', user.id);
    if (error) throw error;
  },
};
