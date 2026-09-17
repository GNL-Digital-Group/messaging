// import.js — reads a chat export into plain records the app can import. No dependencies.
//
// Supported files
//   • WhatsApp "Export chat": the .txt (Android) or the .zip holding _chat.txt (iPhone), in
//     either layout — "12/25/23, 9:41 PM - Name: text" or "[12/25/23, 9:41:23 PM] Name: text".
//   • Android text messages saved by the "SMS Backup & Restore" app (its .xml file — read in
//     slices with the picture data stripped, since those backups can be hundreds of MB).
//
// readExport(file) → {
//   format: 'whatsapp' | 'sms',
//   messages: [{ ts, key, sender, text, thread }],
//     ts     = ms since epoch in this phone's time zone, made strictly increasing in file order
//     key    = the time as written in the file (to the minute) — the same on any phone, in any zone
//     sender = ME for the exporting phone's own texts (SMS), or the WhatsApp display name
//   threads:  [{ key, label, count }],          // SMS conversations (one per contact); empty for WhatsApp
//   skipped:  { media, deleted, system },
//   ambiguousDates, dayFirst,                   // WhatsApp only: could the day/month order not be proven?
// }

export const ME = '__me__';

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

const XML_HEAD = /^(?:<\?xml|<smses[\s>])|<(?:sms|mms)\s/;

export async function readExport(file, options = {}) {
  const name = (file.name || '').toLowerCase();
  const isZip = name.endsWith('.zip') || /zip/.test(file.type || '');

  if (!isZip) {
    // Sniff a few KB before reading the whole file: an SMS backup with pictures can be huge.
    const head = stripBom(await file.slice(0, 5000).text()).trimStart();
    if (XML_HEAD.test(head)) return parseSmsBackup(await readXmlWithoutAttachments(file));
  }

  const text = stripBom(isZip ? await unzipChatText(file) : await file.text());
  const result = parseWhatsApp(text, options);
  if (!result.messages.length && !result.skipped.media && !result.skipped.system) {
    throw new ImportError('This doesn’t look like a WhatsApp export or an SMS backup file.');
  }
  return result;
}

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Give same-minute messages distinct, file-ordered times so ids, ordering and paging stay exact. */
function spreadTimestamps(messages) {
  messages.sort((a, b) => a.ts - b.ts); // stable: keeps file order within a minute
  let last = 0;
  for (const m of messages) {
    if (m.ts <= last) m.ts = last + 1;
    last = m.ts;
  }
  return messages;
}

// ---------- WhatsApp ----------

// "[12/25/23, 9:41:23 PM] Name: text"  ·  "12/25/23, 9:41 PM - Name: text"  ·  "25/12/2023 21:41 - Name: text"  ·  "2023-12-25, 21:41 - Name: text"
const HEADER = /^\[?(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})[,.]?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:\s*([ap])\.?\s?m\.?)?\]?\s*(?:[-–—]\s*)?(.*)$/i;

const MEDIA = /^(?:<[^>]*(?:omitted|omitido|omitida|omis|omesso|weggelassen|ausgelassen)[^>]*>|<(?:attached|adjunto|anexo|anexado|pièce jointe|allegato|angehängt)[^>]*>|(?:image|video|audio|sticker|gif|document|contact card|imagen|v[ií]deo|documento|tarjeta de contacto)\s+(?:omitted|omitido|omitida))$/i;
// Android "Include media": "IMG-20231225-WA0001.jpg (file attached)" — the caption, if any, is on the next line.
const ATTACHED = /^(?:.+ \((?:file attached|datei angehängt|archivo adjunto|fichier joint|arquivo anexado|file allegato|bestand bijgevoegd)\)|(?:IMG|VID|AUD|PTT|STK|DOC)-\d{8}-WA\d{4}\.\w{2,5} \([^()]{2,40}\)|.+\.[a-z0-9]{2,5} <attached>)$/i;
const DELETED = /^(?:this message was deleted|you deleted this message|message deleted|se eliminó este mensaje|eliminaste este mensaje|este mensaje fue eliminado|null)\.?$/i;
const EDITED_SUFFIX = /\s*<(?:this message was edited|se editó este mensaje)>$/i;

