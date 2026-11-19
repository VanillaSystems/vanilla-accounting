/**
 * The tax at source on the real API (docs/specs/payroll.md §15.4 B2): a payslip whose canton's file is not
 * loaded says so; loading it (here the excerpt of the ESTV's ZH file uploaded as a file, no network) shows the
 * card first for the month closed without it; «Rückwirkende Korrektur» carries the tax to the next open month;
 * a file corrected during the year (an invented change of one bracket, clearly not the canton's) leaves the
 * closed payslips byte for byte as they were and carries each difference by the person's click; the
 * settlement list equals 2279's movements in the books. Invented people only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { allPayslipEvents, savePayroll } from '../src/payroll/store.js';
import { loadBooks } from '../src/books/store.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { firm, owner, dated } from './support/payroll.js';

const ZH = readFileSync(join(APP_ROOT, 'tests/fixtures/qst/tar26zh-excerpt.txt'));
const BE = readFileSync(join(APP_ROOT, 'tests/fixtures/qst/tar26be-excerpt.txt'));
/** An invented correction of the ZH file: the bracket from 6'451 of A0N at 7.50 % instead of 7.28 %, made 04.03.2026. */
const ZH_CORRECTED = Buffer.from(ZH.toString('latin1')
  .replace(/^00ZH {15}20251208/m, `00ZH${' '.repeat(15)}20260304`)
  .replace(/^(0601ZHA0N {7}20260101000645100000005000 00000000000)00728/m, '$100750'), 'latin1');

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  const person = owner({
    id: 'q1', isOwner: false, name: [dated('2026-01-01', { first: 'Lena', last: 'Grenzfall' })],
    employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 6500, pensum: 100, hoursPerWeek: 42, holidayDays: 25 })],
    insurances: [dated('2026-01-01', { uvg: { insurance: 'uvg', code: 'A1' } })],
    taxAtSource: [dated('2026-01-01', { subject: true, canton: 'ZH', code: 'A0', church: false })],
  });
  savePayroll(api.ws, firm([person]));
});
after(() => api?.stop());

const upload = (region: string, year: string, bytes: Buffer, backdated?: string) =>
  api.fetch(`/api/payroll/tariffs/${region}/${year}/file${backdated ? `?backdated=${backdated}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) }).then(async (r) => ({ status: r.status, json: await r.json() as Record<string, unknown> }));
type Line = { wageType: string; amount: number; corrects?: string; base?: number; tariff?: { created: string } };
const linesOf = async (id: string) => ((await api.send('GET', `/api/payroll/payslips/${id}`)).json.slip as { lines: Line[]; missing?: Array<{ wageType: string; missing: string }> });

test('without the file: «unvollständig: Tarif ZH 2026 nicht geladen», and the month closes after the warning', async () => {
  const slip = await linesOf('2026-09-q1');
  assert.ok(slip.missing?.some((m) => m.wageType === 'quellensteuer' && m.missing === 'tariff:ZH:2026'));
  assert.ok(!slip.lines.some((l) => l.wageType === 'quellensteuer'));
  const closed = await api.send('POST', '/api/payroll/payslips/2026-09-q1/close', { confirm: true });
  assert.equal(closed.json.closed, true);
});

test('a file of another canton is refused with its reason', async () => {
  const r = await upload('ZH', '2026', BE);
  assert.equal(r.status, 400);
  assert.deepEqual(r.json.params, { why: 'tariff', tariff: 'otherRegion' });
});

test('loading the file: the card first, then «Rückwirkende Korrektur» carries September\'s tax to October', async () => {
  const card = await upload('ZH', '2026', ZH);
  assert.equal(card.json.saved, false);
  const affected = card.json.affected as Array<{ payslip: string; differences: Array<{ wageType: string; diff: number; carry: boolean }> }>;
  assert.deepEqual(affected.map((a) => a.payslip), ['2026-09-q1']);
  assert.deepEqual(affected[0].differences.filter((d) => d.carry).map((d) => [d.wageType, d.diff]), [['quellensteuer', 473.2]]);
  assert.ok(affected[0].differences.some((d) => d.wageType === 'bezugsprovision' && !d.carry), 'the commission follows the tax');
  const before = await linesOf('2026-10-q1');
  assert.ok(!before.lines.some((l) => l.wageType === 'quellensteuer'), 'nothing changed before the click');
  const done = await upload('ZH', '2026', ZH, 'correct');
  assert.equal(done.json.saved, true);
  assert.equal((done.json.corrections as unknown[]).length, 1);
  const oct = await linesOf('2026-10-q1');
  const tax = oct.lines.filter((l) => l.wageType === 'quellensteuer');
  assert.deepEqual(tax.map((l) => [l.amount, l.corrects ?? null]), [[473.2, '2026-09-q1'], [473.2, null]]);
  assert.deepEqual(oct.lines.filter((l) => l.wageType === 'bezugsprovision').map((l) => [l.base, l.amount]), [[946.4, 18.93]]);
  const closed = await api.send('POST', '/api/payroll/payslips/2026-10-q1/close', { confirm: true });
  assert.equal(closed.json.closed, true);
});

