/**
 * Löhne (docs/specs/payroll.md §6, §12): the year, the month's Lohnlauf, one payslip with its booking
 * preview; closing (per person and «Alle abschliessen»), reopening the latest month, the Rückwirkende
 * Korrektur, and the Lohnarten added to a month. Every write to the books goes through the write door
 * as the person (updateBooksWithEffects) and refuses a closed period first; payroll.json and the payslip
 * events are not the books and change only through src/payroll/.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { WS, readBooks, updateBooksWithEffects, RequestError } from '../books.js';
import { ClosedPeriodError, periodLock, receiptFile, type Books } from '../../books/store.js';
import { PayrollRefusal, planClose } from '../../payroll/close.js';
import { addCorrection, chartNumbers, closePayslip, payrollContext, reopenPayslip, type BooksWriter } from '../../payroll/service.js';
import { monthView, payslipView, employeeRows, yearStrip } from '../../payroll/views.js';
import { paymentRows } from '../../payroll/payments.js';
import { insurerRows, settlementEntry } from '../../payroll/insurers.js';
import { closedPayslips, issueLohnausweis, lohnausweisSnapshots } from '../../payroll/service.js';
import { csv, declarationRows, journalOf, lohnausweisOf, lohnkonto } from '../../payroll/documents.js';
import { firmWageTypes } from '../../payroll/catalogue.js';
import { nameOf } from '../../payroll/views.js';
import { valueOn } from '../../core/dated.js';
import { join } from 'node:path';
import { idSource, sha256 } from '../../invoices/store.js';
import { loadPayroll, updatePayroll } from '../../payroll/store.js';
import { employs } from '../../workspace/setup.js';
import type { ApiErrorBody } from '../../types/api-error.js';

export const router = Router();

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const today = () => new Date().toISOString().slice(0, 10);
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {});
const write: BooksWriter = <T>(fn: (books: Books) => T): T => updateBooksWithEffects((books) => fn(books) as never) as T;

function idParts(id: string): { month: string; employee: string } {
  const month = id.slice(0, 7);
  const employee = id.slice(8);
  if (!MONTH.test(month) || id[7] !== '-' || !employee) throw new RequestError(400, `${id} ist keine Lohnabrechnung (JJJJ-MM-<Person>).`, { code: 'payroll', params: { why: 'badInput' } });
  return { month, employee };
}

const monthParam = (req: Request): string => {
  const m = String(req.params.month);
  if (!MONTH.test(m)) throw new RequestError(400, `${m} ist kein Monat (JJJJ-MM).`, { code: 'payroll', params: { why: 'badInput' } });
  return m;
};

/** A month whose first day lies in a closed period takes no line and no text: its payslips stay as they are. */
function assertMonthOpen(month: string): void {
  const lock = periodLock(readBooks());
  if (lock.isClosed(`${month}-01`)) throw new ClosedPeriodError(`${lock.closedText(`${month}-01`)} Eine Lohnabrechnung einer geschlossenen Periode bleibt, wie sie ist: korrigiert wird im nächsten offenen Monat (Rückwirkende Korrektur).`, lock.closedThrough, 'payroll');
}

/** An async route's error goes to the API's error handler. */
const run = (fn: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve().then(() => fn(req, res)).catch((e) => {
    if (e instanceof PayrollRefusal) {
      const status = e.code === 'notFound' || e.code === 'unknownInsurance' ? 404 : e.code === 'badAmount' || e.code === 'unknownWageType' || e.code === 'badInput' ? 400 : 409;
      res.status(status).json({ error: e.message, code: 'payroll', params: { why: e.code } } satisfies ApiErrorBody);
    } else next(e);
  });
};

// ─── reading ───────────────────────────────────────────────────────────────────

