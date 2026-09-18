// speech.js — speech in (the browser's SpeechRecognition) and speech out (speechSynthesis).
//
// Nothing here is required for the app to work: where the phone can't listen, the mic
// buttons hide and the keyboard's own microphone key still dictates into the text boxes.

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

/** True inside an iPhone/iPad Home Screen web app (never on Android or in a Safari tab). */
export const isIosStandalone = () => typeof navigator !== 'undefined' && 'standalone' in navigator && navigator.standalone === true;

// iOS exposes SpeechRecognition inside Home Screen web apps but never delivers results there
// (bugs.webkit.org/show_bug.cgi?id=225298). Safari itself works — which is what talk.html is for.
export const canListen = () => !!SR && !isIosStandalone();
export const canSpeak = () => typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';

// The recognizer wants a region-tagged language. Any region understands the language; these are just common defaults.
const REGION = {
  en: 'en-US', es: 'es-MX', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-PT', nl: 'nl-NL', sv: 'sv-SE',
  da: 'da-DK', no: 'nb-NO', fi: 'fi-FI', pl: 'pl-PL', cs: 'cs-CZ', sk: 'sk-SK', hu: 'hu-HU', ro: 'ro-RO',
  bg: 'bg-BG', hr: 'hr-HR', sr: 'sr-RS', sl: 'sl-SI', uk: 'uk-UA', ru: 'ru-RU', el: 'el-GR', tr: 'tr-TR',
  ar: 'ar-SA', he: 'he-IL', fa: 'fa-IR', hi: 'hi-IN', bn: 'bn-BD', ur: 'ur-PK', ta: 'ta-IN', te: 'te-IN',
  th: 'th-TH', vi: 'vi-VN', id: 'id-ID', ms: 'ms-MY', tl: 'fil-PH', ja: 'ja-JP', ko: 'ko-KR', sw: 'sw-KE',
};
export const speechLang = (code) => REGION[code] || code;

/**
 * A start/stop wrapper around SpeechRecognition.
 *   onInterim(text)  — what it thinks you're saying so far (may be '')
 *   onFinal(text)    — a finished phrase
 *   onError(code)    — 'not-allowed' | 'audio-capture' | 'network' | 'unavailable' | 'start-failed' | …
 *   onStateChange(running)
 * With `continuous`, it keeps listening (restarting itself after each pause) until stop().
 */
export function createRecognizer({ lang, continuous = false, onInterim, onFinal, onError, onStateChange }) {
  let rec = null;           // the current instance — events from older instances are ignored
  let active = false;
  let restartTimer = null;
  let startedAt = 0;
  let heard = false;        // this session produced a result, or a genuine 'no-speech' (the engine did listen)
  let deadSessions = 0;     // consecutive sessions that ended at once with nothing
  let reportedError = false;
  let lastFinalIndex = -1;  // highest results[] index already delivered — reset for each new instance
  let recentFinals = [];    // { text, at } of what we've handed over, to catch restart echoes
  const DEAD_MS = 1500;
  const DEAD_LIMIT = 3;
  const ECHO_WINDOW_MS = 2500;   // a phrase arriving this soon after a (re)start is a replay, not speech
  const ECHO_MEMORY_MS = 20_000; // how far back to remember what was already said
  const setState = (running) => onStateChange && onStateChange(running);

  function build() {
    const r = new SR();
    r.lang = speechLang(lang);
    r.continuous = continuous;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      if (r !== rec) return;
      heard = true;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = ((res[0] && res[0].transcript) || '').trim();
        if (!res.isFinal) {
          interim += (res[0] && res[0].transcript) || '';
          continue;
        }
        // Android re-delivers results it has already marked final (resultIndex doesn't advance),
        // and a restarted session often replays the phrase that ended the previous one. Hand each
        // sentence over exactly once: by position within this instance, and — for anything arriving
        // in the first moments of a session, which is a replay rather than someone speaking — by
        // checking it against what was already said.
        if (i <= lastFinalIndex) continue;
        lastFinalIndex = i;
        if (!text) continue;
        const now = Date.now();
        recentFinals = recentFinals.filter((f) => now - f.at < ECHO_MEMORY_MS);
        const isEcho = now - startedAt < ECHO_WINDOW_MS && recentFinals.some((f) => f.text === text);
        recentFinals.push({ text, at: now });
        if (isEcho) continue;
        if (onFinal) onFinal(text);
      }
      if (onInterim) onInterim(interim.trim());
    };
    r.onerror = (e) => {
      if (r !== rec) return;
      if (e.error === 'no-speech') { heard = true; return; } // silence — the engine did listen; onend restarts
      if (e.error === 'aborted') return;                       // onend follows and is judged there
      active = false;
      reportedError = true;
      if (onError) onError(e.error || 'unknown');
    };
    r.onend = () => {
      if (r !== rec) return;
      if (onInterim) onInterim('');
      if (reportedError) { reportedError = false; return; }   // the app already dealt with it
      deadSessions = (!heard && Date.now() - startedAt < DEAD_MS) ? deadSessions + 1 : 0;
      if (active && continuous) {
        if (deadSessions >= DEAD_LIMIT) {                       // starts, dies at once, never hears: not going to work here
          active = false;
          setState(false);
          if (onError) onError('unavailable');
          return;
        }
        restartTimer = setTimeout(() => { if (active) safeStart(); }, 300);
      } else {
        active = false;
        setState(false);
      }
    };
    return r;
  }

  function safeStart() {
    try {
      rec = build();
      startedAt = Date.now();
      heard = false;
      lastFinalIndex = -1; // a fresh instance has a fresh results[] list
      rec.start();
    } catch {
      active = false;
      setState(false);
      if (onError) onError('start-failed');
    }
  }

  return {
    get running() { return active; },
    start() {
      if (active) return;
      active = true;
      deadSessions = 0;
      reportedError = false;
      recentFinals = [];
      setState(true);
      safeStart();
    },
    stop() {
      const wasActive = active;
      active = false;
      clearTimeout(restartTimer);
      const old = rec;
      rec = null; // whatever the old instance still reports is ignored
      if (old) { try { old.stop(); } catch { /* already stopped */ } }
      if (wasActive) setState(false);
    },
    setLang(code) {
      lang = code;
      if (active) { this.stop(); this.start(); }
    },
  };
}

