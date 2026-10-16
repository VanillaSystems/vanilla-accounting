/**
 * The drop dialog (src/intake/recognize.ts, unzip.ts, src/server/routes/drop.ts): files are
 * recognized by their structure; a ZIP is unpacked, three levels at most, a bomb and 7z refused;
 * a protected ZIP waits for its password, which is used and never written; a duplicate is not
 * taken; nothing enters the inbox before «Hinzufügen», which then starts the inbox's run.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { recognize } from '../src/intake/recognize.js';
import { unzip } from '../src/intake/unzip.js';
import type { DropSession } from '../src/types/drop.js';
import type { RunDetail } from '../src/workflows/model.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';
import { RECEIPT, SESSION, bookedWithReceipt } from './support/inbox-run.js';
import { textPdf } from './support/text-pdf.js';

configure({ useWebWorkers: false });

const PASSWORD = 'geheim-7Q2x';
/** A made-up invoice the demo books do not hold: a file of its own by its bytes and its facts. */
const invoicePdf = (no: string, what: string) => textPdf([`Malerbedarf Muster AG`, `Rechnung ${no}`, `Datum: 12.08.2026`, `${what} 100.00`, `Total CHF 108.10`]);

async function zipOf(files: Array<[string, Uint8Array | string]>, opts: { password?: string; level?: number } = {}): Promise<Buffer> {
  const w = new ZipWriter(new Uint8ArrayWriter(), { password: opts.password, level: opts.level ?? 6 });
  for (const [name, data] of files) await w.add(name, typeof data === 'string' ? new TextReader(data) : new Uint8ArrayReader(data));
  return Buffer.from(await w.close());
}

