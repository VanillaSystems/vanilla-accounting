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
import { baseCurrency, payrollClearing } from '../../engines/index.js';
import { ClosedPeriodError, periodLock, receiptFile, type Books } from '../../books/store.js';
import { CatalogueError } from '../../payroll/catalogue.js';
import { PayrollRefusal, assertNotOpening, planClose } from '../../payroll/close.js';
import { addCorrection, chartNumbers, closePayslip, payrollContext, reopenPayslip, type BooksWriter } from '../../payroll/service.js';
import { decemberOpen, monthView, payslipView, employeeRows, yearStrip } from '../../payroll/views.js';
import { paymentRows } from '../../payroll/payments.js';
import { bookInsurerPayments, insurancesOfPayment, insurerRows, settlementOf } from '../../payroll/insurers.js';
import { payrollInsurerContext } from '../../payroll/insurers-context.js';
import { forgetPayrollWay, keptText, keptWayOf, wayTarget, writeKept } from '../../payroll/insurer-way.js';
import { collectsOffer, forgetCollects, keptCollects, keptCollectsOf, keptCollectsText, namedKinds, writeCollects } from '../../payroll/collects-way.js';
import { collectorsOf } from '../../booking/withheld.js';
import { loadKnowledge } from '../../knowledge/layers.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { loadFxResolver } from '../../accounting/fx-rates.js';
import { bankAccountFor } from '../../workspace/money-accounts.js';
import { loadClassifyContext, mappedReceipts, payrollInsurerOfPayment, ruleOfPayment } from '../../booking/classify.js';
import { paymentFileOf, paymentFilePlan } from '../../payroll/payment-file.js';
import { businessOfPayment } from '../../intake/batch-payers.js';
import { closedPayslips, keepPaymentFile, paymentFilePath, paymentFilesMade, issueLohnausweis, lohnausweisSnapshots, payslipMail, payslipsSent, sendPayslip, setMailPassword } from '../../payroll/service.js';
import { sendMail } from '../../invoices/mail.js';
import { csv, declarationRows, familyAllowanceStatement, journalOf, lohnausweisOf, lohnkonto, pensionWages } from '../../payroll/documents.js';
import { firmWageTypes } from '../../payroll/catalogue.js';
import { nameOf } from '../../payroll/views.js';
import { entriesWithin, valueOn } from '../../core/dated.js';
import type { PayrollEmployee, PayslipClose } from '../../payroll/model.js';
import { join } from 'node:path';
import { idSource, sha256 } from '../../invoices/store.js';
import { loadPayroll, updatePayroll } from '../../payroll/store.js';
import { driftOf } from '../../payroll/settings.js';
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
    // A layer of Lohnarten that names one no more there (a copy of a removed copy) refuses, never fails the page.
    if (e instanceof CatalogueError) e = new PayrollRefusal('used', e.message);
    if (e instanceof PayrollRefusal) {
      const status = e.code === 'notFound' || e.code === 'unknownInsurance' || e.code === 'gone' ? 404 : e.code === 'badAmount' || e.code === 'unknownWageType' || e.code === 'badInput' || e.code === 'badPassword' ? 400 : 409;
      res.status(status).json({ error: e.message, code: 'payroll', params: { why: e.code, ...(e.field ? { field: e.field } : {}) } } satisfies ApiErrorBody);
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
  const ctx = payrollContext(WS);
  const view = payslipView(ctx, employee, month, periodLock(readBooks()));
  // A month of her opening has no payslip here: said why, never «not found».
  if (!view) assertNotOpening(ctx, employee, month);
  if (!view) throw new PayrollRefusal('notFound', `Keine Lohnabrechnung ${req.params.id}.`);
  // A closed payslip the values of today compute otherwise says so, as a fact (§19.3 «So lassen»).
  const close = ctx.history.closed.get(view.id);
  // The Lohnarten added to an open month, with their ids: the draft's «entfernen».
  const monthLines = close ? [] : ctx.store.monthLines.filter((l) => l.employee === employee && l.month === month && !l.removed);
  // A payslip paid before it was reopened and closed again with another payout: the difference on 1091, as a fact.
  const paidRow = close ? paymentRows(readBooks(), [...ctx.history.closed.values()], close.month, payrollClearing() ?? '1091').find((r) => r.id === close.id) : undefined;
  res.json({ ...view, drift: close ? driftOf(ctx, close) : [], monthLines, ...(paidRow?.difference && paidRow.paid?.forThis !== undefined ? { paidDifference: { difference: paidRow.difference, paid: paidRow.paid.forThis, account: paidRow.account!, ref: paidRow.paid.ref, date: paidRow.paid.date } } : {}) });
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
  assertNotOpening(ctx, employee, month);
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
  const rows = paymentRows(readBooks(), closedPayslips(WS), month, payrollClearing() ?? '1091');
  res.json({ month, rows, file: paymentFilePlan(rows, WS.bankAccounts, baseCurrency(), today(), paymentFilesMade(WS, month.slice(0, 4))) });
}));

