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
import { ClosedPeriodError, loadBooks, PERSON, periodLock, saveBooks, sealsOf, update, type Books } from '../src/books/store.js';
import { derivePeriod } from '../src/accounting/periods.js';
import { vat } from '../src/engines/index.js';
import { ech0217Xml } from '../src/providers/ech0217/xml.js';
import { APP_ROOT, workspaceAt, yearPaths, type Workspace } from '../src/workspace/workspace.js';
import { openEngine, SKIPPED } from '../src/workflows/engine.js';
import { filedXml, filingXml, holdsFiledPeriod, releaseApproval, type PeriodReturn, type PreparedXml } from '../src/workflows/filing.js';
import { loadWorkflows } from '../src/workflows/load.js';
import { summaryOf, taskOf } from '../src/workflows/model.js';
import { filedReturnsOf } from '../src/workspace/reads.js';
import { approvalWithheld, returnSummary } from '../src/app/areas/automation/filing-summary.js';
import { DEMO_ROOT } from './support/workspace.js';
import { saleQuestionLine } from '../src/intake/sale-questions.js';
import { appendQuestionLine, readQuestions } from '../src/questions/store.js';

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

test('a period that has not ended cannot be prepared: the run stops before it computes, says until when the period runs and from when it can be filed, and writes nothing (r6f-33)', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT, now: () => '2026-10-16T08:00:00.000Z' });
  const r = await engine.start('vat-filing', { kind: 'period', id: '2026-Q4' }, { kind: 'manual' });
  assert.ok(r.ok, JSON.stringify(r));
  await engine.idle();
  const run = engine.run(r.run!)!;
  assert.equal(run.state.status, 'stuck');
  const why = { code: 'periodRunning', params: { period: '2026-Q4', ends: '2026-12-31', from: '2027-01-01' } };
  assert.deepEqual(run.state.status === 'stuck' ? run.state.why : undefined, why, 'the refusal in a code the screens have words for');
  assert.deepEqual(summaryOf(run).why, why, 'the list of runs carries it too');
  assert.deepEqual(run.steps.map((s) => [s.step, s.output, s.why]), [['compute', undefined, why]], 'no figures computed');
  assert.equal(filingXml(ws, '2026-Q4'), undefined, 'no XML written');

  const ended = await engine.start('vat-filing', { kind: 'period', id: '2026-Q3' }, { kind: 'manual' });
  await engine.idle();
  const q3 = engine.run(ended.ok ? ended.run! : '')!;
  assert.deepEqual([q3.state.status, 'at' in q3.state ? q3.state.at : ''], ['waiting', 'review'], 'a period that ended on 30.9. is prepared on 16.10.');
});

test('the year\'s last period is filed like any other, but the year close seals it: the run archives the filed XML and ends without closing or sealing (r6f-33)', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT, now: () => '2027-01-10T08:00:00.000Z' });
  const file = async (key: string) => {
    const r = await engine.start('vat-filing', { kind: 'period', id: key }, { kind: 'manual' });
    assert.ok(r.ok, JSON.stringify(r));
    await engine.idle();
    for (const outcome of ['approved', 'filed']) { await engine.command({ kind: 'answer', run: r.run!, outcome }); await engine.idle(); }
    return engine.run(r.run!)!;
  };
  for (const key of ['2026-Q2', '2026-Q3']) assert.equal((await file(key)).state.status, 'done', key);
  assert.equal(loadBooks(ws).config.closedThrough, '2026-09-30');

  const q4 = await file('2026-Q4');
  assert.equal(q4.state.status, 'done', JSON.stringify(q4.state));
  assert.ok(existsSync(filedXml(ws, '2026-Q4')), 'the filed XML lies beside the seals, where the year close and the 0535 read it');
  assert.ok(filedReturnsOf(ws, '2026').some((f) => f.period === '2026-Q4'), 'the year close finds the fourth quarter filed');
  assert.equal(loadBooks(ws).config.closedThrough, '2026-09-30', 'the year close moves the line to 31.12., after the year-end entries');
  assert.equal(existsSync(join(yearPaths(ws.paths, '2026').filings, 'seal-Q4.json')), false, 'no seal before the year-end entries');
  assert.equal(q4.steps.at(-1)!.outcome, 'ok');
});

/** The first Q2 entry with the normal input-tax code, its code flipped to I0: the figures of Q2 change. */
const inQ2 = (e: { date: string }) => e.date >= '2026-04-01' && e.date <= '2026-06-30';
function flipOne(books: Books): string {
  const e = books.journalEntries.find((x) => inQ2(x) && x.vatCode === 'I81')!;
  e.vatCode = 'I0';
  return e.id;
}
const payableNow = (ws: Workspace) => { const b = loadBooks(ws); return vat().figures(b.journalEntries, Q, b.config.vatAdjustments ?? []).payable; };
const at = (run: { state: { status: string } & { at?: string } }) => [run.state.status, run.state.at ?? ''];

