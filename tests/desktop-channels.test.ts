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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASK, PUSH, TELL } from '../src/desktop/channels.js';
import { chosenFolder, newFolderPanel } from '../src/desktop/new-folder.js';
import { bringUp, offerMove, type AppWindow, type MoveOffer } from '../src/desktop/start.js';
import { desktopServer } from '../src/desktop/server.js';
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
    defaultPath: '/Users/sandra/Documents/Buchhaltung 2026', buttonLabel: 'Erstellen', properties: ['createDirectory'],
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
  bringUp(undefined, create);
  bringUp(fakeWindow({ destroyed: true }), create);
  assert.equal(created, 2, 'no window, or a closed one: a new one');

  const hidden = fakeWindow({ visible: false });
  bringUp(hidden, create);
  assert.deepEqual(hidden.did, ['show', 'focus'], 'a window that waits hidden is shown: a running app without a window leaves nothing to click');
  const minimized = fakeWindow({ visible: true, minimized: true });
  bringUp(minimized, create);
  assert.deepEqual(minimized.did, ['restore', 'focus']);
  const there = fakeWindow({ visible: true });
  bringUp(there, create);
  assert.deepEqual(there.did, ['focus']);
  assert.equal(created, 2);
});

test('a Documents folder the app may not read («Nicht erlauben») leaves the start screen its answer: no folders, no error', { skip: process.getuid?.() === 0 ? 'root reads every folder' : false }, () => {
  const home = mkdtempSync(join(tmpdir(), 'vanilla-documents-'));
  const documents = join(home, 'Documents');
  mkdirSync(join(documents, 'Buchhaltung 2026'), { recursive: true });
  const server = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: documents, dist: join(home, 'dist') });
  assert.deepEqual(server.info().folders, ['Buchhaltung 2026']);
  chmodSync(documents, 0o000);
  try {
    assert.deepEqual(server.info().folders, []);
  } finally {
    chmodSync(documents, 0o755);
  }
  assert.deepEqual(desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: join(home, 'none'), dist: join(home, 'dist') }).info().folders, []);
});
