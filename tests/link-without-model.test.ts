/**
 * «Zuordnen» of a receipt to a payment that is booked already, on a Mac without Claude (r8f-41):
 * the booking stays and the answer says so (`kept`), instead of the booking going and the rebooking
 * waiting for a model that is not there. The undo («Lösen») takes the link back and leaves the
 * booking, which saw no receipt. A payment without a booking is booked again as before (its run
 * holds at the hand step), and so is one whose booking claimed a receipt now unlinked
 * (tests/relink-no-model.test.ts).
 * On the real API server, whose `claude` is tests/support/no-model-bin.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Index, JournalEntry, Mapping, Receipt } from '../src/types/index.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { writeIndex } from './support/workspace.js';

const FIXTURE = 'tests/fixtures/period-lock-index.json';
type Fixture = Index & { journalEntries: JournalEntry[] };
let api: ApiServer;

/** The fixture with the open payment O1 booked by the app without a receipt, and a receipt with Swiss VAT not linked to anything. */
function books(): Fixture {
  const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
  const entry: JournalEntry = { id: 'jo', transactionRef: 'O1', date: '2026-08-10', accountDebit: '6500', accountCredit: '1021', amount: 20, description: 'Bank August', vatCode: 'I0', origin: 'classify', receipts: [], by: { kind: 'model', model: 'sonnet' }, reason: 'ohne Beleg: kein Vorsteuerabzug' };
  const receipt: Receipt = { id: 'rv', filename: 'august.pdf', originalFilename: 'august.pdf', extractedText: 'Rechnung August MWST 8.1%', extractionMethod: 'pdftotext', fileSize: 10, indexedAt: '2026-08-11T08:00:00Z', location: 'archived', date: '2026-08-10', amount: 20, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 18.5, vat: 1.5, gross: 20 }] };
  return { ...f, journalEntries: f.journalEntries.map((e) => (e.id === 'jo' ? entry : e)), receipts: [...f.receipts, receipt], mappings: f.mappings.filter((m) => m.transactionRef !== 'O1') };
}

before(async () => { api = await startApi(FIXTURE); });
after(async () => { await api?.stop(); });

const onO1 = async () => {
  const b = (await api.send('GET', '/books.json')).json as unknown as Fixture;
  return { entries: b.journalEntries.filter((e) => e.transactionRef === 'O1'), links: (b.mappings as Mapping[]).filter((m) => m.transactionRef === 'O1' && m.receiptId === 'rv') };
};

test('r8f-41: without a model, linking a receipt to a booked payment keeps the booking, says so, and «Lösen» undoes the link alone', async () => {
  const fixture = books();
  writeIndex(api.ws, fixture);
  const before = fixture.journalEntries.filter((e) => e.transactionRef === 'O1');

  const linked = await api.send('POST', '/api/mapping/add', { receiptId: 'rv', transactionRef: 'O1' });
  assert.equal(linked.status, 200, JSON.stringify(linked.json));
  assert.deepEqual(linked.json, { ok: true, again: [], kept: ['O1'] }, 'the answer names the payment whose booking stays');
  const after1 = await onO1();
  assert.deepEqual(after1.entries, before, 'the booking is as it was, byte for byte');
  assert.deepEqual(after1.links.map((m) => m.by), ['human'], 'the link is there, as made by hand (Änderungen lists it)');

  const loose = await api.send('POST', '/api/mapping/remove', { receiptId: 'rv', transactionRef: 'O1' });
  assert.deepEqual(loose.json, { ok: true, again: [] }, 'the undo takes the link back; the booking, which saw no receipt, fits the payment as before');
  const after2 = await onO1();
  assert.deepEqual(after2.entries, before, 'the undo leaves the booking');
  assert.deepEqual(after2.links, []);
});

test('without a model, linking a receipt to a payment without a booking books it again as before (the run holds for the hand)', async () => {
  const fixture = books();
  writeIndex(api.ws, { ...fixture, journalEntries: fixture.journalEntries.filter((e) => e.transactionRef !== 'O1') });
  const linked = await api.send('POST', '/api/mapping/add', { receiptId: 'rv', transactionRef: 'O1' });
  assert.deepEqual(linked.json, { ok: true, again: ['O1'] }, 'nothing kept: there was no booking');
});
