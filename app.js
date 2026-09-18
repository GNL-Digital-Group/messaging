// app.js — Chat with Gregorio: a private two-person chat that translates every
// message into each person's own language. No build step; runs from GitHub Pages.
//
// How it works
//   • There is exactly one chat. The first two phones to open the app take its two
//     places — side "a" and side "b" — and nobody else can read or write it
//     (enforced by firestore.rules). No passcodes, no accounts: each phone gets an
//     anonymous Firebase identity, and a side stays yours even after a phone swap.
//   • Each message is stored with its original text + language. The sender also
//     stores a translation into the partner's language, so it lands ready to read.
//     If that's missing (e.g. you changed language), the receiver translates on the
//     fly and caches it locally. Imported history is translated only when tapped.
//   • `?demo=1` runs everything in memory with a robot partner — no Firebase needed.

import { translate, getCached, TranslationError, LANGUAGES, languageName, guessLanguage } from './translate.js';
import { readExport, ImportError, ME } from './import.js';
import { canListen, createRecognizer, listenErrorText } from './speech.js';
import { initTalk } from './talk.js';
import { cloningAvailable, canRecord, startRecording, cloneVoice, clearCachedVoice } from './voice.js';
import { firebaseConfig } from './firebase-config.js';

const APP_NAME = 'Chat with Gregorio';
const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/12.19.0';
const ROOM_ID = 'main';
const SIDES = ['a', 'b'];
const MESSAGE_LIMIT = 300;
const MAX_TEXT = 2000;
const ONLINE_WINDOW_MS = 2.5 * 60_000;
const WRITE_TIMEOUT_MS = 10_000;

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  demo: false,
  profile: null,        // { name, lang, email }
  uid: null,
  side: null,           // 'a' | 'b' — which of the two places this phone holds
  store: null,          // FirestoreStore | LocalStore
  seated: false,
  members: {},          // uid -> { name, lang, lastSeen, side }
  partner: null,        // { uid, name, lang, lastSeen, side }
  messages: [],         // the live window: newest MESSAGE_LIMIT messages, ascending
  older: [],            // pages loaded via "Show earlier messages", ascending
  olderExhausted: false,
  loadingOlder: false,
  pending: [],          // messages still being translated/sent
  showAlt: new Set(),   // message ids with the original/translation expanded
  txWanted: new Set(),  // imported message ids the user asked to translate
  txErrors: new Map(),  // message id -> TranslationError
  txInflight: new Set(),
  unsubs: [],
  seenIds: null,        // null until the first snapshot arrives
  forceScroll: false,
  unread: 0,
  heartbeat: null,
  // Import screen
  importFile: null,
  importParsed: null,
  importThread: null,
  importRoles: new Map(), // sender -> { role: 'me'|'partner'|'skip'|'', lang }
  importing: false,
  // Listen screen (in-person interpreter) and composer dictation
  listen: { langs: null }, // [mine, theirs] for the Talk screen (logic in talk.js)
  myVoiceId: null,      // my cloned voice at ElevenLabs, if I recorded one
  recorder: null,       // an in-progress voice recording
  recordTimer: null,
  dictation: null,
};

const screens = {
  config: $('#screen-config'),
  install: $('#screen-install'),
  setup: $('#screen-setup'),
  full: $('#screen-full'),
  import: $('#screen-import'),
  listen: $('#screen-listen'),
  chat: $('#screen-chat'),
};

// ---------- Local storage ----------

const profileKey = () => (state.demo ? 'chat.demo.profile' : 'chat.profile');
const SEATED_KEY = 'chat.seated';
const SIDE_KEY = 'chat.side';
const VOICE_KEY = 'chat.voiceId';

function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(profileKey()) || 'null');
    return p && p.name && p.lang ? p : null;
  } catch {
    return null;
  }
}

function saveProfile(p) {
  localStorage.setItem(profileKey(), JSON.stringify(p));
}

/** Whether this phone already holds a place — later opens skip the network checks so cached messages show offline. */
const wasSeated = () => !state.demo && localStorage.getItem(SEATED_KEY) === '1';
function rememberSeated(yes) {
  if (state.demo) return;
  if (yes) localStorage.setItem(SEATED_KEY, '1');
  else localStorage.removeItem(SEATED_KEY);
}

function rememberSide(side) {
  state.side = side;
  if (!state.demo && side) localStorage.setItem(SIDE_KEY, side);
}

function isConfigured() {
  const c = firebaseConfig || {};
  return ['apiKey', 'projectId', 'appId'].every((k) => typeof c[k] === 'string' && c[k] && !/^PASTE/i.test(c[k]));
}

const otherSide = (side) => (side === 'a' ? 'b' : 'a');

function seatDoc(side) {
  const seat = { name: state.profile.name, lang: state.profile.lang, lastSeen: Date.now(), side };
  if (state.myVoiceId) seat.voiceId = state.myVoiceId;
  return seat;
}

/** Proves to my own voice Worker that this really is one of our phones. */
async function getIdToken() {
  if (!firebase) return null;
  const user = firebase.auth.getAuth(firebase.app).currentUser;
  return user ? user.getIdToken() : null;
}

/** Whose voice should speak language `index` on the Talk screen: 0 = me, 1 = my partner. */
function voiceIdFor(index) {
  if (index === 0) return state.myVoiceId || null;
  return (state.partner && state.partner.voiceId) || null;
}

const isPermissionDenied = (e) => /permission-denied/.test(String((e && e.code) || ''));

/** iOS keeps a Safari tab and a Home Screen web app in separate storage, so they'd count as two phones. */
const isIosBrowserTab = () => 'standalone' in navigator && navigator.standalone === false;

/** requestSubmit() is missing on older iPhones; fall back to a plain submit event. */
function submitForm(form) {
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

/** Firestore writes wait forever while offline; give the UI something to say instead. */
function withTimeout(promise, ms = WRITE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms)),
  ]);
}

