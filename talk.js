// talk.js — the Talk screen: speak in one language, see and hear it in the other.
//
// Shared by the app (index.html, #screen-listen) and by talk.html — a plain page that runs in
// Safari on an iPhone, where the phone's speech recognition works (it doesn't inside the
// installed app, so there the screen falls back to typing and the keyboard's microphone key).

import { translate, TranslationError, LANGUAGES, languageName } from './translate.js';
import { canListen, canSpeak, isIosStandalone, createRecognizer, speak, primeSpeech, hasVoiceFor, listenErrorText } from './speech.js';
import { speakCloned, primeAudio, stopCloned } from './voice.js';

const AUTO_SPEAK_KEY = 'chat.autoSpeak';
const TRANSLATE_TIMEOUT_MS = 10_000;
const SETTLE_MS = 1100;          // quiet time that means "they've finished the sentence"
const STILL_TALKING_MS = 8000;   // within this, a longer version is the same sentence, not a new one
const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * opts.langs()         → [mine, theirs]
 * opts.setLangs(pair)  → remember a changed pair
 * opts.email()         → email for the translator's higher free limit ('' if none)
 * opts.onBack()        → leave the screen (omit when there is nowhere to go back to)
 * opts.safariLink      → URL of talk.html, offered on an iPhone where the app itself can't listen
 * Returns { open(), close(), pause() }.
 */
