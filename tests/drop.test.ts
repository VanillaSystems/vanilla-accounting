/**
 * The drop dialog (src/intake/recognize.ts, unzip.ts, src/server/routes/drop.ts): files are
 * recognized by their structure; a ZIP is unpacked, three levels at most, a bomb and 7z refused;
 * a protected ZIP waits for its password, which is used and never written; a duplicate is not
 * taken; nothing enters the inbox before «Hinzufügen», which then starts the inbox's run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configure, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { recognize } from '../src/intake/recognize.js';
import { unzip } from '../src/intake/unzip.js';
import type { DropSession } from '../src/types/drop.js';
import type { RunDetail } from '../src/workflows/model.js';
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

test('recognized by structure: a receipt PDF, a photo, a camt.053 with its facts; 7z, Word and a bank CSV refused with what would work', () => {
  assert.deepEqual([recognize(readFileSync(RECEIPT), 'a.pdf').kind, recognize(readFileSync(RECEIPT), 'a.pdf').state], ['receipt', 'take']);
  assert.equal(recognize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'IMG_1.PNG').kind, 'photo');
  const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><Stmt><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id></Acct><Ntry><BookgDt><Dt>2026-10-01</Dt></BookgDt></Ntry><Ntry><BookgDt><Dt>2026-10-13</Dt></BookgDt></Ntry></Stmt></Document>`;
  const c = recognize(Buffer.from(camt), 'x.xml');
  assert.deepEqual([c.kind, c.how, c.facts], ['camt', 'structure', { iban: 'CH6580808000000000001', from: '2026-10-01', to: '2026-10-13', entries: 2 }]);
  assert.deepEqual(recognize(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), 'a.7z'), { state: 'refused', reason: 'as-zip' });
  assert.equal(recognize(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'Offerte.docx').reason, 'office', 'a real .docx is a ZIP and must not be unpacked');
  assert.equal(recognize(Buffer.from('Buchungsdatum;Text;Belastung;Gutschrift;Saldo\n01.07.2026;Farbmix;100.00;;\n'), 'export.txt').reason, 'bank-csv');
  assert.equal(recognize(Buffer.from('a;b\n'), 'Kontoauszug.csv').reason, 'bank-csv');
  assert.equal(recognize(Buffer.from('hello'), 'notes.txt').reason, 'as-pdf');
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

test('the dialog: a file is taken as it comes, a duplicate is not, a ZIP waits for its password, which is never written', async () => {
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
    assert.deepEqual(s.rows.map((r) => [r.name, r.state, r.from]), [['archived.pdf', 'duplicate', undefined], ['notes.docx', 'refused', undefined], ['fresh.pdf', 'taken', 'locked.zip']], 'the unpacked file is taken at once');
    const written = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? written(join(d, f)) : [join(d, f)]));
    assert.ok(!written(api.root).some((f) => readFileSync(f).includes(PASSWORD)), 'the password is in no file of the workspace');
    assert.ok(s.rows.find((r) => r.name === 'fresh.pdf')?.run, 'the inbox run took it');
    assert.deepEqual(inbox(), ['fresh.pdf'], 'only the new file went in: not the duplicate, not the Word file');
    assert.deepEqual(readdirSync(join(api.root, 'data/drop', s.id, 'files')).sort(), [s.rows.find((r) => r.name === 'archived.pdf')!.key], 'the session keeps only the file that waits for an answer');
  } finally {
    // The run a drop started works on; the workspace goes only once it rests.
    await SESSION(api).rest().catch(() => {});
    api.stop();
  }
});

const SESSION = (api: { port: number }) => {
  const base = `http://127.0.0.1:${api.port}`;
  const post = async (path: string, body?: Buffer | object): Promise<DropSession> => {
    const r = await fetch(base + path, {
      method: 'POST', body: Buffer.isBuffer(body) ? new Uint8Array(body) : body ? JSON.stringify(body) : undefined,
      headers: Buffer.isBuffer(body) ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' },
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${json.error}`);
    return json as DropSession;
  };
  const runOf = async (id: string) => (await (await fetch(`${base}/api/automation/runs/${id}`)).json()) as RunDetail;
  /** Until no run of the inbox works any more. */
  const rest = async () => {
    for (let i = 0; i < 200; i++) {
      const v = (await (await fetch(`${base}/api/automation`)).json()) as { runs: Array<{ status: string }> };
      if (!v.runs.some((r) => r.status === 'running' || r.status === 'queued')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the inbox run did not come to rest');
  };
  const books = async () => (await (await fetch(`${base}/books.json`)).json()) as { receipts: Array<{ id: string }>; transactions: Array<{ ref: string }> };
  return { post, runOf, rest, books };
};

test('each file tells its run what it is: a statement by its bank, account and days, a receipt by its id', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    const { post, runOf } = SESSION(api);
    const name = 'Kontoauszug 01.09.2026 - 30.09.2026 - CH6580808000000000001 - 2026-09-30.pdf';
    const placed = join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen', name);
    const statement = readFileSync(placed);
    rmSync(placed);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=${encodeURIComponent(name)}`, statement);
    s = await post(`/api/drop/${s.id}/files?name=fresh.pdf`, Buffer.concat([readFileSync(RECEIPT), Buffer.from('\n% arrival\n')]));
    assert.deepEqual(s.rows.map((r) => r.state), ['taken', 'taken'], 'both taken as they came, without «Hinzufügen»');
    const [st, rc] = s.rows;
    // The demo's PDFs print no closing balance, so the run claims none.
    assert.deepEqual((await runOf(st.run!)).arrived?.find((a) => a.file.endsWith(name)), { kind: 'statement', file: `Raiffeisen/${name}`, account: '1021', added: 0, bank: 'Raiffeisen', currency: 'CHF', from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual((await runOf(rc.run!)).arrived?.find((a) => a.file === 'fresh.pdf'), { kind: 'receipt', file: 'fresh.pdf', id: rc.id });
  } finally {
    // The run a drop started works on; the workspace goes only once it rests.
    await SESSION(api).rest().catch(() => {});
    api.stop();
  }
});

test('«Rückgängig» takes a file back out: a receipt the run read leaves the books, a statement leaves with the payments it added', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    const { post, runOf, rest, books } = SESSION(api);
    const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>U-1</MsgId><CreDtTm>2026-08-25T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>U-1</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">12.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-08-25</Dt></BookgDt><AcctSvcrRef>REF-UNDO</AcctSvcrRef><AddtlNtryInf>Undo me</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=wrong.pdf`, Buffer.concat([readFileSync(RECEIPT), Buffer.from('\n% dropped by mistake\n')]));
    s = await post(`/api/drop/${s.id}/files?name=august.xml`, Buffer.from(camt));
    const [rc, st] = s.rows;
    assert.deepEqual([rc.state, st.state], ['taken', 'taken']);
    assert.deepEqual(st.statement, { file: 'Raiffeisen/august.xml', refs: ['REF-UNDO'] });
    await rest();
    assert.ok((await books()).receipts.some((r) => r.id === rc.id), 'the run read the receipt');

    s = await post(`/api/drop/${s.id}/rows/${rc.key}`, { kind: 'undo' });
    s = await post(`/api/drop/${s.id}/rows/${st.key}`, { kind: 'undo' });
    assert.deepEqual(s.rows.map((r) => r.state), ['undone', 'undone']);
    const after = await books();
    assert.equal(after.receipts.some((r) => r.id === rc.id), false, 'the receipt left the books');
    assert.equal(after.transactions.some((t) => t.ref === 'REF-UNDO'), false, 'the payment the statement added left too');
    assert.equal(existsSync(join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen/august.xml')), false, 'and its file');
    assert.equal(((await runOf(rc.run!)).arrived ?? []).some((a) => a.file === 'wrong.pdf'), false, 'the run no longer counts it');
    await assert.rejects(post(`/api/drop/${s.id}/rows/${rc.key}`, { kind: 'undo' }), /400/, 'once is enough');
  } finally {
    // The run a drop started works on; the workspace goes only once it rests.
    await SESSION(api).rest().catch(() => {});
    api.stop();
  }
});

