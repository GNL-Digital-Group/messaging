# Chat with Gregorio

A private chat for two people who read different languages. Each of you picks your
language once; from then on every message shows up in *your* language, and a tap
reveals the original.

No accounts, no passwords, no codes: the first two phones to open the app **are** the
chat, and nobody else can get in. It installs on an iPhone or Android phone from a
link (no App Store), keeps working offline for reading, and costs nothing to run.

- **Link (once published):** https://gnl-digital-group.github.io/messaging/
- **Demo without any setup:** add `?demo=1` to the link to chat with a robot that replies in another language.

---

## Setup

You do this **once**, from a computer. It takes about five to ten minutes and needs
your Google account (Firebase is Google's free app backend). No credit card is asked for.

### 1. Create a Firebase project

1. Go to https://console.firebase.google.com and sign in with your Google account.
2. Click **Create a project** (or **Add project**). Name it anything, e.g. `chat`.
3. If it offers **Gemini in Firebase**, leave it off. When asked about **Google Analytics**, turn it
   **off** — it isn't needed. Click **Create project**, then **Continue**.

### 2. Add a web app and copy its settings

1. On the project's home page click the **`</>`** (Web) icon under "Get started by adding Firebase to your app".
2. Nickname: `chat`. Leave "Firebase Hosting" **unchecked**. Click **Register app**.
3. You'll see a block of code containing `const firebaseConfig = { apiKey: "…", … }`.
   Copy the six values inside the braces into [`firebase-config.js`](firebase-config.js),
   replacing each `PASTE_…` placeholder. (Or paste the whole block to Claude and ask it to update the file.)
4. Click **Continue to console**.
5. **Get the edited file onto GitHub** — the published app is built from what's in this repository,
   not from your computer. Easiest: ask Claude to commit and push it. By hand: on github.com open
   `firebase-config.js`, click the **pencil** (Edit), replace the placeholders, click **Commit changes**.
   (These values are meant to be public; the security rules in step 4 are what protect your chat.)

### 3. Turn on anonymous sign-in

1. In the left menu open **Authentication** (it's under *Security*; older layouts list it under *Build*). Click **Get started**.
2. Open the **Sign-in method** tab, choose **Anonymous**, switch it to **Enable**, click **Save**.

(This is how the app tells your two phones apart without either of you making an account.)

### 4. Create the database and paste the rules

1. Left menu: **Firestore Database** (under *Databases & Storage*, or *Build*) → **Create database**.
2. Pick the location nearest you, click **Next**, choose **Start in production mode**, click **Create**.
3. Open the **Rules** tab. Delete everything in the editor and paste the contents of
   [`firestore.rules`](firestore.rules). Click **Publish**.

These rules are what make the chat private — don't skip them.

### 5. Publish the app

The app is plain files, so GitHub can host it for free from this repository:

1. On GitHub, open this repository → **Settings → General**, scroll to **Danger Zone → Change visibility → Make public**.
   (GitHub's free plan only serves websites from public repositories. Nothing secret is in the code.)
2. **Settings → Pages**. Under **Build and deployment**, set **Source: Deploy from a branch**,
   **Branch: `main`**, folder **`/ (root)`**, click **Save**.
3. Wait a minute, then open **https://gnl-digital-group.github.io/messaging/**. That's your link.

Every later change pushed to `main` goes live automatically within a minute or two.

---

## Install it on your phones

> **Only two phones can ever be in the chat.** A computer counts as one — and on an iPhone,
> a Safari tab and the Home Screen icon count as two *different* phones. If you peek at the
> link on your computer first, that's fine — afterwards open ⚙ Settings on your phone and tap
> **Disconnect** next to the computer so your partner's phone can take its place.

**iPhone / iPad** — must be done from **Safari** (if the link opened inside another app such as
WhatsApp or Mail, use its share/⋯ button → *Open in Safari* first):
1. Open the link above in Safari. It will ask you to add it to your Home Screen (don't type a name here).
2. Tap the **Share** button (the square with an arrow; on newer iPhones it's inside the **⋯** button),
   then **Add to Home Screen**, then **Add**. If it shows an *Open as Web App* switch, leave it on.
3. Open the new icon and enter your name and language **there**. From now on always use the icon.

**Android** — from **Chrome**:
1. Open the link in Chrome.
2. Tap the **Install** prompt if one appears, or the **⋮** menu → **Add to Home screen** → **Install**.

It then opens full-screen from its own icon like any other app.

## Using it

- On first open (from the icon) each of you enters a **name** and the **language you read**. That's it.
- Type in your own language. Your partner sees it in theirs. Tap any message to see the
  original, or how yours was delivered.
- The **⚙** button changes your name or language, shows which two phones are connected, and
  imports old messages.
- With a long history, **Show earlier messages** at the top of the chat pages back through it.

### Talk: speak in one language, the phone says it in the other

Tap **Talk** at the top of the chat. It shows two big buttons — your language and your
partner's (English and Español, say). Whoever is about to talk taps theirs and speaks. Each
sentence is shown in **both** languages, large enough for both of you to read, and the phone
**says the translation out loud** (the microphone pauses while it speaks, then listens again).
Tap the other button when the other person talks. It's a pocket interpreter for when you're
in the same room; Talk doesn't save anything to the chat (the sentences go to the translation service, like any message).

- *Say it aloud* under the buttons turns the voice off if you'd rather just read. The 🔊 button
  on any line repeats it.
- The phone can't tell which language it's hearing on its own, which is why there are two
  buttons instead of one. *Change languages* swaps in any other pair.

Talk uses the phone's own speech recognition and voices and needs an internet connection. On
**Android** it all happens inside the app: the first time, allow the microphone when Chrome asks.

On an **iPhone** there's a catch: Apple doesn't let an app opened from the Home Screen listen
through the microphone (Safari can, the installed app can't). So in the app, Talk works by
typing — tap the language, then use the **microphone key on the iPhone keyboard** to dictate into
the box, and the translation is still shown large and read aloud. For hands-free voice, open
the separate **Talk page in Safari**: https://gnl-digital-group.github.io/messaging/talk.html —
you can add it to the Home Screen too (Share → Add to Home Screen); that icon opens in Safari
and listens properly. Needs no setup and nothing from it is stored in the chat.

### Speak instead of typing

On Android, the microphone next to the message box dictates into it in your language. Tap it,
talk, tap again (or just pause) — then send as usual; allow the microphone the first time the
phone asks. On an iPhone there is no microphone button in the app: tap the message box and use
the microphone key on the keyboard instead.

### Bringing in your old messages

⚙ Settings → **Import old messages…** brings an existing conversation into this chat, in order,
with each message attributed to the right person. It understands:

- **WhatsApp** — *iPhone:* open the chat, tap the name at the top, scroll down, **Export Chat →
  Without Media**, then **Save to Files** (it's a `.zip` called "WhatsApp Chat - …", in the Files
  app). *Android:* open the chat, tap **⋮ → More → Export chat → Without media**, then choose
  **Drive** in the share panel and tap Save (no Drive? choose Gmail and send it to yourself, then
  open the attachment on the phone). Android keeps no copy of its own — if you close that panel
  without choosing, there is no file. Then pick the file in the import screen; on Android the
  picker's **☰** menu gets you to Drive or Downloads. The `.txt` and the `.zip` both work.
- **Android text messages** — install the free **SMS Backup & Restore** app (SyncTech), make a
  backup of messages, saved to the phone, and pick its `.xml` file. The file holds every
  conversation on the phone; you choose which one to import. If your conversation is missing or
  stops partway, it's probably encrypted RCS "chats": in the app, **Settings → Backup settings →
  Back up as default SMS app**, then back up again.
- **iPhone text messages** — Apple doesn't let apps read them. If either of you is on Android,
  back up from that phone: it contains both sides of your conversation. On the import screen the
  row *"Texts sent from the phone that made the backup"* is then your **partner**, not you — the
  app asks when it can't tell from the names.

Photos and attachments aren't imported, only text. Imported messages are translated **when you
tap them** rather than all at once, so a big history doesn't use up the free translation limit.

**Check *Who is this?* (and, for a text-message backup, *Which conversation?*) before you tap
Import.** Those choices can't be undone in the app: importing again with the people swapped adds
a second copy on the other side instead of fixing the first. Two things *are* safe to redo:
importing the same file again with the same choices changes nothing, and if only the *Written in*
language was wrong, import again with the right one — the messages are replaced in place. If an
import really went wrong, delete the `rooms` collection in Firebase console → Firestore Database
and start fresh (this also removes both phones' places and the live messages).

### If one of you gets a new phone

The old phone still holds its place, so the new one will say *"This chat already has two phones."*
On the **other** phone: ⚙ Settings → **Disconnect** next to the old phone. Then tap
**Try again** on the new phone and it joins — with all the old messages still on the right side.

The same fix applies if a place got taken by mistake (your computer, an earlier try, or a Safari
tab on an iPhone): Settings on the device that is in the chat shows who holds the other place —
if it's *your own* name, that's the stray one; disconnect it. After disconnecting, the app offers
to delete the messages that device sent — say yes for a test device (otherwise your partner's
phone would inherit them), no for a partner's old phone.

(If *both* phones are gone, delete the `rooms` collection in Firebase console → Firestore Database
and the next two phones start fresh. Old messages are deleted with it.)

## Good to know

- **Where messages live:** in your own Firebase project, under Google's standard security.
  Only the two connected phones can read them.
- **Translation service:** message text is sent to MyMemory (a free translation service) to be
  translated. It's fine for personal use, but it is a third party. The free limit is about
  5,000 characters a day per network, or 50,000 if you enter an email in the optional field
  in Settings. To move to DeepL or Google Translate later, only [`translate.js`](translate.js) changes.
- **Notifications:** on Android, while the app is open or in the background, a new message buzzes
  the phone and (if you allowed notifications when asked) shows one; tapping it opens the chat. An
  iPhone shows new messages when you open the app. Push notifications when the app is fully
  closed are not included — that's a possible later upgrade.
- **Translation limits:** the newest messages are translated automatically; older ones (and anything
  imported) say *tap to translate* so a long backlog can't use up the free daily limit.
- **Updating the app:** after files change, bump `VERSION` in [`sw.js`](sw.js) so installed
  phones pick up the update on their next open.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `translate.js` | Translation engine + language list |
| `import.js` | Reads WhatsApp exports and SMS backups |
| `speech.js` | Microphone listening and read-aloud |
| `talk.js`, `talk.html`, `talk.webmanifest` | The Talk screen, and its stand-alone page for Safari on an iPhone |
| `firebase-config.js` | Your Firebase project's settings (step 2) |
| `firestore.rules` | Security rules to paste into Firebase (step 4) |
| `manifest.webmanifest`, `sw.js`, `icons/` | What makes it installable and work offline |
| `tools/make-icons.py` | Regenerates the icons (optional) |
