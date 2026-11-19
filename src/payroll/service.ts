/**
 * Payroll on a workspace's files (docs/specs/payroll.md §6): the context a payslip is computed in, and
 * closing, reopening and correcting it. Every change to the books goes through the caller's write door
 * (`write`: the API's updateBooksWithEffects as the person, a test's update); a payslip whose posting
 * date lies in a closed period is never closed or reopened (golden rule 1), only corrected in the
 * person's next open month. The PDF lies in the year's receipts/ like any receipt; the events are
 * appended to payslips.jsonl only once the books are saved.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ClosedPeriodError, loadBooks, periodLock, receiptFile, type Books } from '../books/store.js';
import { chart, payroll, payrollYears, setup } from '../engines/index.js';
import { writeAtomic, idSource, sha256 } from '../invoices/store.js';
import { accountsOf } from '../workspace/reads.js';
import { setAccountName } from '../workspace/accounts-write.js';
import { standardAccounts } from '../workspace/chart.js';
import { yearPaths, type Workspace } from '../workspace/workspace.js';
import { valueOn } from '../core/dated.js';
import { lohnausweisOf, type LohnausweisData } from './documents.js';
import { lohnausweisPdf } from './lohnausweis-pdf.js';
import type { PayrollData } from '../core/modules/schema.js';
import { firmWageTypes } from './catalogue.js';
import type { PayrollContext } from './compute.js';
import { historyOf } from './history.js';
import { tariffSource } from './tariffs.js';
import { PayrollRefusal, applyClose, applyReopen, assertReopenable, closeEventOf, correctionOf, entriesOf, payslipReceipt, planClose, reopenEventOf, type ClosePlan, type CloseWarning } from './close.js';
import { payslipPdf } from './pdf.js';
import { lineSource, sourceText } from './sources.js';
import { allPayslipEvents, appendPayslipEvents, loadPayroll, updatePayroll } from './store.js';
import { encryptPdf, generatedPassword } from './pdf-encrypt.js';
import { sendingAddress, type MailMessage } from '../invoices/mail.js';
import type { PayrollEmployee, PayrollStore, PayslipClose, PayslipCorrection } from './model.js';
import type { PaymentFileRecord } from './payment-file.js';
import { payrollYearEnd, type PayrollYearEnd } from './year-end.js';
import { providerIssuesIn } from '../intake/pair-chain.js';

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
  return { data: payrollData(), years: payrollYears(), store: loadPayroll(ws), history: historyOf(allPayslipEvents(ws)), tariffs: tariffSource(ws) };
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
    ...(plan.draft.text ? { text: plan.draft.text } : {}), ...(plan.draft.holidays ? { holidays: plan.draft.holidays } : {}), at: now,
    sources: plan.draft.lines.map((l) => { const s = lineSource(l, plan.draft, ctx.data, ctx.years, ctx.store.insurances); return s && sourceText(s, ctx.data.documents, plan.draft.language); }),
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

// ─── documents ─────────────────────────────────────────────────────────────────

/** A Lohnausweis as issued: a snapshot of its figures and its PDF; a later one replaces or corrects it, both stay. */
export interface LohnausweisSnapshot {
  id: string; employee: string; year: string; kind: 'original' | 'replacement' | 'correction';
  issuedAt: string; data: LohnausweisData; file: string; sha256: string;
}

const snapshotsFile = (ws: Pick<Workspace, 'paths'>, year: string) => join(yearPaths(ws.paths, year).payroll, 'lohnausweise.jsonl');

export function lohnausweisSnapshots(ws: Pick<Workspace, 'paths'>, year: string): LohnausweisSnapshot[] {
  const f = snapshotsFile(ws, year);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LohnausweisSnapshot) : [];
}

/**
 * Issues the Lohnausweis of `employee` for `year` from her closed payslips: the PDF in the year's payroll
 * folder and its snapshot appended. A second one is a replacement (all figures again) or a correction.
 */
