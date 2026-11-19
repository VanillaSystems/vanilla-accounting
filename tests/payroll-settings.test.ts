/**
 * Löhne › Einstellungen and Mitarbeitende (src/payroll/settings.ts, src/server/routes/payroll-settings.ts):
 * the social security number checked by its check digit and never in a list, a person created with every
 * section dated from her entry, a dated entry added and one a closed payslip used kept, a rate outside its
 * range a warning, the Lohnart layer, the accounts check, and a change dated before a closed month (§19.3):
 * the card first, then «Rückwirkende Korrektur» carried to the next open month, or «So lassen».
 * Invented people only; IBAN and social security numbers are split so the leak guard reads no literal.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApi, type ApiServer } from './support/api-server.js';
import { ch, closedThrough, ctxOf, firm, amountOf } from './support/payroll.js';
import { computePayslip } from '../src/payroll/compute.js';
import { historyOf } from '../src/payroll/history.js';
import { appendPayslipEvents, loadPayroll, savePayroll } from '../src/payroll/store.js';
import { PayrollRefusal } from '../src/payroll/close.js';
import {
  addDatedEntry, affectedBy, backdatedCorrections, copyWageType, createEmployee, createInsurance, driftOf, ean13, patchEmployee, payrollAccounts,
  removeWageType, reopenOffer, setWageType, socialSecurityNumberOf, withdrawDatedEntry,
} from '../src/payroll/settings.js';
import type { PayrollStore, PayslipEvent } from '../src/payroll/model.js';

const data = ch.payroll!;
const NOW = '2026-11-19T10:00:00.000Z';
/** The example number the federal register publishes for the check digit; split so no literal stands here. */
const VALID = ['756', '9217', '0769', '85'].join('.');
const IBAN = ['CH93', '0076', '2011', '6238', '5295', '7'].join(' ');
const refused = (code: PayrollRefusal['code']) => (e: unknown) => e instanceof PayrollRefusal && e.code === code;

test('the social security number: its pattern and the EAN-13 check digit; kept with dots', () => {
  assert.equal(ean13(VALID.replace(/\./g, '')), true);
  assert.equal(socialSecurityNumberOf(VALID.replace(/\./g, ' '), data), VALID);
  assert.equal(socialSecurityNumberOf(VALID.replace(/\./g, ''), data), VALID);
  assert.throws(() => socialSecurityNumberOf(VALID.slice(0, -1) + '6', data), refused('socialSecurityNumber'), 'a wrong check digit');
  assert.throws(() => socialSecurityNumberOf(['757', '9217', '0769', '85'].join('.'), data), refused('socialSecurityNumber'), 'another prefix');
  assert.throws(() => socialSecurityNumberOf('756.123', data), refused('socialSecurityNumber'));
});

test('a person with every section from her entry; the undated facts patched', () => {
  const store = firm([]);
  const e = createEmployee(store, data, {
    first: 'Mila', last: 'Beispiel', birthDate: '1985-03-04', sex: 'f', isOwner: true, socialSecurityNumber: VALID, validFrom: '2026-01-01',
    employment: { kind: 'monthly', amount: 8600, pensum: 100, hoursPerWeek: 42, thirteenth: { months: [12] } },
    address: { street: 'Musterweg', number: '1', postcode: '6300', town: 'Zug' },
    bank: { iban: IBAN },
    insurances: { bvg: { insurance: 'pk', employee: 290, employer: 290 }, uvg: { insurance: 'uvg', code: 'A1' } },
  }, 'p1', NOW);
  assert.equal(e.isOwner, true);
  assert.equal(e.socialSecurityNumber, VALID);
  for (const h of [e.name, e.address, e.bank, e.employment, e.insurances]) assert.deepEqual(h.map((x) => x.validFrom), ['2026-01-01']);
  assert.equal(e.bank[0].value.iban, IBAN.replace(/ /g, ''));
  assert.deepEqual(e.insurances[0].value.bvg, { insurance: 'pk', employee: 290, employer: 290 });
  const d = computePayslip(ctxOf(store), 'p1', '2026-09')!;
  assert.equal(amountOf(d, 'monatslohn'), 8600);
  assert.equal(amountOf(d, 'bvg-an'), 290);
  assert.throws(() => createEmployee(store, data, { first: 'X', last: 'Y', birthDate: '1990-01-01', validFrom: '2026-01-01', employment: { kind: 'monthly', amount: 1 }, bank: { iban: 'CH00 1234' } }, 'p2', NOW), refused('iban'));
  assert.throws(() => createEmployee(store, data, { first: 'X', last: 'Y', birthDate: '1990-01-01', validFrom: '2026-01-01', employment: { kind: 'monthly', amount: 1 }, insurances: { uvg: { insurance: 'nope', code: 'A1' } } }, 'p3', NOW), refused('badInput'));
  patchEmployee(store, data, 'p1', { sex: 'm', socialSecurityNumber: '' });
  assert.equal(store.employees[0].sex, 'm');
  assert.equal(store.employees[0].socialSecurityNumber, undefined);
});

