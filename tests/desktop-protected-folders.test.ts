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
import { askingPath, firstPage, unaskedPath } from '../src/desktop/start.js';
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
    await firstPage({ last: undefined, reach: server.reach, answered: server.answered, unasked: () => '/start?unasked', open: server.open, current: server.current, pathOf: () => '/', asking: () => '/start?asking', show: (p) => shown.push(p) });
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

/** Books «Maler Huber GmbH» made in Documents by version `version` of the app, as the save panel's folder. */
async function booksInDocuments(tcc: ProtectedFolders, version: string): Promise<string> {
  const books = join(tcc.documents, 'Maler Huber');
  const http = await serve(serverOn(tcc, { appVersion: version }));
  try {
    const made = await fetch(`${http.base}/api/desktop/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'consultant', name: 'Maler Huber GmbH', uid: 'CHE-153.004.184', owner: 'Sandra Huber', language: 'de', root: books, answers: ANSWERS, banks: [{ bank: 'UBS', currency: 'CHF' }] }),
    });
    assert.equal(made.status, 200, await made.text());
  } finally {
    http.close();
  }
  return books;
}

test('after an update the start reads nothing in Documents before she was told why macOS asks: the books open on her «Weiter» (#373, 2026-11-13)', async () => {
  const tcc = protectedFolders();
  try {
    const books = await booksInDocuments(tcc, '0.4.1');
    // The first start of the new version: an unsigned build lost macOS's permission with the update.
    tcc.start();
    tcc.hold();
    const server = serverOn(tcc, { appVersion: '0.4.2' });
    assert.equal(server.answered(books), false, 'this version has no answer of macOS for Documents');
    const http = await serve(server);
    try {
      const shown: string[] = [];
      const unasked = (root: string) => unaskedPath(root, server.recent().find((b) => b.root === root)?.name ?? '', server.folderOf(root));
      await firstPage({ last: books, reach: server.reach, answered: server.answered, unasked, open: server.open, current: server.current, pathOf: () => '/', asking: () => '/start?asking', show: (p) => shown.push(p), wait: async () => {} });
      assert.deepEqual(shown, [`/start?${new URLSearchParams({ unasked: books, name: 'Maler Huber GmbH', folder: 'documents' })}`], 'the window says first why macOS will ask');
      // The start screen's list names them from desktop.json, without a look into the folder.
      const info = await (await fetch(`${http.base}/api/desktop`)).json();
      assert.deepEqual(info.recent, [{ root: books, demo: false, name: 'Maler Huber GmbH', unasked: 'documents' }]);
      assert.equal(info.homeAccess, undefined);
      assert.deepEqual(tcc.touches, [], 'nothing under Documents before her click: macOS would ask over a screen that said nothing about it');

      // «Weiter»: now macOS asks, and only asynchronously.
      const opening = fetch(`${http.base}/api/desktop/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: books }) });
      await tcc.asked();
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(tcc.frozen, [], 'no synchronous call under Documents before macOS answered');
      tcc.answer();
      assert.equal((await (await opening).json()).name, 'Maler Huber GmbH');
      assert.equal(server.answered(books), true, 'the answer is kept for this version');
      assert.equal((await (await fetch(`${http.base}/api/desktop`)).json()).homeAccess, 'allowed');
    } finally {
      http.close();
    }
  } finally {
    tcc.stop();
  }
});