async function sha(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Stores ----------

let firebase = null; // { fs, auth, app, db } — the SDK may only be initialised once per page, but sign-in can be retried
let libAttempt = 0;  // browsers remember a failed import(); a fresh URL makes the retry real (e.g. after an offline first open)
const lib = (name) => `${FIREBASE_CDN}/${name}${libAttempt ? `?retry=${libAttempt}` : ''}`;

class FirestoreStore {
  static async connect() {
    if (!firebase) {
      let mods;
      try {
        mods = await Promise.all([import(lib('firebase-app.js')), import(lib('firebase-auth.js')), import(lib('firebase-firestore.js'))]);
      } catch (e) {
        libAttempt++;
        throw e;
      }
      const [{ initializeApp }, auth, fs] = mods;
      const app = initializeApp(firebaseConfig);
      const db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache() });
      firebase = { fs, auth, app, db };
    }
    const { fs, auth, app, db } = firebase;
    // Returns the same anonymous user on every open of this phone (it is remembered locally).
    const cred = await auth.signInAnonymously(auth.getAuth(app));
    return new FirestoreStore(fs, db, cred.user.uid);
  }

  constructor(fs, db, uid) {
    this.fs = fs;
    this.db = db;
    this.uid = uid;
    this.roomRef = fs.doc(db, 'rooms', ROOM_ID);
    this.messagesRef = fs.collection(db, 'rooms', ROOM_ID, 'messages');
  }

  /** Succeeds only once the security rules from the README are published. */
  probe() {
    return this.fs.getDoc(this.fs.doc(this.db, 'meta', 'setup'));
  }

  /** Take a free place on this side. Rejects with permission-denied if we can't. */
  claimSeat(seat) {
    return this.fs.setDoc(this.roomRef, { members: { [this.uid]: seat } }, { merge: true });
  }

  /**
   * Update fields of our existing place. Unlike claimSeat this can't take a place back after
   * the other phone disconnected us — the rules refuse a seat that ends up incomplete.
   */
  refreshSeat(fields) {
    const args = [];
    for (const [key, value] of Object.entries(fields)) args.push(new this.fs.FieldPath('members', this.uid, key), value);
    return this.fs.updateDoc(this.roomRef, ...args);
  }

  freeSeat(uid) {
    return this.fs.updateDoc(this.roomRef, new this.fs.FieldPath('members', uid), this.fs.deleteField());
  }

  onRoom(onData, onError) {
    return this.fs.onSnapshot(this.roomRef, (snap) => onData(snap.data() || {}), onError);
  }

  onMessages(onData, onError) {
    const { query, orderBy, limit, onSnapshot } = this.fs;
    const q = query(this.messagesRef, orderBy('clientTs', 'desc'), limit(MESSAGE_LIMIT));
    return onSnapshot(q, (snap) => {
      onData(snap.docs.map((d) => ({ id: d.id, pendingWrite: d.metadata.hasPendingWrites, ...d.data() })).reverse());
    }, onError);
  }

  /** One page of messages older than `beforeTs`, ascending. */
  async loadOlder(beforeTs, n) {
    const { query, orderBy, limit, startAfter, getDocs } = this.fs;
    const snap = await getDocs(query(this.messagesRef, orderBy('clientTs', 'desc'), startAfter(beforeTs), limit(n)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
  }

  sendMessage(msg) {
    return this.fs.addDoc(this.messagesRef, { ...msg, createdAt: this.fs.serverTimestamp() });
  }

  /** Remove everything a (test) device posted — offered after disconnecting it. */
  async deleteMessagesFrom(uid) {
    const { query, where, getDocs, deleteDoc } = this.fs;
    const snap = await getDocs(query(this.messagesRef, where('uid', '==', uid)));
    let next = 0;
    const worker = async () => {
      while (next < snap.docs.length) await deleteDoc(snap.docs[next++].ref);
    };
    await Promise.all(Array.from({ length: Math.min(16, snap.docs.length) }, worker));
    return snap.docs.length;
  }

  /**
   * Write imported messages one by one (a batch would exceed the rules' lookup budget),
   * a few at a time. Ids are deterministic, so importing the same file twice is harmless.
   */
  async importMessages(items, onProgress) {
    const { doc, setDoc, serverTimestamp } = this.fs;
    let next = 0;
    let done = 0;
    let failed = 0;
    const worker = async () => {
      while (next < items.length) {
        const item = items[next++];
        try {
          await setDoc(doc(this.messagesRef, item.id), { ...item.data, createdAt: serverTimestamp() });
        } catch (e) {
          if (!isPermissionDenied(e)) throw e;
          failed++; // already imported by the other phone — leave theirs alone
        }
        done++;
        onProgress(done, items.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, items.length) }, worker));
    return { written: done - failed, failed };
  }
}

const BOT_LINES = {
  es: ['¡Hola! Escríbeme algo y te contesto en español.', '¡Qué bien! ¿Cómo va tu día?', 'Perfecto, nos vemos a las seis.', '¿Puedes comprar leche de camino a casa?', 'Te quiero ❤️'],
  en: ['Hi! Write me something and I will answer in English.', 'Nice! How is your day going?', 'Perfect, see you at six.', 'Can you pick up milk on the way home?', 'Love you ❤️'],
};

/** In-memory stand-in for Firestore, with a robot partner. Used by `?demo=1`. */
class LocalStore {
  constructor() {
    this.uid = 'me';
    this.members = {};
    this.messages = [];
    this.roomListeners = new Set();
    this.msgListeners = new Set();
    this.botLang = 'es';
    this.replyIndex = 0;
    this.greeted = false;
  }

  async probe() {}

  async claimSeat(seat) {
    this.members.me = seat;
    this.botLang = seat.lang === 'es' ? 'en' : 'es';
    this.members.bot = { name: 'Demo partner', lang: this.botLang, lastSeen: Date.now(), side: otherSide(seat.side) };
    this.emitRoom();
    if (!this.greeted) {
      this.greeted = true;
      setTimeout(() => this.botSay(BOT_LINES[this.botLang][0]), 600);
    }
  }

  async refreshSeat(fields) {
    if (!this.members.me) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    Object.assign(this.members.me, fields);
    this.emitRoom();
  }

  async freeSeat(uid) {
    delete this.members[uid];
    this.emitRoom();
  }

  async deleteMessagesFrom(uid) {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.uid !== uid);
    this.emitMessages();
    return before - this.messages.length;
  }

  onRoom(onData) {
    this.roomListeners.add(onData);
    onData({ members: { ...this.members } });
    return () => this.roomListeners.delete(onData);
  }

  onMessages(onData) {
    this.msgListeners.add(onData);
    onData(this.window());
    return () => this.msgListeners.delete(onData);
  }

  async loadOlder(beforeTs, n) {
    const older = this.messages.filter((m) => m.clientTs < beforeTs).sort((a, b) => b.clientTs - a.clientTs).slice(0, n);
    return older.reverse();
  }

  async sendMessage(msg) {
    this.messages.push({ id: 'm' + Date.now() + Math.random().toString(16).slice(2), ...msg });
    this.emitMessages();
    if (!this.members.bot) return;
    const lines = BOT_LINES[this.botLang];
    this.replyIndex = (this.replyIndex % (lines.length - 1)) + 1;
    setTimeout(() => this.botSay(lines[this.replyIndex]), 1500);
  }

  async importMessages(items, onProgress) {
    const ids = new Set(this.messages.map((m) => m.id));
    let done = 0;
    for (const item of items) {
      if (!ids.has(item.id)) this.messages.push({ id: item.id, ...item.data });
      onProgress(++done, items.length);
    }
    this.messages.sort((a, b) => a.clientTs - b.clientTs);
    this.emitMessages();
    return { written: items.length, failed: 0 };
  }

  botSay(text) {
    this.messages.push({ id: 'b' + Date.now(), uid: 'bot', side: this.members.bot.side, name: 'Demo partner', text, lang: this.botLang, tx: {}, clientTs: Date.now() });
    this.emitMessages();
  }

  window() {
    return this.messages.slice(-MESSAGE_LIMIT);
  }

  emitRoom() {
    for (const l of this.roomListeners) l({ members: { ...this.members } });
  }

  emitMessages() {
    for (const l of this.msgListeners) l(this.window());
  }
}