// ---------- Speaking ----------

let primed = false;

/** The voice list loads asynchronously on phones; resolve once it's there (or give up). */
function voicesReady() {
  return new Promise((resolve) => {
    if (!canSpeak()) return resolve([]);
    const now = speechSynthesis.getVoices();
    if (now && now.length) return resolve(now);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(speechSynthesis.getVoices() || []);
    };
    try { speechSynthesis.addEventListener('voiceschanged', done, { once: true }); } catch { /* older engines */ }
    setTimeout(done, 1500);
  });
}

const normLang = (l) => String(l || '').toLowerCase().replace('_', '-');

function pickVoice(voices, tag) {
  const want = normLang(tag);
  const base = want.split('-')[0];
  return voices.find((v) => normLang(v.lang) === want)
    || voices.find((v) => normLang(v.lang).startsWith(base + '-'))
    || voices.find((v) => normLang(v.lang) === base)
    || null;
}

/** Does this phone have any voice that can read `code` aloud? */
export async function hasVoiceFor(code) {
  if (!canSpeak()) return false;
  return !!pickVoice(await voicesReady(), speechLang(code));
}

/**
 * Phones only let a page speak after a tap. Call this from a tap handler once; afterwards
 * speak() may run from anywhere (e.g. right after a translation arrives).
 */
export function primeSpeech() {
  if (primed || !canSpeak()) return;
  primed = true;
  try {
    speechSynthesis.getVoices();  // nudge the voice list into loading
    speechSynthesis.cancel();     // clear anything left wedged in the queue
    // Real text, not a blank: some engines silently drop an empty utterance and then never
    // fire `end`, which leaves speechSynthesis stuck "speaking" and kills every later call.
    const u = new SpeechSynthesisUtterance('.');
    u.volume = 0;
    speechSynthesis.speak(u);
    speechSynthesis.resume();
  } catch { /* nothing to do */ }
}

/**
 * Read `text` aloud in `lang`.
 * Resolves true when it actually played, false if the phone couldn't say it.
 */
export function speak(text, lang) {
  if (!canSpeak() || !text) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let keepAlive = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(keepAlive);
      resolve(ok);
    };

    const go = async () => {
      const voices = await voicesReady();
      const tag = speechLang(lang);
      const voice = pickVoice(voices, tag);
      const u = new SpeechSynthesisUtterance(text);
      u.lang = tag;
      if (voice) u.voice = voice;
      u.volume = 1;
      u.rate = 1;
      u.pitch = 1;
      u.onstart = () => { started = true; };
      u.onend = () => finish(started);
      u.onerror = () => finish(false);
      try {
        speechSynthesis.resume(); // Chrome sometimes leaves the queue paused
        speechSynthesis.speak(u);
      } catch {
        finish(false);
        return;
      }
      // Chrome cuts long utterances off after ~15 s unless nudged.
      keepAlive = setInterval(() => {
        try {
          if (!speechSynthesis.speaking) return;
          speechSynthesis.pause();
          speechSynthesis.resume();
        } catch { /* ignore */ }
      }, 10_000);
      // Some phones never fire `end`; don't hang the caller forever.
      timer = setTimeout(() => finish(started), 5000 + text.length * 110);
    };

    let started = false;
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
      setTimeout(go, 150); // cancel() immediately followed by speak() can drop the utterance
    } else {
      go();
    }
  });
}

/** What to tell the user when listening fails. */
export function listenErrorText(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Allow the microphone for this app in your phone’s settings, then try again.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'network':
      return 'Listening needs an internet connection.';
    case 'language-not-supported':
      return 'This language isn’t available for listening on this phone.';
    case 'unavailable':
      return 'This phone can’t listen from here. Type in the box below, or use the microphone key on the keyboard.';
    default:
      return 'Listening stopped unexpectedly. Tap the language again to retry.';
  }
}