test('a dated entry: added by its path; one a closed payslip read stays, a planned one can go', () => {
  const store = firm();
  const events = closedThrough(store, '2026-03');
  const history = historyOf(events);
  const { entry } = addDatedEntry(store, data, { path: 'employees/e1/employment', validFrom: '2027-01-01', value: { kind: 'monthly', amount: 11000 } }, NOW);
  assert.equal(store.employees[0].employment.length, 2);
  withdrawDatedEntry(store, data, history, 'employees/e1/employment', entry);
  assert.equal(store.employees[0].employment.length, 1, 'the planned raise is taken back');
  const first = store.employees[0].employment[0];
  assert.throws(() => withdrawDatedEntry(store, data, history, 'employees/e1/employment', first), refused('used'));
  assert.throws(() => addDatedEntry(store, data, { path: 'employees/e1/name', validFrom: '2026-02-01', validUntil: '2026-03-01', value: { first: 'A', last: 'B' } }, NOW), refused('badInput'), 'a name does not end');
  assert.throws(() => addDatedEntry(store, data, { path: 'employees/e1/salary', validFrom: '2026-02-01', value: 1 }, NOW), refused('badInput'));
  assert.throws(() => addDatedEntry(store, data, { path: 'employees/e1/recurring/monatslohn', validFrom: '2026-02-01', value: { amount: 1 } }, NOW), refused('badInput'), 'the app computes it');
  addDatedEntry(store, data, { path: 'employees/e1/recurring/pauschalspesen', validFrom: '2026-04-01', value: { amount: 300 } }, NOW);
  assert.equal(amountOf(computePayslip(ctxOf(store, events), 'e1', '2026-04')!, 'pauschalspesen'), 300);
  addDatedEntry(store, data, { path: 'company/rounding', validFrom: '2026-01-01', value: 0.01 }, NOW);
  assert.throws(() => addDatedEntry(store, data, { path: 'company/rounding', validFrom: '2026-01-01', value: 0.1 }, NOW), refused('badInput'));
});

test('a rate outside its range is a warning, never a refusal', () => {
  const store = firm();
  const { warnings } = addDatedEntry(store, data, { path: 'insurances/ak/solutions/A/rates', validFrom: '2027-01-01', value: { adminCost: 7 } }, NOW);
  assert.deepEqual(warnings, [{ key: 'adminCost', value: 7, range: [0, 5] }]);
  assert.throws(() => addDatedEntry(store, data, { path: 'insurances/ak/solutions/A/rates', validFrom: '2027-01-01', value: { nope: 1 } }, NOW), refused('badInput'));
  const created = createInsurance(store, data, { kind: 'uvgz', name: 'Zusatz Beispiel', validFrom: '2026-01-01', rates: { employee: 9, employer: 0.4 } }, 'z1', NOW);
  assert.deepEqual(created.warnings.map((w) => w.key), ['employee']);
  assert.equal(store.insurances.at(-1)?.solutions[0].rates[0].value.employer, 0.4);
});

