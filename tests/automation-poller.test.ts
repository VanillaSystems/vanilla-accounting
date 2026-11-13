/**
 * The automation store's loop of asks (src/app/automation/poller.ts, #453): asking at once while an
 * ask waits for its answer starts no second loop. Before, each such ask left one more timer running
 * for good: after a drop, 8 asks every 20 s on a quiet app instead of 2, until a reload.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { poller } from '../src/app/automation/poller.js';

/** A loop whose asks answer only when told, counting the asks; `fast` is the store's hurry. */
function loop() {
  const answers: Array<() => void> = [];
  let asks = 0;
  let fast = false;
  const p = poller(() => { asks++; return new Promise<void>((done) => answers.push(done)); }, () => (fast ? 2_000 : 10_000), () => true);
  return {
    p, asks: () => asks, setFast: (on: boolean) => { fast = on; },
    /** Answers every waiting ask and lets the microtasks run. */
    async answer() { while (answers.length) answers.shift()!(); for (let i = 0; i < 5; i++) await Promise.resolve(); },
  };
}

test('many asks while one waits leave exactly one loop', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const l = loop();
    l.p.now();
    for (let i = 0; i < 10; i++) l.p.now();
    assert.equal(l.asks(), 1, 'no second ask while one waits');
    await l.answer();
    assert.equal(l.asks(), 2, 'the wish noted: one ask right after the answer');
    await l.answer();
    // From here on one ask per 10 s: never more.
    mock.timers.tick(10_000); await l.answer();
    mock.timers.tick(10_000); await l.answer();
    assert.equal(l.asks(), 4);
    mock.timers.tick(30_000); await l.answer();
    assert.ok(l.asks() <= 7, `one loop: ${l.asks()} asks`);
    l.p.stop();
  } finally {
    mock.timers.reset();
  }
});

test('in a hurry every 2 s, and back to every 10 s after it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const l = loop();
    l.setFast(true);
    l.p.now(); await l.answer();
    for (let i = 0; i < 5; i++) { mock.timers.tick(2_000); await l.answer(); }
    assert.equal(l.asks(), 6, 'every 2 s in a hurry');
    l.setFast(false);
    mock.timers.tick(2_000); await l.answer();
    const at = l.asks();
    mock.timers.tick(9_000); await l.answer();
    assert.equal(l.asks(), at, 'nothing within 10 s');
    mock.timers.tick(1_000); await l.answer();
    assert.equal(l.asks(), at + 1, 'then one ask every 10 s');
    l.p.stop();
    mock.timers.tick(60_000); await l.answer();
    assert.equal(l.asks(), at + 1, 'stopped: no timer left');
  } finally {
    mock.timers.reset();
  }
});
