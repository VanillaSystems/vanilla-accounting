// The share's small encrypted envelope: what the share page shows once the browser has the key
// (who sends, the company, a note, the date). The server stores it as opaque base64url and never sees
// its content: it knows no names and no e-mail addresses.

import { fromBase64url, toBase64url } from './base64url.js';
import { decrypt, encrypt, ShareCryptoError } from './share-crypto.js';

/** Most bytes the server accepts for the encrypted envelope (base64url text). */
export const MAX_META_TEXT = 8192;

export interface ShareMeta {
  v: 1;
  /** Who shares, as the page and the app show it: «Anna Muster». */
  senderName: string;
  /** send: the books go out; return: they come back (the fiduciary's corrections). */
  direction: 'send' | 'return';
  /** The company's name, e.g. «Muster Kaffee GmbH». */
  company?: string;
  /** The sender's note to the recipient. */
  note?: string;
  /** The books' state as of this date, ISO yyyy-mm-dd. */
  asOf?: string;
}

export async function encryptMeta(key: Uint8Array, meta: ShareMeta): Promise<string> {
  const text = toBase64url(await encrypt(key, new TextEncoder().encode(JSON.stringify(meta)), { kind: 'meta', name: 'meta' }));
  if (text.length > MAX_META_TEXT) throw new ShareCryptoError('length', `the envelope is longer than ${MAX_META_TEXT} characters`);
  return text;
}

export async function decryptMeta(key: Uint8Array, text: string): Promise<ShareMeta> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64url(text);
  } catch {
    throw new ShareCryptoError('header', 'the envelope is not base64url');
  }
  const plain = await decrypt(key, bytes, { kind: 'meta', name: 'meta' });
  const meta = JSON.parse(new TextDecoder().decode(plain)) as ShareMeta;
  if (meta?.v !== 1 || typeof meta.senderName !== 'string') throw new ShareCryptoError('header', 'unknown envelope version');
  return meta;
}