router.get('/api/payroll', run((req, res) => {
  const ctx = payrollContext(WS);
  const day = today();
  const year = typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year) ? req.query.year : day.slice(0, 4);
  res.json({
    shown: employs(WS.profile) || ctx.store.employees.length > 0,
    year, today: day,
    months: yearStrip(ctx, year, day),
    employees: employeeRows(ctx, day),
    insurances: ctx.store.insurances.map((i) => ({ id: i.id, kind: i.kind, name: i.name })),
    federal: Object.keys(ctx.years ?? {}),
  });
}));

router.get('/api/payroll/months/:month', run((req, res) => {
  res.json(monthView(payrollContext(WS), monthParam(req)));
}));

router.get('/api/payroll/payslips/:id', run((req, res) => {
  const { month, employee } = idParts(String(req.params.id));
  const view = payslipView(payrollContext(WS), employee, month, periodLock(readBooks()));
  if (!view) throw new PayrollRefusal('notFound', `Keine Lohnabrechnung ${req.params.id}.`);
  res.json(view);
}));

/** The PDF of a closed payslip, exactly as it lies in Belege. */
router.get('/payroll/payslips/:file', (req, res, next) => run((rq, rs) => servePdf(rq, rs, next))(req, res, next));
function servePdf(req: Request, res: Response, next: NextFunction): void {
  const m = /^(.+)\.pdf$/.exec(String(req.params.file));
  if (!m) return void next();
  const ctx = payrollContext(WS);
  const close = ctx.history.closed.get(m[1]);
  const books = readBooks();
  const receipt = close && books.receipts.find((r) => r.id === close.receiptId);
  const path = receipt && receiptFile(WS, books, receipt);
  if (!path || !existsSync(path)) throw new PayrollRefusal('notFound', `Kein PDF für ${m[1]}.`);
  res.type('application/pdf').send(readFileSync(path));
}

// ─── closing, reopening, correcting ─────────────────────────────────────────────

router.post('/api/payroll/payslips/:id/close', run(async (req, res) => {
  const { month, employee } = idParts(String(req.params.id));
  res.json(await closePayslip(WS, write, employee, month, { confirm: body(req).confirm === true }));
}));

/** «Alle abschliessen»: every draft of the month; with anything to say first and no confirm, nothing is closed and every warning comes back by person. */
router.post('/api/payroll/months/:month/close', run(async (req, res) => {
  const month = monthParam(req);
  const confirm = body(req).confirm === true;
  const ctx = payrollContext(WS);
  const drafts = monthView(ctx, month).rows.filter((r) => r.status === 'draft');
  if (!confirm) {
    const chart = chartNumbers(WS);
    const warned = drafts.map((r) => ({ id: r.id, name: r.name, warnings: planClose(ctx, r.employee, month, chart).warnings })).filter((w) => w.warnings.length);
    if (warned.length) return void res.json({ closed: [], warned });
  }
  const closed: string[] = [];
  for (const r of drafts) {
    try {
      const out = await closePayslip(WS, write, r.employee, month, { confirm: true });
      if (out.closed) closed.push(out.id);
    } catch (e) {
      // The ones closed so far stand: say which, and why the next one did not close.
      return void res.status(e instanceof ClosedPeriodError ? 403 : 409).json({ closed, warned: [], stopped: { id: r.id, error: (e as Error).message } });
    }
  }
  res.json({ closed, warned: [] });
}));

router.post('/api/payroll/payslips/:id/reopen', run((req, res) => {
  idParts(String(req.params.id));
  res.json(reopenPayslip(WS, write, String(req.params.id)));
}));

router.post('/api/payroll/payslips/:id/corrections', run((req, res) => {
  idParts(String(req.params.id));
  const b = body(req);
  const num = (k: string) => (b[k] === undefined || b[k] === null || b[k] === '' ? undefined : typeof b[k] === 'number' ? b[k] as number : NaN);
  const input = { wageType: String(b.wageType ?? ''), amount: num('amount'), base: num('base'), rateDiff: num('rateDiff'), ...(typeof b.text === 'string' && b.text.trim() ? { text: b.text.trim() } : {}) };
  if ([input.amount, input.base, input.rateDiff].some((x) => x !== undefined && !Number.isFinite(x))) throw new PayrollRefusal('badAmount', 'Zahlen erwartet.');
  res.json(addCorrection(WS, String(req.params.id), input));
}));

