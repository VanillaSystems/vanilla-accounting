/**
 * «The share file is the document» (the owner's decision of 2026-11-15, src/handover/document.ts):
 * the Freigabe-Datei a recipient opened is his copy. Three servers stand for three Macs: Sandra's
 * books, Ernst's app, and Ernst's second Mac. His changes are saved into the file he opened; the
 * file, mailed back, opens in her books as a return for review, never as a copy of her own books;
 * opened on another Mac it brings his changes along; a newer file carries his changes over and
 * leaves the older file as it was; a save is atomic. Both extensions open: `.vanillashare` and the
 * `.vanilla` of 0.6.x.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { readPackage, SAVED_MEMBER } from '../src/handover/package.js';
import { writeAtomically, type DocumentState } from '../src/handover/document.js';
import { isVanillaPath } from '../src/desktop/open-files.js';
import { shareClient } from '../src/share/client.js';
import { receivePackage } from '../src/share/transport.js';
import { progressLine } from '../src/desktop/progress-text.js';
import { textsIn } from '../src/app/i18n/texts-in.js';

const dir = mkdtempSync(join(tmpdir(), 'share-document-'));
const ERNST = { name: 'Ernst Beispiel', email: 'ernst@example.ch' };
let sandra: ApiServer;
let ernst: ApiServer;
let ernst2: ApiServer;

before(async () => {
  const fixture = 'tests/fixtures/period-lock-index.json';
  sandra = await startApi(fixture, { VANILLA_DURCHSICHT_DIR: join(dir, 'sandra-copies') });
  ernst = await startApi(fixture, { VANILLA_DURCHSICHT_DIR: join(dir, 'ernst-copies') });
  ernst2 = await startApi(fixture, { VANILLA_DURCHSICHT_DIR: join(dir, 'ernst2-copies') });
});
after(async () => { await sandra?.stop(); await ernst?.stop(); await ernst2?.stop(); });

const downloads = join(dir, 'Downloads');
mkdirSync(downloads, { recursive: true });

/** «Teilen › Als Datei» at Sandra's: the Freigabe-Datei, saved where a download lands. */
async function shareFile(name: string): Promise<string> {
  const res = await sandra.fetch('/api/handover/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: ERNST }) });
  assert.equal(res.status, 200);
  assert.match(decodeURIComponent(res.headers.get('content-disposition') ?? ''), /\.vanillashare$/, 'the app writes .vanillashare only');
  const path = join(downloads, name);
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
  return path;
}

/** A double-click in Finder: the file's bytes and its path, as the Mac app sends them (src/desktop/open-files.ts). */
async function open(api: ApiServer, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await api.fetch('/api/handover/open', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Vanilla-File': encodeURIComponent(path) }, body: new Uint8Array(readFileSync(path)) });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

const doc = async (api: ApiServer) => (await api.send('GET', '/api/handover/document')).json.document as DocumentState | null;
const entries = async (api: ApiServer) => (await api.send('GET', '/books.json')).json.journalEntries as Array<{ id: string; date: string; description: string }>;

let first = '';
let entryId = '';

test('his copy saves into the file he opened: after «Sichern» the file on disk holds his change; the hand-over in it is as it came', async () => {
  first = await shareFile('Muster – Buchhaltung (2026-11-15).vanillashare');
  const before = readPackage(readFileSync(first));
  const opened = await open(ernst, first);
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.kind, 'full');
  assert.equal(opened.json.document, first, 'the file is the copy\'s document');
  assert.deepEqual(await doc(ernst), { path: first, name: 'Muster – Buchhaltung (2026-11-15).vanillashare', dirty: false, missing: false, auto: false, savedAt: (await doc(ernst))!.savedAt });
  const open1 = (await entries(ernst)).find((e) => e.date > '2026-06-30')!;
  entryId = open1.id;
  assert.equal((await ernst.send('PATCH', `/api/journal-entries/${entryId}`, { description: 'von Ernst korrigiert' })).status, 200);
  await ernst.send('PUT', '/api/handover/notes', { key: `entry:${entryId}`, text: 'Falsches Konto' });
  assert.equal((await doc(ernst))!.dirty, true, '«ungespeichert» until saved');
  // By itself (idle, closing) the app does not write into a file she never saved into: macOS may ask for its folder first (#373).
  await ernst.send('POST', '/api/handover/document/save', { auto: true });
  assert.equal(readPackage(readFileSync(first)).saved, undefined, 'nothing written by itself before her first «Sichern»');
  const saved = await ernst.send('POST', '/api/handover/document/save', {});
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal((await doc(ernst))!.auto, true, 'from now on it saves by itself too');
  assert.equal((await doc(ernst))!.dirty, false);
  const after = readPackage(readFileSync(first));
  assert.ok(after.saved, `the file holds ${SAVED_MEMBER}`);
  const ret = readPackage(after.saved!);
  assert.equal(ret.index.kind, 'return');
  assert.ok(JSON.stringify(ret.changes).includes('von Ernst korrigiert'));
  assert.ok(JSON.stringify(ret.changes).includes('Falsches Konto'), 'his «Warum?» too');
  assert.deepEqual(after.index.version, before.index.version, 'the hand-over\'s own members as they came');
  assert.deepEqual([...after.files.keys()].sort(), [...before.files.keys()].sort());
  assert.equal((await ernst.send('POST', '/api/handover/document/save', {})).status, 200, 'a save with nothing new writes nothing and is fine');
});

test('the same file on his other Mac opens with his changes', async () => {
  const opened = await open(ernst2, first);
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.deepEqual(opened.json.restored, { applied: 1, dropped: 0, stale: false });
  assert.equal((await entries(ernst2)).find((e) => e.id === entryId)?.description, 'von Ernst korrigiert');
  assert.equal((await doc(ernst2))!.dirty, false, 'what the file holds counts as saved');
});

test('mailed back, the file opens in Sandra\'s books as his changes for review, never as a copy of her own books', async () => {
  const mailed = join(dir, 'mail', 'Muster – Buchhaltung (2026-11-15).vanillashare');
  mkdirSync(join(dir, 'mail'), { recursive: true });
  writeFileSync(mailed, readFileSync(first));
  const opened = await open(sandra, mailed);
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.kind, 'return');
  assert.equal((opened.json.from as { name: string }).name, ERNST.name);
  const review = await sandra.send('GET', `/api/handover/returns/${opened.json.id as string}`);
  assert.equal(review.status, 200);
  assert.ok(JSON.stringify(review.json).includes('von Ernst korrigiert'));
  assert.ok(!(await sandra.send('GET', '/api/handover')).json.durchsicht, 'her books stay open, no copy');
  // Her own file without his changes has nothing to open.
  const plain = join(dir, 'mail', 'plain.vanillashare');
  writeFileSync(plain, readFileSync(await shareFile('again.vanillashare')));
  const refused = await open(sandra, plain);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'shareOwnBooks');
});

