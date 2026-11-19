/**
 * Löhne › Einstellungen and Mitarbeitende (docs/specs/payroll.md §5.1–§5.4, §19): the people, their dated
 * values, the firm's Stammdaten, Sozialversicherungen and Lohnarten, and «Konto anlegen». payroll.json is
 * not the books: it changes through src/payroll/ (updatePayroll), never through the write door. A change
 * a closed payslip would compute otherwise answers with the card of §19.3 and saves nothing until the
 * request says how (`backdated: 'correct'` or `'keep'`). The social security number is never in a list:
 * only the person's own «anzeigen» reads it in full.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { WS, readBooks } from '../books.js';
import { periodLock } from '../../books/store.js';
import { DatedEntryError } from '../../core/dated.js';
import { PayrollRefusal } from '../../payroll/close.js';
import { CatalogueError } from '../../payroll/catalogue.js';
import { chartNumbers, payrollContext } from '../../payroll/service.js';
import { appendPayslipEvents, updatePayroll } from '../../payroll/store.js';
import {
  addDatedEntry, addSolution, affectedBy, backdatedCorrections, keepEvents, copyWageType, createEmployee, createInsurance, employeeDetail, patchEmployee,
  patchInsurance, payrollAccounts, removeWageType, reopenOffer, setOpening, setWageType, settingsView, withdrawDatedEntry, type RateWarning,
} from '../../payroll/settings.js';
import type { PayrollStore, PayslipEvent } from '../../payroll/model.js';
import { maskedNumber } from '../../payroll/views.js';
import { idSource } from '../../invoices/store.js';
import { accountsOf } from '../../workspace/reads.js';
import { setAccountName } from '../../workspace/accounts-write.js';
import { standardAccounts } from '../../workspace/chart.js';
import type { ApiErrorBody } from '../../types/api-error.js';
import { keepSetupCard, type KeptItem } from '../../payroll/settings.js';
import { parseSetupAnswer, readSetupDocument, setupCards, setupKindOf, setupPrompt } from '../../payroll/setup-documents.js';
import { loadSetupState, updateSetupState } from '../../payroll/setup-store.js';
import { ask, modelReady } from '../../llm/ask.js';

export const router = Router();

const today = () => new Date().toISOString().slice(0, 10);
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {});
const hex = (n: number) => idSource.bytes(n).toString('hex');

const STATUS: Record<PayrollRefusal['code'], number> = {
  notFound: 404, badAmount: 400, unknownWageType: 400, badInput: 400, socialSecurityNumber: 400, iban: 400,
  alreadyClosed: 409, notClosed: 409, notLatest: 409, used: 409, exists: 409,
  unknownInsurance: 404, gone: 404, closedPeriod: 403, noExpenseAccount: 409, nothingAccrued: 409, noEmail: 409, noPassword: 409, noOutbox: 409, badPassword: 400,
  opening: 409,
};

const run = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response, next: NextFunction) => {
  try { fn(req, res); } catch (e) {
    const refusal = e instanceof DatedEntryError ? new PayrollRefusal('badInput', e.message) : e instanceof CatalogueError ? new PayrollRefusal('used', e.message) : e;
    if (refusal instanceof PayrollRefusal) res.status(STATUS[refusal.code]).json({ error: refusal.message, code: 'payroll', params: { why: refusal.code, ...(refusal.field ? { field: refusal.field } : {}) } } satisfies ApiErrorBody);
    else next(e);
  }
};

/**
 * One change to payroll.json, compared first with the closed payslips (§19.3): without `backdated` and
 * with a payslip it changes, nothing is saved and the card comes back; `correct` saves it and records a
 * Rückwirkende Korrektur per differing Lohnart; `keep` saves it alone («So lassen»). `change` must give
 * the same result each time it runs (its ids and times made before).
 */