/**
 * «Zahlungsdatei erstellen»: the month's payouts not paid yet, debiting the firm's `account`, kept with its record.
 * A file made before for one of these payslips is said first (uploaded twice, it pays twice); `confirm` makes another.
 */
router.post('/api/payroll/payments/:month/payment-file', run((req, res) => {
  const month = monthParam(req);
  const b = body(req);
  const closes = closedPayslips(WS);
  const rows = paymentRows(readBooks(), closes, month, payrollClearing() ?? '1091');
  const plan = paymentFilePlan(rows, WS.bankAccounts, baseCurrency(), today(), paymentFilesMade(WS, month.slice(0, 4)));
  if (!plan.accounts.length) throw new PayrollRefusal('badInput', 'Kein Bankkonto der Firma mit IBAN in der Buchwährung: unter Firma › Konten eine IBAN eintragen.', 'noAccount');
  if (!plan.included.length) throw new PayrollRefusal('notFound', 'Keine offene Lohnzahlung mit IBAN in diesem Monat.');
  const ids = new Set(plan.included.map((p) => p.id));
  const earlier = plan.made.filter((m) => m.payslips.some((p) => ids.has(p)));
  if (earlier.length && b.confirm !== true) return void res.json({ made: false, earlier });
  const account = typeof b.account === 'string' && plan.accounts.some((a) => a.account === b.account) ? b.account : plan.accounts[0].account;
  const now = new Date().toISOString();
  const xml = paymentFileOf(plan, rows, closes, { name: WS.company.name, ...(WS.company.address ? { address: WS.company.address } : {}) }, account, baseCurrency(), now);
  const id = /<MsgId>([^<]+)<\/MsgId>/.exec(xml)![1];
  const record = { id, month, at: now, account, payslips: [...ids], total: Math.round(plan.included.reduce((s, p) => s + p.amount * 100, 0)) / 100 };
  keepPaymentFile(WS, record, xml);
  res.json({ made: true, record, url: `/payroll/payments/${month}/payment-files/${id}.xml` });
}));

/** A payment file as it was made, its bytes unchanged. */
router.get('/payroll/payments/:month/payment-files/:file', run((req, res) => {
  const month = monthParam(req);
  const m = /^([A-Za-z0-9-]+)\.xml$/.exec(String(req.params.file));
  const record = m && paymentFilesMade(WS, month.slice(0, 4)).find((r) => r.id === m[1] && r.month === month);
  const path = record && paymentFilePath(WS, month.slice(0, 4), record.id);
  if (!record || !path || !existsSync(path)) throw new PayrollRefusal('notFound', 'Keine solche Zahlungsdatei.');
  res.set('Cache-Control', 'no-store').type('application/xml; charset=utf-8').attachment(`lohnzahlungen-${month}-${record.id}.xml`).send(readFileSync(path));
}));

/** Per insurance: what the payslips accrued, what was paid, what is open, from the books. */
router.get('/api/payroll/insurances', run((req, res) => {
  const year = typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year) ? req.query.year : today().slice(0, 4);
  const ctx = payrollContext(WS);
  const counterparties = loadKnowledge(APP_ROOT, WS.paths.root).counterparties;
  // Each insurance's kept way («Immer so», §22 decision 59), with the file that keeps it: undone from here too.
  res.json({ year, rows: insurerRows(readBooks(), ctx.data, ctx.store, year).map((r) => {
    const ins = ctx.store.insurances.find((i) => i.id === r.id)!;
    const kept = keptWayOf(ins, counterparties);
    // What the fund's company file collects («Zieht Lohnabzüge ein», §22 decision 110): undone from here too.
    const collects = keptCollectsOf(WS, ins, counterparties);
    return { ...r, ...(kept ? { kept } : {}), ...(collects ? { collects } : {}) };
  }) });
}));