test('a later start of the same version opens the books before the window; if macOS asks anyway, only asynchronously; the menu reads nothing (#373)', async () => {
  const tcc = protectedFolders();
  try {
    const books = await booksInDocuments(tcc, '0.4.2');
    // The next start: macOS answered this version already, yet asks again (the grant of the save panel lasted one run).
    tcc.start();
    tcc.hold();
    const server = serverOn(tcc, { appVersion: '0.4.2' });
    assert.equal(server.answered(books), true);
    assert.deepEqual(server.recent().map((b) => [b.root, b.name]), [[books, 'Maler Huber GmbH']], 'the menu names the books from desktop.json');
    assert.deepEqual(tcc.touches, [], 'the menu reads nothing under Documents');
    const shown: string[] = [];
    // The wait for the folder is over at once here: macOS's question takes longer than any wait.
    const asking = (root: string) => askingPath(root, server.recent().find((b) => b.root === root)?.name ?? '', server.folderOf(root));
    const started = firstPage({ last: books, reach: server.reach, answered: server.answered, unasked: () => '/start?unasked', open: server.open, current: server.current, pathOf: () => '/', asking, show: (p) => shown.push(p), wait: async () => {} });
    await tcc.asked();
    await new Promise((r) => setTimeout(r, 50));
    const waitingAt = `/start?${new URLSearchParams({ asking: books, name: 'Maler Huber GmbH', folder: 'documents' })}`;
    assert.deepEqual(shown, [waitingAt], 'the window comes while macOS asks, with the start screen naming the folder and the books');
    assert.deepEqual(tcc.frozen, [], 'no synchronous call under Documents before macOS answered: it would hold the main process');
    tcc.answer();
    await started;
    assert.deepEqual(shown, [waitingAt, '/'], 'once she allowed it, the books open in the window');
    assert.equal(server.current()?.name, 'Maler Huber GmbH');
    assert.deepEqual(tcc.frozen, []);

    // The menu's «Zuletzt geöffnet» and the start screen's list open and look through the server too.
    tcc.forget();
    tcc.hold();
    const again = serverOn(tcc, { appVersion: '0.4.2' });
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

test('iCloud Drive, the cloud providers\' folders and the volumes count as asked about too, each volume and provider on its own (#373)', async () => {
  const tcc = protectedFolders();
  const icloud = join(tcc.home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const dropbox = join(tcc.home, 'Library', 'CloudStorage', 'Dropbox', 'Buchhaltung');
  const stick = join(tcc.home, 'Volumes', 'STICK', 'Buchhaltung');
  const share = join(tcc.home, 'Volumes', 'Treuhand', 'Buchhaltung');
  for (const d of [icloud, dropbox, stick, share]) mkdirSync(d, { recursive: true });
  const state = join(tcc.home, 'Library', 'Application Support', 'Vanilla Accounting', 'desktop.json');
  const server = serverOn(tcc, { protectedFolders: { documents: tcc.documents, icloud: join(tcc.home, 'Library', 'Mobile Documents'), cloud: join(tcc.home, 'Library', 'CloudStorage'), volumes: join(tcc.home, 'Volumes') } });
  try {
    writeFileSync(state, JSON.stringify({ recent: [icloud, dropbox, stick], names: { [icloud]: 'Maler Huber GmbH' } }));
    for (const d of [icloud, dropbox, stick, share]) assert.equal(server.answered(d), false, d);
    assert.equal(server.answered(join(tcc.home, 'Buchhaltung')), true, 'a folder macOS guards not: read as ever');
    assert.deepEqual((await server.info()).recent, [
      { root: icloud, demo: false, name: 'Maler Huber GmbH', unasked: 'other' },
      { root: dropbox, demo: false, unasked: 'other' },
      { root: stick, demo: false, unasked: 'other' },
    ]);
    // Her «Weiter» for the stick: macOS answered for that volume, not for the network share.
    assert.equal(await server.reach(stick), 'ok');
    assert.equal(server.answered(stick), true);
    assert.equal(server.answered(share), false, 'macOS asks per volume');
    assert.equal(server.answered(dropbox), false);
    assert.deepEqual(Object.keys(JSON.parse((await import('node:fs')).readFileSync(state, 'utf8')).access), ['volumes:STICK']);
  } finally {
    tcc.stop();
  }
});

test('only a read that went through or macOS\'s refusal is kept as its answer; a missing folder is none (#373 review)', async () => {
  const tcc = protectedFolders();
  try {
    const server = serverOn(tcc, { appVersion: 'b1' });
    assert.equal(await server.reach(join(tcc.documents, 'Gibt es nicht')), 'missing');
    assert.equal(server.answered(tcc.documents), false, 'a missing folder says nothing about macOS\'s answer');
    assert.equal(await server.reach(join(tcc.documents)), 'ok');
    assert.equal(server.answered(tcc.documents), true);
  } finally {
    tcc.stop();
  }
});

test('two builds of one package version: the second asks first, since an ad hoc signed build is a new app to macOS; a Developer ID build keeps its answers per version (#373 review)', async () => {
  const { answerKey, signedByDeveloperId } = await import('../src/desktop/build-key.js');
  const rc56 = answerKey({ packageVersion: '0.4.2', build: '0.4.2-rc.56+g36b66d6', builtAt: '2026-11-13T09:00:00Z', developerId: false });
  const rc57 = answerKey({ packageVersion: '0.4.2', build: '0.4.2-rc.57+g1a2b3c4', builtAt: '2026-11-13T15:00:00Z', developerId: false });
  const rebuilt = answerKey({ packageVersion: '0.4.2', build: '0.4.2-rc.56+g36b66d6', builtAt: '2026-11-13T16:00:00Z', developerId: false });
  assert.equal(new Set([rc56, rc57, rebuilt]).size, 3, 'every build its own key, a rebuild of one commit too');
  const signed = (build: string) => answerKey({ packageVersion: '0.4.2', build, builtAt: build, developerId: true });
  assert.equal(signed('0.4.2-rc.56+g36b66d6'), signed('0.4.2-rc.57+g1a2b3c4'), 'signed: kept across builds of the version');
  assert.equal(signedByDeveloperId('Executable=/Applications/Vanilla Accounting.app/Contents/MacOS/Vanilla Accounting\nAuthority=Developer ID Application: Muster AG (ABCDE12345)\nAuthority=Developer ID Certification Authority\n'), true);
  assert.equal(signedByDeveloperId('Executable=/Applications/Vanilla Accounting.app/Contents/MacOS/Vanilla Accounting\nSignature=adhoc\n'), false);

  const tcc = protectedFolders();
  try {
    const books = await booksInDocuments(tcc, rc56);
    tcc.start();
    const server = serverOn(tcc, { appVersion: rc57 });
    assert.equal(server.answered(books), false, 'rc.57 has no answer of macOS, though rc.56 of the same 0.4.2 had');
    const shown: string[] = [];
    await firstPage({ last: books, reach: server.reach, answered: server.answered, unasked: () => '/start?unasked', open: server.open, current: server.current, pathOf: () => '/', asking: () => '/start?asking', show: (p) => shown.push(p), wait: async () => {} });
    assert.deepEqual(shown, ['/start?unasked'], 'the words come before macOS asks');
    assert.deepEqual(tcc.touches, []);
  } finally {
    tcc.stop();
  }
});

test('a folder macOS refuses (EPERM) and one whose rights refuse (EACCES) are told apart, and the books keep their name (#373)', { skip: process.getuid?.() === 0 ? 'root reads every folder' : false }, async () => {
  const tcc = protectedFolders();
  const { chmodSync } = await import('node:fs');
  const onDesktop = join(tcc.desktop, 'Buchhaltung');
  const inDownloads = join(tcc.downloads, 'Alt');
  mkdirSync(onDesktop);
  mkdirSync(inDownloads);
  const server = serverOn(tcc);
  const http = await serve(server);
  try {
    // «Nicht erlauben»: macOS fails every read there with EPERM.
    tcc.refuse(tcc.desktop);
    await assert.rejects(server.open(onDesktop), (e: { refusal?: unknown }) => {
      assert.deepEqual(e.refusal, { code: 'folderRefused', params: { root: onDesktop, folder: 'desktop', why: 'privacy' } });
      return true;
    });
    // The folder's own rights: EACCES.
    chmodSync(tcc.downloads, 0o000);
    await assert.rejects(server.open(inDownloads), (e: { refusal?: unknown }) => {
      assert.deepEqual(e.refusal, { code: 'folderRefused', params: { root: inDownloads, folder: 'downloads', why: 'rights' } });
      return true;
    });
    // The start screen's list: the name desktop.json keeps, with why. macOS answered for both folders
    // to this version (the Desktop's «Nicht erlauben» was kept just now; Downloads allowed before).
    const state = join(tcc.home, 'Library', 'Application Support', 'Vanilla Accounting', 'desktop.json');
    const { readFileSync } = await import('node:fs');
    const access = { ...JSON.parse(readFileSync(state, 'utf8')).access, downloads: { answer: 'allowed', version: '' } };
    assert.deepEqual(access.desktop, { answer: 'refused', version: '' }, '«Nicht erlauben» is macOS\'s answer, kept');
    writeFileSync(state, JSON.stringify({ recent: [onDesktop, inDownloads], names: { [onDesktop]: 'Maler Huber GmbH' }, access }));
    const recent = (await (await fetch(`${http.base}/api/desktop`)).json()).recent;
    assert.deepEqual(recent, [
      { root: onDesktop, demo: false, name: 'Maler Huber GmbH', noAccess: { folder: 'desktop', why: 'privacy' } },
      { root: inDownloads, demo: false, noAccess: { folder: 'downloads', why: 'rights' } },
    ]);
  } finally {
    chmodSync(tcc.downloads, 0o755);
    http.close();
    tcc.stop();
  }
});

test('the books opened last open before the window when their folder answers at once, and stay shut when she chose others meanwhile (#373)', async () => {
  const order: string[] = [];
  const books = { root: '/Users/sandra/Documents/Maler Huber' };
  const asking = () => '/start?asking';
  await firstPage({
    last: books.root, reach: async () => { order.push('reach'); return 'ok'; }, open: async (r) => { order.push(`open ${r}`); return books; }, current: () => undefined,
    answered: () => true, unasked: () => '/start?unasked', pathOf: (b) => (b ? '/' : '/start'), asking, show: (p) => order.push(`show ${p}`), wait: () => new Promise(() => {}),
  });
  assert.deepEqual(order, ['reach', `open ${books.root}`, 'show /'], 'as before #373: no start screen flashes before the books');

  order.length = 0;
  let answer: (r: string) => void = () => {};
  const started = firstPage({
    last: books.root, reach: () => new Promise<string>((r) => { answer = r; }), open: async (r) => { order.push(`open ${r}`); return books; },
    current: () => ({ root: '/Users/sandra/Demo' }), answered: () => true, unasked: () => '/start?unasked', pathOf: () => '/', asking, show: (p) => order.push(`show ${p}`), wait: async () => {},
  });
  await new Promise((r) => setTimeout(r, 10));
  answer('ok');
  await started;
  assert.deepEqual(order, ['show /start?asking'], 'she opened the demo while macOS asked: the window stays on it');

  order.length = 0;
  const refused = firstPage({
    last: books.root, reach: () => new Promise<string>((r) => { answer = r; }), open: async (r) => { order.push(`open ${r}`); return books; },
    current: () => null, answered: () => true, unasked: () => '/start?unasked', pathOf: () => '/', asking, show: (p) => order.push(`show ${p}`), wait: async () => {},
  });
  await new Promise((r) => setTimeout(r, 10));
  answer('refused');
  await refused;
  assert.deepEqual(order, ['show /start?asking', 'show /start'], '«Nicht erlauben»: the plain start screen, whose list says how to allow it');
});

test('macOS refusing the Documents folder («Nicht erlauben», EPERM) is an answer: no folders, kept, said on the next step; its rights (EACCES) are said apart (#373)', { skip: process.getuid?.() === 0 ? 'root reads every folder' : false }, async () => {
  const tcc = protectedFolders();
  const { chmodSync } = await import('node:fs');
  mkdirSync(join(tcc.documents, 'Buchhaltung 2026'));
  const logged = console.error;
  const lines: unknown[] = [];
  console.error = (...args: unknown[]) => { lines.push(args); };
  const server = serverOn(tcc);
  const http = await serve(server);
  try {
    tcc.refuse(tcc.documents);
    assert.deepEqual(await (await fetch(`${http.base}/api/desktop/folders`)).json(), { folders: [], access: 'refused' });
    assert.equal((await (await fetch(`${http.base}/api/desktop`)).json()).homeAccess, 'refused');
    const made = await fetch(`${http.base}/api/desktop/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'consultant', name: 'Maler Huber GmbH', uid: '', owner: 'Sandra Huber', language: 'de', root: join(tcc.documents, 'Maler Huber'), answers: ANSWERS, banks: [{ bank: 'UBS', currency: 'CHF' }] }),
    });
    const body = await made.json();
    assert.deepEqual([made.status, body.code, body.params?.why], [400, 'folderRefused', 'privacy'], 'new books there are refused with the way to allow it, not with a file error');
    tcc.stop();

    // The folder's own rights: said apart, and not kept as macOS's answer.
    writeFileSync(join(tcc.home, 'Library', 'Application Support', 'Vanilla Accounting', 'desktop.json'), '{"recent":[]}');
    chmodSync(tcc.documents, 0o000);
    assert.deepEqual(await (await fetch(`${http.base}/api/desktop/folders`)).json(), { folders: [], access: 'locked' });
    assert.equal((await (await fetch(`${http.base}/api/desktop`)).json()).homeAccess, undefined);
    assert.deepEqual(lines, [], 'refused is an answer, not an error to log');
  } finally {
    chmodSync(tcc.documents, 0o755);
    console.error = logged;
    http.close();
    tcc.stop();
  }
});

test('macOS\'s answer is kept for this version of the app only: after an update the words come again (#373 review)', async () => {
  const tcc = protectedFolders();
  try {
    const http = await serve(serverOn(tcc, { appVersion: '0.4.2' }));
    try {
      assert.equal((await (await fetch(`${http.base}/api/desktop/folders`)).json()).access, 'allowed');
      assert.equal((await (await fetch(`${http.base}/api/desktop`)).json()).homeAccess, 'allowed');
    } finally { http.close(); }
    const updated = await serve(serverOn(tcc, { appVersion: '0.4.3' }));
    try {
      assert.equal((await (await fetch(`${updated.base}/api/desktop`)).json()).homeAccess, undefined, 'an update (an unsigned build above all) may have lost the permission');
    } finally { updated.close(); }
  } finally {
    tcc.stop();
  }
});

test('after a restart new books never open the books already in the proposed folder: the taken name steps aside (#373 review)', async () => {
  const tcc = protectedFolders();
  try {
    const taken = join(tcc.documents, 'Buchhaltung 2026');
    const form = (root: string, name: string) => ({
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'consultant', name, uid: 'CHE-153.004.184', owner: 'Sandra Huber', language: 'de', root, answers: ANSWERS, banks: [{ bank: 'UBS', currency: 'CHF' }] }),
    });
    {
      const http = await serve(serverOn(tcc, { appVersion: '1' }));
      try {
        assert.equal((await (await fetch(`${http.base}/api/desktop/folders`)).json()).access, 'allowed');
        const made = await fetch(`${http.base}/api/desktop/create`, form(taken, 'Maler Huber GmbH'));
        assert.equal(made.status, 200, await made.text());
      } finally { http.close(); }
    }
    // The next start: nothing listed in memory; allowed by this version, the form reads the folders for a free name.
    const server = serverOn(tcc, { appVersion: '1' });
    const http = await serve(server);
    try {
      const info = await (await fetch(`${http.base}/api/desktop`)).json();
      assert.equal(info.homeAccess, 'allowed');
      assert.deepEqual((await (await fetch(`${http.base}/api/desktop/folders`)).json()).folders, ['Buchhaltung 2026'], 'what the form takes the free name from');
      // And were the old name sent anyway: refused, with the free one, the old books left shut.
      const again = await fetch(`${http.base}/api/desktop/create`, form(taken, 'Schreinerei Graf GmbH'));
      assert.equal(again.status, 400);
      assert.deepEqual((await again.json()).params, { root: taken, holds: 'books', name: 'Maler Huber GmbH', free: `${taken} 2` });
      assert.equal(server.current(), null, 'the old books were not opened');
      const next = await fetch(`${http.base}/api/desktop/create`, form(`${taken} 2`, 'Schreinerei Graf GmbH'));
      assert.equal(next.status, 200, await next.text());
      assert.equal(server.current()?.name, 'Schreinerei Graf GmbH');
    } finally { http.close(); }
  } finally {
    tcc.stop();
  }
});

test('the look for the AI\'s programs never looks into Documents, Desktop or Downloads, though the PATH names them (#373 review)', async () => {
  const { placesOf } = await import('../src/platform/ai-cli.js');
  const { inProtectedFolder } = await import('../src/platform/login-path.js');
  const pinned = process.env.CLAUDE_BIN;
  delete process.env.CLAUDE_BIN;
  try {
    const places = placesOf('claude', { home: '/Users/sandra', path: '/Users/sandra/Documents/bin:/usr/local/bin:/Users/sandra/Desktop/tools:/Users/sandra/Downloads' });
    assert.deepEqual(places, ['/usr/local/bin/claude', '/Users/sandra/.local/bin/claude']);
    assert.equal(inProtectedFolder('/Users/sandra/Documents2', '/Users/sandra'), false, 'a folder only named alike is looked into');
  } finally {
    if (pinned !== undefined) process.env.CLAUDE_BIN = pinned;
  }
});

test('desktop.json of 0.4.1 kept the Documents answer as homeAccess: read as the Documents folder\'s answer (#373)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { readState } = await import('../src/desktop/state.js');
  const file = join(mkdtempSync(join(tmpdir(), 'vanilla-state-')), 'desktop.json');
  writeFileSync(file, JSON.stringify({ recent: [], homeAccess: { answer: 'allowed', version: '0.4.1' } }));
  assert.deepEqual(readState(file).access, { documents: { answer: 'allowed', version: '0.4.1' } });
  writeFileSync(file, JSON.stringify({ recent: [], access: { desktop: { answer: 'refused', version: '0.4.2' }, downloads: { answer: 'maybe', version: '0.4.2' } } }));
  assert.deepEqual(readState(file).access, { desktop: { answer: 'refused', version: '0.4.2' } }, 'an answer macOS cannot give is dropped');
});

test('the phone listens again when the first books open, once, not at the start (#373 review)', async () => {
  const { resumeOnce } = await import('../src/desktop/start.js');
  let resumed = 0;
  const onOpen = resumeOnce(async () => { resumed++; });
  assert.equal(resumed, 0, 'nothing before books open');
  onOpen();
  assert.equal(resumed, 1, 'the first open starts the listener again');
  onOpen();
  onOpen();
  assert.equal(resumed, 1, 'later opens leave it as it is');
});