test('the books change between the review and «Freigegeben»: no XML of stale figures, the person reviews the figures of today instead (r7h-24)', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  const run = () => engine.run(r.ok ? r.run! : '')!;
  const reviewed = (run().steps[0].output!.return as PeriodReturn).payable;
  const books = loadBooks(ws);
  update(books, PERSON, flipOne);
  saveBooks(ws, books);
  assert.notEqual(payableNow(ws), reviewed, 'the flip changes what is to pay');

  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'approved' });
  await engine.idle();
  assert.deepEqual(at(run()), ['waiting', 'review'], 'back to the review');
  assert.equal(run().steps.find((s) => s.step === 'xml')!.outcome, 'changed');
  assert.equal(filingXml(ws, Q), undefined, 'no XML of the stale figures');
  const again = run().steps.at(-2)!.output!.return as PeriodReturn;
  assert.equal(again.payable, payableNow(ws), 'the review shows the figures of today');
  assert.deepEqual(again.reviewedBefore, { payable: reviewed }, 'and says what the first review showed');

  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'approved' });
  await engine.idle();
  assert.deepEqual(at(run()), ['waiting', 'submit']);
  assert.match(readFileSync(filingXml(ws, Q)!, 'utf8'), new RegExp(`payableTax>${payableNow(ws).toFixed(2)}<`), 'the XML carries the figures the person approved');
});

test('«Freigegeben» holds the period until «Eingereicht» or «Zurück»: nothing dated in it changes, and the refusal names the approval (r7h-24)', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  const answer = async (outcome: string) => { await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome }); await engine.idle(); };
  const run = () => engine.run(r.ok ? r.run! : '')!;
  await answer('approved');
  assert.deepEqual(loadBooks(ws).config.approvedReturn, { period: Q, through: '2026-06-30' });
  const lock = periodLock(loadBooks(ws));
  assert.equal(lock.closedThrough, '2026-03-31', 'not filed yet');
  assert.deepEqual([lock.isClosed('2026-06-30'), lock.isClosed('2026-07-01')], [true, false], 'held through the period\'s end');
  const held = loadBooks(ws);
  assert.throws(() => update(held, PERSON, flipOne), (e: unknown) => e instanceof ClosedPeriodError && e.approved === Q && /freigegeben/.test(e.message));
  const before = payableNow(ws);

  await answer('back');
  assert.deepEqual(at(run()), ['waiting', 'review'], '«Zurück» from the filing task reopens the review');
  assert.equal(loadBooks(ws).config.approvedReturn, undefined, 'and frees the period');
  const free = loadBooks(ws);
  update(free, PERSON, flipOne);
  saveBooks(ws, free);
  assert.notEqual(payableNow(ws), before);

  await answer('approved');
  assert.deepEqual(at(run()), ['waiting', 'review'], 'the review of the figures the books now give');
  await answer('approved');
  assert.deepEqual(at(run()), ['waiting', 'submit']);
  await answer('filed');
  assert.equal(run().state.status, 'done');
  const after = loadBooks(ws);
  assert.equal(after.config.closedThrough, '2026-06-30');
  assert.equal(after.config.approvedReturn, undefined, 'filed: the hold gave way to the close');
});