// ---------- App flow ----------

async function main() {
  registerServiceWorker();
  state.demo = new URLSearchParams(location.search).has('demo');
  state.profile = loadProfile();
  if (!state.demo) {
    state.side = localStorage.getItem(SIDE_KEY) || null;
    state.myVoiceId = localStorage.getItem(VOICE_KEY) || null;
  }
  bindUI();

  if (!state.demo && !isConfigured()) {
    show('config');
    return;
  }
  if (!state.demo && !state.profile && isIosBrowserTab()) {
    show('install');
    return;
  }
  if (!state.profile) {
    openSetup(false);
    return;
  }
  await connect();
}

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

async function connect() {
  teardown();
  state.fullKind = null;
  show('chat');
  $('#demo-banner').hidden = !state.demo;
  setHeader('Connecting…', '');

  try {
    if (!state.store) state.store = state.demo ? new LocalStore() : await FirestoreStore.connect();
  } catch (e) {
    showChatError(friendlyError(e));
    return;
  }
  state.uid = state.store.uid;

  // First time on this phone: check the database is set up, then take a place.
  if (state.demo || !wasSeated()) {
    try {
      await state.store.probe();
    } catch (e) {
      showChatError(friendlyError(e));
      return;
    }
    try {
      await claimAnySide();
    } catch (e) {
      if (isPermissionDenied(e)) showFull('full');
      else showChatError(friendlyError(e));
      return;
    }
    rememberSeated(true);
  }

  state.seated = true;
  state.unsubs.push(state.store.onRoom(onRoom, onListenError));
  state.unsubs.push(state.store.onMessages(onMessages, onListenError));
  startHeartbeat();
}