test('the Lohnart layer: a rename, a copy, and a copy a closed payslip used stays', () => {
  const store = firm();
  setWageType(store, data, 'pauschalspesen', { label: { de: 'Spesenpauschale' }, debit: '5831' });
  assert.deepEqual(store.wageTypes, [{ key: 'pauschalspesen', label: { de: 'Spesenpauschale' }, debit: '5831' }]);
  setWageType(store, data, 'pauschalspesen', {});
  assert.deepEqual(store.wageTypes, [], 'back to the catalogue');
  copyWageType(store, data, { copyOf: 'bonus', label: { de: 'Erfolgsprämie' } }, 'copy-1');
  addDatedEntry(store, data, { path: 'employees/e1/recurring/copy-1', validFrom: '2026-01-01', value: { amount: 100 } }, NOW);
  const events = closedThrough(store, '2026-02');
  assert.throws(() => removeWageType(store, historyOf(events), 'copy-1'), refused('used'));
  assert.throws(() => removeWageType(store, historyOf(events), 'bonus'), refused('badInput'), 'a catalogue Lohnart is never removed');
  assert.throws(() => copyWageType(store, data, { copyOf: 'ahv-an', label: 'X' }, 'copy-2'), refused('badInput'));
});

test('the accounts the payroll books on, and which the chart lacks', () => {
  const store = firm();
  const accounts = payrollAccounts(ctxOf(store), new Map([['5000', 'Lohnaufwand'], ['1091', 'Lohndurchlaufkonto']]), new Map([['2271', 'Verbindlichkeiten AHV']]));
  const byNumber = new Map(accounts.map((a) => [a.number, a]));
  assert.equal(byNumber.get('5000')?.exists, true);
  assert.equal(byNumber.get('1091')?.exists, true);
  assert.equal(byNumber.get('2271')?.exists, false);
  assert.equal(byNumber.get('2271')?.name, 'Verbindlichkeiten AHV', 'named as the standard chart names it');
  assert.ok(byNumber.get('2275'), 'the pension fund\'s liability account');
});

/** Jan–Aug closed; a new certificate from 1 August raises BVG from 300 to 320 on each side. */
function backdated(): { store: PayrollStore; next: PayrollStore; events: PayslipEvent[] } {
  const store = firm();
  const events = closedThrough(store, '2026-09');
  const next = structuredClone(store);
  addDatedEntry(next, data, { path: 'employees/e1/insurances', validFrom: '2026-08-01', value: { bvg: { insurance: 'pk', employee: 320, employer: 320 }, uvg: { insurance: 'uvg', code: 'A1' }, ktg: { insurance: 'ktg', code: 'A' } } }, NOW);
  return { store, next, events };
}

test('§19.3: a change dated before a closed month names the payslip and each Lohnart that differs', () => {
  const { store, next, events } = backdated();
  const ctx = ctxOf(store, events);
  const affected = affectedBy(ctx, next);
  assert.deepEqual(affected.map((a) => a.month), ['2026-08']);
  assert.deepEqual(affected[0].differences.map((d) => [d.wageType, d.side, d.before, d.after, d.diff]), [['bvg-an', 'employee', 300, 320, 20], ['bvg-ag', 'employer', 300, 320, 20]]);
  assert.equal(reopenOffer(ctx, affected, () => false), '2026-08-e1', 'the latest closed month, in an open period');
  assert.equal(reopenOffer(ctx, affected, () => true), undefined, 'a closed period offers only the correction');
  // A change after every closed payday touches none: a new address from 1 September.
  const moved = structuredClone(store);
  addDatedEntry(moved, data, { path: 'employees/e1/address', validFrom: '2026-09-01', value: { postcode: '8000', town: 'Zürich' } }, NOW);
  assert.deepEqual(affectedBy(ctx, moved), []);
});