/**
 * What a final statement of `year` is compared with, before a total is typed (§22 decision 58): the year's
 * contributions in the books, so the page says the difference and its direction as the total is typed, and the
 * people whose December is not closed yet. `compare: null` with the reason when the year has nothing to compare.
 */
router.get('/api/payroll/insurances/:id/compare', run((req, res) => {
  const year = typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year) ? req.query.year : today().slice(0, 4);
  const ctx = payrollContext(WS);
  const counterparties = loadClassifyContext(WS).counterparties ?? [];
  const books = readBooks();
  try {
    const { compare } = settlementOf(books, ctx.data, ctx.store, String(req.params.id), year, 0, `${year}-12-31`, () => '',
      (tx) => businessOfPayment(tx, mappedReceipts(books, tx), counterparties), baseCurrency());
    res.json({ year, compare, decemberOpen: decemberOpen(ctx, year) });
  } catch (e) {
    if (!(e instanceof PayrollRefusal) || e.code === 'unknownInsurance') throw e;
    res.json({ year, compare: null, why: e.code, decemberOpen: decemberOpen(ctx, year) });
  }
}));

/**
 * A final statement (Schlussabrechnung): the year's total the statement shows; code books its difference to the
 * year's contributions in the books (what the payslips accrued, and the payments booked for the months before payroll
 * ran here) on the employer's contribution account against the insurance's liability, on `date` (the statement's day,
 * in an open period). A difference over 5 % of the year, or a December of the year a person's payslip is still a
 * draft of, is said first and booked only with `confirm` («Trotzdem buchen», §18); every answer carries the comparison.
 */
router.post('/api/payroll/insurances/:id/settle', run((req, res) => {
  const b = body(req);
  const year = String(b.year ?? '');
  const date = String(b.date ?? '');
  const total = typeof b.total === 'number' && Number.isFinite(b.total) ? b.total : NaN;
  if (!/^\d{4}$/.test(year) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(total)) throw new PayrollRefusal('badInput', 'Jahr, Datum und Total der Schlussabrechnung.');
  const ctx = payrollContext(WS);
  const counterparties = loadClassifyContext(WS).counterparties ?? [];
  const december = decemberOpen(ctx, year);
  const out = updateBooksWithEffects((books) => {
    const lock = periodLock(books);
    if (lock.isClosed(date)) throw new ClosedPeriodError(`${lock.closedText(date)} Neue Buchungen müssen in der offenen Periode liegen.`, lock.closedThrough, 'newEntry');
    const { entry, compare } = settlementOf(books, ctx.data, ctx.store, String(req.params.id), year, total, date, () => idSource.bytes(8).toString('hex'),
      (tx) => businessOfPayment(tx, mappedReceipts(books, tx), counterparties), baseCurrency());
    // A large difference, or a December not closed yet, is said before it is booked: the person decides (§18).
    if (entry && (compare.large || december.length) && b.confirm !== true) return { booked: null, warning: true, compare, ...(december.length ? { decemberOpen: december } : {}) };
    if (entry) books.journalEntries.push(entry);
    return entry ? { booked: entry.id, amount: entry.amount, debit: entry.accountDebit, credit: entry.accountCredit, compare } : { booked: null, compare };
  });
  res.json(out);
}));

// ─── the insurers' payments: which need no receipt, «Immer so» (§22 decisions 45, 126) ──────

/**
 * The open payments whose proof is not a receipt of their own, never «kein Beleg»: to one of the firm's payroll insurers
 * while payroll runs here (the payslips prove them), or to a business whose file says it collects wage deductions
 * (`collects`, §22 decision 110: the payslips prove what it clears, as src/booking/receipt-wait.ts receiptFree says).
 * Read with every load of the books: the payments are routed only when some business collects, each open payment out once.
 */
