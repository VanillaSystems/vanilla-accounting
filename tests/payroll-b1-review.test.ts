/**
 * The review of phase B1 (2026-11-19), each finding as a test: a Nachzahlung of the next year judged against the
 * exit year's wage, overlapping absences and two kinds of one fund, the birth allowance apart from the monthly one,
 * an exempt person without a birth date, the payment file's QR-IBANs, character set, odd input and a second
 * creation said first. Invented people only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { computePayslip } from '../src/payroll/compute.js';
import { declarationRows } from '../src/payroll/documents.js';
import { historyOf } from '../src/payroll/history.js';
import { addAbsence, addChild } from '../src/payroll/settings.js';
import { pain001, PainError, spsText, localTime } from '../src/providers/pain001/xml.js';
import { paymentFilePlan } from '../src/payroll/payment-file.js';
import type { PaymentRow } from '../src/payroll/payments.js';
import type { PayrollEmployee, PayslipClose, PayslipEvent } from '../src/payroll/model.js';
import { savePayroll } from '../src/payroll/store.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { ch, closeOf, closedThrough, ctxOf, dated, firm, owner } from './support/payroll.js';

const staff = (id: string, more: Partial<PayrollEmployee> = {}): PayrollEmployee => owner({ id, isOwner: false, birthDate: '1990-04-02', sex: 'f', name: [dated('2026-01-01', { first: 'Nora', last: id })], insurances: [dated('2026-01-01', { uvg: { insurance: 'uvg', code: 'A1' }, ktg: { insurance: 'ktg', code: 'A' } })], ...more });
const monthly = (amount: number) => ({ kind: 'monthly' as const, amount, pensum: 100, hoursPerWeek: 42, holidayDays: 25 });
const sumOf = (d: NonNullable<ReturnType<typeof computePayslip>>, w: string) => d.lines.filter((l) => l.wageType === w).reduce((s, l) => s + l.amount, 0);
const FIRM = ['CH93', '0076', '2011', '6238', '5295', '7'].join('');
const PLAIN = ['CH76', '0900', '0000', '1234', '5678', '9'].join('');
const QR = ['CH44', '3199', '9123', '0008', '8901', '2'].join('');

test('1. a Nachzahlung in the year after a full year is judged against that year\'s wage: AHV owed on it', () => {
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(6000), undefined, '2026-12-31')] })]);
  const events: PayslipEvent[] = [];
  for (let m = 1; m <= 12; m++) { const d = computePayslip(ctxOf(store, events), 'p1', `2026-${String(m).padStart(2, '0')}`); if (d) events.push(closeOf(d)); }
  store.monthLines = [{ id: 'm1', employee: 'p1', month: '2027-02', wageType: 'bonus', amount: 2000, enteredAt: '2027-02-10T08:00:00Z' }];
  const years = { ...ch.payrollYears, 2027: { ...ch.payrollYears!['2026'], year: 2027 } };
  const d = computePayslip({ data: ch.payroll!, years, store, history: historyOf(events) }, 'p1', '2027-02')!;
  assert.equal(sumOf(d, 'ahv-an'), 106, '2,000 × 5.3 %: 2026 paid 72,000, far above the small-wage limit');
  assert.ok(!d.facts.some((f) => f.key === 'smallWage'));
  assert.equal(sumOf(d, 'alv-an'), 22, '72,000 of 2026 leave room under its ALV ceiling of 148,200');
});

test('4. absences over the same days take a day\'s wage off once', () => {
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(6000))] })]);
  addAbsence(store, ch.payroll!, 'p1', { kind: 'illness', from: '2026-09-01', to: '2026-09-30', continuedPay: 80 }, 'a1', 'now');
  addAbsence(store, ch.payroll!, 'p1', { kind: 'unpaid', from: '2026-09-01', to: '2026-09-30' }, 'a2', 'now');
  const d = computePayslip(ctxOf(store), 'p1', '2026-09')!;
  assert.equal(sumOf(d, 'lohnausfall') + sumOf(d, 'unbezahlter-urlaub'), 6000, 'never more than the month\'s wage');
  assert.equal(d.gross, 4800, 'the illness took the month first, 80 % continued');
  assert.ok(d.facts.some((f) => f.key === 'absenceOverlap'));
});

test('5. two kinds paid by one fund in a month each top up their own continued pay', () => {
  const store = firm([staff('p1', { employment: [dated('2026-01-01', monthly(6000))] })]);
  addAbsence(store, ch.payroll!, 'p1', { kind: 'maternity', from: '2026-09-01', to: '2026-09-15', continuedPay: 100, dailyAllowance: 160 }, 'a1', 'now');
  addAbsence(store, ch.payroll!, 'p1', { kind: 'military', from: '2026-09-16', to: '2026-09-30', continuedPay: 100, dailyAllowance: 160 }, 'a2', 'now');
  const d = computePayslip(ctxOf(store), 'p1', '2026-09')!;
  assert.deepEqual(d.lines.filter((l) => l.wageType === 'lohnfortzahlung').map((l) => [l.text, l.amount]), [['Mutterschaft', 600], ['Militär, Zivildienst, Zivilschutz', 600]], 'each 3,000 less its own 2,400');
  assert.equal(d.gross, 6000);
});

test('7. a birth allowance is apart from the monthly history; the child allowance runs from the birth month', () => {
  const store = firm([staff('c1', { employment: [dated('2026-01-01', monthly(5000))] })]);
  addChild(store, ch.payroll!, 'c1', { name: 'Tim', birthDate: '2026-09-03', wageType: 'kinderzulage', amount: 215, validFrom: '2026-09-01', birth: { wageType: 'geburtszulage', amount: 1500, month: '2026-09' } }, 'k2', 'now');
  const sep = computePayslip(ctxOf(store), 'c1', '2026-09')!;
  assert.deepEqual(sep.lines.filter((l) => l.source === 'fak').map((l) => [l.wageType, l.amount, l.child]), [['kinderzulage', 215, 'k2'], ['geburtszulage', 1500, 'k2']]);
  const oct = computePayslip(ctxOf(store), 'c1', '2026-10')!;
  assert.deepEqual(oct.lines.filter((l) => l.source === 'fak').map((l) => l.wageType), ['kinderzulage']);
  assert.throws(() => addChild(store, ch.payroll!, 'c1', { name: 'Ada', birthDate: '2026-01-01', wageType: 'geburtszulage', amount: 1500, validFrom: '2026-01-01' }, 'k3', 'now'), /einmal/);
});

test('8. an exempt person without a birth date does not break the declaration; a line missing for another reason is no small wage', () => {
  const store = firm([staff('p1', { birthDate: undefined as unknown as string, employment: [dated('2026-01-01', monthly(6000))] })]);
  store.insurances = store.insurances.filter((i) => i.kind !== 'ahv');
  const events = closedThrough(store, '2026-04', 'p1') as PayslipClose[];
  const rows = declarationRows(store.employees, events, '2026', { data: ch.payroll!, years: ch.payrollYears });
  assert.equal(rows[0].exempt?.reason, 'other', 'no fund for the first pillar: the line was «unvollständig», not a small wage');
});

test('2, 3, 9. the payment file: no QR-IBAN, the permitted characters, ids without «//», odd input refused, local time', () => {
  const order = (p: Record<string, unknown>, debtor = FIRM) => ({ messageId: '/L2026//09', created: '2026-09-24T10:15:00.000Z', executionDate: '2026-09-25', currency: 'CHF', debtor: { name: 'Firma', iban: debtor }, payments: [{ id: '/2026//09-p1', name: 'Ida', iban: PLAIN, amount: 10, purpose: 'Lohn 09/2026', ...p }] });
  assert.throws(() => pain001(order({ iban: QR })), PainError);
  assert.throws(() => pain001(order({}, QR)), PainError);
  assert.throws(() => pain001(order({}, ['DE89', '3704', '0044', '0532', '0130', '00'].join(''))), PainError, 'a debtor abroad has no IID: refused, not NOTPROVIDED');
  for (const bad of [{ name: '  ' }, { purpose: '' }, { amount: 0.004 }, { amount: Infinity }, { amount: Number.NaN }]) assert.throws(() => pain001(order(bad)), PainError, JSON.stringify(bad));
  const xml = pain001(order({ name: 'Łukasz “Żółć” 😀 Иван\tA\nB Müller', purpose: 'Lohn – 09/2026 €' }));
  const doc = new XMLParser({ parseTagValue: false, isArray: (n) => n === 'CdtTrfTxInf' }).parse(xml).Document.CstmrCdtTrfInitn;
  assert.equal(doc.PmtInf.CdtTrfTxInf[0].Cdtr.Nm, 'Łukasz .Żółć. . .... A B Müller', 'Latin letters with their accents kept (Latin-1 and Extended-A), the rest «.», whitespace collapsed');
  assert.equal(doc.PmtInf.CdtTrfTxInf[0].RmtInf.Ustrd, 'Lohn . 09/2026 €');
  assert.equal(doc.GrpHdr.MsgId, 'L2026/09');
  assert.equal(doc.PmtInf.CdtTrfTxInf[0].PmtId.EndToEndId, '2026/09-p1');
  assert.match(doc.GrpHdr.CreDtTm, /^2026-09-24T\d{2}:15:00[+-]\d{2}:\d{2}$/);
  assert.equal(doc.GrpHdr.CreDtTm, localTime('2026-09-24T10:15:00.000Z'));
  assert.equal(spsText('Ä é ß ł Ж ẞ'), 'Ä é ß ł . .');
  assert.equal(spsText('ǅ'), '.', 'a letter outside the set without a permitted base stays out');
  const row = (id: string, iban: string): PaymentRow => ({ id, employee: id.slice(8), name: id, payout: 100, purpose: 'Lohn 09/2026', valueDate: '2026-09-25', iban });
  const plan = paymentFilePlan([row('2026-09-a', PLAIN), row('2026-09-b', QR), row('2026-09-c', ['DE89', '3704', '0044', '0532', '0130', '00'].join(''))],
    [{ bank: 'x', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank', iban: QR }, { bank: 'y', currency: 'CHF', account: '1021', label: 'Bank 2', role: 'bank', iban: FIRM }] as never, 'CHF', '2026-09-20');
  assert.deepEqual(plan.accounts.map((a) => a.account), ['1021'], 'a QR-IBAN of the firm is never debited');
  assert.deepEqual(plan.left.map((l) => [l.id, l.why]), [['2026-09-b', 'referenceIban'], ['2026-09-c', 'foreignIban']]);
});

// ─── 6. a second payment file is said first ─────────────────────────────────────

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  savePayroll(api.ws, firm([owner()]));
});
after(() => api?.stop());

test('6. the payment file is kept with its record; a second one for the same payslips is said first, then made', async () => {
  await api.send('PATCH', '/api/workspace', { banks: [{ bank: api.ws.bankAccounts.find((b) => b.role === 'bank')!.bank, currency: 'CHF', iban: FIRM }] });
  assert.equal((await api.send('POST', '/api/payroll/payslips/2026-09-e1/close', { confirm: true })).json.closed, true);
  const first = await api.send('POST', '/api/payroll/payments/2026-09/payment-file', {});
  assert.equal(first.json.made, true, JSON.stringify(first.json));
  const file = await api.fetch(first.json.url as string);
  assert.match(await file.text(), /<EndToEndId>2026-09-e1<\/EndToEndId>/);
  const again = await api.send('POST', '/api/payroll/payments/2026-09/payment-file', {});
  assert.equal(again.json.made, false);
  assert.equal((again.json.earlier as unknown[]).length, 1);
  const list = await api.send('GET', '/api/payroll/payments/2026-09');
  assert.equal((list.json.file as { made: unknown[] }).made.length, 1, 'the row says «Datei erstellt am …»');
  const second = await api.send('POST', '/api/payroll/payments/2026-09/payment-file', { confirm: true });
  assert.equal(second.json.made, true);
});
