// voice.js — "speak in my own voice".
//
// Recording a sample creates a cloned voice at ElevenLabs (through your own Worker, which holds
// the API key). After that, a translation of something you said is played back in your voice
// instead of the phone's robot voice.
//
// Everything here degrades quietly: with no Worker configured, or no cloned voice, or no network,
// the caller falls back to the phone's built-in speech.

import { voiceWorkerUrl } from './voice-config.js';

const DB_NAME = 'chat-voice';
const STORE = 'clips';
const MAX_CACHE = 300;
const SPEAK_TIMEOUT_MS = 15_000;

/** Is voice cloning switched on for this install? */
export const cloningAvailable = () => !!(voiceWorkerUrl && /^https?:\/\//.test(voiceWorkerUrl));

const endpoint = (path) => voiceWorkerUrl.replace(/\/+$/, '') + path;

// ---------- Cache (so a phrase you repeat is never paid for twice) ----------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('at', 'at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

const cacheKey = (voiceId, text) => `${voiceId}|${text.trim()}`;

async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function cachePut(key, blob) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, blob, at: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
    trimCache();
  } catch { /* the cache is a nicety, not a need */ }
}

async function trimCache() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const count = await new Promise((r) => { const q = store.count(); q.onsuccess = () => r(q.result); q.onerror = () => r(0); });
    if (count <= MAX_CACHE) return;
    let toDrop = count - MAX_CACHE;
    const cursorReq = store.index('at').openCursor(); // oldest first
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || toDrop <= 0) return;
      cursor.delete();
      toDrop--;
      cursor.continue();
    };
  } catch { /* ignore */ }
}

/** Forget every cached clip for a voice — used when a voice is re-recorded or removed. */
export async function clearCachedVoice(voiceId) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (!voiceId || String(cursor.value.key).startsWith(voiceId + '|')) cursor.delete();
      cursor.continue();
    };
  } catch { /* ignore */ }
}

// ---------- Playing ----------

let audioEl = null;
let unlocked = false;

/** Phones only play audio a person asked for. Call this from a tap, once. */
export function primeAudio() {
  if (unlocked) return;
  unlocked = true;
  try {
    audioEl = new Audio();
    audioEl.preload = 'auto';
    // A moment of silence, played during the tap, is what buys us playback later.
    audioEl.src = 'data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////////////////////////////////////////////////////////////8AAAA8TEFNRTMuMTAwAc0AAAAAAAAAABSAJAJAQgAAgAAAAnGMHkkIAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
    audioEl.volume = 0;
    const p = audioEl.play();
    if (p && p.catch) p.catch(() => {});
  } catch { /* ignore */ }
}

function playBlob(blob) {
  return new Promise((resolve) => {
    let url = null;
    try {
      url = URL.createObjectURL(blob);
      const el = audioEl || new Audio();
      audioEl = el;
      el.volume = 1;
      el.src = url;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (url) URL.revokeObjectURL(url);
        resolve(ok);
      };
      el.onended = () => finish(true);
      el.onerror = () => finish(false);
      const timer = setTimeout(() => finish(true), SPEAK_TIMEOUT_MS + 15_000);
      const p = el.play();
      if (p && p.catch) p.catch(() => finish(false));
    } catch {
      if (url) URL.revokeObjectURL(url);
      resolve(false);
    }
  });
}

/** Stop whatever is currently being spoken in a cloned voice. */
export function stopCloned() {
  try {
    if (audioEl) { audioEl.pause(); audioEl.currentTime = 0; }
  } catch { /* ignore */ }
}

/**
 * Speak `text` in the cloned voice `voiceId`.
 * Resolves true if it actually played; false means the caller should fall back to the phone's voice.
 */
export async function speakCloned(text, voiceId, getToken) {
  if (!cloningAvailable() || !voiceId || !text || !text.trim()) return false;
  const key = cacheKey(voiceId, text);
  const cached = await cacheGet(key);
  if (cached) return playBlob(cached);

  let token;
  try {
    token = await getToken();
  } catch {
    return false;
  }
  if (!token) return false;

  let res;
  try {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), SPEAK_TIMEOUT_MS);
    res = await fetch(endpoint('/voice/speak'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: text.trim(), voiceId }),
      signal: controller.signal,
    });
    clearTimeout(abort);
  } catch {
    return false; // offline or the Worker is down — the phone's own voice takes over
  }
  if (!res.ok) return false;

  const blob = await res.blob();
  if (!blob || !blob.size) return false;
  cachePut(key, blob);
  return playBlob(blob);
}

// ---------- Recording a sample ----------

/** The best audio type this browser records in, and the file name ElevenLabs should see. */
function recordingType() {
  const candidates = [
    ['audio/webm;codecs=opus', 'sample.webm'],
    ['audio/webm', 'sample.webm'],
    ['audio/mp4', 'sample.m4a'],
    ['audio/ogg;codecs=opus', 'sample.ogg'],
  ];
  for (const [mime, name] of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mime)) {
      return { mime, name };
    }
  }
  return { mime: '', name: 'sample.webm' };
}

export const canRecord = () =>
  typeof MediaRecorder !== 'undefined' &&
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

/**
 * Record from the microphone until stop() is called.
 * Returns { stop() → Promise<Blob>, cancel(), mime, fileName }.
 */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const { mime, name } = recordingType();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start(1000);

  const closeStream = () => stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });

  return {
    mime,
    fileName: name,
    get state() { return rec.state; },
    stop() {
      return new Promise((resolve, reject) => {
        rec.onstop = () => {
          closeStream();
          const blob = new Blob(chunks, { type: mime || 'audio/webm' });
          if (!blob.size) reject(new Error('Nothing was recorded.'));
          else resolve(blob);
        };
        try { rec.stop(); } catch (e) { closeStream(); reject(e); }
      });
    },
    cancel() {
      try { rec.stop(); } catch { /* ignore */ }
      closeStream();
    },
  };
}

/** Send a recording off to be cloned. Resolves to the new voice id. */
export async function cloneVoice({ blob, fileName, name, getToken }) {
  if (!cloningAvailable()) throw new Error('Voice cloning isn’t set up for this app yet.');
  const token = await getToken();
  if (!token) throw new Error('Not signed in.');

  const form = new FormData();
  form.append('name', name || 'Chat voice');
  form.append('files', blob, fileName || 'sample.webm');

  let res;
  try {
    res = await fetch(endpoint('/voice/clone'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    throw new Error('Couldn’t reach the voice service. Check your connection and try again.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* fall through to the error below */ }
  if (!res.ok || !data.voice_id) {
    throw new Error(friendlyCloneError(res.status, data));
  }
  return data.voice_id;
}

function friendlyCloneError(status, data) {
  const detail = String((data && data.detail) || '');
  if (status === 401) return 'The app isn’t signed in. Close and reopen it, then try again.';
  if (status === 500 && data.error === 'worker_not_configured') {
    return 'The voice service is missing its key (see worker/README.md, step 3).';
  }
  if (/quota|limit|exceed/i.test(detail)) return 'Your ElevenLabs plan is out of credit for this month.';
  if (/subscription|tier|plan/i.test(detail)) return 'Voice cloning needs a paid ElevenLabs plan (Starter or above).';
  if (/too short|duration|length/i.test(detail)) return 'That recording was too short — try again and read for a full minute.';
  if (status === 413) return 'That recording was too long. Keep it to a minute or two.';
  return 'Couldn’t create the voice. Please try recording again.';
}