router.get('/api/payroll/insurer-payments', run((_req, res) => {
  // The knowledge and payroll.json only, not the classifier's whole context.
  const counterparties = loadKnowledge(APP_ROOT, WS.paths.root).counterparties;
  const insurerOf = payrollInsurerContext(WS, counterparties).payrollInsurer;
  const collectors = new Set(counterparties.filter((c) => c.collects?.length).map((c) => c.id));
  if (!insurerOf && !collectors.size) return void res.json({ refs: [] });
  const books = readBooks();
  const lock = periodLock(books);
  const currency = baseCurrency();
  const open = books.transactions.filter((tx) => tx.direction === 'DBIT' && !lock.isClosed(tx.date));
  const toCollector = new Set(collectors.size ? open.filter((tx) => collectors.has(businessOfPayment(tx, mappedReceipts(books, tx), counterparties) ?? '')).map((tx) => tx.ref) : []);
  const context = { payrollInsurer: insurerOf, counterparties };
  res.json({ refs: open.filter((tx) => toCollector.has(tx.ref) || (!!insurerOf && tx.currency === currency && !!payrollInsurerOfPayment(books, tx, context))).map((tx) => tx.ref) });
}));

/**
 * What «Immer so» on payment `ref` does (§22 decision 59): the insurance it pays, the file that keeps the way, and the open
 * payments to that insurance the liability way books at once (a company rule's left alone), so the form names them first.
 */
function insurerWayPlan(ref: string) {
  const context = loadClassifyContext(WS);
  const books = readBooks();
  const tx = books.transactions.find((t) => t.ref === ref);
  const lock = periodLock(books);
  if (tx && lock.isClosed(tx.date)) throw new ClosedPeriodError(`${lock.closedText(tx.date)} Eine Zahlung einer geschlossenen Periode bleibt, wie sie gebucht ist.`, lock.closedThrough, 'newEntry');
  const pay = tx && payrollInsurerOfPayment(books, tx, context);
  if (!tx || !pay) throw new PayrollRefusal('notFound', `Keine Zahlung an eine Sozialversicherung: ${ref}.`);
  const ctx = payrollContext(WS);
  const ins = ctx.store.insurances.find((i) => i.id === pay.id)!;
  const counterparties = context.counterparties ?? [];
  const routed = businessOfPayment(tx, mappedReceipts(books, tx), counterparties);
  const target = wayTarget(ins, routed, counterparties, ctx.data.insurances[ins.kind]?.role ?? 'supplier');
  const fx = loadFxResolver();
  /** Books (or, on a copy, previews) this insurance's open payments the liability way takes; never one a company rule decides. */
  const book = (index: Books) => bookInsurerPayments(index, ctx.data, ctx.store, periodLock(index),
    (t) => businessOfPayment(t, mappedReceipts(index, t), counterparties), (t) => { try { return bankAccountFor(t, WS.bankAccounts); } catch { return undefined; } },
    () => idSource.bytes(8).toString('hex'),
    { currency: baseCurrency(), ruled: (t) => !!ruleOfPayment(index, t, context, fx), keep: true,
      only: (t) => insurancesOfPayment(t, ctx.store, (x) => businessOfPayment(x, mappedReceipts(index, x), counterparties)).some((i) => i.id === ins.id) });
  const preview = structuredClone(books);
  const refs = book(preview);
  const payments = refs.map((r) => books.transactions.find((t) => t.ref === r)!).map((t) => ({ ref: t.ref, date: t.date, amount: Math.abs(t.amount), currency: t.currency }));
  return { tx, ins, target, book, payments };
}

/** «Immer so», before the click: the file it keeps the way in and the payments it books at once. */
router.get('/api/payroll/insurer-way', run((req, res) => {
  const { ins, target, payments } = insurerWayPlan(String(req.query.ref ?? ''));
  res.json({ name: ins.name, business: target.id, path: target.path, created: target.created, payments });
}));

/**
 * «Immer so» on the hand form of a payment to a payroll insurer: «für Monate ab dem Lohnstart» (`way: after`) kept in the
 * company's file of the fund; code books at once every open payment to that insurance the liability does not cover yet
 * (the ones the GET named), never one a company rule decides. «Davor» is chosen per payment and is never kept. The file
 * is written only once the books took the bookings.
 */
