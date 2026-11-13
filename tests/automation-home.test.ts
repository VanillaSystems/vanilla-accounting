import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedRuns, authorOf, homeFigures, workflowState, type PeriodRange } from '../src/app/automation/home.js';
import { nextRun } from '../src/workflows/cron.js';
import type { Index, JournalEntry, Receipt } from '../src/types/index.js';
import type { AutomationView, RunSummary, WorkflowDecl } from '../src/workflows/model.js';

const Q4: PeriodRange = { key: '2026-Q4', from: '2026-10-01', to: '2026-12-31' };
const ctx = { today: '2026-10-21', vatRegistered: true, dueDays: 60, openFrom: '2026-10-01' };

const receipt = (id: string, over: Partial<Receipt> = {}): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext', fileSize: 1,
  indexedAt: '2026-10-05T08:00:00.000Z', location: 'archived', date: '2026-10-04', amount: 10, currency: 'CHF', ...over,
});
const entry = (id: string, ref: string, over: Partial<JournalEntry> = {}): JournalEntry => ({
  id, transactionRef: ref, date: '2026-10-06', accountDebit: '6500', accountCredit: '1020', amount: 10, ...over,
});
const books = (receipts: Receipt[], links: Array<[string, string]>, entries: JournalEntry[], closedThrough?: string): Index => ({
  receipts, transactions: [], bankStatements: [],
  mappings: links.map(([receiptId, transactionRef]) => ({ receiptId, transactionRef })),
  journalEntries: entries, ...(closedThrough ? { config: { closedThrough } as Index['config'] } : {}),
});

test('a receipt passes collected, read, matched and booked by what the books record of it', () => {
  const b = books([
    receipt('a', { hasSwissVat: true }),
    receipt('b'),
    receipt('c', { amount: undefined, date: undefined }),                 // came in 05.10., not read yet: the working period's
    receipt('d', { kind: 'supporting' }),                                // proof only: no receipt in Belege either
    receipt('e', { kind: 'duplicate' }),                                 // the same document again
    receipt('f', { date: '2026-10-02' }),                                // dated in Q4, paid in September: Q3's
  ], [['a', 'T1'], ['b', 'T2'], ['f', 'T9']], [entry('1', 'T1', { origin: 'classify' })]);
  b.transactions = [{ ref: 'T9', date: '2026-09-30', amount: -10 } as Index['transactions'][number]];
  const f = homeFigures(b, Q4, ctx);
  assert.deepEqual(
    { collected: f.collected, read: f.read, withVat: f.withVat, payable: f.payable, matched: f.matched, booked: f.booked },
    { collected: 3, read: 2, withVat: 1, payable: 3, matched: 2, booked: 1 },
  );
});

test('one rule places a receipt in a period (#385): its payment\'s, else its date, else (undated or from before, unpaid) the working period', async () => {
  const { placeDay } = await import('../src/app/automation/home.js');
  assert.equal(placeDay(['2026-08-03', '2026-07-30'], '2026-10-02', '2026-07-01'), '2026-07-30', 'paid: the earliest payment\'s day, whatever its own date');
  assert.equal(placeDay([], '2026-09-12', '2026-07-01'), '2026-09-12', 'unpaid: its own date');
  assert.equal(placeDay([], undefined, '2026-07-01'), '2026-07-01', 'undated and unpaid: the working period');
  assert.equal(placeDay([], '2026-06-28', '2026-07-01'), '2026-07-01', 'dated before the books and unpaid: still the working period\'s work');
  assert.equal(placeDay([], '2026-03-28', '2026-07-01', '2026-06-30'), '2026-03-28', 'in a filed quarter: its date');
});