export function parseWhatsApp(text, { dayFirst } = {}) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/[‎‏]/g, '').replace(/[  ]/g, ' ').split('\n');

  // Pass 1: find every header so the day/month order can be settled from the data itself.
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]);
    if (m) heads.push({ i, m });
  }
  let proven = null;
  for (const { m } of heads) {
    if (m[1].length === 4) continue;                  // year first: no ambiguity
    if (Number(m[1]) > 12) { proven = true; break; }  // first number can't be a month
    if (Number(m[2]) > 12) { proven = false; break; } // second number can't be a month
  }
  const ambiguousDates = proven === null && heads.some(({ m }) => m[1].length !== 4);
  if (proven !== null) dayFirst = proven;
  else if (typeof dayFirst !== 'boolean') dayFirst = !/^en-(us|ca|ph)?$/i.test(navigator.language || 'en-US');

  // Pass 2: build messages; lines that aren't headers continue the previous message.
  const messages = [];
  const skipped = { media: 0, deleted: 0, system: 0 };
  let current = null;
  let headIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = heads[headIdx] && heads[headIdx].i === i ? heads[headIdx++] : null;
    if (!head) {
      if (current && line.trim()) current.text += '\n' + line;
      continue;
    }
    current = null;
    const m = head.m;
    const rest = m[8];
    const colon = rest.indexOf(': ');
    if (colon <= 0) { skipped.system++; continue; } // "Messages and calls are end-to-end encrypted…" etc.
    const when = timestamp(m, dayFirst);
    if (!when) { skipped.system++; continue; }
    current = { ts: when.ts, key: when.key, sender: rest.slice(0, colon).trim(), text: rest.slice(colon + 2), thread: null };
    messages.push(current);
  }

  const kept = [];
  for (const msg of messages) {
    msg.text = msg.text.replace(EDITED_SUFFIX, '').trim();
    const nl = msg.text.indexOf('\n');
    const first = nl < 0 ? msg.text : msg.text.slice(0, nl);
    const rest = nl < 0 ? '' : msg.text.slice(nl + 1).trim();
    if (!first) { skipped.system++; continue; }
    if (DELETED.test(first)) { skipped.deleted++; continue; }
    if (MEDIA.test(first) || ATTACHED.test(first)) {
      skipped.media++;
      if (!rest) continue;
      msg.text = rest; // keep the caption written under a photo
    }
    kept.push(msg);
  }
  return { format: 'whatsapp', messages: spreadTimestamps(kept), threads: [], skipped, ambiguousDates, dayFirst };
}

function timestamp(m, dayFirst) {
  let y, mo, d;
  if (m[1].length === 4) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    y = +m[3];
    if (y < 100) y += 2000;
    if (dayFirst) { d = +m[1]; mo = +m[2]; } else { mo = +m[1]; d = +m[2]; }
  }
  let h = +m[4];
  const min = +m[5];
  const s = m[6] ? +m[6] : 0;
  if (m[7]) h = (h % 12) + (m[7].toLowerCase() === 'p' ? 12 : 0);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59 || y < 2005 || y > 2100) return null;
  const date = new Date(y, mo - 1, d, h, min, s); // local time, like the export
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  // The minute as written in the file: identical on both phones whatever their time zone, and
  // identical between an Android export (no seconds) and an iPhone export of the same chat.
  return { ts: date.getTime(), key: `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(min)}` };
}

// ---------- SMS Backup & Restore (Android) ----------