test('a newer file over the older one with his changes: his changes carried over and said; the older file untouched', async () => {
  const oldBytes = readFileSync(first);
  const newer = await shareFile('Muster – Buchhaltung (2026-11-16).vanillashare');
  const opened = await open(ernst, newer);
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.carried, 1, 'his change came along');
  assert.equal(opened.json.document, newer);
  assert.equal((await entries(ernst)).find((e) => e.id === entryId)?.description, 'von Ernst korrigiert');
  assert.equal((await doc(ernst))!.dirty, true, 'his changes are not in the newer file yet');
  assert.deepEqual(readFileSync(first), oldBytes, 'the older file stays as it was');
  assert.equal((await ernst.send('POST', '/api/handover/document/save', {})).status, 200);
  assert.ok(readPackage(readFileSync(newer)).saved);
});

test('a read-only file or one that went is said so; «Sichern unter…» writes another file that becomes the document', async () => {
  const newer = (await doc(ernst))!.path;
  await ernst.send('PATCH', `/api/journal-entries/${entryId}`, { description: 'von Ernst nochmals korrigiert' });
  chmodSync(newer, 0o444);
  const ro = await ernst.send('POST', '/api/handover/document/save', {});
  assert.equal(ro.status, 409);
  assert.equal(ro.json.code, 'shareDocReadOnly');
  chmodSync(newer, 0o644);
  const other = join(dir, 'elsewhere', 'Kopie.vanillashare');
  mkdirSync(join(dir, 'elsewhere'), { recursive: true });
  const as = await ernst.send('POST', '/api/handover/document/save', { to: other });
  assert.equal(as.status, 200, JSON.stringify(as.json));
  assert.equal((await doc(ernst))!.path, other);
  assert.ok(JSON.stringify(readPackage(readPackage(readFileSync(other)).saved!).changes).includes('nochmals'));
  rmSync(other);
  await ernst.send('PATCH', `/api/journal-entries/${entryId}`, { description: 'dritte Fassung' });
  assert.equal((await doc(ernst))!.missing, true);
  const gone = await ernst.send('POST', '/api/handover/document/save', {});
  assert.equal(gone.status, 409);
  assert.equal(gone.json.code, 'shareDocMissing');
});

