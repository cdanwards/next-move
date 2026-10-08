// Uploaded documents live in IndexedDB so large files don't blow the localStorage quota.
// Each record: { id, name, type, size, kind, label, addedAt, blob }

const DB_NAME = 'nextmove-docs';
const STORE = 'docs';

let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export async function listDocs() {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => b.addedAt - a.addedAt);
  } catch (err) {
    console.error(err);
    return [];
  }
}

export function putDoc(doc) {
  return tx('readwrite', (s) => s.put(doc));
}

export async function getDoc(id) {
  return tx('readonly', (s) => s.get(id));
}

export function deleteDoc(id) {
  return tx('readwrite', (s) => s.delete(id));
}

export function clearDocs() {
  return tx('readwrite', (s) => s.clear());
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

export function guessKind(name) {
  const n = name.toLowerCase();
  if (/resume|cv\b/.test(n)) return 'Resume';
  if (/cover/.test(n)) return 'Cover letter';
  if (/portfolio|deck|case/.test(n)) return 'Portfolio';
  if (/reference/.test(n)) return 'References';
  if (/offer|comp|salary/.test(n)) return 'Offer / comp';
  return 'Other';
}

export function prettySize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
