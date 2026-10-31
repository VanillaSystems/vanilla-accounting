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
import { APP_FOLDER, APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { vat } from '../src/engines/index.js';

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

test('r10c-5: vat-report says the figures the page and the XML carry (the tax of 383 on the total, the payable rounded once), not the per-entry sums that differ by a Rappen', () => {
  const root = mkdtempSync(join(tmpdir(), 'vat-report-'));
  cpSync(join(APP_ROOT, 'demo-consulting', APP_FOLDER), join(root, APP_FOLDER), { recursive: true });
  const entries = join(root, APP_FOLDER, 'transactional-data/2026/books/entries.jsonl');
  // Three Bezugsteuer entries of 24.60: 1.99 each per entry (5.97), 5.98 on their total of 73.80.
  const ads = [1, 2, 3].map((i) => JSON.stringify({ id: `ads${i}`, transactionRef: `M2026-90${i}`, date: `2026-09-0${i}`, accountDebit: '6600', accountCredit: '1020', amount: 24.6, vatCode: 'B81-1', description: `Ads ${i}` }));
  writeFileSync(entries, readFileSync(entries, 'utf8').trimEnd() + '\n' + ads.join('\n') + '\n');
  const books = loadBooks(workspaceAt(join(root, APP_FOLDER)));
  const filed = vat().filedReport(books.journalEntries, '2026-Q3', books.config.vatAdjustments ?? []);
  const perEntry = vat().report(books.journalEntries, '2026-Q3', books.config.vatAdjustments ?? []);
  const box = (r: typeof filed, n: string) => r.ziffern.find((z) => z.number === n)!.amount;
  assert.notEqual(box(filed, '383'), box(perEntry, '383'), 'the two ways differ by a Rappen on these books');

  const out = report(root, '2026-Q3');
  const amount = (ziffer: string) => Number(new RegExp(`Ziffer ${ziffer} .*?([\\d'’]+\\.\\d{2})\\s*$`, 'm').exec(out)![1].replace(/['’]/g, ''));
  assert.deepEqual([amount('383'), amount('399'), amount('500')], [box(filed, '383'), box(filed, '399'), box(filed, '500')]);
  const toPay = Number(/ZU BEZAHLEN \(Ziffer 500\): CHF ([\d'’]+\.\d{2})/.exec(out)![1].replace(/['’]/g, ''));
  assert.equal(toPay, filed.toPay);
});