const STUB = join(process.cwd(), 'tests/support/stub-bin');
/** A camt.053 of the demo's Raiffeisen account with the one payment of CHF 1120.00 that the stub links the receipt to. */
const SCAFFOLD = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>G-1</MsgId><CreDtTm>2026-08-01T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>G-1</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">1120.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-08-01</Dt></BookgDt><AcctSvcrRef>REF-G</AcctSvcrRef><AddtlNtryInf>Geruestbau</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
const LINKS_TO_G = { suggestedFilename: '20260801-geruestbau.pdf', date: '2026-08-01', description: 'Gerüstbau, Gerüstmiete', amount: 1120, currency: 'CHF', confidence: 0.95, matchedTransactionRefs: ['REF-G'] };

/** The demo with the model stub, the statement read and booked, then the receipt dropped, linked and the payment booked again with it. */
async function bookedWithReceipt() {
  const api = await startApi('demo', { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_ANSWER: JSON.stringify(LINKS_TO_G) });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  const session = SESSION(api);
  const full = async () => (await (await fetch(`http://127.0.0.1:${api.port}/books.json`)).json()) as { receipts: Array<{ id: string }>; mappings: Array<{ receiptId: string; transactionRef: string }>; journalEntries: Array<{ transactionRef: string; receipts?: string[] }> };
  const onG = async () => (await full()).journalEntries.filter((e) => e.transactionRef === 'REF-G').map((e) => e.receipts);
  let s = await session.post('/api/drop');
  s = await session.post(`/api/drop/${s.id}/files?name=august.xml`, Buffer.from(SCAFFOLD));
  await session.rest();
  assert.deepEqual(await onG(), [[]], 'the statement run booked the payment without a receipt');
  const pdf = Buffer.concat([readFileSync(RECEIPT), Buffer.from('\n% Geruest_August\n')]);
  s = await session.post(`/api/drop/${s.id}/files?name=Geruest_August.pdf`, pdf);
  await session.rest();
  const rc = s.rows.at(-1)!;
  assert.deepEqual(await onG(), [[rc.id]], 'linked, and booked again with the receipt');
  return { api, session, s, rc, pdf, full, onG };
}

