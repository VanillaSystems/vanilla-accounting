/**
 * The owner corrects the VAT the AI read off a receipt, by hand (PATCH /api/receipts/:id): the
 * payment the classifier booked with the old facts is booked again with hers, and her facts stay
 * through the run that books it. Runs the real server with the model stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookedWithReceipt } from './support/inbox-run.js';

test('VAT facts set by hand are a person\'s: the receipt\'s payment is booked again with them, they stay through the run; an undo gives them back to the AI', async () => {
  const { api, session, rc, full } = await bookedWithReceipt();
  try {
    const onG = async () => (await full()).journalEntries.filter((e) => e.transactionRef === 'REF-G').map((e) => [e.vatCode, e.origin, e.receipts]);
    const receipt = async () => (await full()).receipts.find((r) => r.id === rc.id)!;
    assert.equal((await receipt()).hasSwissVat, false, 'the AI read no Swiss VAT');
    assert.deepEqual(await onG(), [['I0', 'classify', [rc.id]]]);

    const vat = { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 83.92 }], vatId: 'CHE-111.222.333' };
    const { status, json } = await api.send('PATCH', `/api/receipts/${rc.id}`, { vat });
    assert.equal(status, 200, String(json.error));
    await session.rest();
    assert.deepEqual(await onG(), [['I81', 'classify', [rc.id]]], 'booked again, with the input tax');
    const r = await receipt();
    assert.deepEqual([r.hasSwissVat, r.vatSummary, r.vatId, r.vatBy], [true, vat.vatSummary, vat.vatId, 'human'], 'her facts survived the run');

    const ids = async () => (await full()).journalEntries.filter((e) => e.transactionRef === 'REF-G').map((e) => e.id);
    const booked = await ids();
    const same = await api.send('PATCH', `/api/receipts/${rc.id}`, { vat, description: 'Gerüst' });
    assert.equal(same.status, 200);
    await session.rest();
    assert.deepEqual(await ids(), booked, 'the same facts again book nothing again');

    const undo = await api.send('PATCH', `/api/receipts/${rc.id}`, { vat: { hasSwissVat: false, vatSummary: [] }, vatBy: null });
    assert.equal(undo.status, 200, String(undo.json.error));
    await session.rest();
    const back = await receipt();
    assert.deepEqual([back.hasSwissVat, back.vatSummary, back.vatId, back.vatBy], [false, [], undefined, undefined], 'an undo puts back what the AI read, as the AI\'s');
    assert.deepEqual(await onG(), [['I0', 'classify', [rc.id]]], 'and books the payment as before');

    const none = await api.send('PATCH', `/api/receipts/${rc.id}`, { vat: null });
    assert.equal(none.status, 200);
    await session.rest();
    const read = await receipt();
    assert.deepEqual([read.hasSwissVat, read.vatBy, !!read.vatExtractedAt], [false, undefined, true], 'without facts the VAT step reads them again');
  } finally {
    await session.rest().catch(() => {});
    await api.stop();
  }
});