function save<T>(req: Request, res: Response, what: { path: string; validFrom?: string }, change: (store: PayrollStore) => T, answer: (result: T) => Record<string, unknown>, warnings: (result: T) => RateWarning[] = () => []): void {
  const how = body(req).backdated;
  if (how !== undefined && how !== 'correct' && how !== 'keep') throw new PayrollRefusal('badInput', 'backdated: correct oder keep.');
  const ctx = payrollContext(WS);
  const next = structuredClone(ctx.store);
  const result = change(next);
  const lock = periodLock(readBooks());
  const affected = affectedBy(ctx, next, (d) => lock.isClosed(d));
  if (affected.length && !how) {
    const reopen = reopenOffer(ctx, affected, (d) => lock.isClosed(d));
    return void res.json({ saved: false, affected, ...(reopen ? { reopen } : {}), warnings: warnings(result) });
  }
  // A closed period offers only the correction (§19.3, golden rule 1).
  if (how === 'keep' && affected.some((a) => a.closedPeriod)) throw new PayrollRefusal('closedPeriod', 'Eine Lohnabrechnung einer geschlossenen Periode wird nur korrigiert: «So lassen» gibt es für sie nicht.');
  const now = new Date().toISOString();
  const saved = updatePayroll(WS, (s) => change(s));
  const corrections = how === 'correct' ? backdatedCorrections(ctx, affected, () => `co_${hex(6)}`, now) : [];
  const events: PayslipEvent[] = how === 'keep' ? keepEvents(affected, what, now) : corrections;
  const yearOf = (e: PayslipEvent) => (e.event === 'correction' ? e.of : e.id).slice(0, 4);
  for (const year of new Set(events.map(yearOf))) appendPayslipEvents(WS, year, events.filter((e) => yearOf(e) === year));
  res.json({ saved: true, ...answer(saved), warnings: warnings(saved), corrections });
}

/** A random id the store does not have yet (`taken` says which are). */
function freshId(prefix: string, n: number, taken: (id: string) => boolean): string {
  for (;;) { const id = `${prefix}${hex(n)}`; if (!taken(id)) return id; }
}

// ─── reading ───────────────────────────────────────────────────────────────────

const chartNames = () => new Map((accountsOf(WS) as Array<{ number?: unknown; name?: unknown }>).flatMap((a) => (a.number === undefined ? [] : [[String(a.number), String(a.name ?? '')] as const])));
const standardNames = () => new Map(standardAccounts(WS.company.legalForm).map((a) => [a.number, a.name]));

router.get('/api/payroll/settings', run((_req, res) => {
  const ctx = payrollContext(WS);
  res.json(settingsView(ctx, payrollAccounts(ctx, chartNames(), standardNames())));
}));

router.get('/api/payroll/employees/:id', run((req, res) => {
  const year = typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year) ? req.query.year : today().slice(0, 4);
  res.json(employeeDetail(payrollContext(WS), String(req.params.id), year, today(), (n) => maskedNumber(n)!));
}));

/** The number in full: only on the person's own page, after «anzeigen». */
router.get('/api/payroll/employees/:id/social-security-number', run((req, res) => {
  const e = payrollContext(WS).store.employees.find((x) => x.id === req.params.id);
  if (!e) throw new PayrollRefusal('notFound', `Keine Person ${req.params.id}.`);
  res.set('Cache-Control', 'no-store').json({ socialSecurityNumber: e.socialSecurityNumber ?? null });
}));

// ─── the people ────────────────────────────────────────────────────────────────

router.post('/api/payroll/employees', run((req, res) => {
  const id = freshId('p', 3, (x) => payrollContext(WS).store.employees.some((e) => e.id === x));
  const now = new Date().toISOString();
  const data = payrollContext(WS).data;
  save(req, res, { path: `employees/${id}` }, (s) => createEmployee(s, data, body(req), id, now).id, (id) => ({ id }));
}));

router.patch('/api/payroll/employees/:id', run((req, res) => {
  const { backdated: _, ...patch } = body(req);
  const data = payrollContext(WS).data;
  save(req, res, { path: `employees/${req.params.id}` }, (s) => patchEmployee(s, data, String(req.params.id), patch), () => ({ id: req.params.id }));
}));

/**
 * A person's opening of a year (a start here mid-year, §22 decision 43): January to `through` paid and booked
 * before payroll ran here, with their bases and Lohnausweis fields; `null` removes it. Its figures change the
 * ceilings of the months after it, so a closed payslip it computes otherwise answers with the card first.
 */