test('a file corrected during the year: closed payslips stay as they are, each difference carried by the click', async () => {
  const closesBefore = allPayslipEvents(api.ws).filter((e) => e.event === 'close').map((e) => JSON.stringify(e));
  const card = await upload('ZH', '2026', ZH_CORRECTED);
  assert.equal(card.json.saved, false);
  const affected = card.json.affected as Array<{ payslip: string; differences: Array<{ wageType: string; diff: number; carry: boolean }> }>;
  // 6'500 × (7.50 − 7.28) % = 14.30 a month.
  assert.deepEqual(affected.map((a) => [a.payslip, a.differences.find((d) => d.wageType === 'quellensteuer')?.diff]), [['2026-09-q1', 14.3], ['2026-10-q1', 14.3]]);
  // Until the click, payroll computes with the file of 08.12.2025.
  assert.equal((await linesOf('2026-11-q1')).lines.find((l) => l.wageType === 'quellensteuer' && !l.corrects)?.tariff?.created, '2025-12-08');
  const done = await upload('ZH', '2026', ZH_CORRECTED, 'correct');
  assert.equal(done.json.saved, true);
  assert.equal((done.json.corrections as unknown[]).length, 2);
  const nov = await linesOf('2026-11-q1');
  assert.deepEqual(nov.lines.filter((l) => l.wageType === 'quellensteuer' && l.corrects).map((l) => [l.corrects, l.amount]), [['2026-09-q1', 14.3], ['2026-10-q1', 14.3]]);
  assert.equal(nov.lines.find((l) => l.wageType === 'quellensteuer' && !l.corrects)?.amount, 487.5, 'November with the corrected file: 6500 × 7.50 %');
  const closesAfter = allPayslipEvents(api.ws).filter((e) => e.event === 'close').map((e) => JSON.stringify(e));
  assert.deepEqual(closesAfter, closesBefore, 'every closed payslip byte for byte as it was');
  const tariffs = await api.send('GET', '/api/payroll/tariffs');
  const zh = (tariffs.json.files as Array<{ region: string; versions: unknown[] }>).find((f) => f.region === 'ZH')!;
  assert.equal(zh.versions.length, 2, 'both versions stay');
});

test('the settlement list per canton and month equals the movements of 2279 in the books', async () => {
  const r = await api.send('GET', '/api/payroll/documents/2026/tax-at-source');
  const lists = r.json.settlements as Array<{ month: string; region: string; totals: { tax: number; commission: number; payable: number } }>;
  assert.deepEqual(lists.map((s) => `${s.month} ${s.region}`), ['2026-10 ZH']);
  const books = loadBooks(api.ws);
  for (const s of lists) {
    const ref = `LR-${s.month}-q1`;
    const entries = books.journalEntries.filter((e) => e.transactionRef === ref);
    const credit = entries.filter((e) => e.accountCredit === '2279').reduce((a, e) => a + e.amount, 0);
    const debit = entries.filter((e) => e.accountDebit === '2279').reduce((a, e) => a + e.amount, 0);
    assert.equal(Math.round(credit * 100), Math.round(s.totals.tax * 100));
    assert.equal(Math.round(debit * 100), Math.round(s.totals.commission * 100));
    assert.equal(Math.round((credit - debit) * 100), Math.round(s.totals.payable * 100));
  }
  const csv = await api.fetch('/payroll/documents/2026/tax-at-source.csv?month=2026-10&region=ZH');
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('cache-control'), 'no-store');
  assert.match(await csv.text(), /2026-10;ZH;q1;Lena Grenzfall/);
});
