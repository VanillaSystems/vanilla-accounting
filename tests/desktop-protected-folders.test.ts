/**
 * Issue #373: at the very first start of the Mac app, macOS asked «"Vanilla Accounting" would like
 * to access files in your Documents folder» over the welcome screen, before the person had chosen
 * anything: the start screen's GET /api/desktop listed the Documents folder for a free name. Here
 * every file system call under the folders macOS protects is recorded (tests/support/protected-folders.ts)
 * while the desktop server does what the app does before the first window and before her first
 * choice. Nothing may touch them on a first start; on a later start with books in Documents, the
 * window comes first and the books are read asynchronously, never synchronously before macOS has
 * answered (that held the main process, #363).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopServer, listen, portOf, type DesktopServerOptions } from '../src/desktop/server.js';
import { firstPage } from '../src/desktop/start.js';
import { protectedFolders, type ProtectedFolders, type Touch } from './support/protected-folders.js';

const ANSWERS = {
  legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly', fiscalYear: 'calendar', start: 'new',
  sells: ['services'], foreignCustomers: 'yes', imports: 'no', employees: 'owner', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no',
};

/** The desktop server as main.ts makes it: the user data folder in Library, new books in Documents. */
function serverOn(tcc: ProtectedFolders, more: Partial<DesktopServerOptions> = {}) {
  const userData = join(tcc.home, 'Library', 'Application Support', 'Vanilla Accounting');
  mkdirSync(userData, { recursive: true });
  return desktopServer({
    stateFile: join(userData, 'desktop.json'), demoRoot: join(userData, 'Demo'), booksHome: tcc.documents, dist: join(tcc.home, 'dist'),
    protectedFolders: { documents: tcc.documents, desktop: tcc.desktop, downloads: tcc.downloads },
    aiAvailable: async () => true,
    ...more,
  });
}

async function serve(server: ReturnType<typeof desktopServer>) {
  const http = await listen(server.app, '127.0.0.1', undefined);
  const host = `127.0.0.1:${portOf(http)}`;
  server.allowHost(host);
  return { base: `http://${host}`, close: () => http.close() };
}

test('a first start touches nothing under Documents, Desktop or Downloads until she chooses new books (#373)', async () => {
  const tcc = protectedFolders();
  mkdirSync(join(tcc.documents, 'Buchhaltung 2026'));
  try {
    tcc.start();
    // main.ts: the server, the menu, the first window (no books opened before).
    const server = serverOn(tcc);
    assert.deepEqual(server.recent(), []);
    const http = await serve(server);
    const shown: string[] = [];
    await firstPage({ last: undefined, reach: server.reach, open: server.open, current: server.current, pathOf: () => '/', show: (p) => shown.push(p) });
    assert.deepEqual(shown, ['/']);
    try {
      // The page of the first window, until her first click: the welcome screen and the look at this Mac's AI.
      const info = await (await fetch(`${http.base}/api/desktop`)).json();
      const ai = await (await fetch(`${http.base}/api/desktop/ai`)).json();
      assert.deepEqual(tcc.touches, [], 'nothing under a protected folder before her first choice: macOS would ask over the welcome screen');
      assert.deepEqual(ai, { available: true });
      assert.equal(info.open, null);
      assert.deepEqual(info.recent, []);
      assert.deepEqual(info.folders, [], 'no free name is looked for before she wants new books');
      assert.equal(info.homeAccess, undefined, 'macOS has not been asked yet');

      // «Neue Buchhaltung erstellen», after the app said why macOS asks: now the Documents folder is read, asynchronously.
      const listed = await (await fetch(`${http.base}/api/desktop/folders`)).json();
      assert.deepEqual(listed, { folders: ['Buchhaltung 2026'], access: 'allowed' });
      const touches: Touch[] = tcc.touches;
      assert.ok(touches.length > 0 && touches.every((t) => t.kind === 'async' && t.folder === tcc.documents), JSON.stringify(touches));
      assert.equal((await (await fetch(`${http.base}/api/desktop`)).json()).homeAccess, 'allowed', 'kept: the next time the step needs no word about it');
    } finally {
      http.close();
    }
  } finally {
    tcc.stop();
  }
});

