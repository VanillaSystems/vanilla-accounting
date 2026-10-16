/**
 * A link made or taken back by hand (Zahlung verknüpfen, «Lösen», the AI sidebar, its undo): the
 * payment's automatic booking is made again with what is linked now, so an invoice with Swiss VAT
 * is booked with its input tax and a payment that lost its receipt claims none. A hand booking
 * stays as the person left it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantEvent } from '../src/types/assistant.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'link-rebook-'));
  const changes = join(dir, 'changes.json');
  const api = await startApi('demo', { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: changes });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  const books = async () => (await (await api.fetch('/books.json')).json()) as Index;
  const rest = async () => {
    for (let i = 0; i < 300; i++) {
      const v = (await (await api.fetch('/api/automation')).json()) as { runs: Array<{ status: string }> };
      if (!v.runs.some((r) => r.status === 'running' || r.status === 'queued')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the inbox run did not come to rest');
  };
  /** The payment's bookings as [VAT code, the receipts it saw, origin]. */
  const onL = async () => ((await books()).journalEntries ?? []).filter((e) => e.transactionRef === 'REF-L').map((e) => [e.vatCode, e.receipts, e.origin ?? '']);
  const drop = (await (await api.fetch('/api/drop', { method: 'POST' })).json()) as DropSession;
  await api.fetch(`/api/drop/${drop.id}/files?name=september.xml`, { method: 'POST', body: CAMT, headers: { 'Content-Type': 'application/octet-stream' } });
  await rest();
  const receipt = (await books()).receipts.find((r) => r.filename === RECEIPT)!;
  assert.ok(receipt.hasSwissVat, 'the receipt shows Swiss VAT');
  assert.deepEqual(await onL(), [['I0', [], 'classify']], 'the statement run booked the payment without a receipt: no input tax');
  const ask = async (asked: unknown) => {
    writeFileSync(changes, JSON.stringify(asked));
    const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Beleg zur Zahlung', language: 'de', context: [] }) });
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
    const made = events.find((e): e is Extract<AssistantEvent, { type: 'changes' }> => e.type === 'changes');
    assert.ok(made, JSON.stringify(events.at(-1)));
    return { conversation: (events[0] as { id: string }).id, made: made.changes };
  };
  const done = async () => { await rest().catch(() => {}); await api.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { api, receipt, rest, onL, ask, done };
}

test('linking a receipt by hand books its payment again with the receipt\'s VAT; «Lösen» books it again without', async () => {
  const { api, receipt, rest, onL, done } = await setUp();
  try {
    const linked = await api.send('POST', '/api/mapping/add', { receiptId: receipt.id, transactionRef: 'REF-L' });
    assert.deepEqual(linked.json, { ok: true, again: ['REF-L'] });
    await rest();
    assert.deepEqual(await onL(), [['I81', [receipt.id], 'classify']], 'booked again at once, with the input tax the receipt shows');

    const loose = await api.send('POST', '/api/mapping/remove', { receiptId: receipt.id, transactionRef: 'REF-L' });
    assert.deepEqual(loose.json, { ok: true, again: ['REF-L'] });
    await rest();
    assert.deepEqual(await onL(), [['I0', [], 'classify']], 'no input tax on a payment without its receipt');
  } finally {
    await done();
  }
});

test('a hand booking stays as the person left it when a receipt is linked or taken back', async () => {
  const { api, receipt, rest, onL, done } = await setUp();
  try {
    const entry = (await api.send('GET', '/books.json')).json.journalEntries as Array<{ id: string; transactionRef: string }>;
    const id = entry.find((e) => e.transactionRef === 'REF-L')!.id;
    assert.equal((await api.send('PATCH', `/api/journal-entries/${id}`, { vatCode: 'I81' })).status, 200);
    assert.deepEqual((await api.send('POST', '/api/mapping/add', { receiptId: receipt.id, transactionRef: 'REF-L' })).json, { ok: true, again: [] });
    assert.deepEqual((await api.send('POST', '/api/mapping/remove', { receiptId: receipt.id, transactionRef: 'REF-L' })).json, { ok: true, again: [] });
    await rest();
    assert.deepEqual(await onL(), [['I81', [], 'manual']]);
  } finally {
    await done();
  }
});

test('a link the AI sidebar makes books the payment again with the receipt; undoing it books it again without', async () => {
  const { api, receipt, rest, onL, ask, done } = await setUp();
  try {
    const { conversation, made } = await ask([{ kind: 'link', receipt: receipt.id, payment: 'REF-L' }]);
    await rest();
    assert.deepEqual(await onL(), [['I81', [receipt.id], 'classify']]);

    assert.equal((await api.send('POST', `/api/assistant/${conversation}/changes/${made[0].id}/undo`)).status, 200);
    await rest();
    assert.deepEqual(await onL(), [['I0', [], 'classify']], 'the undo takes the link back, and with it the input tax');

    await ask([{ kind: 'link', receipt: receipt.id, payment: 'REF-L' }]);
    await rest();
    await ask([{ kind: 'unlink', receipt: receipt.id, payment: 'REF-L' }]);
    await rest();
    assert.deepEqual(await onL(), [['I0', [], 'classify']], 'an unlink by the sidebar the same');
  } finally {
    await done();
  }
});