test('«ohne dich» counts only bookings the app made and nobody changed, among those whose author is recorded', () => {
  const rs = ['a', 'b', 'c', 'd', 'e'].map((id) => receipt(id));
  const f = homeFigures(books(rs, rs.map((r, i) => [r.id, `T${i}`]), [
    entry('1', 'T0', { by: { kind: 'rule', rule: 'swisscom' } }),
    entry('2', 'T1', { run: 'booking-1', by: { kind: 'model', model: 'm' } }),
    entry('3', 'T2', { origin: 'manual', by: { kind: 'person', at: 'x', was: { accountDebit: '6500' } } }),   // the app's booking, changed
    entry('4', 'T3', { origin: 'manual', by: { kind: 'person', at: 'x' } }),                                   // booked by hand
    entry('5', 'T4'),                                                                                           // nobody recorded
  ]), Q4, ctx);
  assert.deepEqual(f.authors, { app: 2, asked: 0, changed: 1, person: 1, unknown: 1 });
  assert.equal(f.withoutYou, 50);
});

test('the share is left out when no booked receipt records who booked it', () => {
  const f = homeFigures(books([receipt('a')], [['a', 'T1']], [entry('1', 'T1')]), Q4, ctx);
  assert.equal(f.booked, 1);
  assert.equal(f.withoutYou, undefined);
});

test('a payment the app booked after asking a person is not booked without her', () => {
  const asked = new Set(['ask-1']);
  assert.equal(authorOf(entry('1', 'T1', { run: 'ask-1', by: { kind: 'rule', rule: 'r' } }), asked), 'asked');
  assert.equal(authorOf(entry('1', 'T1', { run: 'booking-2', by: { kind: 'rule', rule: 'r' } }), asked), 'app');
  const f = homeFigures(books([receipt('a')], [['a', 'T1']], [entry('1', 'T1', { run: 'ask-1' })]), Q4, ctx, asked);
  assert.equal(f.withoutYou, 0);
});

test('a description changed by hand makes the app booking a changed one', () => {
  assert.equal(authorOf(entry('1', 'T1', { origin: 'manual', by: { kind: 'model', model: 'm' } })), 'changed');
});

test('the last stage: running, due with its day, overdue, filed, before the books begin', () => {
  const b = books([], [], [entry('july', 'july', { date: '2026-07-14' })]);
  assert.deepEqual(homeFigures(b, Q4, ctx).filing, { kind: 'running', ends: '2026-12-31' });
  const Q3: PeriodRange = { key: '2026-Q3', from: '2026-07-01', to: '2026-09-30' };
  const Q2: PeriodRange = { key: '2026-Q2', from: '2026-04-01', to: '2026-06-30' };
  assert.deepEqual(homeFigures(b, Q2, ctx).filing, { kind: 'before' }, 'ended before the books\' first day: not «überfällig» (#345)');
  assert.deepEqual(homeFigures(books([], [], []), Q3, ctx).filing, { kind: 'before' }, 'books with nothing dated');
  assert.deepEqual(homeFigures(b, Q3, ctx).filing, { kind: 'due', due: '2026-11-29', overdue: false });
  assert.deepEqual(homeFigures(b, Q3, { ...ctx, today: '2026-12-01' }).filing, { kind: 'due', due: '2026-11-29', overdue: true });
  assert.deepEqual(homeFigures(books([], [], [], '2026-09-30'), Q3, ctx).filing, { kind: 'filed' });
  assert.deepEqual(homeFigures(b, Q3, { ...ctx, vatRegistered: false }).filing, { kind: 'due', overdue: false });
});

test('the dock card\'s payments count the period\'s payments once each, and the booked ones: hers by hand without a receipt too (#365)', () => {
  const b = books([receipt('a')], [], [entry('1', 'LOHN', { accountDebit: '5000', origin: 'manual' }), entry('2', 'OLD', { date: '2026-09-30' })]);
  b.transactions = [
    { ref: 'LOHN', bank: 'Raiffeisen', date: '2026-10-25', amount: 5200, currency: 'CHF', direction: 'DBIT', description: 'Lohn Oktober' },
    { ref: 'OPEN', bank: 'Raiffeisen', date: '2026-10-26', amount: 89, currency: 'CHF', direction: 'DBIT', description: 'Abo' },
    { ref: 'OLD', bank: 'Raiffeisen', date: '2026-09-30', amount: 12, currency: 'CHF', direction: 'DBIT', description: 'Kontoführung' },
    // A card charge split over two balances: two legs, one ref, one payment.
    { ref: 'SPLIT', bank: 'Wise', date: '2026-10-27', amount: 30, currency: 'EUR', direction: 'DBIT', description: 'Card transaction' },
    { ref: 'SPLIT', bank: 'Wise', date: '2026-10-27', amount: 12, currency: 'CHF', direction: 'DBIT', description: 'Card transaction' },
  ];
  b.journalEntries!.push(entry('3', 'SPLIT', { accountDebit: '6570' }));
  const f = homeFigures(b, Q4, ctx);
  assert.equal(f.booked, 0, 'no receipt of the period is booked');
  assert.equal(f.payments, 3, 'the wage, the open payment and the split charge once; not another period\'s');
  assert.equal(f.paymentsBooked, 2, 'her wage, booked by hand, and the split charge once; the open payment does not count');
});

