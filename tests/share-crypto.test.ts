/**
 * The share format in the app (src/share/crypto/, a copy of the share service's src/crypto/): it
 * must write and read exactly the bytes of the service's published vectors (tests/fixtures/share/
 * share-v1.json, a copy of its test-vectors/share-v1.json), and refuse what was changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decrypt, decryptFile, decryptIndex, encrypt, encryptFile, encryptIndex, generateKey, HEADER_LENGTH, newObjectId, openProof,
  sha256Hex, ShareCryptoError, TAG_LENGTH, unwrapKey, wrapKey, type ShareIndex,
} from '../src/share/crypto/index.js';
import { parseLink, serviceOf } from '../src/share/service.js';

const vectors = JSON.parse(readFileSync('tests/fixtures/share/share-v1.json', 'utf8')) as {
  openProof: { key: string; proof: string };
  vectors: Array<{ description: string; key: string; salt: string; kind: 'file' | 'index' | 'meta' | 'wrap'; name: string; chunkSize: number; plaintext: string; blob: string }>;
};
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

async function refused(p: Promise<unknown>, code: ShareCryptoError['code']): Promise<void> {
  const e = await p.then(() => null, (x: unknown) => x);
  assert.ok(e instanceof ShareCryptoError, `expected a ShareCryptoError, got ${String(e)}`);
  assert.equal((e as ShareCryptoError).code, code);
}

for (const v of vectors.vectors) {
  test(`vector: ${v.description}`, async () => {
    const blob = await encrypt(fromHex(v.key), fromHex(v.plaintext), { kind: v.kind, name: v.name, chunkSize: v.chunkSize, salt: fromHex(v.salt) });
    assert.equal(hex(blob), v.blob);
    assert.equal(hex(await decrypt(fromHex(v.key), fromHex(v.blob), { kind: v.kind, name: v.name })), v.plaintext);
  });
}

test('vector: the open proof is HKDF of the key, and not the key', async () => {
  assert.equal(await openProof(fromHex(vectors.openProof.key)), vectors.openProof.proof);
  const key = generateKey();
  assert.notEqual(await openProof(key), Buffer.from(key).toString('base64url'));
});

test('a return key is bound to its return: unwrapped under another id it fails', async () => {
  const share = generateKey(), ret = generateKey();
  const id = newObjectId();
  const wrapped = await wrapKey(share, ret, id);
  assert.deepEqual(await unwrapKey(share, wrapped, id), ret);
  await refused(unwrapKey(share, wrapped, newObjectId()), 'auth');
  await refused(unwrapKey(generateKey(), wrapped, id), 'auth');
});

test('a chunk swapped, cut or changed fails; a wrong key fails; one file opens without the others', async () => {
  const key = generateKey();
  const plain = new Uint8Array(64 * 3 + 10).map((_, i) => (i * 7) & 0xff);
  const blob = await encrypt(key, plain, { kind: 'file', name: 'abcdefghijklmnopqrstuvwxyz', chunkSize: 64 });
  const chunk = 64 + TAG_LENGTH;
  const swapped = blob.slice();
  swapped.set(blob.subarray(HEADER_LENGTH + chunk, HEADER_LENGTH + 2 * chunk), HEADER_LENGTH);
  swapped.set(blob.subarray(HEADER_LENGTH, HEADER_LENGTH + chunk), HEADER_LENGTH + chunk);
  await refused(decrypt(key, swapped, { kind: 'file', name: 'abcdefghijklmnopqrstuvwxyz' }), 'auth');
  await refused(decrypt(key, blob.subarray(0, HEADER_LENGTH + 2 * chunk), { kind: 'file', name: 'abcdefghijklmnopqrstuvwxyz' }), 'truncated');
  const flipped = blob.slice(); flipped[blob.length - 1] ^= 1;
  await refused(decrypt(key, flipped, { kind: 'file', name: 'abcdefghijklmnopqrstuvwxyz' }), 'auth');
  await refused(decrypt(generateKey(), blob, { kind: 'file', name: 'abcdefghijklmnopqrstuvwxyz' }), 'auth');
  // Stored under another object's name, it fails too: the service cannot swap objects.
  await refused(decrypt(key, blob, { kind: 'file', name: 'zyxwvutsrqponmlkjihgfedcba' }), 'auth');

  const a = newObjectId(), b = newObjectId();
  const files = { 'ledger.json': new TextEncoder().encode('{}'), 'transactional-data/2026/receipts/a.pdf': new TextEncoder().encode('%PDF') };
  const index: ShareIndex = { format: 1, kind: 'full', files: [
    { path: 'ledger.json', object: a, bytes: 2, sha256: await sha256Hex(files['ledger.json']) },
    { path: 'transactional-data/2026/receipts/a.pdf', object: b, bytes: 4, sha256: await sha256Hex(files['transactional-data/2026/receipts/a.pdf']) },
  ] };
  const read = await decryptIndex(key, await encryptIndex(key, index));
  const only = await decryptFile(key, read.files[1], await encryptFile(key, b, files['transactional-data/2026/receipts/a.pdf']));
  assert.equal(new TextDecoder().decode(only), '%PDF');
  // A file sealed under one object id and named under another in the index fails.
  await refused(decryptFile(key, { ...read.files[1], object: a }, await encryptFile(key, b, files['transactional-data/2026/receipts/a.pdf'])), 'auth');
});

test('links: the service\'s page link and the app\'s scheme; the key only in the fragment', () => {
  const key = Buffer.from(generateKey()).toString('base64url');
  const id = 'abcdefghijklmnopqrstuvwxyz';
  assert.deepEqual(parseLink(`https://share.example.ch/${id}#${key}`), { service: 'https://share.example.ch', id, key });
  assert.deepEqual(parseLink(`vanilla-accounting://open?share=${id}#${key}`, 'https://share.example.ch'), { service: 'https://share.example.ch', id, key });
  assert.deepEqual(parseLink(`vanilla-accounting://open?share=${id}&service=https%3A%2F%2Fother.example#${key}`, 'https://share.example.ch'), { service: 'https://other.example', id, key });
  assert.equal(parseLink(`vanilla-accounting://open?share=${id}#${key}`, undefined), undefined, 'no service known');
  assert.equal(parseLink(`https://share.example.ch/${id}`), undefined, 'no key');
  assert.equal(parseLink(`https://share.example.ch/${id}#short`), undefined, 'not a key');
  assert.equal(parseLink(`http://share.example.ch/${id}#${key}`), undefined, 'http only on this computer');
  assert.deepEqual(parseLink(`http://localhost:8787/${id}#${key}`), { service: 'http://localhost:8787', id, key });
  assert.equal(parseLink(`https://share.example.ch/notanid#${key}`), undefined);
  assert.equal(serviceOf('share.example.ch/'), 'https://share.example.ch');
  assert.throws(() => serviceOf('ftp://x'));
});
