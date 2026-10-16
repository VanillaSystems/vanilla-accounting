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
import { openEngine, SKIPPED } from '../src/workflows/engine.js';
import { filedXml, filingXml, type PeriodReturn, type PreparedXml } from '../src/workflows/filing.js';
import { loadWorkflows } from '../src/workflows/load.js';
import { taskOf } from '../src/workflows/model.js';
import { returnSummary } from '../src/app/areas/automation/filing-summary.js';
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

test('a replay of a filed run recomputes nothing: the period is filed, the run says so, and the filing stays as it was (r5f-19)', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const first = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  for (const outcome of ['approved', 'filed']) { await engine.command({ kind: 'answer', run: first.ok ? first.run! : '', outcome }); await engine.idle(); }
  const filed = readFileSync(filedXml(ws, Q), 'utf8');
  const sealed = readFileSync(join(yearPaths(ws.paths, '2026').filings, 'seal-Q2.json'), 'utf8');

  const replay = await engine.command({ kind: 'replay', run: first.ok ? first.run! : '' });
  assert.ok(replay.ok && replay.run, JSON.stringify(replay));
  await engine.idle();
  const run = engine.run(replay.run!)!;
  assert.equal(run.mode, 'replay');
  assert.equal(run.state.status, 'stuck');
  assert.match(run.state.status === 'stuck' ? run.state.reason : '', /filed already/);
  assert.equal(readFileSync(filedXml(ws, Q), 'utf8'), filed, 'the filed XML is as it was');
  assert.equal(readFileSync(join(yearPaths(ws.paths, '2026').filings, 'seal-Q2.json'), 'utf8'), sealed, 'the seal is as it was');
});

test('a dry run of a filing never closes or seals', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' }, 'dry');
  await engine.idle();
  for (const outcome of ['approved', 'filed']) { await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome }); await engine.idle(); }
  const run = engine.run(r.ok ? r.run! : '')!;
  assert.equal(run.state.status, 'done');
  assert.equal(run.steps.at(-1)!.outcome, 'skipped', 'a step that wrote nothing does not say ok (r5f-19)');
  assert.equal(run.steps.at(-1)!.effects[0].would, SKIPPED);
  assert.equal(loadBooks(ws).config.closedThrough, '2026-03-31');
  assert.equal(existsSync(join(yearPaths(ws.paths, '2026').filings, 'seal-Q2.json')), false);
});

test('the person\'s tasks carry what they check: the review the return in words, the filing where the XML lies', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const w = loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((x) => x.id === 'vat-filing')!;
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  const review = taskOf(w, engine.run(r.ok ? r.run! : '')!)!;
  const ret = review.reads!.return as PeriodReturn;
  const s = returnSummary(ret);
  assert.deepEqual(s.due, ret.payable > 0 ? { kind: 'pay', amount: ret.payable } : { kind: 'credit', amount: -ret.payable });
  assert.deepEqual(s.boxes, Object.entries(ret.figures).filter(([box, n]) => n && box !== vat().form.payable && box !== vat().form.credit).map(([box, amount]) => ({ box, amount })), 'every box with an amount, the payable apart');
  assert.ok(s.boxes.some((b) => b.box === vat().form.turnoverBox));
  assert.equal(filingXml(ws, Q), undefined, 'no file before the review');

  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'approved' });
  await engine.idle();
  const submit = taskOf(w, engine.run(r.ok ? r.run! : '')!)!;
  const xml = submit.reads!.xml as PreparedXml;
  assert.equal(xml.period, Q);
  assert.equal(filingXml(ws, Q), xml.path, 'the prepared XML until it is filed');
  assert.match(xml.path, /data[\\/]filing[\\/]mwst-ech0217-2026-Q2\.xml$/);

  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'filed' });
  await engine.idle();
  assert.equal(filingXml(ws, Q), filedXml(ws, Q), 'then the filed one');
});
