/**
 * «Rückgängig» after a receipt was deleted restores exactly: the receipt, its links, and the entries
 * the deletion took with it, as they were (same ids, same fields), without asking the model again.
 * The entries booked meanwhile without the receipt go; a person's entry booked meanwhile stays, and
 * the deleted entry of that payment is not brought back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Index } from '../src/types/index.js';
import type { DropSession } from '../src/types/drop.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';

const STUB = join(process.cwd(), 'tests/support/stub-bin');
const CAMT = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>L-1</MsgId><CreDtTm>2026-09-13T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>L-1</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">217.75</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-13</Dt></BookgDt><AcctSvcrRef>REF-L</AcctSvcrRef><AddtlNtryInf>Post CH Rechnung September</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
/** A demo receipt that shows Swiss VAT (8.1 %). */
const RECEIPT = '20260912-post-ch-rechnung-2026-09.pdf';

async function setUp() {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-restore-'));
  const prompts = join(dir, 'prompts.txt');
  const api = await startApi('demo', { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_PROMPTS: prompts });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  const books = async () => (await (await api.fetch('/books.json')).json()) as Index;
  const rest = async () => {
    for (let i = 0; i < 400; i++) {
      const v = (await (await api.fetch('/api/automation')).json()) as { runs: Array<{ status: string }> };
      if (!v.runs.some((r) => r.status === 'running' || r.status === 'queued')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the inbox run did not come to rest');
  };
  const onL = async () => ((await books()).journalEntries ?? []).filter((e) => e.transactionRef === 'REF-L');
  /** How often the model was asked to book REF-L. */
  const bookingCalls = () => (existsSync(prompts) ? readFileSync(prompts, 'utf8').split('\n\0\n').filter((p) => p.includes('## Chart of Accounts') && p.includes('REF-L')).length : 0);
  const drop = (await (await api.fetch('/api/drop', { method: 'POST' })).json()) as DropSession;
  await api.fetch(`/api/drop/${drop.id}/files?name=september.xml`, { method: 'POST', body: CAMT, headers: { 'Content-Type': 'application/octet-stream' } });
  await rest();
  const receipt = (await books()).receipts.find((r) => r.filename === RECEIPT)!;
  assert.deepEqual((await api.send('POST', '/api/mapping/add', { receiptId: receipt.id, transactionRef: 'REF-L' })).json, { ok: true, again: ['REF-L'] });
  await rest();
  const before = await onL();
  assert.deepEqual(before.map((e) => [e.vatCode, e.receipts, e.origin]), [['I81', [receipt.id], 'classify']], 'booked with the receipt and its input tax');
  const links = async () => (await books()).mappings.filter((m) => m.receiptId === receipt.id).map((m) => m.transactionRef).sort();
  const linksBefore = await links();
  assert.ok(linksBefore.includes('REF-L'));
  const done = async () => { await rest().catch(() => {}); await api.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { api, books, receipt, rest, onL, links, before, linksBefore, bookingCalls, done };
}

test('restoring a deleted receipt puts its entries back as they were, without a model call', async () => {
  const { api, books, receipt, rest, onL, links, before, linksBefore, bookingCalls, done } = await setUp();
  try {
    const deleted = await api.send('DELETE', `/api/receipts/${receipt.id}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    await rest();
    assert.deepEqual(await links(), []);
    assert.deepEqual((await onL()).map((e) => [e.vatCode, e.receipts]), [['I0', []]], 'booked again without the receipt: no input tax');
    const calls = bookingCalls();

    const restored = await api.send('POST', `/api/receipts/${receipt.id}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    await rest();
    assert.deepEqual(await onL(), before, 'the entries are back exactly as they were');
    assert.equal(bookingCalls(), calls, 'no model call to book the payment again');
    assert.ok((await books()).receipts.some((r) => r.id === receipt.id), 'the receipt is back');
    assert.deepEqual(await links(), linksBefore, 'and its links');
  } finally {
    await done();
  }
});

test('a hand booking made meanwhile stays; the deleted entry of that payment is not restored', async () => {
  const { api, receipt, rest, onL, bookingCalls, done } = await setUp();
  try {
    assert.equal((await api.send('DELETE', `/api/receipts/${receipt.id}`)).status, 200);
    await rest();
    const [rebooked] = await onL();
    assert.equal((await api.send('PATCH', `/api/journal-entries/${rebooked.id}`, { accountDebit: '6510' })).status, 200);
    const calls = bookingCalls();

    assert.equal((await api.send('POST', `/api/receipts/${receipt.id}/restore`)).status, 200);
    await rest();
    assert.deepEqual((await onL()).map((e) => [e.id, e.accountDebit, e.vatCode, e.origin]), [[rebooked.id, '6510', 'I0', 'manual']], 'the person\'s booking stays, nothing else is booked');
    assert.equal(bookingCalls(), calls);
  } finally {
    await done();
  }
});

test('deleting the receipt of a hand-corrected booking keeps the booking and drops the receipt from it; «Rückgängig» names it again (r4c-32)', async () => {
  const { api, receipt, rest, onL, done } = await setUp();
  try {
    const [booked] = await onL();
    assert.equal((await api.send('PATCH', `/api/journal-entries/${booked.id}`, { accountDebit: '6510' })).status, 200);
    assert.equal((await api.send('DELETE', `/api/receipts/${receipt.id}`)).status, 200);
    await rest();
    assert.deepEqual((await onL()).map((e) => [e.id, e.origin, e.receipts]), [[booked.id, 'manual', []]], 'kept, without the deleted receipt');
    assert.equal((await api.send('POST', `/api/receipts/${receipt.id}/restore`)).status, 200);
    await rest();
    assert.deepEqual((await onL()).map((e) => [e.id, e.receipts]), [[booked.id, [receipt.id]]]);
  } finally {
    await done();
  }
});
