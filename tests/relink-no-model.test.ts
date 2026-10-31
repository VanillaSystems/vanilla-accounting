/**
 * Without a model (an owner or accountant without a subscription): a link made or taken back by
 * hand never leaves its payment silently unbooked. A payment that lost its receipt waits for one,
 * marked so (issue #29); with its receipt, what no company rule decides becomes a task in
 * Automatisierung, «Zahlung ohne Buchung · von Hand buchen», with the payment's hand form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Index, JournalEntry } from '../src/types/index.js';
import type { AutomationView } from '../src/workflows/model.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT, writeIndex } from './support/workspace.js';
import { startApi } from './support/api-server.js';

/** A demo receipt that shows Swiss VAT (8.1 %). */
const RECEIPT = '20260912-post-ch-rechnung-2026-09.pdf';
/** The statement of the demo's Raiffeisen account that paid it: the read step keeps only payments a statement file holds. */
const CAMT = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>L-1</MsgId><CreDtTm>2026-09-13T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>L-1</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">217.75</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-13</Dt></BookgDt><AcctSvcrRef>REF-L</AcctSvcrRef><AddtlNtryInf>Post CH Rechnung September</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

test('without a model, unlinking and linking by hand leave the payment booked or on Aufgaben, never silently unbooked', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    writeFileSync(join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen/september.xml'), CAMT);
    // The payment as an inbox run with a model booked it: the receipt linked, its input tax claimed, the receipt recorded.
    const index = JSON.parse(JSON.stringify(loadBooks(workspaceAt(DEMO_ROOT)))) as Index;
    const receipt = index.receipts.find((r) => r.filename === RECEIPT)!;
    index.transactions.push({ ref: 'REF-L', bank: 'Raiffeisen', date: '2026-09-13', amount: 217.75, currency: 'CHF', direction: 'DBIT', description: 'Post CH Rechnung September' });
    index.mappings.push({ transactionRef: 'REF-L', receiptId: receipt.id });
    index.journalEntries!.push({ id: 'e-ref-l', transactionRef: 'REF-L', date: '2026-09-13', accountDebit: '6510', accountCredit: '1021', amount: 217.75, vatCode: 'I81', description: 'Post CH', origin: 'classify', receipts: [receipt.id] });
    writeIndex(api.ws, index);

    const books = async () => (await (await api.fetch('/books.json')).json()) as Index;
    const view = async () => (await (await api.fetch('/api/automation')).json()) as AutomationView;
    const rest = async () => {
      for (let i = 0; i < 400; i++) {
        if (!(await view()).runs.some((r) => r.status === 'running' || r.status === 'queued')) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the runs did not come to rest');
    };
    const onL = async () => ((await books()).journalEntries ?? []).filter((e) => e.transactionRef === 'REF-L');
    const forL = (v: AutomationView) => v.tasks.filter((t) => t.item.kind === 'transaction' && t.item.id === 'REF-L');
    const intakeRuns = (v: AutomationView) => v.runs.filter((r) => r.workflow === 'receipt-intake');

    assert.equal((await onL()).length, 1);
    const loose = await api.send('POST', '/api/mapping/remove', { receiptId: receipt.id, transactionRef: 'REF-L' });
    assert.deepEqual(loose.json, { ok: true, again: ['REF-L'] });
    await rest();
    let v = await view();
    assert.deepEqual(await onL(), [], 'the booking that saw the receipt is gone');
    assert.equal(intakeRuns(v).length, 1, 'the unlink started an inbox run');
    assert.deepEqual(forL(v), [], 'no task: without its receipt the payment waits for it, the app\'s work (issue #29)');
    assert.ok((await books()).transactions.find((t) => t.ref === 'REF-L')?.waitsForReceipt, 'marked as waiting for its receipt');

    const linked = await api.send('POST', '/api/mapping/add', { receiptId: receipt.id, transactionRef: 'REF-L' });
    assert.deepEqual(linked.json, { ok: true, again: ['REF-L'] }, 'a link of an unbooked payment books it again');
    await rest();
    v = await view();
    assert.equal(intakeRuns(v).length, 2, 'the link started an inbox run too');
    assert.equal(forL(v).length, 1, `with its receipt and no model, a task waits for the payment: ${JSON.stringify(v.tasks.map((t) => [t.workflow, t.step, t.item]))} ${JSON.stringify(v.runs.map((r) => [r.workflow, r.item.id, r.status, r.path, r.error]))}`);
    assert.equal(forL(v)[0].title.de, 'Zahlung ohne Buchung · von Hand buchen');
    assert.deepEqual(forL(v)[0].outcomes, ['booked']);
    assert.equal(forL(v)[0].do, 'open-item');
    assert.equal((await books()).transactions.find((t) => t.ref === 'REF-L')?.waitsForReceipt, undefined, 'it waits for its receipt no more');

    // The person books it by hand: the task is answered, and the payment stays as the person left it.
    const booked = await api.send('POST', '/api/journal-entries', { date: '2026-09-13', accountDebit: '6510', accountCredit: '1021', amount: 217.75, vatCode: 'I81', description: 'Post CH, von Hand', transactionRef: 'REF-L' });
    assert.equal(booked.status, 200, JSON.stringify(booked.json));
    const answered = await api.send('POST', '/api/automation', { kind: 'answer', run: forL(v)[0].run, outcome: 'booked' });
    assert.deepEqual(answered.json, { ok: true, run: forL(v)[0].run });
    await rest();
    v = await view();
    assert.deepEqual(forL(v), []);
    assert.deepEqual((await onL()).map((e: JournalEntry) => [e.vatCode, e.origin]), [['I81', 'manual']]);
  } finally {
    await api.stop();
  }
});