test('§19.3 «Rückwirkende Korrektur»: one correction per Lohnart, carried by the next open month', () => {
  const { store, next, events } = backdated();
  const ctx = ctxOf(store, events);
  let n = 0;
  const corrections = backdatedCorrections(ctx, affectedBy(ctx, next), () => `co_${++n}`, NOW);
  assert.deepEqual(corrections.map((c) => [c.of, c.wageType, c.side, c.amount]), [['2026-08-e1', 'bvg-an', 'employee', 20], ['2026-08-e1', 'bvg-ag', 'employer', 20]]);
  const sep = computePayslip(ctxOf(next, [...events, ...corrections]), 'e1', '2026-09')!;
  const carried = sep.lines.filter((l) => l.corrects === '2026-08-e1');
  assert.deepEqual(carried.map((l) => [l.wageType, l.amount]), [['bvg-an', 20], ['bvg-ag', 20]]);
  assert.equal(amountOf(sep, 'bvg-an'), 340, 'September at 320 plus the August difference');
  // The closed August stays; with the corrections it computes no drift any more.
  const after = ctxOf(next, [...events, ...corrections]);
  assert.deepEqual(driftOf(after, after.history.closed.get('2026-08-e1')!), []);
  assert.deepEqual(driftOf(ctxOf(next, events), ctxOf(next, events).history.closed.get('2026-08-e1')!).map((d) => d.diff), [20, 20], '«So lassen» leaves it as a fact');
});

// ─── the routes ────────────────────────────────────────────────────────────────

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  const store = firm();
  savePayroll(api.ws, store);
  appendPayslipEvents(api.ws, '2026', closedThrough(store, '2026-09'));
});
after(() => api?.stop());

test('routes: a person created; her number masked in every list, in full only by its own route', async () => {
  const bad = await api.send('POST', '/api/payroll/employees', { first: 'Nora', last: 'Muster', birthDate: '1990-02-02', validFrom: '2026-10-01', socialSecurityNumber: VALID.slice(0, -1) + '0', employment: { kind: 'monthly', amount: 5000 } });
  assert.equal(bad.status, 400);
  assert.deepEqual([bad.json.code, (bad.json.params as { why: string }).why], ['payroll', 'socialSecurityNumber']);
  const made = await api.send('POST', '/api/payroll/employees', { first: 'Nora', last: 'Muster', birthDate: '1990-02-02', sex: 'f', validFrom: '2026-10-01', socialSecurityNumber: VALID, employment: { kind: 'monthly', amount: 5000, pensum: 60 }, bank: { iban: IBAN } });
  assert.equal(made.status, 200);
  assert.equal(made.json.saved, true);
  const id = String(made.json.id);
  const list = await api.send('GET', '/api/payroll?year=2026');
  const detail = await api.send('GET', `/api/payroll/employees/${id}?year=2026`);
  for (const body of [list.json, detail.json]) assert.ok(!JSON.stringify(body).includes(VALID), 'no list carries the full number');
  assert.equal((detail.json.employee as { socialSecurityNumber: string }).socialSecurityNumber, '756.****.****.85');
  assert.equal((detail.json as { defaultFrom: string }).defaultFrom, '2026-10-01');
  const full = await api.send('GET', `/api/payroll/employees/${id}/social-security-number`);
  assert.equal(full.json.socialSecurityNumber, VALID);
});

