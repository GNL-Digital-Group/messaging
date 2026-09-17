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
  const DEAD_MS = 1500;
  const DEAD_LIMIT = 3;
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
        const text = (res[0] && res[0].transcript) || '';
        if (res.isFinal) {
          if (text.trim() && onFinal) onFinal(text.trim());
        } else {
          interim += text;
        }
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

let primed = false;

/**
 * Phones only let a page speak after a tap. Call this from a tap handler once; afterwards
 * speak() may run from anywhere (e.g. right after a translation arrives).
 */
export function primeSpeech() {
  if (primed || !canSpeak()) return;
  primed = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch { /* nothing to do */ }
}

/** Read `text` aloud in `lang`. Resolves when it has finished (or couldn't play). */
export function speak(text, lang) {
  if (!canSpeak() || !text) return Promise.resolve(false);
  return new Promise((resolve) => {
    const go = () => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = speechLang(lang);
      const want = u.lang.toLowerCase();
      const base = want.split('-')[0];
      const voices = speechSynthesis.getVoices(); // may still be empty on a phone — the lang alone is enough
      const voice = voices.find((v) => v.lang.toLowerCase() === want) || voices.find((v) => v.lang.toLowerCase().startsWith(base));
      if (voice) u.voice = voice;
      let done = false;
      const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
      u.onend = () => finish(true);
      u.onerror = () => finish(false);
      const timer = setTimeout(() => finish(true), 4000 + text.length * 90); // some phones never fire onend
      speechSynthesis.speak(u);
    };
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      setTimeout(go, 80); // cancel() immediately followed by speak() can drop the utterance on iOS
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