test('«Eingereicht» never seals books that differ from the filed XML: a change that got past the hold stops the run with the figures, nothing closed, and the hold is lifted so the books can be restored, then «Weiter» seals (r7h-24, r8h-26)', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'approved' });
  await engine.idle();
  const run = () => engine.run(r.ok ? r.run! : '')!;
  const approved = (run().steps[0].output!.return as PeriodReturn).payable;
  const books = loadBooks(ws);
  const flipped = flipOne(books);
  saveBooks(ws, books);
  const now = payableNow(ws);

  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'filed' });
  await engine.idle();
  const state = run().state;
  assert.equal(state.status, 'stuck');
  assert.deepEqual(state.status === 'stuck' ? state.why : undefined, { code: 'figuresChanged', params: { period: Q, filed: approved.toFixed(2), now: now.toFixed(2), boxes: '405, 479, 500' } });
  assert.equal(loadBooks(ws).config.closedThrough, '2026-03-31', 'nothing closed');
  assert.equal(existsSync(join(yearPaths(ws.paths, '2026').filings, 'seal-Q2.json')), false, 'nothing sealed');
  // r10h-4: the hold stays, in its filed mode: the period is filed at the ESTV, the books must come back to the return.
  const held = loadBooks(ws).config.approvedReturn;
  assert.deepEqual([held?.period, held?.through, held?.filed?.payable], [Q, '2026-06-30', approved], 'the period stays held, with the figures as filed (r10h-4)');

  // Only a change that brings the books back to the filed return gets through the write door.
  const drift = loadBooks(ws);
  const another = drift.journalEntries.find((x) => inQ2(x) && x.vatCode === 'I81' && x.id !== flipped)!;
  assert.throws(() => update(drift, PERSON, (b) => { b.journalEntries.find((x) => x.id === another.id)!.vatCode = 'I0'; }), (e: unknown) => e instanceof ClosedPeriodError && e.filed === Q, 'an unrelated change that moves a Ziffer further from the return is refused, naming the filed period');
  const same = loadBooks(ws);
  assert.throws(() => update(same, PERSON, (b) => { b.journalEntries.find((x) => x.id === flipped)!.description = 'Text geändert'; }), (e: unknown) => e instanceof ClosedPeriodError && e.filed === Q, 'a change that brings the books no closer is refused too: the filed period changes only back toward the return');
  assert.throws(() => update(same, { kind: 'run', id: 'r', workflow: 'w' }, (b) => { b.journalEntries.find((x) => x.id === flipped)!.vatCode = 'I81'; }), ClosedPeriodError, 'a run never writes there, not even the restoring change');
  assert.ok(periodLock(same).isClosed('2026-05-15'), 'runs and scripts still see the period as closed');
  assert.ok(periodLock(same).heldBy('2026-05-15')?.filed, 'and the hold says it is filed');

  const back = loadBooks(ws);
  update(back, PERSON, (b) => { b.journalEntries.find((x) => x.id === flipped)!.vatCode = 'I81'; });
  saveBooks(ws, back);
  await engine.command({ kind: 'resume', run: r.ok ? r.run! : '' });
  await engine.idle();
  assert.equal(run().state.status, 'done', 'restored: «Weiter» seals');
  assert.equal(loadBooks(ws).config.closedThrough, '2026-06-30');
  assert.equal(loadBooks(ws).config.approvedReturn, undefined, 'sealed: the hold gave way to the close');
});

test('«Weiter» after a stuck seal compares every Ziffer, not the payable alone: two changes that cancel in the payable keep the run stuck (r10h-4)', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'approved' });
  await engine.idle();
  const approved = (engine.run(r.ok ? r.run! : '')!.steps[0].output!.return as PeriodReturn).payable.toFixed(2);
  const books = loadBooks(ws);
  // Input tax moved from Ziffer 405 to 400: the same 8.1 %, the payable unchanged.
  books.journalEntries.find((x) => inQ2(x) && x.vatCode === 'I81')!.vatCode = 'M81';
  saveBooks(ws, books);
  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'filed' });
  await engine.idle();
  const state = engine.run(r.ok ? r.run! : '')!.state;
  assert.equal(state.status, 'stuck', 'the books differ from the return in their Ziffern');
  assert.deepEqual(state.status === 'stuck' ? [state.why?.code, state.why?.params] : [], ['figuresChanged', { period: Q, filed: approved, now: approved, boxes: '400, 405' }]);
});