test('a later start with books in Documents reads them only asynchronously while macOS asks; the menu reads nothing (#373)', async () => {
  const tcc = protectedFolders();
  try {
    const books = join(tcc.documents, 'Maler Huber');
    {
      const setup = serverOn(tcc);
      const http = await serve(setup);
      try {
        const made = await fetch(`${http.base}/api/desktop/create`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preset: 'consultant', name: 'Maler Huber GmbH', uid: 'CHE-153.004.184', owner: 'Sandra Huber', language: 'de', root: books, answers: ANSWERS, banks: [{ bank: 'UBS', currency: 'CHF' }] }),
        });
        assert.equal(made.status, 200, await made.text());
      } finally {
        http.close();
      }
    }

    // The next start: macOS asks again about Documents (the grant of the save panel lasted one run).
    tcc.start();
    tcc.hold();
    const server = serverOn(tcc);
    assert.deepEqual(server.recent().map((b) => [b.root, b.name]), [[books, 'Maler Huber GmbH']], 'the menu names the books from desktop.json');
    assert.deepEqual(tcc.touches, [], 'the menu reads nothing under Documents');
    const shown: string[] = [];
    // The wait for the folder is over at once here: macOS's question takes longer than any wait.
    const started = firstPage({ last: books, reach: server.reach, open: server.open, current: server.current, pathOf: () => '/', show: (p) => shown.push(p), wait: async () => {} });
    await tcc.asked();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(shown, ['/start'], 'the window comes while macOS asks, with the start screen');
    assert.deepEqual(tcc.frozen, [], 'no synchronous call under Documents before macOS answered: it would hold the main process');
    tcc.answer();
    await started;
    assert.deepEqual(shown, ['/start', '/'], 'once she allowed it, the books open in the window');
    assert.equal(server.current()?.name, 'Maler Huber GmbH');
    assert.deepEqual(tcc.frozen, []);

    // The menu's «Zuletzt geöffnet» and the start screen's list open and look through the server too.
    tcc.forget();
    tcc.hold();
    const again = serverOn(tcc);
    const http = await serve(again);
    try {
      const listed = fetch(`${http.base}/api/desktop`).then((r) => r.json());
      const opening = again.open(books);
      await tcc.asked();
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(tcc.frozen, [], 'opening or listing recent books reads nothing synchronously before macOS answered');
      tcc.answer();
      assert.equal((await opening).name, 'Maler Huber GmbH');
      assert.equal((await listed).recent[0].name, 'Maler Huber GmbH');
      assert.deepEqual(tcc.frozen, []);
    } finally {
      http.close();
    }
  } finally {
    tcc.stop();
  }
});

test('books in a folder macOS does not let the app read («Nicht erlauben») are refused with the way to allow it (#373)', { skip: process.getuid?.() === 0 ? 'root reads every folder' : false }, async () => {
  const tcc = protectedFolders();
  const books = join(tcc.desktop, 'Buchhaltung');
  mkdirSync(books);
  writeFileSync(join(books, 'x'), '');
  const { chmodSync } = await import('node:fs');
  chmodSync(tcc.desktop, 0o000);
  try {
    const server = serverOn(tcc);
    await assert.rejects(server.open(books), (e: { refusal?: unknown }) => {
      assert.deepEqual(e.refusal, { code: 'folderRefused', params: { root: books, folder: 'desktop' } });
      return true;
    });
  } finally {
    chmodSync(tcc.desktop, 0o755);
    tcc.stop();
  }
});

test('the books opened last open before the window when their folder answers at once, and stay shut when she chose others meanwhile (#373)', async () => {
  const order: string[] = [];
  const books = { root: '/Users/sandra/Documents/Maler Huber' };
  await firstPage({
    last: books.root, reach: async () => { order.push('reach'); }, open: async (r) => { order.push(`open ${r}`); return books; }, current: () => undefined,
    pathOf: (b) => (b ? '/' : '/start'), show: (p) => order.push(`show ${p}`), wait: () => new Promise(() => {}),
  });
  assert.deepEqual(order, ['reach', `open ${books.root}`, 'show /'], 'as before #373: no start screen flashes before the books');

  order.length = 0;
  let answer: () => void = () => {};
  const started = firstPage({
    last: books.root, reach: () => new Promise<void>((r) => { answer = r; }), open: async (r) => { order.push(`open ${r}`); return books; },
    current: () => ({ root: '/Users/sandra/Demo' }), pathOf: () => '/', show: (p) => order.push(`show ${p}`), wait: async () => {},
  });
  await new Promise((r) => setTimeout(r, 10));
  answer();
  await started;
  assert.deepEqual(order, ['show /start'], 'she opened the demo while macOS asked: the window stays on it');
});

test('a Documents folder macOS does not let the app read («Nicht erlauben») is an answer: no folders, kept, said on the next step (#373)', { skip: process.getuid?.() === 0 ? 'root reads every folder' : false }, async () => {
  const tcc = protectedFolders();
  const { chmodSync } = await import('node:fs');
  mkdirSync(join(tcc.documents, 'Buchhaltung 2026'));
  const logged = console.error;
  const lines: unknown[] = [];
  console.error = (...args: unknown[]) => { lines.push(args); };
  chmodSync(tcc.documents, 0o000);
  const server = serverOn(tcc);
  const http = await serve(server);
  try {
    assert.deepEqual(await (await fetch(`${http.base}/api/desktop/folders`)).json(), { folders: [], access: 'refused' });
    assert.equal((await (await fetch(`${http.base}/api/desktop`)).json()).homeAccess, 'refused');
    const made = await fetch(`${http.base}/api/desktop/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'consultant', name: 'Maler Huber GmbH', uid: '', owner: 'Sandra Huber', language: 'de', root: join(tcc.documents, 'Maler Huber'), answers: ANSWERS, banks: [{ bank: 'UBS', currency: 'CHF' }] }),
    });
    assert.deepEqual([made.status, (await made.json()).code], [400, 'folderRefused'], 'new books there are refused with the way to allow it, not with a file error');
    assert.deepEqual(lines, [], 'refused is an answer, not an error to log');
  } finally {
    chmodSync(tcc.documents, 0o755);
    console.error = logged;
    http.close();
    tcc.stop();
  }
});