export function parseSmsBackup(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new ImportError('This backup file could not be read.');

  const messages = [];
  const skipped = { media: 0, deleted: 0, system: 0 };
  const threadOf = (el) => {
    const address = el.getAttribute('address') || '';
    const contact = (el.getAttribute('contact_name') || '').trim();
    const label = contact && contact !== '(Unknown)' ? contact : address;
    return { key: normalizeAddress(address), label };
  };
  const toMs = (v) => { const n = Number(v); return n > 0 && n < 1e11 ? n * 1000 : n; };

  for (const el of doc.getElementsByTagName('sms')) {
    const type = Number(el.getAttribute('type')); // 1 = received, 2 = sent
    const address = el.getAttribute('address') || '';
    if ((type !== 1 && type !== 2) || address.includes('~')) { skipped.system++; continue; }
    const ts = toMs(el.getAttribute('date'));
    const text = (el.getAttribute('body') || '').trim();
    if (!text || !ts) { skipped.system++; continue; }
    const thread = threadOf(el);
    messages.push({ ts, key: String(ts), sender: type === 2 ? ME : thread.label, text, thread });
  }

  for (const el of doc.getElementsByTagName('mms')) {
    const box = Number(el.getAttribute('msg_box')); // 1 = received, 2 = sent
    const address = el.getAttribute('address') || '';
    if ((box !== 1 && box !== 2) || address.includes('~')) { skipped.system++; continue; }
    const ts = toMs(el.getAttribute('date'));
    const text = Array.from(el.getElementsByTagName('part'))
      .filter((p) => (p.getAttribute('ct') || '') === 'text/plain')
      .map((p) => p.getAttribute('text') || '')
      .filter((t) => t && t !== 'null')
      .join('\n')
      .trim();
    if (!text || !ts) { skipped.media++; continue; } // picture-only MMS
    const thread = threadOf(el);
    messages.push({ ts, key: String(ts), sender: box === 2 ? ME : thread.label, text, thread });
  }

  const counts = new Map();
  for (const msg of messages) {
    const t = counts.get(msg.thread.key) || { key: msg.thread.key, label: msg.thread.label, count: 0 };
    t.count++;
    counts.set(msg.thread.key, t);
  }
  const threads = [...counts.values()].sort((a, b) => b.count - a.count);
  if (!messages.length) throw new ImportError('No text messages were found in this backup.');
  return { format: 'sms', messages: spreadTimestamps(messages), threads, skipped, ambiguousDates: false, dayFirst: null };
}

/** "+1 (555) 123-4567" and "5551234567" are the same person. */
function normalizeAddress(address) {
  const digits = address.replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : address.trim().toLowerCase();
}

/**
 * Read an SMS backup a slice at a time, dropping the base64 picture/video data
 * (`data="…"` attributes) so the phone only ever holds the text in memory.
 */
async function readXmlWithoutAttachments(file) {
  const CHUNK = 8 * 1024 * 1024;
  const decoder = new TextDecoder('utf-8');
  const strip = (s) => s.replace(/\sdata="[^"]*"/g, '');
  const out = [];
  let carry = '';
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
    const text = carry + decoder.decode(bytes, { stream: true });
    const cut = text.lastIndexOf('\n');
    if (cut < 0) { carry = text; continue; }
    out.push(strip(text.slice(0, cut + 1)));
    carry = text.slice(cut + 1);
  }
  out.push(strip(carry + decoder.decode()));
  return stripBom(out.join(''));
}

// ---------- Minimal .zip reader (enough for a WhatsApp export) ----------

async function unzipChatText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const bad = () => new ImportError('This .zip file could not be read.');

  // End-of-central-directory record sits in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad();

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(p + 28, true);
    entries.push({
      method: dv.getUint16(p + 10, true),
      size: dv.getUint32(p + 20, true),
      offset: dv.getUint32(p + 42, true),
      name: new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }

  const entry = entries.find((e) => /(^|\/)_chat\.txt$/i.test(e.name))
    || entries.find((e) => /\.txt$/i.test(e.name) && !/^__MACOSX\//.test(e.name));
  if (!entry) throw new ImportError('No chat text file (.txt) was found inside the .zip.');

  const lh = entry.offset;
  if (lh + 30 > buf.length || dv.getUint32(lh, true) !== 0x04034b50) throw bad();
  const start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
  const data = buf.subarray(start, start + entry.size);

  let bytes;
  if (entry.method === 0) {
    bytes = data;
  } else if (entry.method === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new ImportError('This browser can’t open .zip files. Unzip it first and choose the .txt inside.');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new ImportError('This .zip uses a compression method the app can’t open. Unzip it first and choose the .txt inside.');
  }
  return new TextDecoder('utf-8').decode(bytes);
}
