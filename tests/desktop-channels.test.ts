/**
 * The page's bridge and the main process speak over the same channels (issue #339): the first
 * screen's «Neue Buchhaltung erstellen» asked on a channel the main process never answered, and no
 * test saw it, since nothing runs both sides but the packed app, whose system dialogs no script
 * can click. So the two files are read here: whatever one side sends, the other side takes, and
 * both name a channel only through src/desktop/channels.ts. With it: the save panel of that
 * button, a failed call's plain sentence, and the start after the move to the Applications folder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASK, PUSH, TELL } from '../src/desktop/channels.js';
import { chosenFolder, newFolderPanel } from '../src/desktop/new-folder.js';
import { PAINT_GRACE_MS, bringUp, offerMove, type AppWindow, type MoveOffer } from '../src/desktop/start.js';
import { desktopServer, listen, portOf } from '../src/desktop/server.js';
import { DesktopCallError, plainFailures } from '../src/app/desktop/bridge.js';
import de from '../src/app/i18n/locales/de.js';
import type { DesktopBridge } from '../src/types/desktop.js';

const source = (file: string) => readFileSync(join('src/desktop', file), 'utf8');

/** The first argument of every `<call>(` in `code`, as written. */
const firstArgs = (code: string, call: RegExp): string[] =>
  [...code.matchAll(new RegExp(`${call.source}\\(\\s*([^,)\\s]+)`, 'g'))].map((m) => m[1]);

/** The keys of `table` these arguments name; an argument that is no `<NAME>.<key>` of it fails. */
function keysOf(args: string[], name: string, table: Record<string, string>, where: string): string[] {
  return [...new Set(args.map((arg) => {
    const key = arg.startsWith(`${name}.`) ? arg.slice(name.length + 1) : '';
    assert.ok(key in table, `${where}: «${arg}» is no channel of ${name} in src/desktop/channels.ts`);
    return key;
  }))].sort();
}

test('every channel the page\'s bridge uses has its other end in the main process, and the other way round', () => {
  const preload = source('preload.ts');
  const main = source('main.ts');
  const sides = [
    { name: 'ASK', table: ASK, page: /ipcRenderer\.invoke/, app: /ipcMain\.handle/, says: 'the page asks (invoke), the main process answers (handle)' },
    { name: 'TELL', table: TELL, page: /ipcRenderer\.send/, app: /ipcMain\.(?:on|once)/, says: 'the page tells (send), the main process listens (on)' },
    { name: 'PUSH', table: PUSH, page: /ipcRenderer\.(?:on|once)/, app: /\.send/, says: 'the main process tells (send), the page listens (on)' },
  ];
  for (const { name, table, page, app, says } of sides) {
    const all = Object.keys(table).sort();
    assert.deepEqual(keysOf(firstArgs(preload, page), name, table, 'preload.ts'), all, `${name}, preload.ts: ${says}`);
    assert.deepEqual(keysOf(firstArgs(main, app), name, table, 'main.ts'), all, `${name}, main.ts: ${says}`);
  }
  const channels = [ASK, TELL, PUSH].flatMap((t) => Object.values(t));
  assert.equal(new Set(channels).size, channels.length, 'one channel, one meaning');
});

test('only the preload and the main process speak over IPC, so the table above is all of it', () => {
  const others = readdirSync('src/desktop').filter((f) => f.endsWith('.ts') && f !== 'main.ts' && f !== 'preload.ts' && f !== 'channels.ts');
  for (const file of others) assert.doesNotMatch(source(file), /\bipc(Main|Renderer)\b/, `src/desktop/${file}`);
});

test('«Neue Buchhaltung erstellen»: the save panel names a new folder in Documents, with the page\'s words and never the page\'s path', () => {
  const panel = newFolderPanel({ title: 'Wo soll die neue Buchhaltung liegen?', name: 'Buchhaltung 2026', button: 'Erstellen' }, '/Users/sandra/Documents');
  assert.deepEqual(panel, {
    title: 'Wo soll die neue Buchhaltung liegen?', message: 'Wo soll die neue Buchhaltung liegen?',
    defaultPath: '/Users/sandra/Documents/Buchhaltung 2026', buttonLabel: 'Erstellen', properties: ['createDirectory'], showsTagField: false,
  });
  assert.equal(newFolderPanel({ title: 't', name: '../../etc/x', button: 'b' }, '/home/Documents').defaultPath, '/home/Documents/x');
  for (const odd of [undefined, null, 'text', 7, {}, { name: '..' }, { name: 5, title: [], button: {} }]) {
    const p = newFolderPanel(odd, '/home/Documents');
    assert.equal(p.defaultPath, '/home/Documents', JSON.stringify(odd));
    assert.equal('buttonLabel' in p, false);
  }
  assert.equal(chosenFolder({ canceled: false, filePath: '/home/Documents/Buchhaltung 2026' }), '/home/Documents/Buchhaltung 2026');
  assert.equal(chosenFolder({ canceled: true, filePath: '' }), null, 'cancelled: the page gets null and stays where it is');
  assert.equal(chosenFolder({ canceled: false }), null);
});

