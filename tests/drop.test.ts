/**
 * The drop dialog (src/intake/recognize.ts, unzip.ts, src/server/routes/drop.ts): files are
 * recognized by their structure; a ZIP is unpacked, three levels at most, a bomb and 7z refused;
 * a protected ZIP waits for its password, which is used and never written; a duplicate is not
 * taken; nothing enters the inbox before «Hinzufügen», which then starts the inbox's run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configure, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { recognize } from '../src/intake/recognize.js';
import { unzip } from '../src/intake/unzip.js';
import type { DropSession } from '../src/types/drop.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';

configure({ useWebWorkers: false });

const RECEIPT = join(DEMO_ROOT, 'transactional-data/2026/receipts/20260105-example-cloud-invoice-2026-01.pdf');
const PASSWORD = 'geheim-7Q2x';

async function zipOf(files: Array<[string, Uint8Array | string]>, opts: { password?: string; level?: number } = {}): Promise<Buffer> {
  const w = new ZipWriter(new Uint8ArrayWriter(), { password: opts.password, level: opts.level ?? 6 });
  for (const [name, data] of files) await w.add(name, typeof data === 'string' ? new TextReader(data) : new Uint8ArrayReader(data));
  return Buffer.from(await w.close());
}

test('recognized by structure: a receipt PDF, a photo, a camt.053 with its facts; 7z and Word refused with what would work', () => {
  assert.deepEqual([recognize(readFileSync(RECEIPT), 'a.pdf').kind, recognize(readFileSync(RECEIPT), 'a.pdf').state], ['receipt', 'take']);
  assert.equal(recognize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'IMG_1.PNG').kind, 'photo');
  const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><Stmt><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id></Acct><Ntry><BookgDt><Dt>2026-10-01</Dt></BookgDt></Ntry><Ntry><BookgDt><Dt>2026-10-13</Dt></BookgDt></Ntry></Stmt></Document>`;
  const c = recognize(Buffer.from(camt), 'x.xml');
  assert.deepEqual([c.kind, c.how, c.facts], ['camt', 'structure', { iban: 'CH6580808000000000001', from: '2026-10-01', to: '2026-10-13', entries: 2 }]);
  assert.deepEqual(recognize(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), 'a.7z'), { state: 'refused', reason: 'as-zip' });
  assert.equal(recognize(Buffer.from('PK-not-really'), 'brief.docx').reason, 'as-pdf');
});

test('a ZIP is unpacked three levels deep and no deeper; a bomb is refused before it is unpacked', async () => {
  const pdf = readFileSync(RECEIPT);
  const l3 = await zipOf([['c.pdf', pdf]]);
  const l2 = await zipOf([['l3.zip', l3]]);
  const l1 = await zipOf([['b.pdf', pdf], ['l2.zip', l2]]);
  const ok = await unzip(l1);
  assert.deepEqual(ok.ok && ok.files.map((f) => [f.name, f.bytes.equals(pdf)]), [['b.pdf', true], ['c.pdf', true]], 'byte for byte');
  const deep = await unzip(await zipOf([['l1.zip', l1]]));
  assert.deepEqual(deep, { ok: false, reason: 'too-deep' });
  const bomb = await zipOf([['zeros.bin', new Uint8Array(40 * 1024 * 1024)]], { level: 9 });
  assert.ok(bomb.length < 200_000, 'it packs small');
  assert.deepEqual(await unzip(bomb), { ok: false, reason: 'too-big' });
});

test('a protected ZIP waits for its password; a wrong one says so; the right one unpacks', async () => {
  const z = await zipOf([['r.pdf', readFileSync(RECEIPT)]], { password: PASSWORD });
  assert.deepEqual(await unzip(z), { ok: false, locked: true });
  assert.deepEqual(await unzip(z, 'falsch'), { ok: false, locked: true, reason: 'wrong-password' });
  const right = await unzip(z, PASSWORD);
  assert.ok(right.ok && right.files.length === 1);
});

test('the dialog: a duplicate is not taken, the password is never written, «Hinzufügen» fills the inbox and starts the run', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    const base = `http://127.0.0.1:${api.port}`;
    const post = async (path: string, body?: Buffer | object): Promise<DropSession> => (await (await fetch(base + path, {
      method: 'POST', body: Buffer.isBuffer(body) ? new Uint8Array(body) : body ? JSON.stringify(body) : undefined,
      headers: Buffer.isBuffer(body) ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' },
    })).json()) as DropSession;
    const inbox = () => (existsSync(join(api.root, 'beleg-import')) ? readdirSync(join(api.root, 'beleg-import')) : []);
    let s = await post('/api/drop');
    const fresh = Buffer.concat([readFileSync(RECEIPT), Buffer.from('\n% fresh\n')]);
    s = await post(`/api/drop/${s.id}/files?name=archived.pdf`, readFileSync(RECEIPT));
    s = await post(`/api/drop/${s.id}/files?name=locked.zip`, await zipOf([['fresh.pdf', fresh]], { password: PASSWORD }));
    s = await post(`/api/drop/${s.id}/files?name=notes.docx`, Buffer.from('word'));
    assert.deepEqual(s.rows.map((r) => [r.name, r.state]), [['archived.pdf', 'duplicate'], ['locked.zip', 'locked'], ['notes.docx', 'refused']]);
    assert.deepEqual(inbox(), [], 'nothing in the inbox while the dialog is open');
    const locked = s.rows.find((r) => r.state === 'locked')!;
    s = await post(`/api/drop/${s.id}/rows/${locked.key}`, { kind: 'unlock', password: PASSWORD });
    assert.deepEqual(s.rows.map((r) => [r.name, r.state, r.from]), [['archived.pdf', 'duplicate', undefined], ['notes.docx', 'refused', undefined], ['fresh.pdf', 'take', 'locked.zip']]);
    const written = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? written(join(d, f)) : [join(d, f)]));
    assert.ok(!written(api.root).some((f) => readFileSync(f).includes(PASSWORD)), 'the password is in no file of the workspace');
    s = await post(`/api/drop/${s.id}/commit`);
    assert.equal(s.done?.taken, 1);
    assert.ok(s.done?.run, 'the inbox run started');
    assert.deepEqual(inbox(), ['fresh.pdf'], 'only the new file went in: not the duplicate, not the Word file');
    assert.equal(existsSync(join(api.root, 'data/drop', s.id, 'files')), false, 'the session keeps no files');
  } finally {
    api.stop();
  }
});
