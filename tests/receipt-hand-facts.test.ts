/**
 * Issue #438: a photo the app cannot read, completed by the person (date, amount, «Schweizer MWST
 * auf dem Beleg: ja» at the rate she confirms). What she entered is hers: the next run of the inbox
 * (which tries the unread photo again) and every load keep it, the receipt is no longer «nicht
 * lesbar», and its payment is booked with her rate. Runs the real server, without a model and with
 * the model stub whose reading of the photo comes back empty. The photo and the shop are made up.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnreadable, waitingForReceipt } from '../src/accounting/receipt-due.js';
import type { Index } from '../src/types/index.js';
import { startApi } from './support/api-server.js';
import { SESSION } from './support/inbox-run.js';
import { receiptDid } from '../src/app/history/did.js';

// 2 x 2 pixels: a photo, no text of its own.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYBAB7FA/+WnI5aAAAAAElFTkSuQmCC', 'base64');
const STUB = `${process.cwd()}/tests/support/stub-bin`;

/** A camt.053 of the demo's Raiffeisen account with one card payment of CHF 312.90. */
const STATEMENT = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>H-1</MsgId><CreDtTm>2026-08-01T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>H-1</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">312.90</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-07-08</Dt></BookgDt><AcctSvcrRef>REF-B</AcctSvcrRef><AddtlNtryInf>Karte 5412 Einkauf Baumarkt Muster</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

const VAT = { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 23.45 }] };

type Books = Index;

/** The demo with the statement read and the photo dropped, then completed by hand and linked to its payment, as she does in Belege. */
async function completedByHand(env: Record<string, string> = {}) {
  const api = await startApi('demo', env);
  const session = SESSION(api);
  const full = async () => (await (await api.fetch('/books.json')).json()) as Books;
  let s = await session.post('/api/drop');
  s = await session.post(`/api/drop/${s.id}/files?name=juli.xml`, Buffer.from(STATEMENT));
  await session.rest();
  s = await session.post(`/api/drop/${s.id}/files?name=IMG_4502.PNG`, PNG);
  await session.rest();
  const photo = (await full()).receipts.find((r) => r.originalFilename.startsWith('IMG_4502'));
  assert.ok(photo, 'the photo is in the books');
  assert.equal(isUnreadable(photo), true, 'unread: nothing read its VAT');

  const patch = async (body: object) => {
    const { status, json } = await api.send('PATCH', `/api/receipts/${photo.id}`, body);
    assert.equal(status, 200, String(json.error));
    await session.rest();
  };
  // As in the walk: date and amount, «Zuordnen», then «ja» under «Schweizer MWST auf dem Beleg»,
  // whose save books the linked payment again by a run of the inbox.
  await patch({ date: '2026-07-08' });
  await patch({ amount: 312.9, currency: 'CHF' });
  const link = await api.send('POST', '/api/mapping/add', { receiptId: photo.id, transactionRef: 'REF-B' });
  assert.equal(link.status, 200, String(link.json.error));
  await session.rest();
  await patch({ vat: VAT });
  return { api, session, full, id: photo.id };
}

/** Another run of the whole inbox, as the next drop or «Automatisch buchen» starts it. */
async function nextRun(api: Awaited<ReturnType<typeof startApi>>) {
  const { status, json } = await api.send('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } });
  assert.equal(status, 200, String(json.error));
  await SESSION(api).rest();
}

test('without a model: the VAT she gave a photo is kept over the next runs and loads; the receipt is no longer unreadable, its payment waits for no reading', async () => {
  const { api, full, id } = await completedByHand();
  try {
    await nextRun(api);
    await nextRun(api);
    const books = await full();
    const r = books.receipts.find((x) => x.id === id)!;
    assert.deepEqual([r.hasSwissVat, r.vatSummary, r.vatBy, r.date, r.amount], [true, VAT.vatSummary, 'human', '2026-07-08', 312.9], 'her facts, as she gave them');
    assert.equal(isUnreadable(r), false, 'completed by hand: readable');
    assert.equal(receiptDid(r), 'history.keptByHand', 'its Verlauf: filed, not read, its details entered by hand');
    const tx = books.transactions.find((t) => t.ref === 'REF-B')!;
    assert.equal(tx.waitsForReceipt?.unread, undefined, 'no «Beleg nicht lesbar» on its payment');
    assert.deepEqual(waitingForReceipt(books, (ref) => books.journalEntries!.some((e) => e.transactionRef === ref), '2026-07-09').filter((w) => w.kind === 'unread'), [], 'no task «Beleg nicht lesbar»');
  } finally {
    await api.stop();
  }
});

test('with a model that cannot read the photo either: her facts stay and the payment is booked with her rate', async () => {
  const { api, full, id } = await completedByHand({ PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_OCR_TEXT: '' });
  try {
    await nextRun(api);
    const books = await full();
    const r = books.receipts.find((x) => x.id === id)!;
    assert.deepEqual([r.hasSwissVat, r.vatSummary, r.vatBy], [true, VAT.vatSummary, 'human']);
    assert.deepEqual(books.journalEntries!.filter((e) => e.transactionRef === 'REF-B').map((e) => [e.amount, e.vatCode]), [[312.9, 'I81']], 'booked with the input tax she confirmed');
  } finally {
    await api.stop();
  }
});
