// translate.js — translation engine + the list of languages the app offers.
//
// Engine: MyMemory (https://mymemory.translated.net) — free, no API key, works
// straight from the browser. Fair-use limit is ~5,000 characters/day per network,
// or ~50,000/day if an email address is supplied. To switch engines later
// (DeepL, Google, …) replace `providerTranslate` below; nothing else needs to change.

export class TranslationError extends Error {
  constructor(message, code = 'failed') {
    super(message);
    this.name = 'TranslationError';
    this.code = code; // 'offline' | 'quota' | 'failed'
  }
}

export const LANGUAGES = [
  ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'],
  ['pt', 'Português'], ['pt-BR', 'Português (Brasil)'], ['nl', 'Nederlands'], ['sv', 'Svenska'],
  ['da', 'Dansk'], ['no', 'Norsk'], ['fi', 'Suomi'], ['pl', 'Polski'], ['cs', 'Čeština'],
  ['sk', 'Slovenčina'], ['hu', 'Magyar'], ['ro', 'Română'], ['bg', 'Български'], ['hr', 'Hrvatski'],
  ['sr', 'Српски'], ['sl', 'Slovenščina'], ['uk', 'Українська'], ['ru', 'Русский'], ['el', 'Ελληνικά'],
  ['tr', 'Türkçe'], ['ar', 'العربية'], ['he', 'עברית'], ['fa', 'فارسی'], ['hi', 'हिन्दी'],
  ['bn', 'বাংলা'], ['ur', 'اردو'], ['ta', 'தமிழ்'], ['te', 'తెలుగు'], ['th', 'ไทย'],
  ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'], ['tl', 'Filipino'],
  ['ja', '日本語'], ['ko', '한국어'], ['zh-CN', '中文（简体）'], ['zh-TW', '中文（繁體）'], ['sw', 'Kiswahili'],
].map(([code, name]) => ({ code, name }));

export function languageName(code) {
  return (LANGUAGES.find((l) => l.code === code) || { name: code }).name;
}

/** Best guess at the user's language from the phone's settings. */
export function guessLanguage() {
  const nav = (navigator.language || 'en').toLowerCase();
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === nav);
  if (exact) return exact.code;
  if (nav.startsWith('zh')) return /tw|hk|hant/.test(nav) ? 'zh-TW' : 'zh-CN';
  if (nav.startsWith('pt-br')) return 'pt-BR';
  const base = nav.split('-')[0];
  return (LANGUAGES.find((l) => l.code.toLowerCase() === base) || { code: 'en' }).code;
}

// ---------- Cache (so the same message is never translated twice) ----------

const CACHE_KEY = 'chat.txcache';
const CACHE_MAX = 600;
let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    cache = new Map(Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')));
  } catch {
    cache = new Map();
  }
  return cache;
}

function saveCache() {
  try {
    const m = loadCache();
    while (m.size > CACHE_MAX) m.delete(m.keys().next().value); // drop oldest
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch { /* storage full or unavailable — cache is a nicety, not a need */ }
}

const keyFor = (text, from, to) => `${from}|${to}|${text}`;

export function getCached(text, from, to) {
  return loadCache().get(keyFor(text.trim(), from, to)) || null;
}

// ---------- Public API ----------

/**
 * Translate `text` from language `from` to language `to`.
 * Resolves to the translated string; rejects with a TranslationError.
 */
export async function translate(text, from, to, { email } = {}) {
  const clean = text.trim();
  if (!clean || !from || !to || from === to) return text;

  const cached = getCached(clean, from, to);
  if (cached) return cached;

  const parts = [];
  for (const chunk of chunkText(clean)) {
    parts.push(await providerTranslate(chunk, from, to, email));
  }
  const result = parts.join(' ').trim();
  if (!result) throw new TranslationError('Empty translation', 'failed');

  loadCache().set(keyFor(clean, from, to), result);
  saveCache();
  return result;
}

// ---------- MyMemory provider ----------

const MAX_BYTES = 480; // MyMemory accepts up to 500 bytes per request
const byteLength = (s) => new TextEncoder().encode(s).length;

/** Split long text into sentence-ish chunks that fit the provider's size limit. */
function chunkText(text) {
  if (byteLength(text) <= MAX_BYTES) return [text];
  // (No regex lookbehind here — it would make the whole module fail to load on iPhones before iOS 16.4.)
  const sentences = (text.match(/[^.!?。！？؟\n]+[.!?。！？؟]*\s*|[.!?。！？؟]+\s*/g) || [text]).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (let s of sentences) {
    // A single sentence that is too long gets split on spaces.
    while (byteLength(s) > MAX_BYTES) {
      if (current) { chunks.push(current); current = ''; } // flush first, so sentences stay in order
      const words = s.split(' ');
      let piece = '';
      while (words.length && byteLength(piece + ' ' + words[0]) <= MAX_BYTES) {
        piece += (piece ? ' ' : '') + words.shift();
      }
      if (!piece) piece = words.shift(); // one enormous "word" — send it anyway
      chunks.push(piece);
      s = words.join(' ');
    }
    if (!s) continue;
    if (current && byteLength(current + ' ' + s) > MAX_BYTES) {
      chunks.push(current);
      current = s;
    } else {
      current = current ? current + ' ' + s : s;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function providerTranslate(text, from, to, email) {
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', `${from}|${to}`);
  if (email) url.searchParams.set('de', email);

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new TranslationError('No internet connection', 'offline');
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new TranslationError('Bad response from the translator', 'failed');
  }

  const status = Number(data.responseStatus);
  const translated = data.responseData && data.responseData.translatedText;
  const details = String(data.responseDetails || translated || '');
  if (status === 429 || data.quotaFinished === true || /USED ALL AVAILABLE FREE TRANSLATIONS/i.test(details)) {
    throw new TranslationError('Daily free translation limit reached', 'quota');
  }
  if (status !== 200 || !translated) {
    throw new TranslationError(data.responseDetails || 'Translation failed', 'failed');
  }
  return pickBest(text, translated, Array.isArray(data.matches) ? data.matches : []);
}

/**
 * MyMemory's top answer is sometimes a fragment from its crowd-sourced memory ("¿Dónde está el
 * baño?" → "The bathroom?"). Among the near-tied candidates it returns, prefer its machine
 * translation, then the one whose length is closest to the original's.
 */
function pickBest(source, fallback, matches) {
  let usable = matches
    .filter((m) => typeof m.translation === 'string' && m.translation.trim() && Number.isFinite(Number(m.match)))
    .map((m) => ({ text: m.translation.trim(), score: Number(m.match), mt: /^MT!?$/i.test(String(m['created-by'] || '')) }));
  // A memory entry that just echoes the source is no translation at all.
  const echo = source.trim().toLowerCase();
  const real = usable.filter((m) => m.text.toLowerCase() !== echo);
  if (real.length) usable = real;
  if (!usable.length) return fallback;
  const top = Math.max(...usable.map((m) => m.score));
  const tied = usable.filter((m) => m.score >= top - 0.05);
  const mt = tied.find((m) => m.mt);
  if (mt) return mt.text;
  const closeness = (t) => { const r = t.length / Math.max(1, source.length); return Math.min(r, 1 / r); };
  return tied.reduce((best, m) => (closeness(m.text) > closeness(best.text) ? m : best)).text;
}
