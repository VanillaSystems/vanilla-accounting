/**
 * The desktop app reads the inbox by itself, as `npm start` does (src/server/background.ts): a
 * file that waited in the inbox when the app started is read at once, and a file arriving while
 * it runs (from the phone, the Finder) is read without a click.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'desktop-bg-runs-'));
// No model: the read step takes the PDF's own text, which is all this test needs.
process.env.CLAUDE_BIN = join(process.cwd(), 'tests/support/no-model-bin/claude');
const home = mkdtempSync(join(tmpdir(), 'vanilla-desktop-bg-'));
mkdirSync(join(home, 'dist'));
writeFileSync(join(home, 'dist', 'index.html'), '<!doctype html>');
const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: home, dist: join(home, 'dist'), inboxEveryMs: 200 });

const SAMPLE = join(DEMO_ROOT, 'transactional-data/2026/receipts/20260105-example-cloud-invoice-2026-01.pdf');

async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('a file left in the inbox is read at start, one arriving later without a click', async () => {
  // The demo copy, with a scan that waited since the app last ran.
  await desktop.openDemo();
  const { WS } = await import('../src/server/books.js');
  const ws = workspaceAt(WS.paths.root);
  mkdirSync(ws.paths.inbox, { recursive: true });
  const leftover = join(ws.paths.inbox, '20261015-170000.pdf');
  copyFileSync(SAMPLE, leftover);
  writeFileSync(leftover, '\n% left over\n', { flag: 'a' });
  const holds = (name: string) => loadBooks(ws).receipts.some((r) => r.originalFilename === name);
  assert.equal(holds('20261015-170000.pdf'), false);

  desktop.startBackground();
  await until('the leftover is read', () => holds('20261015-170000.pdf'));

  const arriving = join(ws.paths.inbox, '20261016-081200.pdf');
  copyFileSync(SAMPLE, arriving);
  writeFileSync(arriving, '\n% from the phone\n', { flag: 'a' });
  await until('the arriving file is read', () => holds('20261016-081200.pdf'));
});
