/**
 * Invoice PDFs in the desktop app (ADR 0012): Electron's own Chromium prints the same sheet as
 * puppeteer does for the CLI, with the same pages and stamped dates. Runs Electron; skipped when
 * its binary is not downloaded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { APP_ROOT } from '../src/workspace/workspace.js';

const electron = (() => { try { return createRequire(import.meta.url)('electron') as string; } catch { return undefined; } })();
const skip = electron && existsSync(electron) ? false : 'the Electron binary is not downloaded (node node_modules/electron/install.js)';

test('Electron prints a 1-line invoice on one page, longer ones on more, the demo 2026-001 on one with its QR-bill, the same bytes twice', { skip, timeout: 120_000 }, async () => {
  // Two folders below the app root, as the app's own bundle: APP_ROOT and the fonts resolve from there.
  const outfile = join(APP_ROOT, 'out/test/electron-print.mjs');
  await build({ entryPoints: [join(APP_ROOT, 'tests/support/electron-print.ts')], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' });
  const run = spawnSync(electron as string, [outfile], { encoding: 'utf8', timeout: 110_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const line = run.stdout.split('\n').find((l) => l.startsWith('{'));
  assert.ok(line, `Electron printed nothing: ${run.stderr}`);
  const r = JSON.parse(line);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.byLines, { 1: { sheet: 1, pdf: 1 }, 25: { sheet: 2, pdf: 2 }, 60: { sheet: 3, pdf: 3 } });
  assert.deepEqual(r.demo, { sheet: 1, pdf: 1, qr: true });
  assert.equal(r.sameBytes, true);
  assert.equal(r.dates, true, 'creation and modification dates are the document time');
});
