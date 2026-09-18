# The voice Worker — speaking in your own voice

This is the small piece that lets the chat read messages aloud in **your** voice instead of the
phone's robot voice. It's optional: skip it and everything else still works.

It exists for one reason: the app is a public web page, so an ElevenLabs API key put inside it
could be read by anyone and used to run up your bill. The key lives in this Worker instead, and
the Worker only answers phones signed in to your own Firebase project.

**Cost:** ElevenLabs **Starter, $5/month** (the free plan can't clone voices). That includes
about 30,000 characters of speech a month — far more than two people talking. Cloudflare Workers
is free at this size.

---

## Setup (about 10 minutes, once)

### 1. Get an ElevenLabs API key

1. Sign up at https://elevenlabs.io and subscribe to the **Starter** plan ($5/month).
2. Click your profile (bottom left) → **API Keys** → **Create API Key**. Copy it — you only see it once.

### 2. Create the Worker

1. Sign up at https://dash.cloudflare.com (free).
2. In the left menu: **Workers & Pages** → **Create** → **Start with Hello World!** → **Deploy**.
3. Name it something like `chat-voice`. After it deploys, click **Edit code**.
4. Delete everything in the editor, paste the whole contents of
   [`voice-worker.js`](voice-worker.js), and click **Deploy**.

### 3. Give it the two keys

Still in the Worker: **Settings** → **Variables and Secrets** → **Add**, twice:

| Name | Value | Type |
|---|---|---|
| `ELEVENLABS_API_KEY` | the key from step 1 | Secret |
| `FIREBASE_API_KEY` | the `apiKey` value from [`../firebase-config.js`](../firebase-config.js) | Secret |

Click **Deploy** so the changes take effect.

*(Optional, tighter: add `ALLOWED_UIDS` — a comma-separated list of your two phones' sign-in ids —
to lock the Worker to just your phones. Leave it out and any phone signed in to your Firebase
project can use it, which for a private chat is already a small door.)*

### 4. Point the app at it

Your Worker has an address like `https://chat-voice.yourname.workers.dev`. Open it in a browser
with `/health` on the end — it should say `{"ok":true,"configured":true}`. If `configured` is
`false`, a key in step 3 is missing.

Then put that address into [`../voice-config.js`](../voice-config.js):

```js
export const voiceWorkerUrl = 'https://chat-voice.yourname.workers.dev';
```

Commit and push that change (or ask Claude to). Within a minute or two the live app picks it up.

### 5. Re-publish the database rules

Recording a voice stores a small id on your place in the chat, which the current rules don't allow
yet. In the Firebase console → **Firestore Database** → **Rules**, paste the latest
[`../firestore.rules`](../firestore.rules) again and click **Publish**.

### 6. Record

On each phone: ⚙ **Settings** → **Your voice** → tick the consent box → **Start recording** →
read the paragraph out loud for about a minute → **Stop & save**. Then open **Talk** and say
something; the translation comes back in that person's voice.

---

## Notes

- **Each person records on their own phone.** The voice is used for what *that person* says, so
  your partner hears your words in your voice, and you hear theirs in theirs.
- **Consent matters.** Only record your own voice, or someone's with their agreement — the app
  asks you to confirm this before anything is uploaded.
- **Repeats are free.** Every phrase spoken in a cloned voice is stored on the phone, so saying
  the same thing again costs nothing.
- **It always falls back.** No Worker, no recording, no signal, or an empty ElevenLabs balance —
  the phone's built-in voice takes over and the chat keeps working.
- **To turn it off:** Settings → *Stop using my voice*, or blank out `voiceWorkerUrl`. To remove
  the voice at ElevenLabs entirely, delete it in their dashboard under **Voices**.