// ─── the Lohnarten of a month ────────────────────────────────────────────────

/** A Lohnart added to a month not yet closed: an amount, or a quantity (and a rate); a closed or locked month takes none. */
router.post('/api/payroll/month-lines', run((req, res) => {
  const b = body(req);
  const month = String(b.month ?? '');
  const employee = String(b.employee ?? '');
  if (!MONTH.test(month)) throw new PayrollRefusal('badAmount', 'Ein Monat JJJJ-MM.');
  const ctx = payrollContext(WS);
  if (!ctx.store.employees.some((e) => e.id === employee)) throw new PayrollRefusal('notFound', `Keine Person ${employee}.`);
  if (ctx.history.closed.has(`${month}-${employee}`)) throw new PayrollRefusal('alreadyClosed', 'Der Monat ist abgeschlossen: eine Änderung als Rückwirkende Korrektur erfassen.');
  assertMonthOpen(month);
  const wageType = String(b.wageType ?? '');
  if (!ctx.data.wageTypes.some((w) => w.key === wageType) && !ctx.store.wageTypes.some((w) => w.key === wageType)) throw new PayrollRefusal('unknownWageType', `Lohnart ${wageType} gibt es nicht.`);
  const n = (k: string) => (typeof b[k] === 'number' && Number.isFinite(b[k]) ? b[k] as number : undefined);
  const amount = n('amount'); const quantity = n('quantity'); const rate = n('rate');
  if (amount === undefined && quantity === undefined) throw new PayrollRefusal('badAmount', 'Ein Betrag oder eine Menge.');
  const line = {
    id: `ml_${idSource.bytes(6).toString('hex')}`, employee, month, wageType,
    ...(amount !== undefined ? { amount } : {}), ...(quantity !== undefined ? { quantity } : {}), ...(rate !== undefined ? { rate } : {}),
    ...(typeof b.text === 'string' && b.text.trim() ? { text: b.text.trim() } : {}), enteredAt: new Date().toISOString(),
  };
  updatePayroll(WS, (s) => { s.monthLines.push(line); });
  res.json(line);
}));

router.delete('/api/payroll/month-lines/:id', run((req, res) => {
  const store = loadPayroll(WS);
  const line = store.monthLines.find((l) => l.id === req.params.id && !l.removed);
  if (!line) throw new PayrollRefusal('notFound', 'Diese Zeile gibt es nicht.');
  if (payrollContext(WS).history.closed.has(`${line.month}-${line.employee}`)) throw new PayrollRefusal('alreadyClosed', 'Der Monat ist abgeschlossen.');
  assertMonthOpen(line.month);
  updatePayroll(WS, (s) => { const l = s.monthLines.find((x) => x.id === line.id); if (l) l.removed = true; });
  res.json({ removed: line.id });
}));

/** A text for every payslip of a month («Frohe Festtage»); empty removes it. */
router.put('/api/payroll/months/:month/text', run((req, res) => {
  const month = monthParam(req);
  assertMonthOpen(month);
  const text = typeof body(req).text === 'string' ? (body(req).text as string).trim() : '';
  updatePayroll(WS, (s) => {
    const texts = { ...(s.monthTexts ?? {}) };
    if (text) texts[month] = text; else delete texts[month];
    s.monthTexts = texts;
  });
  res.json({ month, text });
}));

// ─── Lohnzahlungen and the insurers ────────────────────────────────────────────

/** The month's Lohnzahlungen: person, IBAN, payout, purpose, value date, and the bank line that paid it. */
router.get('/api/payroll/payments/:month', run((req, res) => {
  const month = monthParam(req);
  res.json({ month, rows: paymentRows(readBooks(), closedPayslips(WS), month) });
}));