export async function issueLohnausweis(ws: Workspace, employee: string, year: string, kind: LohnausweisSnapshot['kind'] = 'original', now = new Date().toISOString(), confirm = false): Promise<LohnausweisSnapshot | { issued: false; openMonths: string[]; noSocialSecurityNumber?: true }> {
  const ctx = payrollContext(ws);
  const e = ctx.store.employees.find((x) => x.id === employee);
  if (!e) throw new PayrollRefusal('notFound', `Keine Person ${employee}.`);
  const types = firmWageTypes(ctx.data, ctx.store);
  const closes = [...ctx.history.closed.values()];
  const data = lohnausweisOf(e, closes, types, ctx.data, year, e.language, [...new Set(ctx.store.monthLines.filter((l) => l.employee === employee && !l.removed).map((l) => l.month))]);
  // Ready once every payslip of the person's year is closed (§6.7); before, only after the warning, and the snapshot names the open months.
  // Without the person's social security number the form lacks its field C: said first, then the person decides (§18).
  if ((data.openMonths.length || !e.socialSecurityNumber) && !confirm) return { issued: false, openMonths: data.openMonths, ...(!e.socialSecurityNumber ? { noSocialSecurityNumber: true as const } : {}) };
  const day = now.slice(0, 10);
  const settings = valueOn(ctx.store.company.lohnausweis, `${year}-12-31`);
  const name = valueOn(e.name, `${year}-12-31`) ?? e.name.at(-1)?.value;
  const address = valueOn(e.address, day) ?? e.address.at(-1)?.value;
  const earlier = lohnausweisSnapshots(ws, year).filter((s) => s.employee === employee);
  const last = earlier.at(-1);
  const words = ctx.data.lohnausweis?.[kind === 'correction' ? 'corrects' : 'replaces'];
  const dd = (d: string) => new Intl.DateTimeFormat(`${e.language}-CH`, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`));
  const note = last && words ? (words[e.language] ?? words.de).replace('{date}', dd(last.issuedAt)) : undefined;
  const rules = settings?.expenseRules && ctx.data.lohnausweis?.expenseRules;
  const rulesText = rules ? (rules[e.language] ?? rules.de).replace('{canton}', settings!.expenseRules!.canton).replace('{date}', dd(settings!.expenseRules!.approvedOn)) : undefined;
  const remarks = [rulesText, settings?.remarks].filter(Boolean).join('; ');
  const pdf = await lohnausweisPdf({
    data, language: e.language,
    person: { name: name ? `${name.first} ${name.last}` : e.id, ...(address ? { address } : {}), ...(e.socialSecurityNumber ? { socialSecurityNumber: e.socialSecurityNumber } : {}), birthDate: e.birthDate },
    firm: { name: ws.company.name, ...(ws.company.address ? { address: ws.company.address } : {}), ...(ctx.store.company.contact ? { contact: ctx.store.company.contact } : {}) },
    boxes: { F: !!settings?.transportF, G: !!settings?.canteenG }, ...(remarks ? { remarks } : {}),
    place: ws.company.address?.town ?? '', day, ...(note ? { note } : {}),
  }, ctx.data);
  const id = `la_${idSource.bytes(6).toString('hex')}`;
  const dir = yearPaths(ws.paths, year).payroll;
  // Named by the snapshot's id: two issues at once never write one file.
  const file = join(dir, `lohnausweis-${year}-${employee}-${id}.pdf`);
  writeAtomic(file, pdf);
  const snap: LohnausweisSnapshot = { id, employee, year, kind: !earlier.length ? 'original' : kind === 'original' ? 'replacement' : kind, issuedAt: now, data, file: relative(ws.paths.root, file), sha256: sha256(pdf) };
  appendFileSync(snapshotsFile(ws, year), JSON.stringify(snap) + '\n');
  return snap;
}

// ─── payslips by mail ──────────────────────────────────────────────────────────

/** One payslip mail as sent: who got it, the copy, when, the server's id. A resend is a line of its own. */
export interface PayslipSent { payslip: string; to: string; copyTo?: string; at: string; messageId: string }

const sentFile = (ws: Pick<Workspace, 'paths'>, year: string) => join(yearPaths(ws.paths, year).payroll, 'sent.jsonl');

export function payslipsSent(ws: Pick<Workspace, 'paths'>, year: string): PayslipSent[] {
  const f = sentFile(ws, year);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as PayslipSent) : [];
}

const digits = (s: string | undefined) => (s ?? '').replace(/\D/g, '');

/**
 * Why a password may not lock a payslip, or a warning to show first: the social security number never
 * (AHVG Art. 153c: it is for social insurance only), the date of birth only after a warning (others know it).
 */
export function passwordCheck(e: PayrollEmployee, password: string): { refused?: 'short' | 'long' | 'characters' | 'socialSecurityNumber'; warn?: 'birthDate' } {
  if (password.length < 8) return { refused: 'short' };
  // A PDF password counts its first 32 bytes, and readers differ on any character outside printable ASCII.
  if (password.length > 32) return { refused: 'long' };
  if (!/^[\x20-\x7e]+$/.test(password)) return { refused: 'characters' };
  const ssn = digits(e.socialSecurityNumber);
  // Its last eight digits are the person's own: any of them in a row is part of the number.
  if (ssn && digits(password).includes(ssn.slice(-8))) return { refused: 'socialSecurityNumber' };
  const [y, m, d] = (e.birthDate ?? '').split('-');
  if (y) {
    const dd = String(Number(d)); const mm = String(Number(m));
    const forms = [`${d}${m}${y}`, `${y}${m}${d}`, `${d}${m}${y.slice(2)}`, `${y.slice(2)}${m}${d}`, `${dd}${mm}${y}`, `${dd}${mm}${y.slice(2)}`];
    if (forms.some((b) => digits(password).includes(b))) return { warn: 'birthDate' };
  }
  return {};
}

/** Her address as it is now (a resend goes where she reads her mail today), else the payday's. */
const recipientOf = (e: PayrollEmployee | undefined, close: PayslipClose, now: string): string | undefined => e && (valueOn(e.email, now.slice(0, 10)) ?? valueOn(e.email, close.payday));
/**
 * The copy goes to the firm's sender, else to the mailbox it sends from (§6.2 step 8); without a mailbox
 * set up nothing is sent at all, so no copy goes either (§22 decision 39), whatever the sender names.
 */
const copyOf = (ws: Workspace, store: PayrollStore): string | undefined => (sendingAddress(ws) ? store.company.sender?.copyTo || sendingAddress(ws) : undefined);

/** What a send would do, shown before it: the recipient, the copy, whether a password is set, whether a mailbox sends at all, the mails sent so far. */
export interface PayslipMail { to?: string; copyTo?: string; password: boolean; outbox: boolean; sent: PayslipSent[] }

export function payslipMail(ws: Workspace, id: string, now = new Date().toISOString()): PayslipMail {
  const ctx = payrollContext(ws);
  const close = ctx.history.closed.get(id);
  if (!close) throw new PayrollRefusal('notClosed', `Die Lohnabrechnung ${id} ist nicht abgeschlossen.`);
  const e = ctx.store.employees.find((x) => x.id === close.employee);
  const to = recipientOf(e, close, now);
  const copyTo = copyOf(ws, ctx.store);
  return { ...(to ? { to } : {}), ...(copyTo ? { copyTo } : {}), password: !!e?.mailPassword, outbox: !!sendingAddress(ws), sent: payslipsSent(ws, close.month.slice(0, 4)).filter((s) => s.payslip === id) };
}

/**
 * Sends a closed payslip to the person's own address as a PDF locked with her password, the copy to the
 * firm's sender; every mail is logged. Without an address or a password nothing is sent.
 */
export async function sendPayslip(ws: Workspace, id: string, send: (message: MailMessage, pdf: { filename: string; content: Buffer }) => Promise<{ to: string; messageId: string }>, now = new Date().toISOString()): Promise<PayslipSent> {
  const ctx = payrollContext(ws);
  const close = ctx.history.closed.get(id);
  if (!close) throw new PayrollRefusal('notClosed', `Die Lohnabrechnung ${id} ist nicht abgeschlossen.`);
  const e = ctx.store.employees.find((x) => x.id === close.employee);
  const to = recipientOf(e, close, now);
  if (!e || !to) throw new PayrollRefusal('noEmail', 'Für diese Person ist keine eigene E-Mail-Adresse erfasst.');
  if (!e.mailPassword) throw new PayrollRefusal('noPassword', 'Für diese Person ist kein Passwort für die Lohnabrechnungen gesetzt.');
  if (!sendingAddress(ws)) throw new PayrollRefusal('noOutbox', 'Kein Postausgang eingerichtet (Firma › E-Mail-Versand): ohne ihn geht keine Lohnabrechnung per Mail.');
  if (passwordCheck(e, e.mailPassword).refused) throw new PayrollRefusal('badPassword', 'Das Passwort dieser Person geht nicht mehr (etwa die AHV-Nummer, seit sie erfasst ist): ein neues setzen.', 'stale');
  const books = loadBooks(ws);
  const receipt = books.receipts.find((r) => r.id === close.receiptId);
  const path = receipt && receiptFile(ws, books, receipt);
  if (!path || !existsSync(path)) throw new PayrollRefusal('notFound', `Das PDF der Lohnabrechnung ${id} fehlt.`);
  const lang = e.language;
  const month = new Intl.DateTimeFormat(`${lang}-CH`, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${close.month}-01T00:00:00Z`));
  const words = (k: keyof PayrollData['documents']) => ctx.data.documents[k][lang] ?? ctx.data.documents[k].de;
  const locked = await encryptPdf(readFileSync(path), e.mailPassword);
  const copyTo = copyOf(ws, ctx.store);
  const out = await send({ to, subject: `${words('payslip')} ${month}`, body: words('mailBody').replace('{month}', () => month).replace('{firm}', () => ws.company.name), ...(copyTo ? { bcc: copyTo } : {}) },
    { filename: `${words('payslip')}-${close.month}.pdf`.replace(/\s+/g, '-'), content: locked });
  const sent: PayslipSent = { payslip: id, to: out.to, ...(copyTo ? { copyTo } : {}), at: now, messageId: out.messageId };
  const dir = yearPaths(ws.paths, close.month.slice(0, 4)).payroll;
  mkdirSync(dir, { recursive: true });
  appendFileSync(sentFile(ws, close.month.slice(0, 4)), JSON.stringify(sent) + '\n');
  return sent;
}

