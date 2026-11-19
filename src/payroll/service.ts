/**
 * Payroll on a workspace's files (docs/specs/payroll.md §6): the context a payslip is computed in, and
 * closing, reopening and correcting it. Every change to the books goes through the caller's write door
 * (`write`: the API's updateBooksWithEffects as the person, a test's update); a payslip whose posting
 * date lies in a closed period is never closed or reopened (golden rule 1), only corrected in the
 * person's next open month. The PDF lies in the year's receipts/ like any receipt; the events are
 * appended to payslips.jsonl only once the books are saved.
 */
import { existsSync, rmSync } from 'node:fs';
import { ClosedPeriodError, loadBooks, periodLock, receiptFile, type Books } from '../books/store.js';
import { payroll, payrollYears } from '../engines/index.js';
import { writeAtomic, idSource, sha256 } from '../invoices/store.js';
import { accountsOf } from '../workspace/reads.js';
import { setAccountName } from '../workspace/accounts-write.js';
import { standardAccounts } from '../workspace/chart.js';
import type { Workspace } from '../workspace/workspace.js';
import type { PayrollData } from '../core/modules/schema.js';
import { firmWageTypes } from './catalogue.js';
import type { PayrollContext } from './compute.js';
import { historyOf } from './history.js';
import { applyClose, applyReopen, assertReopenable, closeEventOf, correctionOf, entriesOf, payslipReceipt, planClose, reopenEventOf, type ClosePlan, type CloseWarning } from './close.js';
import { payslipPdf } from './pdf.js';
import { allPayslipEvents, appendPayslipEvents, loadPayroll } from './store.js';
import type { PayslipCorrection } from './model.js';

/** A change to the books inside the caller's write door; `fn` is synchronous. */
export type BooksWriter = <T>(fn: (books: Books) => T) => T;

export class NoPayrollError extends Error {}

/** The jurisdiction's payroll data; the app's Löhne area does not show without it. */
export function payrollData(): PayrollData {
  const data = payroll();
  if (!data) throw new NoPayrollError('Die Rechtsordnung dieser Bücher hat keine Lohnbuchhaltung.');
  return data;
}

export function payrollContext(ws: Pick<Workspace, 'paths'>): PayrollContext {
  return { data: payrollData(), years: payrollYears(), store: loadPayroll(ws), history: historyOf(allPayslipEvents(ws)) };
}

/** Every payslip closed as it stands, in every year. */
export const closedPayslips = (ws: Pick<Workspace, 'paths'>) => [...historyOf(allPayslipEvents(ws)).closed.values()];

/** The account numbers of the workspace's chart. */
export const chartNumbers = (ws: Workspace): Set<string> =>
  new Set((accountsOf(ws) as Array<{ number?: unknown }>).flatMap((a) => (a.number === undefined ? [] : [String(a.number)])));

const closedRefusal = (books: Books, date: string, what: string) => {
  const lock = periodLock(books);
  if (lock.isClosed(date)) throw new ClosedPeriodError(`${lock.closedText(date)} ${what}`, lock.closedThrough, 'payroll');
};

const CLOSED_TEXT = 'Eine Lohnabrechnung einer geschlossenen Periode bleibt, wie sie ist: korrigiert wird im nächsten offenen Monat (Rückwirkende Korrektur).';

export type CloseOutcome =
  | { closed: false; warnings: CloseWarning[] }
  | { closed: true; id: string; ref: string; entries: string[]; receiptId: string; accountsAdded: string[]; warnings: CloseWarning[] };

/**
 * Closes `employee`'s `month`. With anything to say first (a line «unvollständig», an earlier month open,
 * an account the chart lacks) and without `confirm`, it writes nothing and returns the warnings; with
 * `confirm` it closes anyway («Trotzdem abschliessen»): the lines left out are listed in the close's
 * `left`, a missing account is added from the standard chart.
 */
