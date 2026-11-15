/**
 * A `.vanilla` file on a Mac that never opened books (#545): the packed app declares the type, a
 * file macOS hands over before the server listens is held and opened then, and the desktop server
 * opens a hand-over with no books open (a return says where it belongs). Its own process: the
 * server's workspace is chosen once, when the first books open.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';
import { FileRefused, heldUntilReady, openVanillaFile, refusedText, vanillaPaths } from '../src/desktop/open-files.js';
import { makeShare } from '../src/handover/share.js';
import { buildReturn, openPackage, setDurchsichtHome } from '../src/handover/durchsicht.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { textsIn } from '../src/app/i18n/texts-in.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const home = mkdtempSync(join(tmpdir(), 'vanilla-open-file-'));
process.env.VANILLA_WORKSPACE = '';
process.chdir(home);
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');

test('the packed app declares .vanilla files as its own type (Finder opens them with it)', () => {
  const config = createRequire(import.meta.url)('../desktop/electron-builder.config.cjs') as {
    fileAssociations?: Array<{ ext: string; isPackage?: boolean; role?: string }>;
    mac: { extendInfo: { UTExportedTypeDeclarations?: Array<{ UTTypeTagSpecification: Record<string, string[]> }> } };
  };
  const vanilla = config.fileAssociations?.find((f) => f.ext === 'vanilla');
  assert.ok(vanilla, 'fileAssociations names vanilla');
  assert.equal(vanilla.isPackage, false, 'a file, not a bundle');
  assert.ok(config.mac.extendInfo.UTExportedTypeDeclarations?.some((u) => u.UTTypeTagSpecification['public.filename-extension']?.includes('vanilla')), 'the type is exported');
});

test('files handed over before the app is ready are held and opened in their order, later ones at once', () => {
  const q = heldUntilReady<string>();
  q.add('/a.vanilla');
  q.add('/b.vanilla');
  assert.equal(q.held, 2);
  const opened: string[] = [];
  q.ready((p) => opened.push(p));
  assert.deepEqual(opened, ['/a.vanilla', '/b.vanilla']);
  q.add('/c.vanilla');
  assert.deepEqual(opened, ['/a.vanilla', '/b.vanilla', '/c.vanilla']);
  assert.equal(q.held, 0);
  assert.deepEqual(vanillaPaths(['--flag', '/x/Buchhaltung v1.VANILLA', '/x/beleg.pdf']), ['/x/Buchhaltung v1.VANILLA']);
});

// Sandra's books, shared with Ernst: the hand-over file, and Ernst's return made on a copy elsewhere.
const ws = tempWorkspace('open-file-');
writeIndex(ws, { receipts: [], transactions: [], mappings: [], journalEntries: [], config: { closedThrough: '2026-03-31' } });
const handover = await makeShare(ws, { to: { name: 'Ernst Beispiel' } }, { name: 'Sandra Muster' });
const elsewhere = openPackage(handover.bytes, new Date(), mkdtempSync(join(tmpdir(), 'open-file-other-')));
const ret = buildReturn(workspaceAt(elsewhere.root), 'zurück');
const file = (name: string, bytes: Uint8Array) => { const p = join(home, name); writeFileSync(p, bytes); return p; };
const handoverFile = file('Buchhaltung v1.vanilla', handover.bytes);
const returnFile = file('Rücksendung.vanilla', ret.bytes);
const brokenFile = file('kaputt.vanilla', new TextEncoder().encode('PK\u0003\u0004garbage'));

const copies = mkdtempSync(join(tmpdir(), 'open-file-copies-'));
setDurchsichtHome(copies);
const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: join(home, 'Documents'), dist });
const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
desktop.allowHost(base.slice('http://'.length));
after(() => server.close());
const de = textsIn('de');

test('with no books open, a return is refused and says where it belongs; a file that is no package is named so', async () => {
  assert.equal(desktop.current(), null);
  const refused = await openVanillaFile(returnFile, base).then(() => undefined, (e: unknown) => e);
  assert.ok(refused instanceof FileRefused);
  assert.equal(refused.body.code, 'shareWrongKind');
  assert.equal(refusedText(de, refused), de('desktop.fileIsReturn'));
  const broken = await openVanillaFile(brokenFile, base).then(() => undefined, (e: unknown) => e);
  assert.ok(broken instanceof FileRefused);
  assert.equal(broken.body.code, 'shareNotPackage');
  assert.equal(refusedText(de, broken), de('error.shareNotPackage'));
  assert.equal(desktop.current(), null, 'nothing opened');
});

test('with no books open, a hand-over opens as its Durchsicht copy, the books the API serves', async () => {
  assert.equal(await openVanillaFile(handoverFile, base), '/');
  assert.ok(desktop.current()?.root.startsWith(copies), desktop.current()?.root);
  const view = await (await fetch(`${base}/api/handover`)).json() as { durchsicht?: { me: { name: string }; back: boolean } };
  assert.equal(view.durchsicht?.me.name, 'Ernst Beispiel');
  assert.equal(view.durchsicht?.back, false, 'no books of her own to go back to');
});

test('with books open, the file goes where «Öffnen…» in the books sends it (on a copy, a return is the sharer\'s)', async () => {
  const refused = await openVanillaFile(returnFile, base).then(() => undefined, (e: unknown) => e);
  assert.ok(refused instanceof FileRefused);
  assert.equal(refused.body.code, 'roleRefused');
});