router.post('/api/payroll/insurer-way', run((req, res) => {
  const b = body(req);
  if (b.way !== 'after') throw new PayrollRefusal('badInput', 'Gemerkt wird nur «für Monate ab dem Lohnstart»: «für Monate davor» wird bei jeder Zahlung gewählt.');
  const { tx, ins, target, book } = insurerWayPlan(String(b.ref ?? ''));
  const text = keptText(WS, target, 'liability', tx, today());
  const booked = updateBooksWithEffects((index) => book(index));
  const path = writeKept(WS, target, text);
  res.json({ business: target.id, name: ins.name, path, created: target.created, booked });
}));

/** «Rückgängig» (`?business=`): the kept way leaves the company's file of the business; what it booked stays booked. */
router.delete('/api/payroll/insurer-way', run((req, res) => {
  const id = String(req.query.business ?? '');
  const cp = loadKnowledge(APP_ROOT, WS.paths.root).counterparties.find((c) => c.id === id);
  const path = cp && forgetPayrollWay(WS, cp);
  if (!path) throw new PayrollRefusal('gone', `${id} hält keinen Weg für Zahlungen.`);
  res.json({ business: id, path });
}));

// ─── «Zieht Lohnabzüge ein» (§22 decision 110) ─────────────────────────────────

/**
 * What «Zieht Lohnabzüge ein» offers on payment `ref`, and what its business's company file collects already (with the
 * kinds the payment names, which its «Rückgängig» takes back): none for a payroll insurer's payment, which stays payroll's
 * (decision 68). The knowledge and payroll.json only, not the classifier's whole context: the page asks on every selection.
 */
function collectsPlan(ref: string) {
  const counterparties = loadKnowledge(APP_ROOT, WS.paths.root).counterparties;
  const books = readBooks();
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx) throw new PayrollRefusal('notFound', `Keine Zahlung ${ref}.`);
  const insurerOf = payrollInsurerContext(WS, counterparties).payrollInsurer;
  if (insurerOf && payrollInsurerOfPayment(books, tx, { payrollInsurer: insurerOf, counterparties })) return { tx, offer: undefined, kept: undefined };
  const linked = mappedReceipts(books, tx);
  const business = businessOfPayment(tx, linked, counterparties);
  const cp = counterparties.find((c) => c.id === business);
  const kept = cp && keptCollects(WS, cp);
  const named = new Set(namedKinds(tx, linked));
  const offer = collectsOffer({ books, tx, linked, business, collectors: collectorsOf(counterparties), counterparties });
  // `created`: the company has no file of it yet (a business of the app's own gets a binding, made by the click as a new file is).
  if (offer) offer.target.created ||= !existsSync(join(WS.paths.root, offer.target.path));
  return { tx, offer, kept: kept && { ...kept, named: kept.kinds.filter((k) => named.has(k)) } };
}

/** The offer on a payment (`offer: null` when there is none), and `kept`: what its business's company file collects, with the file, to undo. */
router.get('/api/payroll/collects', run((req, res) => {
  const { offer, kept } = collectsPlan(String(req.query.ref ?? ''));
  res.json({ offer: offer ? { business: offer.target.id, name: offer.target.name, path: offer.target.path, created: offer.target.created, kinds: offer.kinds, collects: offer.collects } : null, kept: kept ?? null });
}));

/**
 * «Zieht Lohnabzüge ein: BVG»: `kinds` (of the offer, never others) join the business file's `collects:`; the rest of the
 * file stays as it was. The books are not written: the payment's hand form proposes the split from now on, and a payment
 * booked whole is named under «Arbeitnehmeranteil abziehen».
 */
router.post('/api/payroll/collects', run((req, res) => {
  const b = body(req);
  const { tx, offer } = collectsPlan(String(b.ref ?? ''));
  const kinds = Array.isArray(b.kinds) ? b.kinds.filter((k): k is string => typeof k === 'string') : [];
  if (!offer || !kinds.length || kinds.some((k) => !offer.kinds.includes(k))) throw new PayrollRefusal('badInput', 'Diese Zahlung bietet das nicht an: nur die Lohnabzüge, die sie nennt und die noch niemand einzieht.');
  const { text, before } = keptCollectsText(WS, offer.target, kinds, tx);
  const path = writeCollects(WS, offer.target.path, text);
  res.json({ business: offer.target.id, name: offer.target.name, path, created: before === undefined && offer.target.created, kinds });
}));