test('a call the desktop app does not answer is said in a plain sentence, not in Electron\'s words', async () => {
  const none = async () => null;
  const dead = async (): Promise<never> => { throw new Error("Error invoking remote method 'desktop:chooseNewFolder': Error: No handler registered for 'desktop:chooseNewFolder'"); };
  const raw: DesktopBridge = { chooseFolder: none, chooseNewFolder: dead, onMenu: () => () => undefined, setLanguage: () => undefined, saveFile: dead, dictate: () => () => undefined };
  const logged = console.error;
  console.error = () => undefined;
  try {
    const bridge = plainFailures(raw);
    assert.equal(await bridge.chooseFolder('t'), null, 'a call that answers passes through');
    assert.equal(typeof bridge.dictate, 'function', 'the rest of the bridge stays');
    const folder = await bridge.chooseNewFolder({ title: 't', name: 'n', button: 'b' }).then(() => undefined, (e: unknown) => e);
    assert.ok(folder instanceof DesktopCallError);
    assert.equal(folder.text, 'desktop.dialogFailed');
    const saved = await bridge.saveFile('/x.pdf', 'x.pdf').then(() => undefined, (e: unknown) => e);
    assert.ok(saved instanceof DesktopCallError);
    assert.equal(saved.text, 'desktop.saveFailed');
    // What errorText (src/app/lib/api.ts) shows for them, in the source language.
    for (const key of [folder.text, saved.text]) {
      const text = de.messages[key];
      assert.ok(typeof text === 'string' && text.length > 20, key);
      assert.doesNotMatch(text, /remote method|handler|desktop:/);
    }
  } finally {
    console.error = logged;
  }
});

const offer = (o: Partial<MoveOffer>, log: string[] = []): MoveOffer => ({
  offered: true, ask: async () => true, move: () => true, failed: async (reason) => { log.push(reason); }, ...o,
});

test('after the move to the Applications folder this process starts nothing more; without it the start goes on', async () => {
  assert.equal(await offerMove(offer({})), 'moved');
  assert.equal(await offerMove(offer({ ask: async () => false, move: () => { throw new Error('not asked for'); } })), 'stays', '«Nicht jetzt»');
  assert.equal(await offerMove(offer({ offered: false, ask: async () => { throw new Error('no question'); } })), 'stays', 'already in Applications, or not packed');
  assert.equal(await offerMove(offer({ move: () => false })), 'stays', 'the move was called off');
  const said: string[] = [];
  assert.equal(await offerMove(offer({ move: () => { throw new Error('EPERM'); } }, said)), 'stays');
  assert.deepEqual(said, ['EPERM'], 'a failed move is told');
});

function fakeWindow(state: { destroyed?: boolean; minimized?: boolean; visible?: boolean }): AppWindow & { did: string[] } {
  const did: string[] = [];
  return {
    did,
    isDestroyed: () => !!state.destroyed, isMinimized: () => !!state.minimized, isVisible: () => !!state.visible,
    restore: () => { did.push('restore'); }, show: () => { did.push('show'); }, focus: () => { did.push('focus'); },
  };
}