router.put('/api/payroll/employees/:id/opening/:year', run((req, res) => {
  const ctx = payrollContext(WS);
  const { backdated: _, ...rest } = body(req);
  const value = 'value' in rest ? rest.value : rest;
  save(req, res, { path: `employees/${req.params.id}/opening` }, (s) => setOpening(s, ctx.data, ctx.history, String(req.params.id), String(req.params.year), value), () => ({ id: req.params.id }));
}));

/** A dated value from a day («gilt ab»): of a person, of the Stammdaten, of a solution's rates (the path a close's `used` names). */
router.post('/api/payroll/entries', run((req, res) => {
  const b = body(req);
  const now = new Date().toISOString();
  const data = payrollContext(WS).data;
  const input = {
    path: String(b.path ?? ''), validFrom: String(b.validFrom ?? ''), ...(b.validUntil ? { validUntil: String(b.validUntil) } : {}), value: b.value,
    ...(typeof b.note === 'string' ? { note: b.note } : {}), ...(typeof b.receiptId === 'string' ? { receiptId: b.receiptId } : {}),
  };
  save(req, res, { path: input.path, validFrom: input.validFrom }, (s) => addDatedEntry(s, data, input, now), (r) => ({ entry: r.entry }), (r) => r.warnings);
}));

/** Takes back an entry no closed payslip read (a planned one, a typo). */
router.post('/api/payroll/entries/withdraw', run((req, res) => {
  const b = body(req);
  const ctx = payrollContext(WS);
  const key = { validFrom: String(b.validFrom ?? ''), enteredAt: String(b.enteredAt ?? '') };
  save(req, res, { path: String(b.path ?? ''), validFrom: key.validFrom }, (s) => withdrawDatedEntry(s, ctx.data, ctx.history, String(b.path ?? ''), key), () => ({ withdrawn: key }));
}));

// ─── the firm's insurances, its Lohnarten, its accounts ────────────────────────

router.post('/api/payroll/insurances', run((req, res) => {
  const id = freshId('in', 3, (x) => payrollContext(WS).store.insurances.some((i) => i.id === x));
  const now = new Date().toISOString();
  const data = payrollContext(WS).data;
  save(req, res, { path: `insurances/${id}`, ...(typeof body(req).validFrom === 'string' ? { validFrom: body(req).validFrom as string } : {}) }, (s) => createInsurance(s, data, body(req), id, now), (r) => ({ id: r.insurance.id }), (r) => r.warnings);
}));

router.patch('/api/payroll/insurances/:id', run((req, res) => {
  const { backdated: _, ...patch } = body(req);
  save(req, res, { path: `insurances/${req.params.id}` }, (s) => patchInsurance(s, String(req.params.id), patch), () => ({ id: req.params.id }));
}));

router.post('/api/payroll/insurances/:id/solutions', run((req, res) => {
  const now = new Date().toISOString();
  const data = payrollContext(WS).data;
  save(req, res, { path: `insurances/${req.params.id}/solutions` }, (s) => addSolution(s, data, String(req.params.id), body(req), now), () => ({ id: req.params.id }), (w) => w);
}));

router.put('/api/payroll/wage-types/:key', run((req, res) => {
  const data = payrollContext(WS).data;
  save(req, res, { path: `wageTypes/${req.params.key}` }, (s) => setWageType(s, data, String(req.params.key), body(req)), () => ({ key: req.params.key }));
}));

router.post('/api/payroll/wage-types', run((req, res) => {
  const key = freshId('copy-', 3, (x) => payrollContext(WS).store.wageTypes.some((l) => l.key === x));
  const data = payrollContext(WS).data;
  save(req, res, { path: `wageTypes/${key}` }, (s) => copyWageType(s, data, body(req), key), (key) => ({ key }));
}));

router.delete('/api/payroll/wage-types/:key', run((req, res) => {
  const ctx = payrollContext(WS);
  save(req, res, { path: `wageTypes/${req.params.key}` }, (s) => removeWageType(s, ctx.history, String(req.params.key)), () => ({ removed: req.params.key }));
}));