test('an empty workspace has zeros and no share', () => {
  const f = homeFigures(books([], [], []), Q4, ctx);
  assert.equal(f.collected + f.read + f.matched + f.booked, 0);
  assert.equal(f.withoutYou, undefined);
});

const wf = (over: Partial<WorkflowDecl> = {}): WorkflowDecl => ({
  id: 'collect', label: { en: 'Collect' }, desc: { en: '' }, phase: 'collect', cadence: { en: '' }, for: 'company',
  triggers: [{ kind: 'schedule', cron: '0 6 * * *' }], emits: [], start: 's', steps: [], version: 'v', origin: 'app', runnable: { ok: true }, ...over,
});
const run = (over: Partial<RunSummary>): RunSummary => ({
  id: 'r1', workflow: 'collect', item: { kind: 'company', id: 'company' }, mode: 'live', startedAt: '2026-10-21T05:00:00Z', status: 'done', path: [], startedBy: { kind: 'manual' },
  digest: { files: [], receipts: 0, links: 0, entries: 0, poorScans: [] }, ...over,
});
const view = (over: Partial<AutomationView> = {}): AutomationView => ({ rev: '', workflows: [], problems: [], warnings: [], runs: [], tasks: [], paused: false, limits: { ai: 1, other: 1 }, pending: [], ...over });
const now = new Date(2026, 9, 21, 10, 0);

test('a workflow\'s dot and next run come from its runs, tasks and schedule', () => {
  assert.equal(workflowState(wf(), view(), now).dot, 'idle');
  assert.equal(workflowState(wf(), view({ runs: [run({})] }), now).dot, 'ok');
  assert.equal(workflowState(wf(), view({ runs: [run({ status: 'running', at: 'pull' })] }), now).at, 'pull');
  assert.equal(workflowState(wf(), view({ runs: [run({ status: 'stuck' })] }), now).dot, 'warn');
  assert.deepEqual(workflowState(wf(), view(), now).next, new Date(2026, 9, 22, 6, 0));
  assert.equal(workflowState(wf(), view({ paused: true }), now).next, undefined);
  const off = workflowState(wf({ runnable: { ok: false, missing: [{ step: 'a', action: 'x' }, { step: 'b', action: 'y' }] } }), view(), now);
  assert.deepEqual([off.dot, off.missing, off.next], ['off', 2, undefined]);
});

test('runs that went through a person\'s step are the asked ones', () => {
  const w = wf({ id: 'ask', steps: [{ id: 'ask', body: { kind: 'person', task: { title: { en: 'q' } } } } as unknown as WorkflowDecl['steps'][number]] });
  assert.deepEqual([...askedRuns({ workflows: [w], runs: [run({ id: 'a', workflow: 'ask', path: ['ask', 'book'] }), run({ id: 'b', workflow: 'ask', path: ['book'] })] })], ['a']);
});

test('nextRun finds the next matching minute, and nothing for an invalid schedule', () => {
  assert.deepEqual(nextRun('*/15 * * * *', new Date(2026, 9, 21, 10, 7, 30)), new Date(2026, 9, 21, 10, 15));
  assert.deepEqual(nextRun('0 6 * * 1', new Date(2026, 9, 21, 10, 0)), new Date(2026, 9, 26, 6, 0));
  assert.equal(nextRun('nonsense', now), undefined);
});