/** Try our remembered side first, then the other one; both refused means the chat is full. */
async function claimAnySide() {
  const order = state.side ? [state.side, otherSide(state.side)] : SIDES;
  let lastError = null;
  for (const side of order) {
    try {
      await state.store.claimSeat(seatDoc(side));
      rememberSide(side);
      return;
    } catch (e) {
      if (!isPermissionDenied(e)) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

function teardown() {
  for (const unsub of state.unsubs) unsub();
  state.unsubs = [];
  clearInterval(state.heartbeat);
  state.seated = false;
  state.members = {};
  state.partner = null;
  state.messages = [];
  state.older = [];
  state.olderExhausted = false;
  state.loadingOlder = false;
  state.pending = [];
  state.seenIds = null;
  state.showAlt.clear();
  state.txWanted.clear();
  state.txErrors.clear();
  txQueue.length = 0;
  state.txInflight.clear();
  $('#chat-error').hidden = true;
}

/** A listener died. permission-denied means our place was taken away (Settings → Disconnect on the other phone). */
function onListenError(e) {
  if (isPermissionDenied(e)) {
    teardown();
    rememberSeated(false);
    showFull('disconnected');
    return;
  }
  showChatError(friendlyError(e));
}

const FULL_TEXT = {
  full: {
    title: 'This chat already has two phones',
    body: `${APP_NAME} is private: only the first two phones to open it can use it, and both places are taken. If one of you has a new phone, open ⚙ Settings on the other phone, tap Disconnect next to the old one, then try again here.`,
    button: 'Try again',
  },
  disconnected: {
    title: 'This phone was disconnected',
    body: 'The other phone removed this one from the chat. If that was a mistake, tap Reconnect — it works as long as a place is free.',
    button: 'Reconnect',
  },
};

function showFull(kind) {
  const t = FULL_TEXT[kind];
  state.fullKind = kind;
  $('#full-title').textContent = t.title;
  $('#full-body').textContent = t.body;
  $('#btn-retry').textContent = t.button;
  show('full');
}

/** Refresh our own place (presence, or a changed name/language). Losing it means we were disconnected. */
function refreshSeat(fields = {}) {
  if (!state.store || !state.seated) return;
  state.store.refreshSeat({ ...fields, lastSeen: Date.now() }).catch((e) => {
    if (isPermissionDenied(e)) onListenError(e);
    else if (!/unavailable/.test(String(e && e.code))) showChatError(friendlyError(e));
  });
}

function startHeartbeat() {
  const beat = () => {
    if (!document.hidden) refreshSeat();
  };
  beat();
  state.heartbeat = setInterval(beat, 60_000);
}

function onRoom(data) {
  state.members = (data && data.members) || {};
  const mine = state.members[state.uid];
  if (!state.demo && !mine) {
    onListenError({ code: 'permission-denied' });
    return;
  }
  if (mine && mine.side && mine.side !== state.side) rememberSide(mine.side);
  const others = Object.entries(state.members)
    .filter(([uid]) => uid !== state.uid)
    .map(([uid, m]) => ({ uid, ...m }))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  state.partner = others[0] || null;
  renderHeader();
  renderMessages();
  renderDevices();
}

function onMessages(msgs) {
  // Anything we were still "sending" that has now arrived from the store.
  state.pending = state.pending.filter((p) => !msgs.some((m) => m.uid === p.uid && m.clientTs === p.clientTs));

  const firstLoad = state.seenIds === null;
  const fresh = firstLoad ? [] : msgs.filter((m) => !state.seenIds.has(m.id) && !isMine(m) && !m.imported);
  state.seenIds = new Set(msgs.map((m) => m.id));
  const live = state.seenIds;
  if (state.older.length || state.loadingOlder) {
    // Every new message pushes the oldest one out of the live window; keep it so the earlier
    // pages stay contiguous with the window instead of leaving a growing hole.
    const olderIds = new Set(state.older.map((m) => m.id));
    const evicted = state.messages.filter((m) => !live.has(m.id) && !olderIds.has(m.id) && !m.pendingWrite);
    state.older = [...state.older.filter((m) => !live.has(m.id)), ...evicted].sort((a, b) => a.clientTs - b.clientTs);
  }
  state.messages = msgs;
  if (firstLoad) state.forceScroll = true;
  $('#chat-error').hidden = true;
  scheduleRender();
  if (fresh.length) notifyNew(fresh);
}

/** Messages carry the side they were sent from, which survives phone swaps; very old ones only have a uid. */
function isMine(m) {
  return m.side ? m.side === state.side : m.uid === state.uid;
}

async function loadOlder() {
  if (state.loadingOlder || state.olderExhausted || !state.store) return;
  const oldest = state.older[0] || state.messages[0];
  if (!oldest) return;
  state.loadingOlder = true;
  renderMessages();
  try {
    const page = await state.store.loadOlder(oldest.clientTs, MESSAGE_LIMIT);
    const known = new Set([...state.older, ...state.messages].map((m) => m.id));
    state.older = [...page.filter((m) => !known.has(m.id)), ...state.older];
    if (page.length < MESSAGE_LIMIT) state.olderExhausted = true;
    state.loadingOlder = false;
    renderMessages({ keepPosition: true });
  } catch (e) {
    state.loadingOlder = false;
    renderMessages();
    toast(friendlyError(e));
  }
}

// ---------- Setup / settings screen ----------

function openSetup(editing) {
  const p = state.profile || {};
  $('#f-name').value = p.name || '';
  $('#f-lang').value = p.lang || guessLanguage();
  $('#f-email').value = p.email || '';
  $('#setup-title').textContent = editing ? 'Settings' : APP_NAME;
  $('#setup-lead').hidden = editing;
  $('#setup-submit').textContent = editing ? 'Save' : 'Start chatting';
  $('#setup-cancel').hidden = !editing;
  $('#btn-import').hidden = !(editing && state.seated);
  renderDevices();
  renderVoiceBox();
  show('setup');
  if (!editing) $('#f-name').focus();
}

function closeSetup() {
  show(state.seated || !state.fullKind ? 'chat' : 'full');
}

async function onSetupSubmit(event) {
  event.preventDefault();
  const profile = {
    name: $('#f-name').value.trim(),
    lang: $('#f-lang').value,
    email: $('#f-email').value.trim(),
  };
  if (!profile.name) return;

  state.profile = profile;
  saveProfile(profile);

  if (state.store && state.seated) {
    // Already in the chat — just refresh our place (name/language may have changed).
    show('chat');
    refreshSeat({ name: profile.name, lang: profile.lang });
    state.txErrors.clear();
    state.listen.langs = null;
    renderHeader();
    renderMessages();
    return;
  }
  await connect();
}

function renderDevices() {
  const box = $('#devices');
  const editing = !$('#setup-cancel').hidden;
  box.hidden = !(editing && state.seated);
  if (box.hidden) return;
  $('#d-me').textContent = state.profile.name;
  const p = state.partner;
  $('#d-partner-row').hidden = !p;
  $('#d-empty').hidden = !!p;
  if (p) $('#d-partner').textContent = `${p.name} — reads ${languageName(p.lang)}`;
  renderVoiceBox();
}

// ---------- Your voice ----------

function renderVoiceBox() {
  const box = $('#voice-box');
  const editing = !$('#setup-cancel').hidden;
  box.hidden = !(editing && state.seated && cloningAvailable() && !state.demo);
  if (box.hidden) return;
  const on = !!state.myVoiceId;
  const state_el = $('#voice-state');
  state_el.textContent = on
    ? 'On \u2014 your partner hears your messages in your voice.'
    : (canRecord()
      ? 'Off \u2014 your messages are read by the phone\u2019s built-in voice.'
      : 'This phone can\u2019t record audio in the browser.');
  state_el.classList.toggle('on', on);
  $('#voice-summary').textContent = on ? 'Record it again\u2026' : 'Record my voice\u2026';
  $('#btn-voice-remove').hidden = !on;
  $('#btn-record').disabled = !$('#voice-consent').checked || !canRecord();
}

function setVoiceError(message) {
  const el = $('#voice-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function setRecordingUi(recording, seconds) {
  const btn = $('#btn-record');
  const timer = $('#voice-timer');
  btn.textContent = recording ? 'Stop & save' : 'Start recording';
  btn.classList.toggle('recording', recording);
  timer.classList.toggle('live', recording);
  timer.textContent = recording ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
}

async function onRecordClick() {
  setVoiceError('');
  if (state.recorder) return finishRecording();
  try {
    state.recorder = await startRecording();
  } catch (e) {
    state.recorder = null;
    setVoiceError(/NotAllowed|Permission/i.test(String(e && e.name))
      ? 'Microphone access was blocked. Allow the microphone for this app in your phone\u2019s settings.'
      : 'Couldn\u2019t start recording on this phone.');
    return;
  }
  let seconds = 0;
  setRecordingUi(true, 0);
  state.recordTimer = setInterval(() => {
    seconds++;
    setRecordingUi(true, seconds);
    if (seconds >= 180) finishRecording(); // plenty of material; keep the upload small
  }, 1000);
  state.recordSeconds = () => seconds;
}

async function finishRecording() {
  const rec = state.recorder;
  if (!rec) return;
  const seconds = state.recordSeconds ? state.recordSeconds() : 0;
  clearInterval(state.recordTimer);
  state.recorder = null;
  setRecordingUi(false, 0);

  if (seconds < 20) {
    rec.cancel();
    setVoiceError('That was only a few seconds. Read the paragraph for about a minute so the voice sounds like you.');
    return;
  }

  let blob;
  try {
    blob = await rec.stop();
  } catch {
    setVoiceError('Nothing was recorded. Please try again.');
    return;
  }

  const btn = $('#btn-record');
  btn.disabled = true;
  btn.textContent = 'Creating your voice\u2026';
  try {
    const voiceId = await cloneVoice({
      blob,
      fileName: rec.fileName,
      name: `${state.profile.name} (${APP_NAME})`,
      getToken: getIdToken,
    });
    const previous = state.myVoiceId;
    state.myVoiceId = voiceId;
    localStorage.setItem(VOICE_KEY, voiceId);
    if (previous) clearCachedVoice(previous);
    refreshSeat({ voiceId });
    toast('Your voice is ready \u2014 open Talk and say something.', 6000);
    $('#voice-details').open = false;
  } catch (e) {
    setVoiceError(String((e && e.message) || e));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start recording';
    renderVoiceBox();
  }
}

function onVoiceRemove() {
  if (!state.myVoiceId) return;
  if (!confirm('Stop using your voice? Messages will be read by the phone\u2019s built-in voice again.')) return;
  const previous = state.myVoiceId;
  state.myVoiceId = null;
  localStorage.removeItem(VOICE_KEY);
  clearCachedVoice(previous);
  // Clearing the field on my seat is a normal seat update, so the rules allow it.
  if (state.store && state.seated) {
    state.store.claimSeat(seatDoc(state.side)).catch(() => {});
  }
  renderVoiceBox();
}

async function onDisconnect() {
  const p = state.partner;
  if (!p || !state.store) return;
  if (!confirm(`Disconnect ${p.name}'s phone? They can join again from the link.`)) return;
  try {
    await withTimeout(state.store.freeSeat(p.uid));
    toast(`${p.name}'s phone was disconnected. The next phone to open the link takes its place.`, 6000);
  } catch (e) {
    toast(e.code === 'timeout' ? 'No connection — this will finish when you are back online.' : friendlyError(e), 6000);
    return;
  }
  // A test device (the computer, an earlier try) leaves messages on the side the partner will inherit.
  const wipe = confirm(`Also delete the messages that phone sent?\n\nOK — it was a test device (your computer, an earlier try).\nCancel — it was ${p.name}'s real phone: keep their messages.`);
  if (!wipe) return;
  try {
    const n = await withTimeout(state.store.deleteMessagesFrom(p.uid), 60_000);
    toast(`Deleted ${num(n)} messages from that phone.`, 6000);
  } catch (e) {
    toast(e.code === 'timeout' ? 'Still deleting — it will finish in the background.' : friendlyError(e), 6000);
  }
}

// ---------- Import screen ----------

function openImport() {
  state.importFile = null;
  state.importParsed = null;
  state.importThread = null;
  state.importRoles = new Map();
  state.importing = false;
  $('#f-import').value = '';
  $('#import-pick').hidden = false;
  $('#import-map').hidden = true;
  $('#import-progress-box').hidden = true;
  $('#import-error').hidden = true;
  $('#btn-import-back').hidden = false;
  show('import');
}

function showImportError(message) {
  const box = $('#import-error');
  box.textContent = message;
  box.hidden = false;
}

async function onImportFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  $('#import-error').hidden = true;
  state.importFile = file;
  state.importThread = null;
  state.importRoles = new Map();
  await parseImportFile();
}

async function parseImportFile(dayFirst) {
  try {
    state.importParsed = await readExport(state.importFile, typeof dayFirst === 'boolean' ? { dayFirst } : {});
  } catch (e) {
    state.importParsed = null;
    $('#import-map').hidden = true;
    showImportError(e instanceof ImportError ? e.message : 'That file could not be read.');
    return;
  }
  if (state.importParsed.threads.length && !state.importThread) state.importThread = state.importParsed.threads[0].key;
  renderImportMap();
}

function importMessagesInThread() {
  const p = state.importParsed;
  if (!p) return [];
  return p.threads.length ? p.messages.filter((m) => m.thread.key === state.importThread) : p.messages;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const num = (n) => n.toLocaleString();

/** Best guess at who a sender is — and '' (ask) whenever the names don't settle it, since a wrong side can't be undone. */
function defaultRole(sender, senders) {
  const norm = (s) => s.trim().toLowerCase();
  const similar = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)));
  const me = norm(state.profile.name);
  const partner = state.partner ? norm(state.partner.name) : null;
  const guess = (n) => (similar(n, me) ? 'me' : partner && similar(n, partner) ? 'partner' : '');
  const flip = (r) => (r === 'me' ? 'partner' : r === 'partner' ? 'me' : '');
  if (sender === ME) {
    // A text-message backup marks the backing-up phone's own texts as ME — and that may well be
    // the partner's phone. Decide from the other name in the conversation, or ask.
    for (const other of senders.filter((x) => x !== ME)) {
      const r = guess(norm(other));
      if (r) return flip(r);
    }
    return '';
  }
  const own = guess(norm(sender));
  if (own) return own;
  if (senders.length === 2) {
    const other = senders.find((x) => x !== sender);
    if (other !== ME && similar(norm(other), me)) return 'partner';
  }
  return '';
}

/** The partner's language, or the best guess at it before they've joined (used by the Talk screen). */
function partnerLangGuess() {
  if (state.partner) return state.partner.lang;
  const mine = (state.profile && state.profile.lang) || guessLanguage();
  return mine === 'en' ? 'es' : 'en';
}

function roleFor(sender, senders) {
  if (!state.importRoles.has(sender)) {
    const role = defaultRole(sender, senders);
    // Until the partner has joined, their language is asked for rather than guessed — it's written into every message.
    const lang = role === 'partner' ? (state.partner ? state.partner.lang : '') : state.profile.lang;
    state.importRoles.set(sender, { role, lang });
  }
  return state.importRoles.get(sender);
}

function renderImportMap() {
  const p = state.importParsed;
  const msgs = importMessagesInThread();
  $('#import-pick').hidden = true;
  $('#import-map').hidden = false;

  // Which conversation (SMS backups hold every contact)
  const threadRow = $('#import-thread-row');
  threadRow.hidden = p.threads.length < 2;
  if (p.threads.length) {
    const sel = $('#import-thread');
    sel.replaceChildren(...p.threads.map((t) => {
      const o = document.createElement('option');
      o.value = t.key;
      o.textContent = `${t.label} (${num(t.count)} messages)`;
      return o;
    }));
    sel.value = state.importThread;
  }

  // Day/month order, when the file can't prove it
  const dayRow = $('#import-dayfirst-row');
  dayRow.hidden = !p.ambiguousDates;
  $('#import-dayfirst').checked = !!p.dayFirst;

  // Summary
  const parts = [];
  if (msgs.length) {
    parts.push(`${num(msgs.length)} messages from ${dateFmt.format(msgs[0].ts)} to ${dateFmt.format(msgs[msgs.length - 1].ts)}.`);
  } else {
    parts.push('No messages in this conversation.');
  }
  const sk = [];
  if (p.skipped.media) sk.push(`${num(p.skipped.media)} photos/attachments`);
  if (p.skipped.deleted) sk.push(`${num(p.skipped.deleted)} deleted`);
  if (sk.length) parts.push(`Not imported: ${sk.join(', ')}.`);
  $('#import-summary').textContent = parts.join(' ');

  // Who is who
  const counts = new Map();
  for (const m of msgs) counts.set(m.sender, (counts.get(m.sender) || 0) + 1);
  const senders = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  const partnerLabel = state.partner ? `Partner (${state.partner.name})` : 'Partner';
  const box = $('#import-senders');
  box.replaceChildren(...senders.map((sender) => {
    const r = roleFor(sender, senders);
    const row = el('div', 'sender');
    const name = el('div', 'sender-name', sender === ME ? 'Texts sent from the phone that made the backup' : sender);
    name.append(el('small', null, `${num(counts.get(sender))} messages`));
    const controls = el('div', 'sender-controls');
    const roleSel = document.createElement('select');
    roleSel.dataset.sender = sender;
    roleSel.dataset.kind = 'role';
    for (const [value, label] of [['', 'Who is this?'], ['me', `Me (${state.profile.name})`], ['partner', partnerLabel], ['skip', 'Skip']]) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      roleSel.append(o);
    }
    roleSel.value = r.role;
    const langSel = document.createElement('select');
    langSel.dataset.sender = sender;
    langSel.dataset.kind = 'lang';
    langSel.title = 'Language these messages were written in';
    const langOptions = LANGUAGES.map((l) => [l.code, `Written in ${l.name}`]);
    if (!r.lang) langOptions.unshift(['', 'Written in…?']);
    langSel.replaceChildren(...langOptions.map(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    }));
    langSel.value = r.lang;
    langSel.hidden = r.role === 'skip' || r.role === '';
    controls.append(roleSel, langSel);
    row.append(name, controls);
    return row;
  }));
  $('#btn-import-go').disabled = !msgs.length;
}