/** Sets a person's payslip password: hers when given and allowed, else one generated and returned once. */
export function setMailPassword(ws: Workspace, employee: string, given: string | undefined, confirm = false): { password?: string; warn?: 'birthDate' } {
  return updatePayroll(ws, (s) => {
    const e = s.employees.find((x) => x.id === employee);
    if (!e) throw new PayrollRefusal('notFound', `Keine Person ${employee}.`);
    // Hers exactly as typed: a space at either end is refused, never cut off without a word (she would not know the one that opens).
    const own = given === undefined || given === '' ? undefined : given;
    if (own !== undefined && own !== own.trim()) throw new PayrollRefusal('badPassword', 'Das Passwort beginnt oder endet mit einem Leerzeichen.', 'spaces');
    const password = own ?? generatedPassword();
    const check = passwordCheck(e, password);
    if (check.refused) throw new PayrollRefusal('badPassword', { short: 'Das Passwort hat mindestens 8 Zeichen.', long: 'Das Passwort hat höchstens 32 Zeichen.', characters: 'Das Passwort hat nur Buchstaben ohne Akzente, Zahlen und Satzzeichen.', socialSecurityNumber: 'Die AHV-Nummer ist nie ein Passwort.' }[check.refused], check.refused);
    if (check.warn && !confirm) return { warn: check.warn };
    e.mailPassword = password;
    return own !== undefined ? {} : { password };
  });
}