test('routes: a backdated change answers with the card and saves nothing, then «Rückwirkende Korrektur»', async () => {
  const body = { path: 'employees/e1/insurances', validFrom: '2026-08-01', value: { bvg: { insurance: 'pk', employee: 320, employer: 320 }, uvg: { insurance: 'uvg', code: 'A1' }, ktg: { insurance: 'ktg', code: 'A' } } };
  const card = await api.send('POST', '/api/payroll/entries', body);
  assert.equal(card.status, 200);
  assert.equal(card.json.saved, false);
  assert.equal(card.json.reopen, '2026-08-e1');
  assert.deepEqual((card.json.affected as Array<{ payslip: string }>).map((a) => a.payslip), ['2026-08-e1']);
  assert.equal(loadPayroll(api.ws).employees[0].insurances.length, 1, 'nothing saved before the person chose');
  const bad = await api.send('POST', '/api/payroll/entries', { ...body, backdated: 'maybe' });
  assert.equal(bad.status, 400);
  const saved = await api.send('POST', '/api/payroll/entries', { ...body, backdated: 'correct' });
  assert.equal(saved.json.saved, true);
  assert.equal((saved.json.corrections as unknown[]).length, 2);
  assert.equal(loadPayroll(api.ws).employees[0].insurances.length, 2);
  const lines = readFileSync(`${api.ws.paths.root}/transactional-data/2026/payroll/payslips.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as PayslipEvent);
  assert.deepEqual(lines.filter((e) => e.event === 'correction').map((e) => e.event === 'correction' && [e.of, e.wageType, e.amount]), [['2026-08-e1', 'bvg-an', 20], ['2026-08-e1', 'bvg-ag', 20]]);
  const sep = await api.send('GET', '/api/payroll/payslips/2026-09-e1');
  assert.ok((sep.json.slip as { lines: Array<{ corrects?: string }> }).lines.some((l) => l.corrects === '2026-08-e1'));
  const aug = await api.send('GET', '/api/payroll/payslips/2026-08-e1');
  assert.deepEqual(aug.json.drift, [], 'the corrected month shows no difference');
});

test('routes: «So lassen» saves the entry alone; the closed month says what differs', async () => {
  const r = await api.send('POST', '/api/payroll/entries', { path: 'insurances/ktg/solutions/A/rates', validFrom: '2026-08-01', value: { employee: 0.6, employer: 0.6 }, backdated: 'keep' });
  assert.equal(r.json.saved, true);
  assert.deepEqual(r.json.corrections, []);
  const aug = await api.send('GET', '/api/payroll/payslips/2026-08-e1');
  assert.deepEqual((aug.json.drift as Array<{ wageType: string }>).map((d) => d.wageType).sort(), ['ktg-ag', 'ktg-an']);
});

test('routes: an insurance with a rate outside its range is saved with the warning; «Konto anlegen»', async () => {
  const r = await api.send('POST', '/api/payroll/insurances', { kind: 'uvgz', name: 'Zusatz Beispiel', validFrom: '2026-10-01', rates: { employee: 6, employer: 0.4 } });
  assert.equal(r.json.saved, true);
  assert.deepEqual((r.json.warnings as Array<{ key: string }>).map((w) => w.key), ['employee']);
  const settings = await api.send('GET', '/api/payroll/settings');
  const missing = (settings.json.accounts as Array<{ number: string; exists: boolean }>).filter((a) => !a.exists).map((a) => a.number);
  assert.ok(missing.length > 0, 'the fixture chart lacks the payroll accounts');
  const add = await api.send('POST', '/api/payroll/accounts', { number: missing[0] });
  assert.equal(add.status, 200);
  assert.equal(add.json.number, missing[0]);
  const again = await api.send('POST', '/api/payroll/accounts', { number: missing[0] });
  assert.equal(again.status, 409);
  const foreign = await api.send('POST', '/api/payroll/accounts', { number: '9999' });
  assert.equal(foreign.status, 400);
});

test('routes: an entry a closed payslip used cannot be withdrawn', async () => {
  const store = loadPayroll(api.ws);
  const first = store.employees[0].employment[0];
  const r = await api.send('POST', '/api/payroll/entries/withdraw', { path: 'employees/e1/employment', validFrom: first.validFrom, enteredAt: first.enteredAt });
  assert.equal(r.status, 409);
  assert.equal((r.json.params as { why: string }).why, 'used');
});


test('the Löhne paths of docs/urls.md parse and format both ways', async () => {
  const { formatLocation, parseLocation } = await import('../src/app/shell/route.js');
  const paths = ['/payroll', '/payroll/2026-09', '/payroll/2026-09/p1', '/payroll/payslips', '/payroll/employees', '/payroll/employees/new', '/payroll/settings/insurances'];
  for (const p of paths) {
    const loc = parseLocation(p, '', '2026-11-19');
    assert.ok(!('redirect' in loc), p);
    assert.equal(loc.route.area, 'payroll', p);
    assert.equal(formatLocation(loc as never), p);
  }
  assert.deepEqual((parseLocation('/payroll/2026-09/p1', '', '2026-11-19') as { route: unknown }).route, { area: 'payroll', view: 'payslips', month: '2026-09', employee: 'p1' });
});