test('«Rückgängig» on a receipt books its payment again as without it; the same file dropped again is taken, not «schon da»', async () => {
  const { api, session, s: s0, rc, pdf, onG } = await bookedWithReceipt();
  try {
    let s = await session.post(`/api/drop/${s0.id}/rows/${rc.key}`, { kind: 'undo' });
    await session.rest();
    assert.deepEqual(await onG(), [[]], 'the payment has its booking again, without the receipt');
    s = await session.post(`/api/drop/${s.id}/files?name=Geruest_August.pdf`, pdf);
    assert.equal(s.rows.at(-1)!.state, 'taken', 'taken back, so it is new again');
    await session.rest();
    assert.deepEqual(await onG(), [[rc.id]], 'and booked with it once more');
  } finally {
    await session.rest().catch(() => {});
    api.stop();
  }
});

test('deleting a receipt books its payment again without it; the trash gives it back, booked with it again', async () => {
  const { api, session, rc, full, onG } = await bookedWithReceipt();
  try {
    const del = await api.send('DELETE', `/api/receipts/${rc.id}`);
    assert.equal(del.status, 200);
    assert.equal((await full()).receipts.some((r) => r.id === rc.id), false);
    await session.rest();
    assert.deepEqual(await onG(), [[]], 'no input tax on a receipt that is gone');
    const trash = join(api.root, 'data/trash', rc.id);
    assert.deepEqual(readdirSync(trash).sort(), ['20260801-geruestbau.pdf', 'trashed.json'], 'the file waits in the trash');

    const back = await api.send('POST', `/api/receipts/${rc.id}/restore`);
    assert.equal(back.status, 200, back.json.error as string);
    const b = await full();
    assert.ok(b.receipts.some((r) => r.id === rc.id) && b.mappings.some((m) => m.receiptId === rc.id && m.transactionRef === 'REF-G'), 'receipt and link back');
    assert.equal(existsSync(trash), false);
    assert.ok(existsSync(join(api.root, 'transactional-data/2026/receipts/20260801-geruestbau.pdf')), 'the file back in its place');
    await session.rest();
    assert.deepEqual(await onG(), [[rc.id]], 'booked with it again');
    assert.equal((await api.send('POST', `/api/receipts/${rc.id}/restore`)).status, 404, 'once');
  } finally {
    await session.rest().catch(() => {});
    api.stop();
  }
});