/** Per insurance: what the payslips accrued, what was paid, what is open, from the books. */
router.get('/api/payroll/insurances', run((req, res) => {
  const year = typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year) ? req.query.year : today().slice(0, 4);
  const ctx = payrollContext(WS);
  res.json({ year, rows: insurerRows(readBooks(), ctx.data, ctx.store, year) });
}));

/**
 * A final statement (Schlussabrechnung): the year's total the statement shows; code books its difference to
 * what the payslips accrued on the employer's contribution account against the insurance's liability, on `date`
 * (the statement's day, in an open period).
 */
router.post('/api/payroll/insurances/:id/settle', run((req, res) => {
  const b = body(req);
  const year = String(b.year ?? '');
  const date = String(b.date ?? '');
  const total = typeof b.total === 'number' && Number.isFinite(b.total) ? b.total : NaN;
  if (!/^\d{4}$/.test(year) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(total)) throw new PayrollRefusal('badInput', 'Jahr, Datum und Total der Schlussabrechnung.');
  const ctx = payrollContext(WS);
  const out = updateBooksWithEffects((books) => {
    const lock = periodLock(books);
    if (lock.isClosed(date)) throw new ClosedPeriodError(`${lock.closedText(date)} Neue Buchungen müssen in der offenen Periode liegen.`, lock.closedThrough, 'newEntry');
    const entry = settlementEntry(books, ctx.data, ctx.store, String(req.params.id), year, total, date, () => idSource.bytes(8).toString('hex'));
    if (entry) books.journalEntries.push(entry);
    return entry ? { booked: entry.id, amount: entry.amount, debit: entry.accountDebit, credit: entry.accountCredit } : { booked: null };
  });
  res.json(out);
}));

// ─── Dokumente ─────────────────────────────────────────────────────────────────

const yearParam = (req: Request): string => {
  const y = String(req.params.year);
  if (!/^\d{4}$/.test(y)) throw new PayrollRefusal('badInput', `${y} ist kein Jahr.`);
  return y;
};

/** The year's documents: per person the Lohnausweis figures (and whether a month is still open), the issued statements, the declarations' figures. */
router.get('/api/payroll/documents/:year', run((req, res) => {
  const year = yearParam(req);
  const ctx = payrollContext(WS);
  const types = firmWageTypes(ctx.data, ctx.store);
  const closes = [...ctx.history.closed.values()];
  const canton = valueOn(ctx.store.company.canton, `${year}-12-31`);
  res.json({
    year,
    people: ctx.store.employees.map((e) => ({ employee: e.id, name: nameOf(e, `${year}-12-31`), lohnausweis: lohnausweisOf(e, closes, types, ctx.data, year, e.language) }))
      .filter((p) => Object.keys(p.lohnausweis.fields).length || p.lohnausweis.openMonths.length),
    issued: lohnausweisSnapshots(WS, year).map(({ data: _, ...s }) => s),
    declarations: declarationRows(ctx.store.employees, closes, year),
    lohnkonto: lohnkonto(closes, types, year),
    copyToTaxOffice: !!canton && (ctx.data.lohnausweis?.copyToTaxOffice ?? []).includes(canton),
  });
}));

/** Issues a person's Lohnausweis (a later one replaces or corrects the first; both stay). */
router.post('/api/payroll/documents/:year/lohnausweis', run(async (req, res) => {
  const year = yearParam(req);
  const b = body(req);
  const kind = b.kind === 'replacement' || b.kind === 'correction' ? b.kind : 'original';
  const { data: _, ...snap } = await issueLohnausweis(WS, String(b.employee ?? ''), year, kind);
  res.json(snap);
}));

/** An issued Lohnausweis's PDF, checked against its checksum. */
router.get('/payroll/documents/:year/lohnausweis/:file', run((req, res) => {
  const m = /^(la_[A-Za-z0-9_-]+)\.pdf$/.exec(String(req.params.file));
  const snap = m && lohnausweisSnapshots(WS, yearParam(req)).find((s) => s.id === m[1]);
  if (!snap) throw new PayrollRefusal('notFound', 'Kein solcher Lohnausweis.');
  const bytes = readFileSync(join(WS.paths.root, snap.file));
  if (sha256(bytes) !== snap.sha256) throw new RequestError(409, `${snap.file}: die Datei passt nicht mehr zu ihrer Prüfsumme.`);
  res.type('application/pdf').send(bytes);
}));