/**
 * «Rückgängig» (`?business=&kinds=pension,tax`, no kinds: all): from the company's file alone, after a restart too, the
 * kinds leave its `collects:`; a file the click made goes once it holds nothing else. What was booked stays booked.
 */
router.delete('/api/payroll/collects', run((req, res) => {
  const id = String(req.query.business ?? '');
  const kinds = typeof req.query.kinds === 'string' && req.query.kinds ? req.query.kinds.split(',') : undefined;
  const cp = loadKnowledge(APP_ROOT, WS.paths.root).counterparties.find((c) => c.id === id);
  const path = cp && forgetCollects(WS, cp, kinds);
  if (!path) throw new PayrollRefusal('gone', `${id} zieht keine solchen Lohnabzüge ein.`);
  res.json({ business: id, path });
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
    people: ctx.store.employees.filter((e) => inYear(e, closes, year)).map((e) => ({ employee: e.id, name: nameOf(e, `${year}-12-31`), lohnausweis: lohnausweisOf(e, closes, types, ctx.data, year, e.language, pendingMonths(ctx.store, e.id)) })),
    issued: lohnausweisSnapshots(WS, year).map(({ data: _, ...s }) => s),
    declarations: declarationRows(ctx.store.employees, closes, year, { data: ctx.data, years: ctx.years }),
    lohnkonto: lohnkonto(closes, types, year, 'de', ctx.store.employees),
    family: familyStatement(ctx, closes, year),
    pension: pensionWages(ctx.store.employees, closes, ctx.data, ctx.years, year),
    copyToTaxOffice: !!canton && (ctx.data.lohnausweis?.copyToTaxOffice ?? []).includes(canton),
  });
}));

/** The family allowances against the fund, and the fund's liability account as the books hold it for the year. */
function familyStatement(ctx: ReturnType<typeof payrollContext>, closes: readonly PayslipClose[], year: string) {
  const statement = familyAllowanceStatement(ctx.store.employees, closes, firmWageTypes(ctx.data, ctx.store), ctx.data, year);
  const account = statement.kind ? insurerRows(readBooks(), ctx.data, ctx.store, year).find((r) => r.kind === statement.kind) : undefined;
  return { ...statement, ...(account ? { account } : {}) };
}

/** Issues a person's Lohnausweis (a later one replaces or corrects the first; both stay). */
router.post('/api/payroll/documents/:year/lohnausweis', run(async (req, res) => {
  const year = yearParam(req);
  const b = body(req);
  const kind = b.kind === 'replacement' || b.kind === 'correction' ? b.kind : 'original';
  const out = await issueLohnausweis(WS, String(b.employee ?? ''), year, kind, new Date().toISOString(), b.confirm === true);
  if ('issued' in out) return void res.json(out);
  const { data: _, ...snap } = out;
  res.json(snap);
}));

/** An issued Lohnausweis's PDF, checked against its checksum. */
router.get('/payroll/documents/:year/lohnausweis/:file', run((req, res) => {
  const m = /^(la_[A-Za-z0-9_-]+)\.pdf$/.exec(String(req.params.file));
  const snap = m && lohnausweisSnapshots(WS, yearParam(req)).find((s) => s.id === m[1]);
  const path = snap && join(WS.paths.root, snap.file);
  if (!snap || !path || !existsSync(path)) throw new PayrollRefusal('notFound', 'Kein solcher Lohnausweis.');
  const bytes = readFileSync(path);
  if (sha256(bytes) !== snap.sha256) throw new PayrollRefusal('notFound', `${snap.file}: die Datei passt nicht mehr zu ihrer Prüfsumme.`);
  res.type('application/pdf').send(bytes);
}));

/** The months with Lohnarten added for the person and not closed (a «Nachzahlung» draft). */
const pendingMonths = (store: { monthLines: ReadonlyArray<{ employee: string; month: string; removed?: boolean }> }, employee: string): string[] =>
  [...new Set(store.monthLines.filter((l) => l.employee === employee && !l.removed).map((l) => l.month))];