test('a save that breaks off between writing and renaming leaves the file as it was, and no half file', () => {
  const path = join(dir, 'atomic.vanillashare');
  writeFileSync(path, 'the old file');
  assert.throws(() => writeAtomically(path, new TextEncoder().encode('the new file'), () => { throw new Error('crash'); }), /crash/);
  assert.equal(readFileSync(path, 'utf8'), 'the old file');
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.saving-')), [], 'no file left beside it');
  writeAtomically(path, new TextEncoder().encode('the new file'));
  assert.equal(readFileSync(path, 'utf8'), 'the new file');
});

test('both extensions open: .vanillashare and the .vanilla of 0.6.x', async () => {
  assert.ok(isVanillaPath('/x/a.vanillashare') && isVanillaPath('/x/A.VANILLA') && !isVanillaPath('/x/a.zip'));
  const legacy = join(dir, 'Alt – Buchhaltung (2026-11-01).vanilla');
  writeFileSync(legacy, readFileSync(await shareFile('legacy-source.vanillashare')));
  const opened = await open(ernst2, legacy);
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.document, legacy, 'a .vanilla of 0.6.x is a document too');
  assert.ok(existsSync(legacy));
});

test('the app\'s download reports its progress up to the whole size', async () => {
  const size = 3 * 1024 * 1024 + 17;
  const file = Buffer.alloc(size, 7);
  const srv = createServer((req, res) => {
    if (req.url === '/api/shares/abc/open') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ download: { object: 'package', method: 'GET', url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/storage`, headers: {} }, filename: 'Muster – Buchhaltung (2026-11-15).vanillashare', bytes: size, expiresAt: new Date().toISOString() })); return; }
    res.writeHead(200, { 'Content-Length': String(size) });
    let at = 0;
    const w = () => { while (at < size) { const n = Math.min(64 * 1024, size - at); const ok = res.write(file.subarray(at, at + n)); at += n; if (!ok) return void res.once('drain', w); } res.end(); };
    w();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const seen: number[] = [];
  const saveTo = join(dir, 'progress');
  const got = await receivePackage({ client: shareClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`), id: 'abc', saveTo, progress: (p) => { assert.equal(p.total, size); seen.push(p.done); } });
  srv.close();
  assert.ok(seen.length > 3, 'told as it goes');
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'never backwards');
  assert.equal(seen.at(-1), size);
  assert.equal(got.path, join(saveTo, 'Muster – Buchhaltung (2026-11-15).vanillashare'), 'a real file in the folder');
  assert.equal(readFileSync(got.path!).length, size);
  assert.deepEqual(readdirSync(saveTo), ['Muster – Buchhaltung (2026-11-15).vanillashare'], 'no .part left');
});

test('the progress window says how far in the person\'s words: «84 von 196 MB»', () => {
  const de = textsIn('de');
  const line = (done: number, total: number) => progressLine(done, total, (v) => de('desktop.shareLoadingOf', v));
  assert.equal(line(84 * 1024 * 1024, 196 * 1024 * 1024), '84 von 196 MB');
  assert.equal(line(1.5 * 1024 * 1024, 4 * 1024 * 1024), '1.5 von 4.0 MB');
  assert.equal(de('desktop.shareLoading', { name: 'Anna Muster' }), 'Lädt die Buchhaltung von Anna Muster');
});