test('recognized by structure: a receipt PDF, a photo, a camt.053 with its facts; 7z, Word and a bank CSV refused with what would work', async () => {
  assert.deepEqual([(await recognize(readFileSync(RECEIPT), 'a.pdf')).kind, (await recognize(readFileSync(RECEIPT), 'a.pdf')).state], ['receipt', 'take']);
  assert.equal((await recognize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'IMG_1.PNG')).kind, 'photo');
  const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><Stmt><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id></Acct><Ntry><BookgDt><Dt>2026-10-01</Dt></BookgDt></Ntry><Ntry><BookgDt><Dt>2026-10-13</Dt></BookgDt></Ntry></Stmt></Document>`;
  const c = await recognize(Buffer.from(camt), 'x.xml');
  assert.deepEqual([c.kind, c.how, c.facts], ['camt', 'structure', { iban: 'CH6580808000000000001', from: '2026-10-01', to: '2026-10-13', entries: 2 }]);
  assert.deepEqual((await recognize(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), 'a.7z')), { state: 'refused', reason: 'as-zip' });
  assert.equal((await recognize(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'Offerte.docx')).reason, 'office', 'a real .docx is a ZIP and must not be unpacked');
  assert.equal((await recognize(Buffer.from('Buchungsdatum;Text;Belastung;Gutschrift;Saldo\n01.07.2026;Farbmix;100.00;;\n'), 'export.txt')).reason, 'bank-csv');
  assert.equal((await recognize(Buffer.from('a;b\n'), 'Kontoauszug.csv')).reason, 'bank-csv');
  assert.equal((await recognize(Buffer.from('hello'), 'notes.txt')).reason, 'as-pdf');
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
    const post = async (path: string, body?: Buffer | object): Promise<DropSession> => (await (await api.fetch(path, {
      method: 'POST', body: Buffer.isBuffer(body) ? new Uint8Array(body) : body ? JSON.stringify(body) : undefined,
      headers: Buffer.isBuffer(body) ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' },
    })).json()) as DropSession;
    const inbox = () => (existsSync(join(api.root, 'beleg-import')) ? readdirSync(join(api.root, 'beleg-import')) : []);
    let s = await post('/api/drop');
    const fresh = await invoicePdf('R-1001', 'Pinsel');
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
    await api.stop();
  }
});

test('by their words and facts: a newsletter waits in quarantine until «doch ein Beleg», an order confirmation is taken beside its invoice, a copy of a receipt in the books asks «ist dasselbe» or «verschieden»', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    const { post, rest, books } = SESSION(api);
    const inbox = () => (existsSync(join(api.root, 'beleg-import')) ? readdirSync(join(api.root, 'beleg-import')).sort() : []);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=Herbstaktion.pdf`, await textPdf(['Farbmix Herbstaktion', 'Bis 31. Oktober 20 % auf alle Fassadenfarben.', 'Sie erhalten diesen Newsletter als Kundin. Abmelden: farbmix.example/abmelden']));
    s = await post(`/api/drop/${s.id}/files?name=AB-5521.pdf`, await textPdf(['Farbmix AG', 'Auftragsbestätigung AB-5521', 'Datum: 24.07.2026', 'Fassadenfarbe Silikon 12.5 l, 10 Stk', 'Die Rechnung folgt mit der Lieferung.']));
    s = await post(`/api/drop/${s.id}/files?name=Invoice-2026-01.pdf`, Buffer.concat([readFileSync(RECEIPT), Buffer.from('\n% downloaded again\n')]));
    const [news, order, copy] = s.rows;
    assert.deepEqual([news.state, news.reason, news.document], ['quarantine', 'not-receipt', 'newsletter']);
    assert.ok(news.quarantined && existsSync(join(api.root, 'data/quarantine', news.quarantined)), 'it lies in quarantine with its reason');
    assert.deepEqual([order.state, order.document], ['taken', 'order-confirmation']);
    const original = (await books()).receipts.find((r) => r.filename === '20260105-example-cloud-invoice-2026-01.pdf')!;
    assert.deepEqual([copy.state, copy.reason, copy.twin?.of, copy.twin?.name, copy.twin?.relation], ['duplicate', 'possible-duplicate', original.id, original.filename, 'duplicate'], 'the same text under another name and other bytes');
    assert.deepEqual(inbox(), ['AB-5521.pdf'], 'neither the newsletter nor the copy went in');

    s = await post(`/api/drop/${s.id}/rows/${copy.key}`, { kind: 'twin', answer: 'same' });
    assert.deepEqual([s.rows[2].state, s.rows[2].reason], ['duplicate', 'same']);
    assert.deepEqual(inbox(), ['AB-5521.pdf'], 'the same: not taken');

    const SEPT = '20260910-gruenkaffee-muster-rechnung-2026-09.pdf';
    s = await post(`/api/drop/${s.id}/files?name=Rechnung-2026-09.pdf`, Buffer.concat([readFileSync(join(DEMO_ROOT, 'transactional-data/2026/receipts', SEPT)), Buffer.from('\n% once more\n')]));
    const again = s.rows.at(-1)!;
    assert.equal(again.twin?.name, SEPT);
    s = await post(`/api/drop/${s.id}/rows/${again.key}`, { kind: 'twin', answer: 'distinct' });
    assert.equal(s.rows.at(-1)!.state, 'taken', 'different: taken');
    const remembered = (await books()).receipts.find((r) => r.filename === SEPT) as { distinctFrom?: string[] };
    assert.deepEqual(remembered.distinctFrom, [again.id], 'and the pair is not asked again');

    s = await post(`/api/drop/${s.id}/rows/${news.key}`, { kind: 'take' });
    assert.equal(s.rows[0].state, 'taken', '«doch ein Beleg»');
    assert.equal(existsSync(join(api.root, 'data/quarantine', news.quarantined!)), false, 'out of quarantine');
    assert.ok(inbox().includes('Herbstaktion.pdf'));
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});


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
    s = await post(`/api/drop/${s.id}/files?name=fresh.pdf`, await invoicePdf('R-1002', 'Rollen'));
    assert.deepEqual(s.rows.map((r) => r.state), ['taken', 'taken'], 'both taken as they came, without «Hinzufügen»');
    const [st, rc] = s.rows;
    // The demo's PDFs print no closing balance, so the run claims none.
    assert.deepEqual((await runOf(st.run!)).arrived?.find((a) => a.file.endsWith(name)), { kind: 'statement', file: `Raiffeisen/${name}`, account: '1021', added: 0, bank: 'Raiffeisen', currency: 'CHF', from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual((await runOf(rc.run!)).arrived?.find((a) => a.file === 'fresh.pdf'), { kind: 'receipt', file: 'fresh.pdf', id: rc.id, inbox: 'fresh.pdf' });
  } finally {
    // The run a drop started works on; the workspace goes only once it rests.
    await SESSION(api).rest().catch(() => {});
    await api.stop();
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
    s = await post(`/api/drop/${s.id}/files?name=wrong.pdf`, await invoicePdf('R-1003', 'Abdeckfolie'));
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
    await api.stop();
  }
});


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
    await api.stop();
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
    assert.deepEqual(readdirSync(join(trash, del.json.deletion as string)).sort(), ['20260801-geruestbau.pdf', 'trashed.json'], 'the file waits in the trash');

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
    await api.stop();
  }
});

