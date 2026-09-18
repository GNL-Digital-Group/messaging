// voice-config.js — connects the app to YOUR voice Worker (the thing that speaks in your voice).
//
// Leave this empty and everything still works: the app just uses the phone's built-in voices.
// To turn on real voice cloning, deploy worker/voice-worker.js (see worker/README.md) and paste
// its address below, e.g. "https://chat-voice.greg.workers.dev".
//
// This address is not a secret — the API key stays inside the Worker, never in this page.

export const voiceWorkerUrl = '';