export async function closePayslip(ws: Workspace, write: BooksWriter, employee: string, month: string, opts: { confirm?: boolean; now?: string } = {}): Promise<CloseOutcome> {
  const now = opts.now ?? new Date().toISOString();
  const ctx = payrollContext(ws);
  const current = loadBooks(ws);
  const plan: ClosePlan = planClose(ctx, employee, month, chartNumbers(ws), current);
  // A closed period is refused before anything is written, the chart included; the write door checks again.
  closedRefusal(current, plan.booking.date, CLOSED_TEXT);
  if (plan.warnings.length && !opts.confirm) return { closed: false, warnings: plan.warnings };
  const employeeRecord = ctx.store.employees.find((e) => e.id === employee);
  const pdf = await payslipPdf({
    month, payday: plan.draft.payday, language: plan.draft.language, lines: plan.draft.lines,
    gross: plan.draft.gross, deductions: plan.draft.deductions, net: plan.draft.net, payout: plan.draft.payout, employer: plan.draft.employer,
    person: plan.draft.person, firm: { name: ws.company.name, ...(ws.company.address ? { address: ws.company.address } : {}) },
    ...(employeeRecord?.socialSecurityNumber ? { socialSecurityNumber: employeeRecord.socialSecurityNumber } : {}),
    ...(plan.draft.text ? { text: plan.draft.text } : {}), at: now,
  }, ctx.data, firmWageTypes(ctx.data, ctx.store));
  const id = () => idSource.bytes(8).toString('hex');
  // Keyed by its content, as the read step keys every file of receipts/: the next run finds this record, never a new one.
  const receiptId = sha256(pdf).slice(0, 16);
  const filename = `${plan.draft.postingDate.replace(/-/g, '')}-lohnabrechnung-${month}-${employee}.pdf`;
  const receipt = payslipReceipt(plan, receiptId, filename, pdf.length, now);
  const entries = entriesOf(plan, id, receiptId);
  const missingAccounts = plan.warnings.flatMap((w) => (w.key === 'accountMissing' ? [w.account] : []));
  // The accounts first: they hold no booking, and a close whose books save fails leaves them harmless.
  const accountsAdded = addAccounts(ws, ctx.data, missingAccounts);
  // The file only once the books are saved: a refused save leaves no PDF in receipts/ for the next run to read.
  const { path, gone } = write((books) => {
    closedRefusal(books, plan.booking.date, CLOSED_TEXT);
    const replaced = applyClose(books, plan, entries, receipt);
    return { path: receiptFile(ws, books, receipt), gone: replaced.map((r) => receiptFile(ws, books, r)) };
  });
  appendPayslipEvents(ws, month.slice(0, 4), [closeEventOf(plan, now, receiptId, entries)]);
  for (const g of gone) if (g !== path && existsSync(g)) rmSync(g);
  writeAtomic(path, pdf);
  return { closed: true, id: plan.draft.id, ref: plan.booking.ref, entries: entries.map((e) => e.id), receiptId, accountsAdded, warnings: plan.warnings };
}

/** Adds accounts the chart lacks, named as the standard chart names them (else by the insurance kind that books on it). */
function addAccounts(ws: Workspace, data: PayrollData, numbers: readonly string[]): string[] {
  if (!numbers.length) return [];
  const standard = new Map(standardAccounts(ws.company.legalForm).map((a) => [a.number, a.name]));
  const byKind = new Map(Object.values(data.insurances).map((k) => [k.account, k.label.de]));
  return numbers.map((n) => setAccountName(ws, n, standard.get(n) ?? byKind.get(n) ?? `Konto ${n}`).number);
}

export type ReopenOutcome = { reopened: true; id: string; removed: string[]; kept: string[] };

/** Reopens the person's latest closed month (§6.5 step 3): its entries taken back, its PDF out of Belege, the reopening appended. */
export function reopenPayslip(ws: Workspace, write: BooksWriter, id: string, now = new Date().toISOString()): ReopenOutcome {
  const ctx = payrollContext(ws);
  const close = assertReopenable(ctx, id);
  let receiptPath: string | undefined;
  const out = write((books) => {
    closedRefusal(books, close.postingDate, CLOSED_TEXT);
    const receipt = books.receipts.find((r) => r.id === close.receiptId);
    if (receipt) receiptPath = receiptFile(ws, books, receipt);
    return applyReopen(books, close);
  });
  if (receiptPath && existsSync(receiptPath)) rmSync(receiptPath);
  appendPayslipEvents(ws, close.month.slice(0, 4), [reopenEventOf(close, now)]);
  return { reopened: true, id, removed: out.removed, kept: out.kept };
}

/** Records a Rückwirkende Korrektur on a closed payslip; the books change only when the next open month closes. */
export function addCorrection(ws: Workspace, of: string, input: { wageType: string; amount?: number; base?: number; rateDiff?: number; text?: string }, now = new Date().toISOString()): PayslipCorrection {
  const ctx = payrollContext(ws);
  const c = correctionOf(ctx, ctx.data, of, input, `co_${idSource.bytes(6).toString('hex')}`, now);
  appendPayslipEvents(ws, of.slice(0, 4), [c]);
  return c;
}