function onImportControlChange(event) {
  const sel = event.target;
  if (!(sel instanceof HTMLSelectElement) || !sel.dataset.sender) return;
  const r = state.importRoles.get(sel.dataset.sender) || { role: '', lang: state.profile.lang };
  if (sel.dataset.kind === 'role') {
    r.role = sel.value;
    if (r.role === 'partner') r.lang = state.partner ? state.partner.lang : '';
    if (r.role === 'me') r.lang = state.profile.lang;
  } else {
    r.lang = sel.value;
  }
  state.importRoles.set(sel.dataset.sender, r);
  renderImportMap();
}

async function runImport() {
  if (state.importing || !state.importParsed || !state.store || !state.seated) return;
  $('#import-error').hidden = true;
  const msgs = importMessagesInThread();
  const counts = new Map();
  for (const m of msgs) counts.set(m.sender, (counts.get(m.sender) || 0) + 1);
  const senders = [...counts.keys()];

  const label = (s) => (s === ME ? 'the texts sent from the phone that made the backup' : `"${s}"`);
  const unassigned = senders.filter((s) => !roleFor(s, senders).role);
  if (unassigned.length) {
    showImportError(`Choose who ${unassigned.map(label).join(' and ')} ${unassigned.length > 1 ? 'are' : 'is'} — or pick Skip.`);
    return;
  }
  for (const role of ['me', 'partner']) {
    const dup = senders.filter((s) => roleFor(s, senders).role === role);
    if (dup.length > 1) {
      showImportError(`${dup.map(label).join(' and ')} can’t both be ${role === 'me' ? 'you' : 'your partner'}.`);
      return;
    }
  }
  const noLang = senders.filter((s) => ['me', 'partner'].includes(roleFor(s, senders).role) && !roleFor(s, senders).lang);
  if (noLang.length) {
    showImportError(`Choose the language ${label(noLang[0])} ${noLang[0] === ME ? 'were' : 'was'} written in.`);
    return;
  }
  const chosen = msgs.filter((m) => ['me', 'partner'].includes(roleFor(m.sender, senders).role));
  if (!chosen.length) {
    showImportError('Everything is set to Skip — nothing to import.');
    return;
  }
  if (!confirm(`Import ${num(chosen.length)} messages? Check "Who is this?" first — a wrong choice can’t be undone in the app.`)) return;

  state.importing = true;
  $('#import-map').hidden = true;
  $('#btn-import-back').hidden = true;
  const progressBox = $('#import-progress-box');
  const progressText = $('#import-progress-text');
  const bar = $('#import-progress');
  progressBox.hidden = false;
  progressText.textContent = 'Preparing…';
  bar.value = 0;

  const partnerSide = otherSide(state.side);
  const items = [];
  const seen = new Map(); // side|minute|text -> how many times already used in this file
  for (const m of chosen) {
    const r = roleFor(m.sender, senders);
    const side = r.role === 'me' ? state.side : partnerSide;
    const text = m.text.length > MAX_TEXT ? m.text.slice(0, MAX_TEXT - 1) + '…' : m.text;
    // The id depends only on what's written in the file, so both phones (in any time zone, from
    // the Android or the iPhone export) agree on it; a repeated "ok" in one minute gets its own.
    const key = `${side}|${m.key}|${text}`;
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    items.push({
      id: 'imp_' + (await sha(`${key}|${n}`)).slice(0, 24),
      data: {
        uid: side === state.side ? state.uid : (state.partner ? state.partner.uid : 'imported'),
        side,
        name: r.role === 'me' ? state.profile.name : (state.partner ? state.partner.name : (m.sender === ME ? 'Partner' : m.sender)),
        text,
        lang: r.lang,
        tx: {},
        clientTs: m.ts,
        imported: true,
        importedBy: state.uid,
      },
    });
  }

  let lastProgress = Date.now();
  const stallTimer = setInterval(() => {
    if (Date.now() - lastProgress > 15_000) progressText.textContent += ' — waiting for the connection…';
  }, 5000);
  try {
    const result = await state.store.importMessages(items, (done, total) => {
      lastProgress = Date.now();
      bar.value = Math.round((done / total) * 100);
      progressText.textContent = `Importing ${num(done)} of ${num(total)}… keep the app open.`;
    });
    clearInterval(stallTimer);
    state.importing = false;
    state.older = [];
    state.olderExhausted = false;
    show('chat');
    state.forceScroll = true;
    renderMessages();
    const note = result.failed ? ` (${num(result.failed)} were already imported from the other phone.)` : '';
    toast(`Imported ${num(result.written)} messages.${note} Tap an old message to translate it.`, 7000);
  } catch (e) {
    clearInterval(stallTimer);
    state.importing = false;
    progressBox.hidden = true;
    $('#import-map').hidden = false;
    $('#btn-import-back').hidden = false;
    showImportError(friendlyError(e));
  }
}

