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
import { basename, dirname, join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { readPackage, SAVED_MEMBER, writePackage, type ShareTag } from '../src/handover/package.js';
import { writeAtomically, type DocumentState } from '../src/handover/document.js';
import { isVanillaPath } from '../src/desktop/open-files.js';
import { shareClient } from '../src/share/client.js';
import { receivePackage, sendPackage } from '../src/share/transport.js';
import type { ShareClient } from '../src/share/client.js';
import { crc32 } from 'node:zlib';
import { unzipSync } from 'fflate';
import { progressLine } from '../src/desktop/progress-text.js';
import { textsIn } from '../src/app/i18n/texts-in.js';

const dir = mkdtempSync(join(tmpdir(), 'share-document-'));
const ERNST = { name: 'Ernst Beispiel', email: 'ernst@example.ch' };
let sandra: ApiServer;
let ernst: ApiServer;
let ernst2: ApiServer;
let ernst3: ApiServer;
let ernst4: ApiServer;

before(async () => {
  const fixture = 'tests/fixtures/period-lock-index.json';
  sandra = await startApi(fixture, { VANILLA_DURCHSICHT_DIR: join(dir, 'sandra-copies') });
  ernst = await startApi(fixture, { VANILLA_DURCHSICHT_DIR: join(dir, 'ernst-copies') });
  ernst2 = await startApi(fixture, { VANILLA_DURCHSICHT_DIR: join(dir, 'ernst2-copies') });
  ernst3 = await startApi(fixture, { VANILLA_DURCHSICHT_DIR: join(dir, 'ernst3-copies') });
  ernst4 = await startApi(fixture, { VANILLA_DURCHSICHT_DIR: join(dir, 'ernst4-copies') });
});
after(async () => { await sandra?.stop(); await ernst?.stop(); await ernst2?.stop(); await ernst3?.stop(); await ernst4?.stop(); });

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

/** A drop in the browser: the bytes only, no path (the copy's document stays as it was). */
async function drop(api: ApiServer, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await api.fetch('/api/handover/open', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(readFileSync(path)) });
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

test('559-1: another file put at the document\'s path (a newer state) is never written over, by itself or by «Sichern»; «Sichern unter…» still works', async () => {
  const mine = join(dir, 'r1', 'Muster – Buchhaltung.vanillashare');
  mkdirSync(join(dir, 'r1'), { recursive: true });
  writeFileSync(mine, readFileSync(await shareFile('r1-v2.vanillashare')));
  assert.equal((await open(ernst3, mine)).status, 200);
  const id = (await entries(ernst3)).find((e) => e.date > '2026-06-30')!.id;
  await ernst3.send('PATCH', `/api/journal-entries/${id}`, { description: 'Ernst r1 A' });
  assert.equal((await ernst3.send('POST', '/api/handover/document/save', {})).status, 200);
  // A newer state replaces the file at the same path (Finder, a sync, a second download).
  const newer = readFileSync(await shareFile('r1-v3.vanillashare'));
  writeFileSync(mine, newer);
  await ernst3.send('PATCH', `/api/journal-entries/${id}`, { description: 'Ernst r1 B' });
  const auto = await ernst3.send('POST', '/api/handover/document/save', { auto: true });
  assert.equal(auto.status, 409, JSON.stringify(auto.json));
  assert.equal(auto.json.code, 'shareDocOther');
  assert.deepEqual(readFileSync(mine), newer, 'the newer file stays as it was');
  const d = (await doc(ernst3))!;
  assert.equal(d.other, true, 'the bar says so');
  assert.equal((await ernst3.send('POST', '/api/handover/document/save', { auto: true })).status, 200, 'by itself: nothing more is tried');
  const by = await ernst3.send('POST', '/api/handover/document/save', {});
  assert.equal(by.json.code, 'shareDocOther');
  assert.deepEqual(readFileSync(mine), newer);
  const elsewhere = join(dir, 'r1', 'Kopie.vanillashare');
  assert.equal((await ernst3.send('POST', '/api/handover/document/save', { to: elsewhere })).status, 200);
  assert.ok(JSON.stringify(readPackage(readPackage(readFileSync(elsewhere)).saved!).changes).includes('Ernst r1 B'));
  assert.equal((await doc(ernst3))!.other, undefined, 'the new file is the document');
});

test('559-2: reopening his own file keeps the changes he made after saving it (saved A, unsaved B: B stays)', async () => {
  const mine = join(dir, 'r2', 'Muster – Buchhaltung.vanillashare');
  mkdirSync(join(dir, 'r2'), { recursive: true });
  writeFileSync(mine, readFileSync(await shareFile('r2.vanillashare')));
  assert.equal((await open(ernst4, mine)).status, 200);
  const id = (await entries(ernst4)).find((e) => e.date > '2026-06-30')!.id;
  await ernst4.send('PATCH', `/api/journal-entries/${id}`, { description: 'Fassung A' });
  assert.equal((await ernst4.send('POST', '/api/handover/document/save', {})).status, 200);
  await ernst4.send('PATCH', `/api/journal-entries/${id}`, { description: 'Fassung B' });
  const again = await open(ernst4, mine);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal((await entries(ernst4)).find((e) => e.id === id)?.description, 'Fassung B', 'the newer change in the copy stays');
  assert.equal((await doc(ernst4))!.dirty, true, 'and is still unsaved');
  // A file saved elsewhere (his other Mac) whose change he has overwritten here since: the copy's version stays too.
  const other = readPackage(readFileSync(mine));
  assert.ok(other.saved);
});

test('559-9: a newer hand-over dropped without its file moves the copy forward; «Sichern» brings his own file to that state', async () => {
  const mine = (await doc(ernst4))!.path;
  const newer = await shareFile('r9-newer.vanillashare');
  const dropped = await drop(ernst4, newer);
  assert.equal(dropped.status, 200, JSON.stringify(dropped.json));
  const v = readPackage(readFileSync(newer)).index.version.n;
  assert.equal((await doc(ernst4))!.path, mine, 'the document is still his file');
  assert.equal((await doc(ernst4))!.dirty, true, 'which holds the older state');
  assert.equal((await ernst4.send('POST', '/api/handover/document/save', {})).status, 200);
  const now = readPackage(readFileSync(mine));
  assert.equal(now.index.version.n, v, 'his file holds the copy\'s state now');
  assert.ok(JSON.stringify(readPackage(now.saved!).changes).includes('Fassung B'));
  const file = await ernst4.fetch('/api/handover/document/file', { method: 'POST' });
  assert.equal(file.status, 200);
  assert.equal(readPackage(new Uint8Array(await file.arrayBuffer())).index.version.n, v, '«Sichern unter…» in the browser writes the same state');
});

test('559-8: a save left half way (.<name>.saving-<pid>) is cleared when the file is opened again', async () => {
  const mine = (await doc(ernst4))!.path;
  const stale = join(dirname(mine), `.${basename(mine)}.saving-99999999`);
  writeFileSync(stale, 'half');
  assert.equal((await open(ernst4, mine)).status, 200);
  assert.ok(!existsSync(stale));
});

test('559-10: two downloads of the same share at once land in two files, never one', async () => {
  const size = 512 * 1024 + 3;
  const srv = createServer((req, res) => {
    if (req.url === '/api/shares/abc/open') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ download: { object: 'package', method: 'GET', url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/storage`, headers: {} }, filename: 'Muster‮gnp.vanillashare', bytes: size, expiresAt: new Date().toISOString() })); return; }
    res.writeHead(200, { 'Content-Length': String(size) });
    setTimeout(() => res.end(Buffer.alloc(size, 1)), 30);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const saveTo = join(dir, 'twice');
  const client = shareClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  const [a, b] = await Promise.all([receivePackage({ client, id: 'abc', saveTo }), receivePackage({ client, id: 'abc', saveTo })]);
  srv.close();
  assert.notEqual(a.path, b.path);
  assert.deepEqual(readdirSync(saveTo).sort(), ['Mustergnp 2.vanillashare', 'Mustergnp.vanillashare'], 'no bidi control in the name, no .part left');
  assert.equal(readFileSync(a.path!).length, size);
  assert.equal(readFileSync(b.path!).length, size);
});

test('559-8: a share is packed once; the share\'s own tag goes into the index in place, with its CRC', async () => {
  const files = new Map([['ledger.json', new TextEncoder().encode('{"x":1}')], ['transactional-data/2026/receipts/a.pdf', new Uint8Array(4096).fill(3)]]);
  const index = readPackage(readFileSync(first)).index;
  let builds = 0;
  const client = {
    upload: async () => ({ target: { object: 'p', method: 'PUT', url: 'http://x' }, bytes: 0, expiresAt: '' }),
    put: async () => undefined,
    complete: async () => ({ id: 'a'.repeat(26), kind: 'share', state: 'ready', bytes: 0, createdAt: '', opens: [], returns: [] }),
  } as unknown as ShareClient;
  const tagged = (tag: ShareTag) => ({ ...index, share: tag });
  const sent = await sendPackage({
    client,
    hand: { service: 'https://share.example.ch', index: (tag) => JSON.stringify(tagged(tag), null, 1), build: (tag, room) => { builds++; return writePackage({ index: tagged(tag), files }, { indexRoom: room }); } },
    start: async () => ({ id: 'b'.repeat(26), revokeToken: 'r', returnToken: 'T'.repeat(43), generation: 2 }),
  });
  assert.equal(builds, 1, 'packed once');
  const zip = Buffer.from(sent.bytes);
  // index.json is the first member: its local header's CRC is the CRC of what it holds now.
  const nameLength = zip.readUInt16LE(26), extra = zip.readUInt16LE(28), size = zip.readUInt32LE(18);
  const data = zip.subarray(30 + nameLength + extra, 30 + nameLength + extra + size);
  assert.equal(zip.readUInt32LE(14), crc32(data) >>> 0);
  assert.deepEqual(JSON.parse(data.toString('utf8')).share, { service: 'https://share.example.ch', id: 'b'.repeat(26), returnToken: 'T'.repeat(43), generation: 2 });
  assert.deepEqual(unzipSync(sent.bytes)['index.json'], new Uint8Array(data), 'a zip reader reads the same');
});