test('a click on the Dock icon brings a window: a new one when none is left, the hidden one when it never appeared', () => {
  let created = 0;
  const create = () => { created++; };
  const since = 1_000_000;
  const fine = { since, failed: false };
  bringUp(undefined, create, fine);
  bringUp(fakeWindow({ destroyed: true }), create, fine);
  assert.equal(created, 2, 'no window, or a closed one: a new one');

  // macOS sends «activate» on an ordinary start too: a window still waiting for its first paint is left to it.
  const fresh = fakeWindow({ visible: false });
  bringUp(fresh, create, fine, since + PAINT_GRACE_MS - 1);
  assert.deepEqual(fresh.did, [], 'no empty frame before the page has painted');
  const stuck = fakeWindow({ visible: false });
  bringUp(stuck, create, fine, since + PAINT_GRACE_MS);
  assert.deepEqual(stuck.did, ['show', 'focus'], 'a window whose paint did not come is shown: a running app without a window leaves nothing to click');
  const broken = fakeWindow({ visible: false });
  bringUp(broken, create, { since, failed: true }, since + 1);
  assert.deepEqual(broken.did, ['show', 'focus'], 'a page that failed to load never paints: shown at once');

  const minimized = fakeWindow({ visible: true, minimized: true });
  bringUp(minimized, create, fine, since + 1);
  assert.deepEqual(minimized.did, ['restore', 'focus']);
  const there = fakeWindow({ visible: true });
  bringUp(there, create, fine, since + 1);
  assert.deepEqual(there.did, ['focus']);
  assert.equal(created, 2);
});

test('the Dock click is heard before the start first waits, so a start that hangs later still gives a window', () => {
  const start = source('main.ts').split('async function start(): Promise<void> {')[1];
  const firstWait = start.search(/\bawait\b/);
  for (const event of ['activate', 'second-instance']) {
    const at = start.indexOf(`app.on('${event}'`);
    assert.ok(at >= 0 && at < firstWait, `app.on('${event}') stands before the first await of start()`);
  }
});

test('a folder named for new books is looked at first: books, a started setup and other files are told apart from a new one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vanilla-taken-'));
  const documents = join(home, 'Documents');
  mkdirSync(documents);
  const server = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: documents, dist: join(home, 'dist') });
  const http = await listen(server.app, '127.0.0.1', undefined);
  const base = `http://127.0.0.1:${portOf(http)}`;
  server.allowHost(`127.0.0.1:${portOf(http)}`);
  const look = async (dir: string) => (await fetch(`${base}/api/desktop/folder?root=${encodeURIComponent(dir)}`)).json();
  const send = (method: string, path: string, body: unknown) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await look(join(documents, 'Neu')), { holds: 'nothing' }, 'a name that does not exist yet');
    const empty = join(documents, 'Leer');
    mkdirSync(empty);
    writeFileSync(join(empty, '.DS_Store'), '');
    assert.deepEqual(await look(empty), { holds: 'nothing' }, 'an empty folder (the Finder\'s own file aside) is as good as new');
    const photos = join(documents, 'Fotos');
    mkdirSync(photos);
    writeFileSync(join(photos, 'baustelle.jpg'), 'x');
    assert.deepEqual(await look(photos), { holds: 'files' });

    const begun = join(documents, 'Begonnen');
    assert.equal((await send('POST', '/api/desktop/setup', { root: begun, language: 'de' })).status, 200);
    assert.equal((await look(begun)).holds, 'setup');

    const books = join(documents, 'Maler Huber');
    const made = await send('POST', '/api/desktop/create', {
      preset: 'consultant', name: 'Maler Huber GmbH', uid: 'CHE-153.004.184', owner: 'Sandra Huber', language: 'de', root: books,
      answers: {
        legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly', fiscalYear: 'calendar', start: 'new',
        sells: ['services'], foreignCustomers: 'yes', imports: 'no', employees: 'owner', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no',
      },
      banks: [{ bank: 'UBS', currency: 'CHF' }],
    });
    assert.equal(made.status, 200, await made.text());
    assert.deepEqual(await look(books), { holds: 'books', name: 'Maler Huber GmbH' });
  } finally {
    http.close();
  }
});

test('a Documents folder the app may not read («Nicht erlauben») leaves the start screen its answer: no folders, no error', { skip: process.getuid?.() === 0 ? 'root reads every folder' : false }, () => {
  const home = mkdtempSync(join(tmpdir(), 'vanilla-documents-'));
  const documents = join(home, 'Documents');
  mkdirSync(join(documents, 'Buchhaltung 2026'), { recursive: true });
  const server = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: documents, dist: join(home, 'dist') });
  assert.deepEqual(server.info().folders, ['Buchhaltung 2026']);
  const logged = console.error;
  const lines: unknown[] = [];
  console.error = (...args: unknown[]) => { lines.push(args); };
  chmodSync(documents, 0o000);
  try {
    assert.deepEqual(server.info().folders, []);
    assert.deepEqual(lines, [], 'refused is an answer, not an error to log');
  } finally {
    chmodSync(documents, 0o755);
    console.error = logged;
  }
  assert.deepEqual(desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: join(home, 'none'), dist: join(home, 'dist') }).info().folders, []);
});
