// voice-worker.js — a tiny Cloudflare Worker that stands between the app and ElevenLabs.
//
// Why it exists: the app is a public web page, so an ElevenLabs API key put inside it could be
// read by anyone and used to drain the account. The key lives here instead, and this Worker only
// answers callers who are signed in to *your* Firebase project.
//
// Deploy: see worker/README.md (about 10 minutes, free).
//
// Endpoints
//   POST /voice/clone  — multipart: name, files[]  → { voice_id }
//   POST /voice/speak  — json: { text, voiceId, lang } → audio/mpeg
//   GET  /health       — plain OK, for checking the deploy worked
//
// Every request needs an `Authorization: Bearer <firebase id token>` header.

const ELEVEN = 'https://api.elevenlabs.io/v1';
const MODEL = 'eleven_multilingual_v2'; // speaks other languages in the cloned voice
const MAX_TEXT = 600;                   // one spoken line; also caps what a single call can cost
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

const ALLOWED_ORIGINS = [
  'https://gnl-digital-group.github.io',
  'http://localhost:8790',
  'http://localhost:8791',
];

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });

/**
 * Confirm the caller is signed in to our Firebase project.
 * Uses Firebase's own lookup endpoint, so there's no JWT crypto to get wrong here.
 */
async function verifyCaller(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user = data.users && data.users[0];
  if (!user || !user.localId) return null;
  // Optional extra lock: set ALLOWED_UIDS to a comma-separated list to restrict it to your phones.
  const allow = (env.ALLOWED_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(user.localId)) return null;
  return user.localId;
}

async function handleSpeak(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400, origin);
  }
  const text = String(body.text || '').trim();
  const voiceId = String(body.voiceId || '').trim();
  if (!text || !voiceId) return json({ error: 'missing_text_or_voice' }, 400, origin);
  if (text.length > MAX_TEXT) return json({ error: 'text_too_long' }, 413, origin);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(voiceId)) return json({ error: 'bad_voice_id' }, 400, origin);

  const res = await fetch(`${ELEVEN}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      output_format: 'mp3_44100_128',
      voice_settings: { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: true },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: 'tts_failed', status: res.status, detail: detail.slice(0, 300) }, 502, origin);
  }
  return new Response(res.body, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', ...cors(origin) },
  });
}

async function handleClone(request, env, origin) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_UPLOAD_BYTES) return json({ error: 'recording_too_large' }, 413, origin);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'bad_form' }, 400, origin);
  }
  const name = String(form.get('name') || 'Chat voice').slice(0, 60);
  const files = form.getAll('files').filter((f) => typeof f === 'object' && f);
  if (!files.length) return json({ error: 'no_audio' }, 400, origin);

  const out = new FormData();
  out.append('name', name);
  out.append('remove_background_noise', 'true');
  for (const f of files) out.append('files', f, f.name || 'sample.webm');

  const res = await fetch(`${ELEVEN}/voices/add`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
    body: out,
  });
  const detail = await res.text();
  if (!res.ok) {
    return json({ error: 'clone_failed', status: res.status, detail: detail.slice(0, 400) }, 502, origin);
  }
  let parsed = {};
  try { parsed = JSON.parse(detail); } catch { /* shouldn't happen */ }
  if (!parsed.voice_id) return json({ error: 'no_voice_id', detail: detail.slice(0, 200) }, 502, origin);
  return json({ voice_id: parsed.voice_id }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (url.pathname === '/health') {
      const ready = !!env.ELEVENLABS_API_KEY && !!env.FIREBASE_API_KEY;
      return json({ ok: true, configured: ready }, 200, origin);
    }
    if (request.method !== 'POST') return json({ error: 'not_found' }, 404, origin);
    if (!env.ELEVENLABS_API_KEY || !env.FIREBASE_API_KEY) {
      return json({ error: 'worker_not_configured' }, 500, origin);
    }

    const uid = await verifyCaller(request, env);
    if (!uid) return json({ error: 'not_signed_in' }, 401, origin);

    if (url.pathname === '/voice/speak') return handleSpeak(request, env, origin);
    if (url.pathname === '/voice/clone') return handleClone(request, env, origin);
    return json({ error: 'not_found' }, 404, origin);
  },
};
