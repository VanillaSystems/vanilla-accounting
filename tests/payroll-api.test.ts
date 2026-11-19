/**
 * The Löhne routes on the real API (src/server/routes/payroll.ts): the year and the month, one payslip
 * with its preview, closing with the warning first, the PDF as filed, a Lohnart added to an open month,
 * a correction, «Alle abschliessen», reopening the latest month. The period lock is in period-lock.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, type ApiServer } from './support/api-server.js';
import { savePayroll } from '../src/payroll/store.js';
import { firm, owner, dated } from './support/payroll.js';

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  savePayroll(api.ws, firm([owner(), owner({ id: 'e2', isOwner: false, name: [dated('2026-01-01', { first: 'Nora', last: 'Muster' })], socialSecurityNumber: ['756', '1234', '5678', '97'].join('.') })]));
});
after(() => api?.stop());

test('GET /api/payroll: the year strip, the people with the number masked', async () => {
  const { status, json } = await api.send('GET', '/api/payroll?year=2026');
  assert.equal(status, 200);
  const months = json.months as Array<{ month: string; state: string; of: number }>;
  assert.equal(months.length, 12);
  assert.equal(months[8].of, 2);
  const people = json.employees as Array<{ id: string; socialSecurityNumber?: string }>;
  assert.equal(people.find((p) => p.id === 'e2')?.socialSecurityNumber, '756.****.****.97');
  assert.ok(!JSON.stringify(json).includes('1234.5678'), 'the full number is in no list');
});

test('a payslip: preview, the warning first, then «Trotzdem abschliessen», the PDF, and the month', async () => {
  const view = await api.send('GET', '/api/payroll/payslips/2026-09-e1');
  assert.equal(view.status, 200);
  assert.equal((view.json.booking as { ref: string }).ref, 'LR-2026-09-e1');
  assert.equal((view.json.reopen as { offered: boolean }).offered, false);
  const first = await api.send('POST', '/api/payroll/payslips/2026-09-e1/close', {});
  assert.equal(first.json.closed, false);
  assert.ok((first.json.warnings as unknown[]).length > 0);
  const second = await api.send('POST', '/api/payroll/payslips/2026-09-e1/close', { confirm: true });
  assert.equal(second.json.closed, true);
  const pdf = await api.fetch("/payroll/payslips/2026-09-e1.pdf");
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const month = await api.send('GET', '/api/payroll/months/2026-09');
  assert.equal(month.json.closed, 1);
  assert.equal(month.json.of, 2);
  const again = await api.send('GET', '/api/payroll/payslips/2026-09-e1');
  assert.equal((again.json.reopen as { offered: boolean }).offered, true);
});

test('a Lohnart added to an open month, a correction on a closed one, «Alle abschliessen», reopening', async () => {
  const line = await api.send('POST', '/api/payroll/month-lines', { employee: 'e1', month: '2026-10', wageType: 'bonus', amount: 2000, text: 'Projekt' });
  assert.equal(line.status, 200);
  const unknown = await api.send('POST', '/api/payroll/month-lines', { employee: 'e1', month: '2026-10', wageType: 'nope', amount: 1 });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, 'payroll');
  const corr = await api.send('POST', '/api/payroll/payslips/2026-09-e1/corrections', { wageType: 'bvg-an', amount: 19 });
  assert.equal(corr.status, 200);
  const oct = await api.send('GET', '/api/payroll/payslips/2026-10-e1');
  const lines = (oct.json.slip as { lines: Array<{ wageType: string; amount: number; corrects?: string }> }).lines;
  assert.ok(lines.some((l) => l.wageType === 'bonus' && l.amount === 2000));
  assert.ok(lines.some((l) => l.corrects === '2026-09-e1' && l.amount === 19));
  const notLatest = await api.send('POST', '/api/payroll/payslips/2026-08-e1/reopen');
  assert.equal(notLatest.status, 409);
  const all = await api.send('POST', '/api/payroll/months/2026-10/close', { confirm: true });
  assert.deepEqual((all.json.closed as string[]).sort(), ['2026-10-e1', '2026-10-e2']);
  const reopen = await api.send('POST', '/api/payroll/payslips/2026-10-e2/reopen');
  assert.equal(reopen.status, 200);
  assert.equal(reopen.json.removed && (reopen.json.removed as string[]).length > 0, true);
});

test('Lohnzahlungen and the insurers: the month\'s rows with what is paid, the accounts\' balances, a final statement booked', async () => {
  const pay = await api.send('GET', '/api/payroll/payments/2026-09');
  const rows = pay.json.rows as Array<{ id: string; purpose: string; payout: number; paid?: unknown }>;
  assert.deepEqual(rows.map((r) => [r.id, r.purpose, r.payout, !!r.paid]), [['2026-09-e1', 'Lohn 09/2026', 8910, false]]);
  const ins = await api.send('GET', '/api/payroll/insurances?year=2026');
  const ahv = (ins.json.rows as Array<{ kind: string; accrued: number; open: number }>).find((r) => r.kind === 'ahv')!;
  assert.ok(ahv.accrued > 0 && ahv.open === ahv.accrued);
  const settle = await api.send('POST', '/api/payroll/insurances/ak/settle', { year: '2026', total: ahv.accrued + 10, date: '2026-12-31' });
  assert.equal(settle.status, 200);
  assert.equal((settle.json as { amount: number }).amount, 10);
});