// ---------- Talk screen (speak in one language, hear it in the other) — the logic lives in talk.js ----------

/** The two languages on the Talk screen: mine and my partner's (or a sensible guess until they join). */
function listenLangs() {
  const L = state.listen;
  if (!L.langs) {
    const mine = (state.profile && state.profile.lang) || guessLanguage();
    const theirs = partnerLangGuess();
    L.langs = [mine, theirs === mine ? (mine === 'en' ? 'es' : 'en') : theirs];
  }
  return L.langs;
}

const talk = initTalk({
  langs: () => listenLangs(),
  setLangs: (pair) => { state.listen.langs = pair; },
  email: () => (state.profile && state.profile.email) || '',
  onBack: () => show('chat'),
  safariLink: new URL('./talk.html', location.href).href,
  voiceIdFor,
  getToken: getIdToken,
});

function openListen() {
  talk.open();
  show('listen');
}

// ---------- Dictation into the message box ----------

function toggleDictation() {
  const input = $('#input');
  const btn = $('#btn-dictate');
  if (state.dictation) {
    state.dictation.stop();
    state.dictation = null;
    return;
  }
  let base = input.value.trim();
  const join = (a, b) => (a && b ? `${a} ${b}` : a || b);
  state.dictation = createRecognizer({
    lang: state.profile.lang,
    continuous: false,
    onInterim: (text) => { input.value = join(base, text); autoGrow(input); },
    onFinal: (text) => { base = join(base, text); input.value = base; autoGrow(input); },
    onError: (code) => { toast(listenErrorText(code), 6000); },
    onStateChange: (running) => {
      btn.classList.toggle('live', running);
      btn.setAttribute('aria-label', running ? 'Stop dictating' : 'Dictate a message');
      if (!running) { state.dictation = null; input.focus(); }
    },
  });
  state.dictation.start();
}

