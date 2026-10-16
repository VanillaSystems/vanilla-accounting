/**
 * `npm run vat-report` on a period under the approval hold (r9c-17): approved («Freigegeben») is
 * not filed. The CLI said «EINGEREICHT — set in stone» for a quarter whose return only waited for
 * «Eingereicht», while filings/ held nothing of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';

const report = (root: string, period: string) =>
  execFileSync(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'src/cli/vat-report.ts'), period], { cwd: APP_ROOT, env: { ...process.env, VANILLA_WORKSPACE: root }, encoding: 'utf8' });

test('vat-report: a quarter approved but not filed reads «FREIGEGEBEN, noch nicht eingereicht»; a filed one «EINGEREICHT»; an open one neither', () => {
  const root = mkdtempSync(join(tmpdir(), 'vat-report-'));
  cpSync(join(APP_ROOT, 'demo-consulting', APP_FOLDER), join(root, APP_FOLDER), { recursive: true });
  const ledger = join(root, APP_FOLDER, 'ledger.json');
  const data = JSON.parse(readFileSync(ledger, 'utf8')) as { config: Record<string, unknown> };
  assert.equal(data.config.closedThrough, '2026-03-31', 'the demo has Q1 filed');
  data.config.approvedReturn = { period: '2026-Q2', through: '2026-06-30' };
  writeFileSync(ledger, JSON.stringify(data, null, 2));
  const q2 = report(root, '2026-Q2');
  assert.match(q2, /FREIGEGEBEN, noch nicht eingereicht/);
  assert.doesNotMatch(q2, /EINGEREICHT — set in stone/);
  assert.match(report(root, '2026-Q1'), /EINGEREICHT — set in stone/);
  assert.doesNotMatch(report(root, '2026-Q3'), /EINGEREICHT|FREIGEGEBEN/);
});