/** «Konto anlegen»: an account the payroll books on that the chart lacks, named as the standard chart names it. */
router.post('/api/payroll/accounts', run((req, res) => {
  const number = String(body(req).number ?? '');
  const ctx = payrollContext(WS);
  const needed = payrollAccounts(ctx, chartNames(), standardNames()).find((a) => a.number === number);
  if (!needed) throw new PayrollRefusal('badInput', `Konto ${number} bucht die Lohnbuchhaltung nicht.`);
  if (chartNumbers(WS).has(number)) throw new PayrollRefusal('exists', `Konto ${number} gibt es schon.`);
  const kindName = Object.values(ctx.data.insurances).find((k) => k.account === number)?.label.de;
  res.json(setAccountName(WS, number, needed.name ?? kindName ?? `Konto ${number}`));
}));

// ─── the funds' documents (§6.1 step 2, src/payroll/setup-documents.ts) ─────────

const cardsNow = () => { const ctx = payrollContext(WS); return setupCards(readBooks().receipts, ctx.store, ctx.data, loadSetupState(WS)); };
const receiptOf = (id: string) => readBooks().receipts.find((r) => r.id === id) ?? (() => { throw new PayrollRefusal('notFound', `Keinen Beleg ${id}.`); })();

/** The cards: each document of a fund or insurer in Belege not kept or set aside, with what code and the AI read; `ai`: whether a model can read the rest. */
router.get('/api/payroll/setup-cards', async (_req, res, next) => {
  try { res.json({ cards: cardsNow(), ai: await modelReady() }); } catch (e) { next(e); }
});

/**
 * «Von der KI lesen lassen»: the AI reads what code left out, from the document's lines without a salary or a birth date (the
 * social security number masked on the way, src/llm/ask.ts); kept beside the books, never used before the person keeps the card.
 */
router.post('/api/payroll/setup-cards/:receipt/read', async (req, res, next) => {
  try {
    const r = receiptOf(String(req.params.receipt));
    const data = payrollContext(WS).data;
    const text = r.extractedText ?? '';
    const kinds = [...new Set([setupKindOf(text, data), ...readSetupDocument(text, data).map((p) => p.kind)].filter((k): k is string => !!k))];
    if (!kinds.length) throw new PayrollRefusal('badInput', 'Dieser Beleg ist kein Dokument einer Versicherung.');
    const raw = await ask(setupPrompt(text, kinds, data), { step: 'payroll-setup', timeoutMs: 120_000 });
    updateSetupState(WS, (st) => { st[r.id] = { ...st[r.id], ai: parseSetupAnswer(raw, kinds, data) }; });
    res.json({ cards: cardsNow() });
  } catch (e) {
    if (e instanceof PayrollRefusal) return void res.status(STATUS[e.code]).json({ error: e.message, code: 'payroll', params: { why: e.code } } satisfies ApiErrorBody);
    next(e);
  }
});

/** «Nicht verwenden»: the card goes; the document stays in Belege. */
router.post('/api/payroll/setup-cards/:receipt/dismiss', run((req, res) => {
  const r = receiptOf(String(req.params.receipt));
  updateSetupState(WS, (st) => { st[r.id] = { ...st[r.id], dismissed: new Date().toISOString() }; });
  res.json({ cards: cardsNow() });
}));

/** «Übernehmen»: the card's insurances, rates and a person's contributions as the person edited them, each naming the document. */
router.post('/api/payroll/setup-cards/:receipt/keep', run((req, res) => {
  const r = receiptOf(String(req.params.receipt));
  const items = Array.isArray(body(req).items) ? body(req).items as KeptItem[] : [];
  const now = new Date().toISOString();
  const data = payrollContext(WS).data;
  const ids: string[] = [];
  const newId = () => { const id = freshId('in', 3, (x) => ids.includes(x) || payrollContext(WS).store.insurances.some((i) => i.id === x)); ids.push(id); return id; };
  let n = 0;
  // `save` may run the change twice (compared, then saved): the ids are made once, in order.
  const idOf = () => ids[n++] ?? newId();
  save(req, res, { path: 'insurances' }, (s) => { n = 0; return keepSetupCard(s, data, r.id, items, idOf, now); }, (kept) => {
    // A card whose person's part could not be taken stays: the person adds her under Mitarbeitende and keeps it again.
    if (!kept.persons.length) updateSetupState(WS, (st) => { st[r.id] = { ...st[r.id], kept: now }; });
    return { insurances: kept.insurances, persons: kept.persons };
  }, (kept) => kept.warnings);
}));
