/**
 * The workflow vat-filing (src/workflows/filing.ts) on the demo: a run of an open quarter gives
 * the figures of the VAT report, waits for the person's review, writes the XML `npm run vat-xml`
 * writes, waits for the filing, then closes and seals the quarter as `npm run seal -- <q> --close`
 * does. A filed quarter is refused; a dry run never closes or seals.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, sealsOf } from '../src/books/store.js';
import { derivePeriod } from '../src/accounting/periods.js';
import { vat } from '../src/engines/index.js';
import { ech0217Xml } from '../src/providers/ech0217/xml.js';
import { APP_ROOT, workspaceAt, yearPaths, type Workspace } from '../src/workspace/workspace.js';
import { openEngine } from '../src/workflows/engine.js';
import { filedXml } from '../src/workflows/filing.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'vat-filing-runs-'));

function demo(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'vat-filing-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  return workspaceAt(dir);
}

const Q = '2026-Q2';
const noTime = (xml: string) => xml.replace(/<[^>]*generationTime>[^<]*<\/[^>]*generationTime>/g, '');

test('a filing run: the report\'s figures, the review, the XML of vat-xml, the filing, then closed and sealed as seal --close does', async () => {
  const ws = demo();
  assert.equal(loadBooks(ws).config.closedThrough, '2026-03-31');
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  assert.ok(r.ok, JSON.stringify(r));
  await engine.idle();
  const run = () => engine.run(r.run!)!;
  const waitsAt = () => { const st = run().state; return st.status === 'waiting' ? st.at : st.status; };
  assert.equal(waitsAt(), 'review');
  const books = loadBooks(ws);
  const expected = vat().figures(books.journalEntries, Q, books.config.vatAdjustments ?? []);
  const ret = run().steps[0].output!.return as { figures: Record<string, number>; payable: number };
  assert.deepEqual([ret.figures, ret.payable], [expected.ziffern, expected.payable], 'the figures of the VAT report');

  await engine.command({ kind: 'answer', run: r.run!, outcome: 'approved' });
  await engine.idle();
  assert.equal(waitsAt(), 'submit');
  const { from, to } = derivePeriod(Q)!;
  const cli = ech0217Xml({ uid: ws.company.uid, organisationName: ws.company.name, period: { key: Q, from, to }, ziffern: expected.ziffern, payable: expected.payable, form: vat().form, rateRows: vat().rateRows, generationTime: '' });
  const written = (run().steps.find((s) => s.step === 'xml')!.output!.xml as { path: string }).path;
  assert.equal(noTime(readFileSync(written, 'utf8')), noTime(cli.xml), 'the XML of npm run vat-xml');
  assert.equal(loadBooks(ws).config.closedThrough, '2026-03-31', 'nothing closed before the person filed');

  await engine.command({ kind: 'answer', run: r.run!, outcome: 'filed' });
  await engine.idle();
  assert.equal(run().state.status, 'done');
  assert.equal(loadBooks(ws).config.closedThrough, '2026-06-30');
  assert.ok(existsSync(join(yearPaths(ws.paths, '2026').filings, 'seal-Q2.json')));
  assert.ok(sealsOf(loadBooks(ws)).checks.some((c) => c.quarter === Q && c.status === 'intact'));
  assert.equal(readFileSync(filedXml(ws, Q), 'utf8'), readFileSync(written, 'utf8'), 'the filed XML kept beside the seal');

  const again = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  const second = engine.run(again.ok ? again.run! : '')!;
  assert.equal(second.state.status, 'stuck');
  assert.match(second.state.status === 'stuck' ? second.state.reason : '', /filed already/);
});

test('a dry run of a filing never closes or seals', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' }, 'dry');
  await engine.idle();
  for (const outcome of ['approved', 'filed']) { await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome }); await engine.idle(); }
  const run = engine.run(r.ok ? r.run! : '')!;
  assert.equal(run.state.status, 'done');
  assert.equal(run.steps.at(-1)!.effects[0].would, 'skipped: not run in a dry run');
  assert.equal(loadBooks(ws).config.closedThrough, '2026-03-31');
  assert.equal(existsSync(join(yearPaths(ws.paths, '2026').filings, 'seal-Q2.json')), false);
});
