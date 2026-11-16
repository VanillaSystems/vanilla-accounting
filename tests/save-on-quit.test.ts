/**
 * ⌘Q and SIGTERM quit the Mac app also with a copy open (review of PR #559): the first quit waits for
 * the copy's last save, bounded, then quits for sure; a save that fails or hangs never keeps the app
 * alive. Only a copy that saves by itself and has unsaved changes is saved (src/desktop/save-on-quit.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { saveBeforeQuit, saveIfDirty } from '../src/desktop/save-on-quit.js';

/** Electron's app as far as the guard uses it: quit() emits before-quit, and quits unless it was prevented. */
function fakeApp() {
  const em = new EventEmitter();
  const app = {
    quits: 0, ended: false,
    on: (ev: 'before-quit', fn: (e: { preventDefault(): void }) => void) => em.on(ev, fn),
    quit() { app.quits++; let prevented = false; em.emit('before-quit', { preventDefault: () => { prevented = true; } }); if (!prevented) app.ended = true; },
  };
  return app;
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('⌘Q waits for the copy\'s save, then quits', async () => {
  const app = fakeApp();
  let saved = false;
  const guard = saveBeforeQuit(app, async () => { await tick(10); saved = true; });
  app.quit();
  assert.equal(app.ended, false, 'held while saving');
  assert.equal(guard.quitting(), true, 'a window closing now does not save again');
  app.quit();
  await tick(30);
  assert.equal(saved, true);
  assert.equal(app.ended, true, 'and then the app quits');
});

test('a save that fails or hangs never keeps the app alive', async () => {
  const failing = fakeApp();
  saveBeforeQuit(failing, () => Promise.reject(new Error('disk full')));
  failing.quit();
  await tick(5);
  assert.equal(failing.ended, true);
  const hanging = fakeApp();
  saveBeforeQuit(hanging, () => new Promise(() => undefined), 20);
  hanging.quit();
  await tick(60);
  assert.equal(hanging.ended, true, 'bounded');
});

test('only a copy that saves by itself and has unsaved changes is saved on quitting', async () => {
  const calls: string[] = [];
  const server = (document: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url).replace('http://x', '')}`);
    return Response.json(String(url).endsWith('/save') ? { document: { dirty: false } } : { document });
  }) as typeof fetch;
  for (const d of [null, { auto: false, dirty: true }, { auto: true, dirty: false }, { auto: true, dirty: true, other: true }, { auto: true, dirty: true, missing: true }]) {
    calls.length = 0;
    assert.equal(await saveIfDirty('http://x', server(d)), false, JSON.stringify(d));
    assert.deepEqual(calls, ['GET /api/handover/document']);
  }
  calls.length = 0;
  assert.equal(await saveIfDirty('http://x', server({ auto: true, dirty: true })), true);
  assert.deepEqual(calls, ['GET /api/handover/document', 'POST /api/handover/document/save']);
});
