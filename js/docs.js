// One API for uploaded files, whether they live in this browser (IndexedDB) or in the cloud.
// Everything here returns metadata only; use getBlob() for the bytes.

import * as local from './files.js';

export { guessKind, prettySize, blobToDataUrl, dataUrlToBlob } from './files.js';

let cloud = null;

export function useCloud(adapter) {
  cloud = adapter;
}

export function useLocal() {
  cloud = null;
}

export async function listDocs() {
  try {
    if (cloud) return await cloud.list();
    return (await local.listDocs()).map(({ blob, ...meta }) => meta);
  } catch (err) {
    console.error(err);
    return [];
  }
}

export async function addDoc(file, meta) {
  if (cloud) return cloud.add(file, meta);
  return local.putDoc({ ...meta, blob: file });
}

export async function updateDoc(id, patch) {
  if (cloud) return cloud.update(id, patch);
  const doc = await local.getDoc(id);
  if (doc) await local.putDoc({ ...doc, ...patch });
}

export async function getBlob(id) {
  if (cloud) return cloud.blob(id);
  return (await local.getDoc(id))?.blob ?? null;
}

export async function deleteDoc(id) {
  if (cloud) return cloud.remove(id);
  return local.deleteDoc(id);
}

export async function clearDocs() {
  if (cloud) return cloud.clear();
  return local.clearDocs();
}
