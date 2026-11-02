/**
 * A line of config.vatAdjustments (a Nachdeklaration) changes the open quarter's return: vat-report and the eCH-0217
 * XML both add its amount to its input-tax Ziffer and take it off what is to be paid. Every demo has none, so the
 * golden master never sees one; this runs on a copy of the demo and leaves the goldens alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_ROOT } from './support/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';

const cli = (ws: string, ...args: string[]) => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, VANILLA_WORKSPACE: ws } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
};
const ziffern = (report: string) => Object.fromEntries([...report.matchAll(/Ziffer (\d{3}) .*?(-?[\d']+\.\d\d)$/gm)].map(([, z, a]) => [z, Number(a.replace(/'/g, ''))]));
const xmlFigures = (ws: string) => {
  const out = join(ws, 'data', 'q2.xml');
  cli(ws, 'src/cli/vat-ech0217.ts', '2026-Q2', out);
  const xml = readFileSync(out, 'utf8');
  const tag = (name: string) => Number(xml.match(new RegExp(`<eCH-0217:${name}>([^<]+)<`))![1]);
  return { investments: tag('inputTaxInvestments'), payable: tag('payableTax') };
};

test('a Nachdeklaration of 405 changes 405, 479 and 500 in vat-report and the XML by its amount', { timeout: 60_000 }, () => {
  const ws = mkdtempSync(join(tmpdir(), 'vat-adjustment-'));
  try {
    cpSync(DEMO_ROOT, ws, { recursive: true, filter: (src) => src !== join(DEMO_ROOT, 'data') });
    const filed = loadBooks(workspaceAt(ws)).journalEntries.find((e) => e.date <= '2026-03-31' && e.vatCode === 'I81')!;
    const before = ziffern(cli(ws, 'src/cli/vat-report.ts', '2026-Q2'));
    const xmlBefore = xmlFigures(ws);

    const ledger = JSON.parse(readFileSync(join(ws, 'ledger.json'), 'utf8'));
    assert.deepEqual(ledger.config.vatAdjustments, [], 'the demo has none');
    ledger.config.vatAdjustments = [{ id: '2026-Q2-1', period: '2026-Q2', ziffer: '405', amount: 12.5, reason: 'Vorsteuer auf einer Q1-Rechnung nachgeholt', entryIds: [filed.id] }];
    writeFileSync(join(ws, 'ledger.json'), JSON.stringify(ledger, null, 2));

    const after = ziffern(cli(ws, 'src/cli/vat-report.ts', '2026-Q2'));
    const r2 = (n: number) => Math.round(n * 100) / 100;
    assert.equal(after['405'], r2(before['405'] + 12.5));
    assert.equal(after['479'], r2(before['479'] + 12.5));
    assert.equal(after['500'], r2(before['500'] - 12.5));
    assert.equal(after['399'], before['399'], 'the tax owed stays');
    const xmlAfter = xmlFigures(ws);
    assert.equal(xmlAfter.investments, r2(xmlBefore.investments + 12.5));
    assert.equal(xmlAfter.payable, r2(xmlBefore.payable - 12.5));

    const q1 = ziffern(cli(ws, 'src/cli/vat-report.ts', '2026-Q1'));
    ledger.config.vatAdjustments = [];
    writeFileSync(join(ws, 'ledger.json'), JSON.stringify(ledger, null, 2));
    assert.deepEqual(ziffern(cli(ws, 'src/cli/vat-report.ts', '2026-Q1')), q1, 'the filed quarter of the entry is untouched');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