// ---------- Sending ----------

async function onSend(event) {
  event.preventDefault();
  const input = $('#input');
  const text = input.value.trim().slice(0, MAX_TEXT);
  if (!text || !state.store || !state.seated || !state.side) return;

  input.value = '';
  autoGrow(input);
  input.focus();

  const msg = { uid: state.uid, side: state.side, name: state.profile.name, text, lang: state.profile.lang, tx: {}, clientTs: Date.now() };
  state.pending.push(msg);
  state.forceScroll = true;
  renderMessages();
  maybeAskNotificationPermission();

  // Translate into the partner's language before sending so it lands ready-to-read.
  const to = state.partner && state.partner.lang;
  if (to && to !== msg.lang) {
    try {
      // Don't hold the message hostage to a slow translator: after 8 s send it as is.
      msg.tx[to] = await withTimeout(translate(text, msg.lang, to, { email: state.profile.email }), 8000);
    } catch (err) {
      if (err instanceof TranslationError && err.code === 'quota') {
        toast('Free translation limit reached for today — sent untranslated.');
      }
      // Otherwise the partner's phone will translate it when it arrives.
    }
  }

  state.store.sendMessage(msg).catch((err) => {
    state.pending = state.pending.filter((p) => p !== msg);
    input.value = text + (input.value ? '\n' + input.value : ''); // give the text back
    autoGrow(input);
    renderMessages();
    // A refused message is not a lost place — the room listener tells us about that separately.
    showChatError(isPermissionDenied(err) ? 'The server refused that message.' : friendlyError(err));
  });
}

// ---------- Translating what we receive ----------

// Only the newest few untranslated messages are translated automatically, a couple at a time,
// so a language change or a long backlog can't fire hundreds of requests and burn the free quota.
const AUTO_TRANSLATE_RECENT = 40;
const TX_CONCURRENCY = 2;
const txQueue = [];
let txActive = 0;

function ensureTranslation(m) {
  if (state.txInflight.has(m.id) || state.txErrors.has(m.id)) return;
  state.txInflight.add(m.id);
  txQueue.push(m);
  pumpTranslations();
}

function pumpTranslations() {
  while (txActive < TX_CONCURRENCY && txQueue.length) {
    const m = txQueue.shift();
    txActive++;
    translate(m.text, m.lang, state.profile.lang, { email: state.profile.email })
      .catch((err) => state.txErrors.set(m.id, err instanceof TranslationError ? err : new TranslationError(String(err))))
      .finally(() => {
        txActive--;
        state.txInflight.delete(m.id);
        scheduleRender();
        pumpTranslations();
      });
  }
}

/** Decide what text to show for a message, and what (if anything) sits behind a tap. */
function viewFor(m, autoTranslate = true) {
  const myLang = state.profile.lang;
  if (isMine(m)) {
    const to = state.partner && state.partner.lang;
    const alt = to && to !== m.lang && m.tx ? m.tx[to] : null;
    return alt ? { text: m.text, kind: 'sent-as', alt, altLang: to } : { text: m.text, kind: 'plain' };
  }
  if (!m.lang || m.lang === myLang) return { text: m.text, kind: 'plain' };

  const tx = (m.tx && m.tx[myLang]) || getCached(m.text, m.lang, myLang);
  if (tx) return { text: tx, kind: 'translated', alt: m.text, altLang: m.lang };

  const error = state.txErrors.get(m.id);
  if (error) return { text: m.text, kind: 'error', error };

  // Imported history and older backlog are translated on request, so they can't eat the daily free limit.
  if ((m.imported || !autoTranslate) && !state.txWanted.has(m.id)) return { text: m.text, kind: 'untranslated', altLang: m.lang };

  ensureTranslation(m);
  return { text: m.text, kind: 'translating' };
}

// ---------- Rendering ----------

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const oldDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return (d.getFullYear() === now.getFullYear() ? dayFmt : oldDayFmt).format(d);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setHeader(name, status) {
  $('#partner-name').textContent = name;
  $('#partner-status').textContent = status;
}

function renderHeader() {
  if (!state.seated) return;
  const p = state.partner;
  if (!p) {
    setHeader('Waiting for your partner', state.demo ? '' : 'Send them the link — the next phone to open it joins the chat.');
    return;
  }
  const online = Date.now() - (p.lastSeen || 0) < ONLINE_WINDOW_MS;
  setHeader(p.name, `${online ? 'Active now' : 'Away'} · reads ${languageName(p.lang)}`);
}

let renderQueued = false;
/** Coalesces bursts of updates (an import landing on the other phone, a run of translations) into one render per frame. */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; renderMessages(); }, 16); // a timer, not rAF: keeps working while the tab is in the background
}

function renderMessages({ keepPosition = false } = {}) {
  const list = $('#messages');
  const prevHeight = list.scrollHeight;
  const prevTop = list.scrollTop;
  const nearBottom = prevHeight - prevTop - list.clientHeight < 120;
  const all = [
    ...state.older,
    ...state.messages,
    ...state.pending.map((p) => ({ ...p, id: 'pending-' + p.clientTs, pending: true })),
  ];

  const frag = document.createDocumentFragment();
  if (state.messages.length >= MESSAGE_LIMIT && !state.olderExhausted) {
    const b = el('button', 'btn ghost load-older', state.loadingOlder ? 'Loading…' : 'Show earlier messages');
    b.type = 'button';
    b.disabled = state.loadingOlder;
    b.addEventListener('click', loadOlder);
    frag.append(b);
  }
  if (!all.length) {
    frag.append(el('div', 'empty', state.partner
      ? `Say hello — ${state.partner.name} will read it in ${languageName(state.partner.lang)}.`
      : 'No messages yet.'));
  }
  let lastDay = null;
  all.forEach((m, i) => {
    const day = new Date(m.clientTs).toDateString();
    if (day !== lastDay) {
      frag.append(el('div', 'day', dayLabel(m.clientTs)));
      lastDay = day;
    }
    frag.append(messageEl(m, i >= all.length - AUTO_TRANSLATE_RECENT));
  });
  list.replaceChildren(frag);

  if (keepPosition) {
    list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
  } else if (nearBottom || state.forceScroll) {
    list.scrollTop = list.scrollHeight;
    state.forceScroll = false;
  }
}

