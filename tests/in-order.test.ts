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
