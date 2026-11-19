/**
 * Days worked abroad on the real API (docs/specs/payroll.md §22 decision 121): entered on an open payslip, the tax at
 * source is withheld on the Swiss days' share at the rate of the whole wage; a wrong count is refused with its reason;
 * the closed payslip keeps the days on its tax line and refuses a change. Invented people only; the ZH excerpt of
 * tests/fixtures/qst uploaded as a file (no network).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { loadPayroll, savePayroll } from '../src/payroll/store.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { firm, owner, dated } from './support/payroll.js';

const ZH = readFileSync(join(APP_ROOT, 'tests/fixtures/qst/tar26zh-excerpt.txt'));

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  const person = owner({
    id: 'g1', isOwner: false, name: [dated('2026-01-01', { first: 'Jonas', last: 'Pendler' })],
    address: [dated('2026-01-01', { street: 'Hauptstrasse', number: '5', postcode: '79539', town: 'Lörrach', country: 'DE' })],
    employment: [dated('2026-01-01', { kind: 'monthly' as const, amount: 8000, pensum: 100, hoursPerWeek: 42, holidayDays: 25 })],
    insurances: [dated('2026-01-01', { uvg: { insurance: 'uvg', code: 'A1' } })],
    taxAtSource: [dated('2026-01-01', { subject: true, canton: 'ZH', code: 'A0', church: false })],
  });
  savePayroll(api.ws, firm([person]));
  const r = await api.fetch('/api/payroll/tariffs/ZH/2026/file', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(ZH) });
  assert.equal(r.status, 200);
});
after(() => api?.stop());

type Line = { wageType: string; amount: number; base?: number; tariff?: { income: number; abroad?: { days: number; total: number; wage: number } } };
const slipOf = async (id: string) => (await api.send('GET', `/api/payroll/payslips/${id}`)).json as { slip: { lines: Line[] }; taxDays?: { abroad: number; total?: number } };
const tax = (s: { slip: { lines: Line[] } }) => s.slip.lines.find((l) => l.wageType === 'quellensteuer')!;

test('5 of 20 days abroad: the tax on 6000 at the rate of 8000, and the payslip shows the days entered', async () => {
  assert.equal(tax(await slipOf('2026-09-g1')).base, 8000, 'without days abroad: the whole wage');
  const put = await api.send('PUT', '/api/payroll/payslips/2026-09-g1/days-abroad', { abroad: 5 });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, { id: '2026-09-g1', abroad: 5, total: 20 });
  const s = await slipOf('2026-09-g1');
  assert.deepEqual(s.taxDays && { abroad: s.taxDays.abroad, total: s.taxDays.total }, { abroad: 5, total: undefined });
  const l = tax(s);
  assert.deepEqual([l.base, l.tariff?.income, l.amount], [6000, 8000, 519.6]);
  assert.deepEqual(l.tariff?.abroad, { days: 5, total: 20, wage: 8000 });
});

test('a wrong count is refused with its reason; 0 removes the days', async () => {
  const more = await api.send('PUT', '/api/payroll/payslips/2026-09-g1/days-abroad', { abroad: 21 });
  assert.equal(more.status, 400);
  assert.match(String(more.json.error), /Mehr Tage im Ausland \(21\) als Arbeitstage im Monat \(20\)/);
  const half = await api.send('PUT', '/api/payroll/payslips/2026-09-g1/days-abroad', { abroad: 2.5 });
  assert.equal(half.status, 400);
  const total = await api.send('PUT', '/api/payroll/payslips/2026-09-g1/days-abroad', { abroad: 3, total: 40 });
  assert.equal(total.status, 400);
  await api.send('PUT', '/api/payroll/payslips/2026-10-g1/days-abroad', { abroad: 4 });
  await api.send('PUT', '/api/payroll/payslips/2026-10-g1/days-abroad', { abroad: 0 });
  assert.equal(loadPayroll(api.ws).taxDays?.['2026-10-g1'], undefined);
  assert.equal(tax(await slipOf('2026-10-g1')).base, 8000);
});

test('closed: the payslip keeps the days on its tax line, and a change is refused', async () => {
  const closed = await api.send('POST', '/api/payroll/payslips/2026-09-g1/close', { confirm: true });
  assert.equal(closed.json.closed, true);
  const l = tax(await slipOf('2026-09-g1'));
  assert.deepEqual(l.tariff?.abroad, { days: 5, total: 20, wage: 8000 });
  const late = await api.send('PUT', '/api/payroll/payslips/2026-09-g1/days-abroad', { abroad: 6 });
  assert.equal(late.status, 409);
  assert.deepEqual([late.json.code, (late.json.params as { why: string }).why], ['payroll', 'alreadyClosed']);
});