function messageEl(m, autoTranslate) {
  const mine = isMine(m);
  const v = viewFor(m, autoTranslate);
  const expanded = state.showAlt.has(m.id);

  const wrap = el('div', `msg ${mine ? 'mine' : 'theirs'}${m.pending ? ' pending' : ''}`);
  const bubble = el('div', 'bubble');
  bubble.dir = 'auto';
  bubble.append(el('div', 'text', v.text));

  let note = null;
  if (v.kind === 'translated') note = `Translated from ${languageName(v.altLang)} · ${expanded ? 'tap to hide original' : 'tap to see original'}`;
  else if (v.kind === 'sent-as') note = `Delivered in ${languageName(v.altLang)} · ${expanded ? 'tap to hide' : 'tap to see'}`;
  else if (v.kind === 'translating') note = 'Translating…';
  else if (v.kind === 'untranslated') note = `${languageName(v.altLang)} · tap to translate`;
  else if (v.kind === 'error') {
    const why = v.error.code === 'quota' ? 'Daily translation limit reached'
      : v.error.code === 'offline' ? 'Offline — showing original'
      : "Couldn't translate";
    note = `${why} · tap to retry`;
  }
  if (note) bubble.append(el('div', `note${v.kind === 'error' ? ' error' : ''}`, note));

  if (v.alt && expanded) {
    const alt = el('div', 'alt', v.alt);
    alt.dir = 'auto';
    bubble.append(alt);
  }

  if (v.alt || v.kind === 'error' || v.kind === 'untranslated') {
    bubble.classList.add('tappable');
    bubble.addEventListener('click', () => {
      if (v.kind === 'error') state.txErrors.delete(m.id);
      else if (v.kind === 'untranslated') state.txWanted.add(m.id);
      else if (expanded) state.showAlt.delete(m.id);
      else state.showAlt.add(m.id);
      renderMessages();
    });
  }

  const time = m.pending ? 'Sending…' : timeFmt.format(m.clientTs) + (m.pendingWrite ? ' · waiting for network' : '');
  wrap.append(bubble, el('div', 'time', time));
  return wrap;
}

// ---------- Notifications, errors, toasts ----------

function notifyNew(fresh) {
  if (!document.hidden) return;
  state.unread += fresh.length;
  document.title = `(${state.unread}) ${APP_NAME}`;
  if (navigator.vibrate) navigator.vibrate(150);
  if ('Notification' in window && Notification.permission === 'granted') {
    const last = fresh[fresh.length - 1];
    showNotification(last.name || 'New message', viewFor(last).text);
  }
}

/** Phones only allow notifications through the service worker; desktops also accept the plain constructor. */
async function showNotification(title, body) {
  const options = { body, icon: './icons/icon-192.png', tag: 'chat' };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.showNotification) {
      await reg.showNotification(title, options);
      return;
    }
  } catch { /* fall through to the page-level API */ }
  try {
    new Notification(title, options);
  } catch { /* not supported in this context */ }
}

let askedForNotifications = false;
function maybeAskNotificationPermission() {
  if (askedForNotifications || !('Notification' in window) || Notification.permission !== 'default') return;
  askedForNotifications = true;
  Notification.requestPermission().catch(() => {});
}

function onVisibility() {
  if (document.hidden) {
    // Phones stop the microphone in the background anyway; keep our buttons honest.
    talk.pause();
    if (state.dictation) { state.dictation.stop(); state.dictation = null; }
    return;
  }
  state.unread = 0;
  document.title = APP_NAME;
  refreshSeat();
}

/** Turn Firebase's error codes into something a person can act on. */
function friendlyError(e) {
  const code = String((e && e.code) || '');
  const text = String((e && e.message) || e || '');
  if (/operation-not-allowed|admin-restricted-operation|configuration-not-found/.test(code)) {
    return 'Anonymous sign-in isn’t turned on in Firebase yet (setup guide, step 3).';
  }
  if (/permission-denied/.test(code)) {
    return 'The database is refusing the app — paste the security rules from the setup guide (step 4).';
  }
  if (/api-key-not-valid|invalid-api-key|app\/no-app|invalid-argument/.test(code) || /projectId/.test(text)) {
    return 'The values in firebase-config.js don’t look right (setup guide, step 2).';
  }
  if (/not-found|failed-precondition/.test(code) && /firestore|database/i.test(text)) {
    return 'The Firestore database hasn’t been created yet (setup guide, step 4).';
  }
  if (/unavailable|network-request-failed/.test(code) || /Failed to fetch|NetworkError/.test(text)) {
    return 'Can’t reach the server — check your internet connection.';
  }
  return text || 'Something went wrong.';
}

function showChatError(message) {
  const box = $('#chat-error');
  box.textContent = message;
  box.hidden = false;
  if (!state.seated) setHeader('Not connected', '');
}

let toastTimer = null;
function toast(message, ms = 4000, onClick = null) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('action', !!onClick);
  t.onclick = onClick;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- Service worker (offline shell + install + updates) ----------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      let hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) toast(`${APP_NAME} was updated — tap to refresh`, 0, () => location.reload());
        hadController = true;
      });
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.update().catch(() => {});
    } catch (e) {
      console.warn('Service worker registration failed:', e);
    }
  });
}

// ---------- UI wiring ----------

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
}

function bindUI() {
  for (const sel of [$('#f-lang')]) {
    sel.replaceChildren(...LANGUAGES.map((l) => {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.name;
      return o;
    }));
  }

  $('#btn-listen').addEventListener('click', openListen);
  $('#btn-dictate').hidden = !canListen();
  $('#btn-dictate').addEventListener('click', toggleDictation);

  $('#setup-form').addEventListener('submit', onSetupSubmit);
  $('#setup-cancel').addEventListener('click', closeSetup);
  $('#btn-disconnect').addEventListener('click', onDisconnect);
  $('#btn-import').addEventListener('click', openImport);
  $('#voice-consent').addEventListener('change', renderVoiceBox);
  $('#btn-record').addEventListener('click', onRecordClick);
  $('#btn-voice-remove').addEventListener('click', onVoiceRemove);
  $('#btn-settings').addEventListener('click', () => openSetup(true));
  $('#btn-retry').addEventListener('click', () => { rememberSeated(false); connect(); });
  $('#btn-full-settings').addEventListener('click', () => openSetup(true));
  $('#composer').addEventListener('submit', onSend);

  $('#f-import').addEventListener('change', onImportFile);
  $('#import-thread').addEventListener('change', (e) => { state.importThread = e.target.value; state.importRoles = new Map(); renderImportMap(); });
  $('#import-dayfirst').addEventListener('change', (e) => parseImportFile(e.target.checked));
  $('#import-senders').addEventListener('change', onImportControlChange);
  $('#btn-import-go').addEventListener('click', runImport);
  $('#btn-import-back').addEventListener('click', () => openSetup(true));

  const input = $('#input');
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitForm($('#composer'));
    }
  });

  document.addEventListener('visibilitychange', onVisibility);
  setInterval(renderHeader, 30_000);
}

main().catch((e) => {
  console.error(e);
  show('chat');
  showChatError(friendlyError(e));
});