export function initTalk(opts) {
  const T = {
    rec: null,
    selected: 0,          // which language typed text is in (last tapped; your own to begin with)
    listening: null,      // index of the language being listened to, or null
    speaking: false,      // reading a translation aloud (mic paused meanwhile)
    log: [],
    settleTimer: null,
    stickyStatus: null,   // a problem worth keeping on screen (e.g. nothing can be played)
    open: false,
    warnedNoVoice: false,
    autoSpeak: localStorage.getItem(AUTO_SPEAK_KEY) !== '0',
  };
  const root = $('.talk');
  const langs = () => opts.langs();

  for (const sel of [$('#listen-lang-a'), $('#listen-lang-b')]) {
    sel.replaceChildren(...LANGUAGES.map((l) => {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.name;
      return o;
    }));
  }

  function open() {
    T.open = true;
    const [a, b] = langs();
    $('#listen-lang-a').value = a;
    $('#listen-lang-b').value = b;
    $('#listen-change').hidden = true;
    $('#listen-autospeak').checked = T.autoSpeak;
    $('#listen-autospeak-row').hidden = !canSpeak();
    root.classList.toggle('no-listen', !canListen());
    renderBanner();
    renderButtons();
    renderLog();
  }

  function pause() {
    stopListening();
  }

  function close() {
    stopListening();
    if (canSpeak()) speechSynthesis.cancel();
    stopCloned();
    T.open = false;
  }

  function renderBanner() {
    const banner = $('#listen-unsupported');
    if (canListen()) { banner.hidden = true; return; }
    banner.hidden = false;
    banner.replaceChildren();
    if (isIosStandalone() && opts.safariLink) {
      banner.append(
        'On an iPhone the installed app can’t listen. Tap a language, then type in the box below or use the ',
        el('b', null, 'microphone key on the keyboard'),
        ' — the translation is still shown and read aloud. For hands-free voice, open Talk in Safari: ',
      );
      const link = el('a', null, opts.safariLink.replace(/^https?:\/\//, ''));
      link.href = opts.safariLink;
      link.target = '_blank';
      link.rel = 'noopener';
      banner.append(link, ' ');
      const copy = el('button', 'link-btn', 'Copy link');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(opts.safariLink); copy.textContent = 'Copied — paste it into Safari'; }
        catch { copy.textContent = opts.safariLink; }
      });
      banner.append(copy);
    } else {
      banner.textContent = 'This browser can’t listen by itself. Tap a language, then type (or use the keyboard’s microphone key) in the box at the bottom.';
    }
  }

  function setStatus(text, isError = false, sticky = false) {
    if (sticky) T.stickyStatus = { text, isError };
    const s = $('#listen-status');
    s.textContent = text;
    s.classList.toggle('error', isError);
  }

  function renderButtons() {
    const [a, b] = langs();
    $('#lang-a-label').textContent = languageName(a);
    $('#lang-b-label').textContent = languageName(b);
    for (const [i, id] of [[0, '#btn-lang-a'], [1, '#btn-lang-b']]) {
      const btn = $(id);
      btn.classList.toggle('selected', T.selected === i);
      btn.classList.toggle('live', T.listening === i);
      btn.setAttribute('aria-pressed', String(T.listening === i));
    }
    if (T.stickyStatus) setStatus(T.stickyStatus.text, T.stickyStatus.isError);
    else if (T.speaking) setStatus('Speaking…');
    else if (T.listening !== null) setStatus(`Listening in ${languageName(langs()[T.listening])}… tap it again to stop.`);
    else setStatus(canListen() ? 'Tap the language of whoever is talking.' : `Typing as ${languageName(langs()[T.selected])}.`);
  }

  function stopListening() {
    if (T.rec) T.rec.stop();
    T.rec = null;
    T.listening = null;
    $('#listen-interim').textContent = '';
    renderButtons();
  }

  /** Tap a language: listen in it (tap again to stop). Typed text uses the last tapped language too. */
  function onLangTap(event) {
    const index = Number(event.currentTarget.dataset.index);
    const wasListening = T.listening === index;
    primeSpeech(); // a tap is what lets the phone read translations aloud later
    primeAudio();
    T.stickyStatus = null;
    T.warnedNoVoice = false;
    stopListening();
    T.selected = index;
    if (wasListening || !canListen()) {
      renderButtons();
      return;
    }
    T.listening = index;
    T.rec = createRecognizer({
      lang: langs()[index],
      continuous: true,
      onInterim: (text) => { $('#listen-interim').textContent = text; },
      onFinal: (text) => addFinal(text, index),
      onError: (code) => {
        stopListening();
        setStatus(listenErrorText(code), true);
      },
      onStateChange: (running) => {
        if (!running && !T.speaking && T.listening === index) T.listening = null;
        renderButtons();
      },
    });
    T.rec.start();
    renderButtons();
  }

  /**
   * Say `text` in `lang`. If the person who said it has recorded their own voice, that is used;
   * otherwise (or if it fails) the phone's built-in voice speaks instead.
   */
  async function speakBest(text, lang, speaker) {
    const voiceId = opts.voiceIdFor && speaker !== undefined ? opts.voiceIdFor(speaker) : null;
    if (voiceId && opts.getToken) {
      const played = await speakCloned(text, voiceId, opts.getToken);
      if (played) return true;
    }
    return speak(text, lang);
  }

  /** Read a translation aloud with the microphone paused, so the phone doesn't transcribe itself. */
  async function sayAloud(text, lang, speaker) {
    const rec = T.rec;
    const index = T.listening;
    const wasListening = !!rec && index !== null;
    T.speaking = true;
    if (wasListening) rec.stop();
    $('#listen-interim').textContent = '';
    renderButtons();
    // Android only hands the speaker back a moment after the microphone stops; speaking
    // immediately gets swallowed with no error.
    if (wasListening) await new Promise((r) => setTimeout(r, 400));
    const spoke = await speakBest(text, lang, speaker);
    T.speaking = false;
    if (!spoke) await reportSpeechProblem(lang);
    if (rec && T.rec === rec && T.listening === index && index !== null && T.open) rec.start();
    renderButtons();
  }

  /** Say why nothing came out — and keep it on screen, because it needs acting on. */
  async function reportSpeechProblem(lang) {
    if (T.warnedNoVoice) return;
    T.warnedNoVoice = true;
    const name = languageName(lang);
    const inAppBrowser = /; wv\)|FBAN|FBAV|Instagram|Line\/|Twitter/i.test(navigator.userAgent || '');
    let message;
    if (!(await hasVoiceFor(lang))) {
      message = `No ${name} voice is installed on this phone, so it can only show the text. Add one under Settings \u2192 General management \u2192 Text-to-speech (Android) or Settings \u2192 Accessibility \u2192 Spoken Content (iPhone).`;
    } else if (inAppBrowser) {
      message = 'This page is open inside another app, which blocks sound. Tap the \u22ee menu at the top and choose "Open in Chrome".';
    } else {
      message = 'Nothing played. Check the volume, make sure this site isn\u2019t muted (\u22ee menu \u2192 unmute), then tap \ud83d\udd0a on a line.';
    }
    setStatus(message, true, true);
  }

  /**
   * A phrase the recognizer called final.
   *
   * Android ends its listening session whenever it finalises something, and the session we start
   * in its place reports the same sentence again, longer, as you keep talking — "you think",
   * "you think it'll", "you think it'll rain today". So nothing is translated the instant it
   * arrives: an arriving phrase that extends (or is contained in) the one still open replaces it,
   * and only once you actually stop does it get translated and spoken, once.
   */
  function addFinal(text, index) {
    const now = Date.now();
    const last = T.log[T.log.length - 1];
    const open = last && !last.settled && last.speaker === index && now - last.at < STILL_TALKING_MS;
    const a = text.toLowerCase();
    const b = open ? last.original.toLowerCase() : '';

    if (open && (a.startsWith(b) || b.startsWith(a))) {
      if (text.length >= last.original.length) last.original = text; // keep the fullest version
      last.at = now;
    } else {
      if (last && !last.settled) settleEntry(last); // a genuinely new sentence — finish the old one
      const pair = langs();
      T.log.push({
        id: 'u' + now + Math.random().toString(16).slice(2),
        original: text, from: pair[index], to: pair[1 - index], speaker: index,
        at: now, settled: false, text: null, error: null,
      });
      if (T.log.length > 200) T.log.shift();
    }
    renderLog();
    clearTimeout(T.settleTimer);
    T.settleTimer = setTimeout(() => {
      const entry = T.log[T.log.length - 1];
      if (entry && !entry.settled) settleEntry(entry);
    }, SETTLE_MS);
  }

  function settleEntry(entry) {
    if (entry.settled) return;
    entry.settled = true;
    renderLog();
    translateEntry(entry);
  }

  async function translateEntry(entry) {
    if (entry.from === entry.to) {
      entry.text = entry.original;
    } else {
      try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new TranslationError('Timed out', 'offline')), TRANSLATE_TIMEOUT_MS));
        entry.text = await Promise.race([translate(entry.original, entry.from, entry.to, { email: opts.email() }), timeout]);
      } catch (err) {
        entry.error = err instanceof TranslationError && err.code === 'quota'
          ? 'Daily free translation limit reached (an email address in Settings raises it)'
          : err instanceof TranslationError && err.code === 'offline' ? 'No internet connection'
          : 'Couldn’t translate';
      }
    }
    renderLog();
    if (entry.text && entry.from !== entry.to && T.autoSpeak && T.open) await sayAloud(entry.text, entry.to, entry.speaker);
  }

  function renderLog() {
    const list = $('#listen-log');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
    const frag = document.createDocumentFragment();
    if (!T.log.length) {
      frag.append(el('div', 'empty', canListen()
        ? 'Tap a language and start talking. Each sentence shows up here in both languages.'
        : 'Tap a language, then type in the box below and tap the arrow.'));
    }
    for (const u of T.log) {
      const box = el('div', 'utt');
      const orig = el('div', 'utt-orig');
      orig.append(el('span', 'utt-lang', languageName(u.from)), document.createTextNode(u.original));
      orig.dir = 'auto';
      box.append(orig);
      const row = el('div', 'utt-row');
      const main = el('div', `utt-text${u.error ? ' error' : ''}${u.text === null && !u.error ? ' pending' : ''}`);
      if (u.error) main.textContent = `${u.error} — ${u.original}`;
      else if (u.text === null) main.textContent = 'Translating…';
      else main.append(el('span', 'utt-lang', languageName(u.to)), document.createTextNode(u.text));
      main.dir = 'auto';
      row.append(main);
      if (u.text && canSpeak()) {
        const btn = el('button', 'icon-btn speak-btn');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Read aloud');
        btn.title = 'Read aloud';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
        btn.addEventListener('click', () => { T.warnedNoVoice = false; sayAloud(u.text, u.to, u.speaker); });
        row.append(btn);
      }
      box.append(row);
      frag.append(box);
    }
    list.replaceChildren(frag);
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  function onLangSelectChange() {
    const pair = [$('#listen-lang-a').value, $('#listen-lang-b').value];
    opts.setLangs(pair);
    if (T.rec && T.listening !== null) T.rec.setLang(pair[T.listening]);
    renderButtons();
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
  }

  function onTyped(event) {
    event.preventDefault();
    const input = $('#listen-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoGrow(input);
    const pair = langs();
    const entry = {
      id: 'u' + Date.now() + Math.random().toString(16).slice(2),
      original: text, from: pair[T.selected], to: pair[1 - T.selected], speaker: T.selected,
      at: Date.now(), settled: true, text: null, error: null,
    };
    const last = T.log[T.log.length - 1];
    if (last && !last.settled) settleEntry(last);
    T.log.push(entry);
    if (T.log.length > 200) T.log.shift();
    renderLog();
    translateEntry(entry);
  }

  // ---- wiring ----
  $('#btn-lang-a').addEventListener('click', onLangTap);
  $('#btn-lang-b').addEventListener('click', onLangTap);
  $('#btn-listen-change').addEventListener('click', () => { const box = $('#listen-change'); box.hidden = !box.hidden; });
  $('#listen-lang-a').addEventListener('change', onLangSelectChange);
  $('#listen-lang-b').addEventListener('change', onLangSelectChange);
  $('#listen-autospeak').addEventListener('change', (e) => {
    T.autoSpeak = e.target.checked;
    localStorage.setItem(AUTO_SPEAK_KEY, T.autoSpeak ? '1' : '0');
    if (!T.autoSpeak && canSpeak()) speechSynthesis.cancel();
  });
  $('#listen-form').addEventListener('submit', onTyped);
  const input = $('#listen-input');
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onTyped(e);
    }
  });
  const back = $('#btn-listen-back');
  if (back) {
    if (opts.onBack) back.addEventListener('click', () => { close(); opts.onBack(); });
    else back.hidden = true;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && T.open) pause(); });

  return { open, close, pause };
}