const sendCsv = (res: Response, name: string, text: string) => res.type('text/csv; charset=utf-8').attachment(name).send(`﻿${text}`);

/** The Lohnausweis figures of every person as a table (the fallback for the free federal tool and the fiduciary). */
router.get('/payroll/documents/:year/lohnausweis.csv', run((req, res) => {
  const year = yearParam(req);
  const ctx = payrollContext(WS);
  const types = firmWageTypes(ctx.data, ctx.store);
  const closes = [...ctx.history.closed.values()];
  const fields = (ctx.data.lohnausweis?.fields ?? []).filter((f) => !f.remark).map((f) => f.key);
  const rows = ctx.store.employees.map((e) => {
    const l = lohnausweisOf(e, closes, types, ctx.data, year, e.language);
    return [e.id, nameOf(e, `${year}-12-31`), e.socialSecurityNumber, year, l.from, l.to, ...fields.map((k) => l.fields[k] ?? 0), l.remarks.map((r) => `${r.label} ${r.amount.toFixed(2)}`).join(', ')];
  });
  sendCsv(res, `lohnausweis-${year}.csv`, csv([['id', 'name', 'ssn', 'year', 'from', 'to', ...fields, '15'], ...rows]));
}));

/** The Lohnkonto: every Lohnart per month, of one person (?employee=) or the firm. */
router.get('/payroll/documents/:year/lohnkonto.csv', run((req, res) => {
  const year = yearParam(req);
  const ctx = payrollContext(WS);
  const who = typeof req.query.employee === 'string' ? req.query.employee : undefined;
  const closes = [...ctx.history.closed.values()].filter((c) => !who || c.employee === who);
  const k = lohnkonto(closes, firmWageTypes(ctx.data, ctx.store), year);
  const head = ['wageType', 'label', ...Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')), 'total'];
  const totals = (['gross', 'net', 'payout', 'employer'] as const).map((t) => [t, ctx.data.totals[t].de, ...k.totals[t].months, k.totals[t].total]);
  sendCsv(res, `lohnkonto-${year}${who ? `-${who}` : ''}.csv`, csv([head, ...k.rows.map((r) => [r.wageType, r.label, ...r.months, r.total]), ...totals]));
}));

/** The declarations' figures: per person each base of the year (AHV, ALV to the ceiling, UVG, …), for the funds' portals. */
router.get('/payroll/documents/:year/declarations.csv', run((req, res) => {
  const year = yearParam(req);
  const ctx = payrollContext(WS);
  const rows = declarationRows(ctx.store.employees, [...ctx.history.closed.values()], year);
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.bases)))].sort();
  sendCsv(res, `meldungen-${year}.csv`, csv([['id', 'name', 'ssn', 'from', 'to', ...keys], ...rows.map((r) => [r.employee, r.name, ctx.store.employees.find((e) => e.id === r.employee)?.socialSecurityNumber, r.from, r.to, ...keys.map((k) => r.bases[k] ?? 0)])]));
}));

/** The month's Lohnbuchungen as a table, for a fiduciary who keeps the ledger elsewhere. */
router.get('/payroll/documents/journal/:month', run((req, res) => {
  const m = /^(\d{4}-\d{2})\.csv$/.exec(String(req.params.month));
  if (!m) throw new PayrollRefusal('badInput', 'JJJJ-MM.csv');
  const entries = journalOf(readBooks().journalEntries, m[1]);
  sendCsv(res, `lohnbuchungen-${m[1]}.csv`, csv([['date', 'ref', 'debit', 'credit', 'amount', 'text'], ...entries.map((e) => [e.date, e.transactionRef, e.accountDebit, e.accountCredit, e.amount, e.description])]));
}));