test('a VAT question open about a payment of the period withholds the filing: the review withholds «Freigegeben», the XML step stops with questionsOpen and holds nothing; answered or closed, «Weiter» goes on; a question asked after the approval is closed with the reason at the seal (r8h-24, r7h-29)', async () => {
  const ws = demo();
  const tx = loadBooks(ws).transactions.find((t) => inQ2(t) && t.direction === 'CRDT')!;
  const q = saleQuestionLine(ws, tx, '2026-07-01T09:00:00.000Z');
  appendQuestionLine(ws, q, '2026-03-31');
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  const id = r.ok ? r.run! : '';
  const run = () => engine.run(id)!;
  const task = taskOf(loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((w) => w.id === 'vat-filing')!, run())!;
  assert.deepEqual(approvalWithheld(task, readQuestions(ws), loadBooks(ws)), { outcome: 'approved', rates: [], questions: 1 }, 'the review withholds «Freigegeben» while the question is open');

  await engine.command({ kind: 'answer', run: id, outcome: 'approved' });
  await engine.idle();
  const stuck = run().state;
  assert.equal(stuck.status, 'stuck', 'an approval sent anyway stops before the XML');
  assert.deepEqual(stuck.status === 'stuck' ? stuck.why : undefined, { code: 'questionsOpen', params: { period: Q, n: '1' } });
  assert.equal(loadBooks(ws).config.approvedReturn, undefined, 'nothing held: the owner can still answer');
  assert.equal(filingXml(ws, Q), undefined, 'no XML');

  appendQuestionLine(ws, { v: 1, event: 'closed', id: q.id, at: '2026-07-02T09:00:00.000Z', by: 'Erika Beispiel', how: 'done' }, '2026-03-31');
  await engine.command({ kind: 'resume', run: id });
  await engine.idle();
  assert.deepEqual(at(run()), ['waiting', 'submit'], 'answered: the XML is written and the period held');
  assert.deepEqual(loadBooks(ws).config.approvedReturn, { period: Q, through: '2026-06-30' });

  const late = saleQuestionLine(ws, tx, '2026-07-03T09:00:00.000Z');
  appendQuestionLine(ws, late, '2026-03-31');
  await engine.command({ kind: 'answer', run: id, outcome: 'filed' });
  await engine.idle();
  assert.equal(run().state.status, 'done');
  const closed = readQuestions(ws).find((x) => x.id === late.id)!;
  assert.deepEqual([closed.status, closed.closed?.how, closed.closed?.why], ['closed', 'withdrawn', 'closed'], 'the safety net at the seal: closed, saying why');
});

test('a filing run discarded while the period was held frees it (r7h-24)', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT, onRest: (run) => releaseApproval(ws, run) });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'approved' });
  await engine.idle();
  assert.ok(loadBooks(ws).config.approvedReturn);
  await engine.command({ kind: 'discard', run: r.ok ? r.run! : '' });
  await engine.idle();
  assert.equal(loadBooks(ws).config.approvedReturn, undefined);
  const state = engine.run(r.ok ? r.run! : '')!.state;
  assert.deepEqual([state.status, state.status === 'discarded' ? state.reason : ''], ['discarded', 'von einer Person verworfen'], 'the run page shows the reason as it is: in the books\' language, not English (r8f-44)');
});

test('r8f-49: «Zurück» from the filing task recomputes the return, so the review task shows today\'s figures, not the ones approved', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT, onRest: (run) => releaseApproval(ws, run) });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  const id = r.ok ? r.run! : '';
  await engine.command({ kind: 'answer', run: id, outcome: 'approved' });
  await engine.idle();
  const approved = payableNow(ws);
  await engine.command({ kind: 'answer', run: id, outcome: 'back' });
  await engine.idle();
  const books = loadBooks(ws);
  flipOne(books);
  saveBooks(ws, books);
  const now = payableNow(ws);
  assert.notEqual(now, approved);
  await engine.command({ kind: 'answer', run: id, outcome: 'back' });
  await engine.idle();
  const run = engine.run(id)!;
  const task = taskOf(loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((w) => w.id === 'vat-filing')!, run)!;
  assert.deepEqual(at(run), ['waiting', 'review']);
  assert.equal((task.reads!.return as PeriodReturn).payable, now, 'the review task reads the recomputed return');
});

test('golden rule 1: a filing run whose period is filed and drifted is not discarded, the hold stays until it seals; a normal discard is unchanged', async () => {
  const ws = demo();
  const engine = openEngine(ws, { appRoot: APP_ROOT, keeps: (run) => holdsFiledPeriod(ws, run), onRest: (run) => releaseApproval(ws, run) });
  const r = await engine.start('vat-filing', { kind: 'period', id: Q }, { kind: 'manual' });
  await engine.idle();
  const id = r.ok ? r.run! : '';
  await engine.command({ kind: 'answer', run: id, outcome: 'approved' });
  await engine.idle();
  const books = loadBooks(ws);
  books.journalEntries.find((x) => inQ2(x) && x.vatCode === 'I81')!.vatCode = 'M81';
  saveBooks(ws, books);
  await engine.command({ kind: 'answer', run: id, outcome: 'filed' });
  await engine.idle();
  assert.equal(engine.run(id)!.state.status, 'stuck');
  assert.ok(loadBooks(ws).config.approvedReturn?.filed);
  assert.deepEqual(await engine.command({ kind: 'discard', run: id }), { ok: false, refusal: 'period-filed' });
  assert.equal(engine.run(id)!.state.status, 'stuck', 'the run stays');
  assert.ok(loadBooks(ws).config.approvedReturn?.filed, 'the hold stays');
  const text = (l: string) => readFileSync(`src/app/i18n/locales/${l}.ts`, 'utf8');
  for (const l of ['de', 'en', 'fr', 'it']) assert.match(text(l), /'automation\.refusal\.period-filed'/);
});