/** A person the year's documents are for: employed in it, or with a closed payslip of it (a payment after the exit). */
const inYear = (e: PayrollEmployee, closes: readonly PayslipClose[], year: string) =>
  closes.some((c) => c.employee === e.id && c.month.startsWith(year)) || entriesWithin(e.employment, `${year}-01-01`, `${year}-12-31`).some((s) => s.entry);

/** A table as a download; one that carries the social security number in full is never kept by a cache. */
const sendCsv = (res: Response, name: string, text: string, secret = false) => {
  if (secret) res.set('Cache-Control', 'no-store');
  return res.type('text/csv; charset=utf-8').attachment(name).send(`﻿${text}`);
};

/** The Lohnausweis figures of every person as a table (the fallback for the free federal tool and the fiduciary). */
router.get('/payroll/documents/:year/lohnausweis.csv', run((req, res) => {
  const year = yearParam(req);
  const ctx = payrollContext(WS);
  const types = firmWageTypes(ctx.data, ctx.store);
  const closes = [...ctx.history.closed.values()];
  const fields = (ctx.data.lohnausweis?.fields ?? []).filter((f) => !f.remark).map((f) => f.key);
  const rows = ctx.store.employees.filter((e) => inYear(e, closes, year)).map((e) => {
    const l = lohnausweisOf(e, closes, types, ctx.data, year, e.language, pendingMonths(ctx.store, e.id));
    return [e.id, nameOf(e, `${year}-12-31`), e.socialSecurityNumber, year, l.from, l.to, ...fields.map((k) => l.fields[k] ?? 0), l.remarks.map((r) => `${r.label} ${r.amount.toFixed(2)}`).join(', ')];
  });
  sendCsv(res, `lohnausweis-${year}.csv`, csv([['id', 'name', 'ssn', 'year', 'from', 'to', ...fields, '15'], ...rows]), true);
}));

/** The Lohnkonto: every Lohnart per month, of one person (?employee=) or the firm. */
router.get('/payroll/documents/:year/lohnkonto.csv', run((req, res) => {
  const year = yearParam(req);
  const ctx = payrollContext(WS);
  const who = typeof req.query.employee === 'string' ? req.query.employee : undefined;
  const closes = [...ctx.history.closed.values()].filter((c) => !who || c.employee === who);
  const k = lohnkonto(closes, firmWageTypes(ctx.data, ctx.store), year, 'de', ctx.store.employees.filter((e) => !who || e.id === who));
  const head = ['wageType', 'label', ...Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')), 'total'];
  const totals = (['gross', 'net', 'payout', 'employer'] as const).map((t) => [t, ctx.data.totals[t].de, ...k.totals[t].months, k.totals[t].total]);
  // The opening's bases (the months paid before payroll ran here), each in the total column only: no month of it has a payslip here.
  const through = k.opening?.people.flatMap((p) => p.through ?? []).sort().at(-1) ?? '—';
  const opening = Object.entries(k.opening?.bases ?? {}).map(([b, v]) => [`opening:${b}`, `Eröffnung bis ${through}: ${ctx.data.bases.find((x) => x.key === b)?.label.de ?? b}`, ...Array(12).fill(undefined), v]);
  sendCsv(res, `lohnkonto-${year}${who ? `-${who}` : ''}.csv`, csv([head, ...k.rows.map((r) => [r.wageType, r.label, ...r.months, r.total]), ...totals, ...opening]));
}));

/** The declarations' figures: per person each base of the year (AHV, ALV to the ceiling, UVG, …), for the funds' portals. */
router.get('/payroll/documents/:year/declarations.csv', run((req, res) => {
  const year = yearParam(req);
  const ctx = payrollContext(WS);
  const rows = declarationRows(ctx.store.employees, [...ctx.history.closed.values()], year, { data: ctx.data, years: ctx.years });
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.bases)))].sort();
  const head = (k: string) => `${ctx.data.bases.find((b) => b.key === k.split('|')[0])?.label.de ?? k}${k.includes('|') ? ' (bis Höchstbetrag)' : ''}`;
  // Beside each base what of it the opening holds («davon Eröffnung»): the months paid before payroll ran here.
  // An exempt person (by age, a pensioner's allowance, a small wage) shows her liable wage and the reason beside it.
  sendCsv(res, `meldungen-${year}.csv`, csv([['id', 'name', 'ssn', 'from', 'to', ...keys.map(head), 'openingThrough', ...keys.map((k) => `${head(k)} davon Eröffnung`), 'liable', 'exempt', 'exemptReason'],
    ...rows.map((r) => [r.employee, r.name, ctx.store.employees.find((e) => e.id === r.employee)?.socialSecurityNumber, r.from, r.to, ...keys.map((k) => r.bases[k] ?? 0), r.opening?.through, ...keys.map((k) => r.opening?.bases[k] ?? 0), r.exempt?.liable, r.exempt?.amount, r.exempt?.reason])]), true);
}));