test('«Rückgängig» of a delete while the run that books the payment without the receipt still works: the payment ends booked with it', async () => {
  const gate = join(tmpdir(), `restore-gate-${process.pid}-${Date.now()}`);
  writeFileSync(gate, '');
  const { api, session, rc, onG } = await bookedWithReceipt({ CLAUDE_STUB_GATE: gate });
  try {
    rmSync(gate);
    rmSync(`${gate}.started`, { force: true });
    assert.equal((await api.send('DELETE', `/api/receipts/${rc.id}`)).status, 200);
    for (let i = 0; i < 200 && !existsSync(`${gate}.started`); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(existsSync(`${gate}.started`), 'the run asks the model to book the payment without the receipt');
    const back = await api.send('POST', `/api/receipts/${rc.id}/restore`);
    assert.equal(back.status, 200, back.json.error as string);
    writeFileSync(gate, '');
    await session.rest();
    assert.deepEqual(await onG(), [[rc.id]], 'booked with the receipt, not left as the run of the delete booked it');
  } finally {
    writeFileSync(gate, '');
    await session.rest().catch(() => {});
    await api.stop();
    rmSync(gate, { force: true });
    rmSync(`${gate}.started`, { force: true });
  }
});

test('deleted, dropped again, deleted again: «Rückgängig» brings back the last deletion; «Rückgängig» of the first one is refused plainly', async () => {
  const { api, session, rc, pdf, full, onG } = await bookedWithReceipt();
  try {
    const first = await api.send('DELETE', `/api/receipts/${rc.id}`);
    assert.equal(first.status, 200);
    await session.rest();
    let s = await session.post('/api/drop');
    s = await session.post(`/api/drop/${s.id}/files?name=Geruest_August.pdf`, pdf);
    assert.equal(s.rows.at(-1)!.state, 'taken', 'a deleted receipt dropped again is new');
    await session.rest();
    assert.deepEqual(await onG(), [[rc.id]], 'booked with it again');
    const second = await api.send('DELETE', `/api/receipts/${rc.id}`);
    assert.equal(second.status, 200);
    await session.rest();
    assert.notEqual(first.json.deletion, second.json.deletion, 'each deletion is its own');

    const old = await api.send('POST', `/api/receipts/${rc.id}/restore`, { deletion: first.json.deletion });
    assert.equal(old.status, 409);
    assert.match(old.json.error as string, /später noch einmal gelöscht/);
    const back = await api.send('POST', `/api/receipts/${rc.id}/restore`, { deletion: second.json.deletion });
    assert.equal(back.status, 200, back.json.error as string);
    const b = await full();
    assert.ok(b.receipts.some((r) => r.id === rc.id) && b.mappings.some((m) => m.receiptId === rc.id), 'receipt and link back');
    await session.rest();
    assert.deepEqual(await onG(), [[rc.id]], 'booked with it');
    const again = await api.send('POST', `/api/receipts/${rc.id}/restore`, { deletion: second.json.deletion });
    assert.equal(again.status, 404, 'once');
    assert.equal(existsSync(join(api.root, 'data/trash', rc.id)), false, 'the trash holds nothing of it any more');
  } finally {
    await session.rest().catch(() => {});
    await api.stop();
  }
});

test('a camt.053 of an account the books lack names its bank and asks; «Nein, privat» sets it aside with nothing read', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    const { post, books } = SESSION(api);
    const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>P-1</MsgId><CreDtTm>2026-08-25T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>P-1</Id><Acct><Id><IBAN>CH4431999123000889012</IBAN></Id><Ccy>CHF</Ccy><Svcr><FinInstnId><BICFI>RAIFCH22</BICFI><Nm>Raiffeisenbank Wil und Umgebung</Nm></FinInstnId></Svcr></Acct>
<Ntry><Amt Ccy="CHF">40.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-08-25</Dt></BookgDt><AcctSvcrRef>REF-PRIVATE</AcctSvcrRef><AddtlNtryInf>Coiffeur</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=privat.xml`, Buffer.from(camt));
    const row = s.rows[0];
    assert.equal(row.state, 'refused');
    assert.deepEqual(row.unknownAccount, { iban: 'CH4431999123000889012', currency: 'CHF', bankName: 'Raiffeisenbank Wil und Umgebung' });

    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'private' });
    const aside = s.rows[0];
    assert.deepEqual([aside.state, aside.reason, aside.unknownAccount, aside.message], ['refused', 'private', undefined, undefined]);
    assert.equal(existsSync(join(api.root, 'data/drop', s.id, 'files', row.key)), false, 'the session keeps no copy');
    assert.equal((await books()).transactions.some((t) => t.ref === 'REF-PRIVATE'), false, 'nothing of it in the books');
    await assert.rejects(post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'private' }), /400/, 'once');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});
