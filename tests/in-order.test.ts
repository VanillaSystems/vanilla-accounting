/**
 * Saves of one invoice draft go to the server one after the other, and only the last answer is
 * shown (persona round 4, corner-44: unit and VAT rate changed within 0.6 s, the second was lost).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inOrder } from '../src/app/lib/in-order.js';

test('a quick second save waits for the first, and only its answer counts as the latest', async () => {
  const save = inOrder();
  const server: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => { release = r; });
  const first = save('d1', async () => { await slow; server.push('unit'); return 'unit'; });
  const second = save('d1', async () => { server.push('unit+vat'); return 'unit+vat'; });
  const other = await save('d2', async () => 'other');
  assert.deepEqual(other, { result: 'other', latest: true }, 'another draft does not wait');
  assert.deepEqual(server, [], 'the second save has not overtaken the first');
  release();
  assert.deepEqual(await first, { result: 'unit', latest: false });
  assert.deepEqual(await second, { result: 'unit+vat', latest: true });
  assert.deepEqual(server, ['unit', 'unit+vat']);
});

test('a failed save does not stop the next one', async () => {
  const save = inOrder();
  const a = save('d', async () => { throw new Error('refused'); });
  const b = save('d', async () => 'ok');
  await assert.rejects(a, /refused/);
  assert.deepEqual(await b, { result: 'ok', latest: true });
});

test('a read of the records that answers while a draft is being saved keeps the draft as it is on the screen (r5h-22: unit, then VAT 0.6 s later, went back to 8.1 %)', async () => {
  const { localEdits } = await import('../src/app/lib/local-edits.js');
  const edits = localEdits();
  const server0 = [{ id: 'd1', unit: '', vat: 8.1 }, { id: 'd2', unit: 'h', vat: 8.1 }];
  // The books changed, so the page reads the records again; meanwhile the person edits d1 twice.
  const merge = edits.read();
  let release!: () => void;
  const saved = edits.saving('d1', new Promise<void>((r) => { release = r; }));
  const local = [{ id: 'd1', unit: 'flat', vat: 2.6 }, server0[1]];
  assert.deepEqual(merge(server0, local), local, 'the older answer does not undo the edits on the screen');
  release();
  await saved;
  const after = edits.read();
  const server1 = [{ id: 'd1', unit: 'flat', vat: 2.6 }, { id: 'd2', unit: 'day', vat: 8.1 }];
  assert.deepEqual(after(server1, local), server1, 'once saved, a read started later is the truth again');
});

test('a read begun while a draft is being saved keeps the draft on the screen even when the save settled before the answer (r6h-9: the unit and the VAT rate, saved, were back at – / 8.1 %)', async () => {
  const { localEdits } = await import('../src/app/lib/local-edits.js');
  const edits = localEdits();
  const creation = [{ id: 'd1', unit: '', vat: 8.1 }];
  // The unit is picked: its save goes out. A read of the records begins while that save is on the
  // way, and the server answers it from before the save. The save settles first, the read answers last.
  let release!: () => void;
  const saved = edits.saving('d1', new Promise<void>((r) => { release = r; }));
  const merge = edits.read();
  release();
  await saved;
  const screen = [{ id: 'd1', unit: 'h', vat: 8.1 }];
  assert.deepEqual(merge(creation, screen), screen, 'the answer is older than the save that settled: the screen keeps the unit');
  // A read begun after the save settled is the truth again.
  assert.deepEqual(edits.read()(creation, screen), creation);
});
