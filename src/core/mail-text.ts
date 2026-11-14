/**
 * A saved mail (.eml) as a person reads it: its sender, recipient, subject and date, and its body,
 * the plain text part, else the HTML part. Small and without Node, so the UI reads one in the browser
 * and in the static audit export alike (FileView). Attachments are left out.
 */

export interface MailText {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  /** The plain text body, when the mail has one. */
  text?: string;
  /** The HTML body, when the mail has no plain text. */
  html?: string;
}

interface Part { headers: Map<string, string>; body: string }

function split(raw: string): Part {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? '' : raw.slice(at).replace(/^\r?\n\r?\n/, '');
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const c = line.indexOf(':');
    if (c > 0) {
      const name = line.slice(0, c).trim().toLowerCase();
      if (!headers.has(name)) headers.set(name, line.slice(c + 1).trim());
    }
  }
  return { headers, body };
}

const param = (value: string | undefined, name: string) => new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, 'i').exec(value ?? '')?.[1];

function bytesOfBinary(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeBytes(bytes: Uint8Array, charset = 'utf-8'): string {
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

function base64Bytes(s: string): Uint8Array {
  try { return bytesOfBinary(atob(s.replace(/[^A-Za-z0-9+/=]/g, ''))); } catch { return bytesOfBinary(s); }
}

const qpBytes = (s: string, underscore = false) =>
  bytesOfBinary((underscore ? s.replace(/_/g, ' ') : s).replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));

/** A header's encoded words (RFC 2047) as text. The raw mail is read as Latin-1, one character per byte. */
function header(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const words = value.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1');
  return decodeBytes(bytesOfBinary(words), 'utf-8').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, text: string) =>
    decodeBytes(enc.toUpperCase() === 'B' ? base64Bytes(text) : qpBytes(text, true), charset));
}

function bodyText(part: Part): string {
  const enc = (part.headers.get('content-transfer-encoding') ?? '').toLowerCase();
  const bytes = enc === 'base64' ? base64Bytes(part.body) : enc === 'quoted-printable' ? qpBytes(part.body) : bytesOfBinary(part.body);
  return decodeBytes(bytes, param(part.headers.get('content-type'), 'charset') ?? 'utf-8');
}

/** The first part of `type` (text/plain or text/html) in the mail's tree, attachments skipped. */
function find(part: Part, type: string): Part | undefined {
  const ct = (part.headers.get('content-type') ?? 'text/plain').toLowerCase();
  if (ct.startsWith('multipart/')) {
    const boundary = param(part.headers.get('content-type'), 'boundary');
    if (!boundary) return undefined;
    const pieces = part.body.split(`--${boundary}`).slice(1);
    for (const piece of pieces) {
      if (piece.startsWith('--')) break;
      const found = find(split(piece.replace(/^\r?\n/, '')), type);
      if (found) return found;
    }
    return undefined;
  }
  const attached = /attachment/i.test(part.headers.get('content-disposition') ?? '');
  return !attached && ct.startsWith(type) ? part : undefined;
}

/** `raw`: the file's bytes read as Latin-1 (one character per byte), so each part decodes by its own charset. */
export function mailText(raw: string): MailText {
  const top = split(raw);
  const plain = find(top, 'text/plain');
  const html = plain ? undefined : find(top, 'text/html');
  return {
    from: header(top.headers.get('from')),
    to: header(top.headers.get('to')),
    subject: header(top.headers.get('subject')),
    date: top.headers.get('date'),
    ...(plain && { text: bodyText(plain) }),
    ...(html && { html: bodyText(html) }),
  };
}