/** The family allowances paid per person and child, by month, and the contributions to the fund. */
router.get('/payroll/documents/:year/family.csv', run((req, res) => {
  const year = yearParam(req);
  const ctx = payrollContext(WS);
  const f = familyAllowanceStatement(ctx.store.employees, [...ctx.history.closed.values()], firmWageTypes(ctx.data, ctx.store), ctx.data, year);
  const mm = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  sendCsv(res, `familienzulagen-${year}.csv`, csv([['id', 'name', 'child', 'wageType', ...mm, 'total'],
    ...f.rows.flatMap((r) => r.children.map((c) => [r.employee, r.name, c.child, c.label, ...c.months, c.total])),
    ['', '', '', 'allowances', ...mm.map(() => undefined), f.totals.allowances], ['', '', '', 'contributions', ...mm.map(() => undefined), f.totals.contributions], ['', '', '', 'balance', ...mm.map(() => undefined), f.totals.balance]]));
}));

/** The pension fund's expected wages: per person the wage of January (or her entry) × 12, with a 13th. */
router.get('/payroll/documents/:year/pension.csv', run((req, res) => {
  const year = yearParam(req);
  const ctx = payrollContext(WS);
  const rows = pensionWages(ctx.store.employees, [...ctx.history.closed.values()], ctx.data, ctx.years, year);
  sendCsv(res, `vorsorge-${year}.csv`, csv([['id', 'name', 'ssn', 'on', 'kind', 'monthly', 'yearly', 'belowThreshold', 'insured'],
    ...rows.map((r) => [r.employee, r.name, ctx.store.employees.find((e) => e.id === r.employee)?.socialSecurityNumber, r.on, r.kind, r.monthly, r.yearly, r.belowThreshold, r.insured ? 'yes' : 'no'])]), true);
}));

/** The month's Lohnbuchungen as a table, for a fiduciary who keeps the ledger elsewhere. */
router.get('/payroll/documents/journal/:month', run((req, res) => {
  const m = /^(\d{4}-\d{2})\.csv$/.exec(String(req.params.month));
  if (!m) throw new PayrollRefusal('badInput', 'JJJJ-MM.csv');
  const entries = journalOf(readBooks().journalEntries, m[1]);
  sendCsv(res, `lohnbuchungen-${m[1]}.csv`, csv([['date', 'ref', 'debit', 'credit', 'amount', 'text'], ...entries.map((e) => [e.date, e.transactionRef, e.accountDebit, e.accountCredit, e.amount, e.description])]));
}));

// ─── payslips by mail ──────────────────────────────────────────────────────────

/** Before a send: where it would go (her address, the copy), whether her password is set, the mails of this payslip so far. */
router.get('/api/payroll/payslips/:id/mail', run((req, res) => {
  idParts(String(req.params.id));
  res.json(payslipMail(WS, String(req.params.id)));
}));

/** Sends a closed payslip to the person's own address, locked with her password; the copy to the sender. */
router.post('/api/payroll/payslips/:id/send', run(async (req, res) => {
  idParts(String(req.params.id));
  res.json(await sendPayslip(WS, String(req.params.id), (m, pdf) => sendMail(WS, m, pdf)));
}));

/** Sets the person's payslip password; without one given, a generated one is returned once. The date of birth warns first. */
router.post('/api/payroll/employees/:id/mail-password', run((req, res) => {
  const b = body(req);
  res.json(setMailPassword(WS, String(req.params.id), typeof b.password === 'string' ? b.password : undefined, b.confirm === true));
}));

router.get('/api/payroll/sent/:year', run((req, res) => {
  res.json({ year: yearParam(req), sent: payslipsSent(WS, yearParam(req)) });
}));
