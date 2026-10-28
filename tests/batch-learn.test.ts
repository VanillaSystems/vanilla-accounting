/**
 * A batch's change of account or code teaches as the same change by hand does (#216,
 * src/server/questions.ts learnFromCorrection): a sale's code set by batch answers the app's
 * question about that payment, and the batch's undo answers it anew from the bookings put back.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readQuestions } from '../src/questions/store.js';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/sale-vat-index.json'); });
after(() => api?.stop());

const questionOn = (ref: string) => readQuestions(api.ws).filter((q) => q.topic === 'saleVat' && q.on.id === ref);

test('a sale\'s code set by batch answers its question, as by hand', async () => {
  const r = await api.send('POST', '/api/batch', { action: { kind: 'vatCode', to: 'V81' }, ids: ['e-ch', 'e-gen'] });
  assert.equal(r.status, 200, String(r.json.error));
  for (const ref of ['S-CH', 'S-GEN']) {
    const [q] = questionOn(ref);
    assert.deepEqual([q?.status, q?.answer?.answer], ['answered', { choice: 'saleDomestic' }], ref);
  }
});