// ─── payment files ─────────────────────────────────────────────────────────────

const paymentFilesLog = (ws: Pick<Workspace, 'paths'>, year: string) => join(yearPaths(ws.paths, year).payroll, 'payment-files.jsonl');
/** Where a made file's bytes lie, by its record's id. */
export const paymentFilePath = (ws: Pick<Workspace, 'paths'>, year: string, id: string) => join(yearPaths(ws.paths, year).payroll, 'payment-files', `${id}.xml`);

/** The payment files made for months of `year`, oldest first. */
export function paymentFilesMade(ws: Pick<Workspace, 'paths'>, year: string): PaymentFileRecord[] {
  const f = paymentFilesLog(ws, year);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as PaymentFileRecord) : [];
}

/** Keeps a made file: its bytes beside the log, its record appended. */
export function keepPaymentFile(ws: Pick<Workspace, 'paths'>, record: PaymentFileRecord, xml: string): void {
  const year = record.month.slice(0, 4);
  const path = paymentFilePath(ws, year, record.id);
  mkdirSync(join(yearPaths(ws.paths, year).payroll, 'payment-files'), { recursive: true });
  writeAtomic(path, Buffer.from(xml, 'utf8'));
  appendFileSync(paymentFilesLog(ws, year), JSON.stringify(record) + '\n');
}

// ─── the year-end ──────────────────────────────────────────────────────────────

/**
 * The payroll's checks of the year's close (§6.7, A7) from the workspace as it is now: undefined where the
 * jurisdiction has no payroll, and where the year has neither a payslip nor a wage booked (nothing to check).
 */
export function payrollYearEndOf(ws: Workspace, year: string, books: Books = loadBooks(ws)): PayrollYearEnd | undefined {
  if (!payroll()) return undefined;
  const ctx = payrollContext(ws);
  const wages = setup().wages;
  const issues = wages?.deductions ? providerIssuesIn(ws, books) : undefined;
  const out = payrollYearEnd({
    year, books, closes: [...ctx.history.closed.values()], employees: ctx.store.employees, data: ctx.data, store: ctx.store,
    issued: lohnausweisSnapshots(ws, year), isDebitNormal: (a) => chart().isDebitNormal(a),
    ...(wages?.account ? { wageAccount: wages.account } : {}), ...(wages?.deductions ? { deductionsAccount: wages.deductions } : {}),
    withheldPayees: new Set(issues?.withheldPayees ?? []), withheldShares: issues?.withheldShares ?? {},
  });
  const something = out.clearing || out.insurers.length || out.wages || out.statements.length || out.withheld;
  return something ? out : undefined;
}
