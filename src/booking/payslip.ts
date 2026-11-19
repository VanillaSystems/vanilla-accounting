/**
 * A payslip another program or a fiduciary issued (docs/specs/payroll.md §10.2 A1–A3): recognised, read,
 * paired with its wage's bank line and booked, all by code. Its figures are read off its text on every
 * read, never stored (§10.3), so a better reader reads old payslips again. A payslip the app closed itself
 * (src/payroll/close.ts, kindRule `payroll`) is no such payslip: payroll's own match pays it. Pure and
 * browser-safe.
 */
import type { BankTransaction, Mapping, Receipt } from '../types/index.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { baseCurrency, documents, setup } from '../engines/index.js';
import { HEAD, wordsRe } from '../core/modules/words.js';
import { issuedByFirm } from '../intake/own-invoice.js';
import { accountOfKind, CORRECTION, deductionKind, namesWord, payslipDeductions, payslipRows, prose } from './withheld.js';

/** The kindRule of a payslip code recognised (A1): told apart from the app's own (`payroll`). */
export const PAYSLIP_RULE = 'document:payslip';

/**
 * The kindRule of a text the firm issued and titles a payslip that code cannot read (or one the app's own payroll closed
 * for that month, dropped again): a payslip all the same, never sent to a model (§11), paired and booked by the person.
 */
export const PAYSLIP_UNREAD_RULE = 'document:payslip-unread';

/** A payslip of another program, as code recognised it: never one the app closed. */
export const externalPayslip = (r: Pick<Receipt, 'kind' | 'kindRule'>): boolean => r.kind === 'payslip' && r.kindRule === PAYSLIP_RULE;

/** What a payslip says: the person and the month it names where it does, its gross, its net, the deductions per kind, the allowances and the expenses by account. */
export interface PayslipRead {
  employee?: string;
  /** `YYYY-MM`. */
  period?: string;
  /** The currency its amounts are in: one a code beside its amounts names, else the books'. */
  currency: string;
  gross: number;
  net: number;
  deductions: Map<string, number>;
  allowances: number;
  expenses: Map<string, number>;
}

type Role = { is: 'gross' } | { is: 'net' } | { is: 'allowance' } | { is: 'expense'; account: string } | { is: 'deduction'; kind: string };

/** What a row's label names, by setup.yaml `wages.payslip` and `wages.withholds`: one role, or none when it names none or two (a sentence names none). */
function roleReader(): ((label: string) => Role | undefined) | undefined {
  const w = setup().wages;
  const p = w?.payslip;
  if (!p?.gross.length || !p.net.length) return undefined;
  const gross = namesWord(p.gross);
  const net = namesWord(p.net);
  const allowance = namesWord(p.allowances ?? []);
  const expenses = (p.expenses ?? []).map((e) => ({ account: e.account, names: namesWord(e.words) }));
  const kind = deductionKind(w?.withholds ?? {});
  return (label) => {
    if (prose(label)) return undefined;
    const found: Role[] = [];
    if (gross(label)) found.push({ is: 'gross' });
    if (net(label)) found.push({ is: 'net' });
    if (allowance(label)) found.push({ is: 'allowance' });
    // The flat expenses are listed first: «Pauschalspesen» names no «Spesen», but «Spesen pauschal» names both.
    const expense = expenses.find((e) => e.names(label));
    if (expense) found.push({ is: 'expense', account: expense.account });
    const k = kind(label);
    if (k) found.push({ is: 'deduction', kind: k });
    return found.length === 1 ? found[0] : undefined;
  };
}

/** The one amount of the rows of a role, or undefined when they name two. */
const oneOf = (amounts: readonly number[]): number | undefined => (amounts.length && amounts.every((a) => toRappen(a) === toRappen(amounts[0])) ? amounts[0] : undefined);

/**
 * A payslip's figures off its text (§10.2 A2), when they are sure: the rows that name the gross, the net,
 * the deductions (as payslipDeductions reads them, per kind), the family allowances and the expenses, laid
 * out on one line each, each label followed by its amount, or all labels and then all amounts (pdftotext's
 * columns, in the order of the labels). Sure means gross − deductions + allowances + expenses is the net to
 * the cent. Undefined otherwise, and without the jurisdiction's words.
 */
export function readPayslip(text: string): PayslipRead | undefined {
  const roleOf = roleReader();
  if (!roleOf || !text.trim()) return undefined;
  const rows = payslipRows(text).map((r) => ({ ...r, role: r.alone ? undefined : roleOf(r.label) }));
  const named = rows.map((r, i) => ({ ...r, i })).filter((r) => r.role);
  const inline = named.filter((r) => r.amount !== undefined);
  let pairs: Array<{ role: Role; label: string; amount: number }>;
  if (inline.some((r) => r.role!.is === 'gross') && inline.some((r) => r.role!.is === 'net')) {
    pairs = inline.map((r) => ({ role: r.role!, label: r.label, amount: r.amount! }));
  } else {
    const bare = named.filter((r) => r.amount === undefined);
    if (!bare.length) return undefined;
    const next = bare.map((l) => rows[l.i + 1]);
    if (next.every((n) => n?.alone)) pairs = bare.map((l, k) => ({ role: l.role!, label: l.label, amount: next[k].amount! }));
    else {
      const amounts = rows.filter((r) => r.alone).map((r) => r.amount!);
      if (amounts.length !== bare.length) return undefined;
      pairs = bare.map((l, k) => ({ role: l.role!, label: l.label, amount: amounts[k] }));
    }
  }
  const of = (is: Role['is']) => pairs.filter((p) => p.role.is === is);
  const gross = oneOf(of('gross').map((p) => p.amount));
  const net = oneOf(of('net').map((p) => p.amount));
  if (gross === undefined || net === undefined || gross <= 0 || net <= 0) return undefined;
  if (of('allowance').some((p) => p.amount < 0) || of('expense').some((p) => p.amount < 0)) return undefined;
  const allowances = fromRappen(of('allowance').reduce((s, p) => s + toRappen(p.amount), 0));
  const expenses = new Map<string, number>();
  for (const p of of('expense')) {
    const account = (p.role as { account: string }).account;
    expenses.set(account, fromRappen(toRappen(expenses.get(account) ?? 0) + toRappen(p.amount)));
  }
  const add = (m: Map<string, number>, kind: string, v: number) => m.set(kind, fromRappen(toRappen(m.get(kind) ?? 0) + toRappen(v)));
  // The deductions as payslipDeductions reads them: a row of a kind with a minus, a correction row taken off.
  const signed = new Map<string, number>();
  for (const p of of('deduction')) {
    const taken = p.amount < 0 ? -p.amount : CORRECTION.test(p.label) ? -p.amount : 0;
    if (taken) add(signed, (p.role as { kind: string }).kind, taken);
  }
  const kinds = setup().wages?.withholds ?? {};
  const read = signed.size ? payslipDeductions(text, undefined, kinds) : undefined;
  const agrees = !signed.size || (!!read && read.size === signed.size && [...read].every(([k, v]) => toRappen(signed.get(k) ?? NaN) === toRappen(v)));
  // A program that prints its deductions without a minus (a column of positive amounts): each row of a kind is a deduction,
  // taken only when no row carries a minus or says it corrects, and the net proves it below.
  const plain = new Map<string, number>();
  const unsigned = of('deduction').every((p) => p.amount > 0 && !CORRECTION.test(p.label));
  if (unsigned) for (const p of of('deduction')) add(plain, (p.role as { kind: string }).kind, p.amount);
  const sums = (m: Map<string, number>) => toRappen(gross) - [...m.values()].reduce((s, v) => s + toRappen(v), 0) + toRappen(allowances) + [...expenses.values()].reduce((s, v) => s + toRappen(v), 0);
  const deductions = agrees && sums(signed) === toRappen(net) ? signed : unsigned && plain.size && sums(plain) === toRappen(net) ? plain : undefined;
  if (!deductions) return undefined;
  const employee = employeeOf(text);
  const period = periodOf(text);
  const currency = currencyOf(text);
  return { ...(employee ? { employee } : {}), ...(period ? { period } : {}), currency, gross, net, deductions, allowances, expenses };
}

/** The currency a payslip names beside its amounts («EUR 4'200.00»); the books' when it names none, or two. */
function currencyOf(text: string): string {
  const named = new Set([...text.matchAll(/(?<![\p{L}])([A-Z]{3})\s*-?\s*\d{1,3}(?:['’ ]?\d{3})*[.,]\d{2}(?![\d])/gu)].map((m) => m[1]).filter((c) => KNOWN_CURRENCIES.has(c) || c === baseCurrency()));
  return named.size === 1 ? [...named][0] : baseCurrency();
}
/** Codes a payslip may name its amounts in (never a deduction's abbreviation: «AHV 5.3» is none). */
const KNOWN_CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'JPY', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'CAD', 'AUD']);

/** The line of the head that titles the payslip («Lohnabrechnung Juli 2026»), by documents.yaml `payslip`. */
function titleLine(text: string): number {
  const words = documents().payslip ?? [];
  if (!words.length) return -1;
  const re = wordsRe(words);
  return text.slice(0, HEAD).split('\n').findIndex((l) => re.test(l));
}

/** The person a payslip names: the line below its title, before a comma («Matthias Kälin, Geschäftsführer»), when it is a name of two to four words. */
function employeeOf(text: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim());
  const at = titleLine(text);
  const below = at < 0 ? undefined : lines.slice(at + 1).find(Boolean);
  const name = below?.split(',')[0].trim();
  return name && /^\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,3}$/u.test(name) ? name : undefined;
}

/** The month a payslip is for, `YYYY-MM`: a month's name and a year on its title line, else in its head («Juli 2026», «07/2026»). */
function periodOf(text: string): string | undefined {
  const head = text.slice(0, HEAD);
  const at = titleLine(text);
  const lines = at < 0 ? [head] : [head.split('\n')[at], head];
  const months = documents().months ?? [];
  for (const line of lines) {
    for (const [i, names] of months.entries()) {
      const m = new RegExp(`(?<![\\p{L}])(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}])\\s+((?:19|20)\\d{2})\\b`, 'iu').exec(line);
      if (m) return `${m[1]}-${String(i + 1).padStart(2, '0')}`;
    }
    const n = /(?<![\d.])(0?[1-9]|1[0-2])[./](20\d{2})\b/.exec(line);
    if (n) return `${n[2]}-${n[1].padStart(2, '0')}`;
  }
  return undefined;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** The lines a letterhead fills: the firm's name, its address, its numbers. */
const LETTERHEAD = 6;

/**
 * Whether a payslip's text is the firm's own: its name in the letterhead (a payroll program prints the
 * employer at the top; a payslip prints no VAT number, so the firm's UID cannot tell), or the firm's
 * UID as the only one the text shows.
 */
export function issuedByTheFirm(text: string, firm: { name?: string; uid?: string } | undefined): boolean {
  if (!firm) return false;
  const name = firm.name ? fold(firm.name) : '';
  const head = fold(text.split('\n').filter((l) => fold(l)).slice(0, LETTERHEAD).join(' '));
  if (name && ` ${head} `.includes(` ${name} `)) return true;
  return !!firm.uid && issuedByFirm({ extractedText: text }, { uid: firm.uid }) === 'uid';
}

/**
 * A text that is a payslip of another program (A1): the firm issued it, its first lines title it a payslip
 * (documents.yaml `payslip`), and it reads (readPayslip). Then its figures; undefined otherwise: the text is
 * a receipt like any other, and the model may read it, masked (§11).
 */
export function payslipOf(text: string, firm: { name?: string; uid?: string } | undefined): PayslipRead | undefined {
  return payslipTitled(text, firm) ? readPayslip(text) : undefined;
}

/** Whether a text is the firm's payslip by its head (its letterhead and title), read or not: it never goes to a model (§10.2 A8). */
export const payslipTitled = (text: string, firm: { name?: string; uid?: string } | undefined): boolean => titleLine(text) >= 0 && issuedByTheFirm(text, firm);

// ─── Booking (A3) ───────────────────────────────────────────────────────────

/** One line of a wage booked from its payslips: `credit` empty is the bank. */
export interface WageLine { debit: string; credit: string; amount: number; what: 'net' | 'deductions' | 'allowances' | 'expenses'; employee?: string; period?: string; receipt: string }

/**
 * The lines one bank payment of wages books from its payslips (§10.2 A3): per payslip, the wage less its
 * deductions on the wage account against the bank, each deduction account's share on the wage account
 * against it, the allowances paid with the wage on the deductions account against the bank (the fund pays
 * them back on its bill), each kind of expenses on its account against the bank. Undefined when the
 * jurisdiction names no wage or deductions account, or a deduction kind has no one account.
 */
export function wageLines(slips: ReadonlyArray<{ receipt: string; read: PayslipRead }>): WageLine[] | undefined {
  const w = setup().wages;
  if (!w?.account || !w.deductions) return undefined;
  const out: WageLine[] = [];
  for (const { receipt, read } of slips) {
    const who = { ...(read.employee ? { employee: read.employee } : {}), ...(read.period ? { period: read.period } : {}), receipt };
    const byAccount = new Map<string, number>();
    for (const [kind, amount] of read.deductions) {
      const account = accountOfKind(kind);
      if (!account) return undefined;
      byAccount.set(account, (byAccount.get(account) ?? 0) + toRappen(amount));
    }
    const withheld = [...byAccount.values()].reduce((s, v) => s + v, 0);
    // A wage less its deductions at or below nothing is no wage code books (a payslip of allowances only, a correction).
    if (toRappen(read.gross) - withheld <= 0) return undefined;
    out.push({ debit: w.account, credit: '', amount: fromRappen(toRappen(read.gross) - withheld), what: 'net', ...who });
    for (const [account, rappen] of byAccount) if (rappen) out.push({ debit: w.account, credit: account, amount: fromRappen(rappen), what: 'deductions', ...who });
    if (toRappen(read.allowances)) out.push({ debit: w.deductions, credit: '', amount: read.allowances, what: 'allowances', ...who });
    for (const [account, amount] of read.expenses) if (toRappen(amount)) out.push({ debit: account, credit: '', amount, what: 'expenses', ...who });
  }
  return out.filter((l) => toRappen(l.amount) > 0);
}

type PairBooks = { transactions: readonly BankTransaction[]; receipts: readonly Receipt[]; mappings: readonly Mapping[] };

/** The payslips of another program linked to a payment, each with what it reads: undefined when another receipt is linked too, or one does not read. */
export function payslipsOf(books: Pick<PairBooks, 'receipts' | 'mappings'>, tx: Pick<BankTransaction, 'ref'>): Array<{ receipt: string; read: PayslipRead }> | undefined {
  const ids = new Set(books.mappings.filter((m) => m.transactionRef === tx.ref).map((m) => m.receiptId));
  const linked = books.receipts.filter((r) => ids.has(r.id));
  if (!linked.length || !linked.every(externalPayslip)) return undefined;
  const reads = linked.map((r) => ({ receipt: r.id, read: readPayslip(r.extractedText ?? '') }));
  return reads.every((x) => x.read) ? reads.map((x) => ({ receipt: x.receipt, read: x.read! })) : undefined;
}

/** The payslips of a payment that pay what the bank paid: their nets add up to it, in the books' currency, money out. */
export function paidBySlips(books: Pick<PairBooks, 'receipts' | 'mappings'>, tx: BankTransaction): Array<{ receipt: string; read: PayslipRead }> | undefined {
  if (tx.direction !== 'DBIT' || tx.currency !== baseCurrency()) return undefined;
  const slips = payslipsOf(books, tx);
  return slips && slips.every((x) => x.read.currency === tx.currency) && slips.reduce((s, x) => s + toRappen(x.read.net), 0) === toRappen(Math.abs(tx.amount)) ? slips : undefined;
}

// ─── Pairing (A1) ───────────────────────────────────────────────────────────

const DAY = 86_400_000;
const at = (d: string) => Date.parse(`${d}T00:00:00Z`);
const shift = (d: string, n: number) => new Date(at(d) + n * DAY).toISOString().slice(0, 10);
/** The last day of a month `YYYY-MM`. */
export const monthEnd = (month: string): string => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
/** A wage is paid from 20 days before its month ends (a payday on the 11th) to a month after, as payroll's own match around its payday (§22 decision 20). */
const BEFORE = 20;
const AFTER = 31;
const wordsOf = (s: string) => fold(s).split(' ').filter((w) => w.length >= 2);

/** Whether the payment names the payslip's person: every word of the bank's counterparty (two at least) in the payslip's text, or the person's name in the payment's. */
function namesPerson(tx: BankTransaction, r: Receipt, read: PayslipRead): boolean {
  // Below its title: the letterhead above it names the firm, which pays rent and transfers too.
  const all = r.extractedText ?? '';
  const at = titleLine(all);
  const text = ` ${fold(at < 0 ? all : all.split('\n').slice(at + 1).join('\n'))} `;
  const payee = wordsOf(tx.counterparty ?? '');
  if (payee.length >= 2 && payee.every((w) => text.includes(` ${w} `))) return true;
  const said = ` ${fold(`${tx.counterparty ?? ''} ${tx.description}`)} `;
  const name = read.employee ? wordsOf(read.employee) : [];
  return name.length >= 2 && name.every((w) => said.includes(` ${w} `));
}

export interface PayslipLink { receipt: string; payment: string }

export interface PairOptions {
  isClosed: (date: string) => boolean;
  /** A payment whose text is a wage's (evidence.guide.yaml ev-exempt-wages): one line for a month's payslips need name nobody. */
  wage?: (tx: BankTransaction) => boolean;
  /** The payments without a receipt of their own (an own transfer, a fee row): never a wage's. */
  noReceipt?: (tx: BankTransaction) => boolean;
}

/**
 * The links code makes between the payslips of another program nothing is linked to and the wages' bank
 * lines (A1): a payment out of the open period in the books' currency, no receipt linked to it, of the
 * payslip's net to the cent, from 20 days before its month ends to a month after, that names its person
 * (by name, both ways, below the payslip's letterhead). Of several, the nearest to the month's end, among every
 * payment that fits: one filed, linked or nearer to another payslip leaves the payslip without a link, never paired a
 * month off. Each payslip and payment once, the nearest pairs first. One line that pays all of a month's payslips (two or more, their nets adding up to
 * it, worded as a wage or naming nobody else) pays each. A payslip without a month is paired only when one
 * payment alone fits it. The model is never asked: a payslip that reads carries a salary and a person.
 */
export function payslipLinks(books: PairBooks, opts: PairOptions): PayslipLink[] {
  const linkedReceipts = new Set(books.mappings.map((m) => m.receiptId));
  const linkedPayments = new Set(books.mappings.map((m) => m.transactionRef));
  const slips = books.receipts.filter((r) => externalPayslip(r) && r.location === 'archived' && !linkedReceipts.has(r.id))
    .flatMap((r) => { const read = readPayslip(r.extractedText ?? ''); return read ? [{ r, read }] : []; });
  if (!slips.length) return [];
  // Every payment a payslip could be paid by, those it may not take too (a closed one, one linked): its own month's wage
  // that is filed or taken is still its nearest, and a payslip never reaches past it to the next month's (review of A-2).
  const all = books.transactions.filter((t) => t.direction === 'DBIT' && t.amount !== 0 && !opts.noReceipt?.(t));
  const free = (t: BankTransaction) => t.currency === baseCurrency() && !linkedPayments.has(t.ref) && !opts.isClosed(t.date);
  const payments = all.filter(free);
  const windowOf = (s: { read: PayslipRead }) => (s.read.period ? { from: shift(monthEnd(s.read.period), -BEFORE), to: shift(monthEnd(s.read.period), AFTER), end: monthEnd(s.read.period) } : undefined);
  const fits = (s: (typeof slips)[number], t: BankTransaction) => {
    if (t.currency !== s.read.currency || toRappen(Math.abs(t.amount)) !== toRappen(s.read.net) || s.r.notPaidBy?.includes(t.ref) || !namesPerson(t, s.r, s.read)) return false;
    const w = windowOf(s);
    return !w || (t.date >= w.from && t.date <= w.to);
  };
  const offOf = (s: (typeof slips)[number], t: BankTransaction) => (windowOf(s) ? Math.abs(at(t.date) - at(windowOf(s)!.end)) : 0);
  const out: PayslipLink[] = [];
  const doneSlips = new Set<string>();
  const donePayments = new Set<string>();
  // Each payslip's nearest payment, among all that fit; a payslip without its month only when one alone fits.
  const nearest = slips.flatMap((s) => {
    const fit = all.filter((t) => fits(s, t)).sort((a, b) => offOf(s, a) - offOf(s, b) || a.date.localeCompare(b.date));
    if (!fit.length || (!s.read.period && fit.length > 1)) return [];
    if (fit.length > 1 && offOf(s, fit[0]) === offOf(s, fit[1])) return [];
    return [{ s, t: fit[0], off: offOf(s, fit[0]) }];
  });
  for (const c of nearest.sort((a, b) => a.off - b.off || a.s.r.id.localeCompare(b.s.r.id))) {
    // Its nearest is filed, linked, or nearer to another payslip: no link, and no reach for the next one.
    doneSlips.add(c.s.r.id);
    if (!free(c.t) || donePayments.has(c.t.ref)) continue;
    donePayments.add(c.t.ref);
    out.push({ receipt: c.s.r.id, payment: c.t.ref });
  }
  // One line for a whole month: every payslip of the month left, two or more, whose nets add up to it.
  const byMonth = new Map<string, typeof slips>();
  for (const s of slips) if (s.read.period && !doneSlips.has(s.r.id) && s.read.currency === baseCurrency()) byMonth.set(s.read.period, [...(byMonth.get(s.read.period) ?? []), s]);
  for (const [month, list] of byMonth) {
    if (list.length < 2) continue;
    const total = list.reduce((s, x) => s + toRappen(x.read.net), 0);
    const end = monthEnd(month);
    const line = payments.filter((t) => !donePayments.has(t.ref) && toRappen(Math.abs(t.amount)) === total && t.date >= shift(end, -BEFORE) && t.date <= shift(end, AFTER)
      && !list.some((s) => s.r.notPaidBy?.includes(t.ref)) && (opts.wage?.(t) || !t.counterparty?.trim()));
    if (line.length !== 1) continue;
    donePayments.add(line[0].ref);
    for (const s of list) { doneSlips.add(s.r.id); out.push({ receipt: s.r.id, payment: line[0].ref }); }
  }
  return out;
}

/** The rule a link of a payslip to its wage names (Mapping.rule): code's, by amount and person. */
export const PAYSLIP_LINK = 'payslip';

/** Links the payslips code pairs (payslipLinks) into `books`, inside the caller's write door. Returns the links. */
export function linkPayslips(books: PairBooks & { mappings: Mapping[] }, opts: PairOptions): PayslipLink[] {
  const links = payslipLinks(books, opts);
  for (const l of links) books.mappings.push({ transactionRef: l.payment, receiptId: l.receipt, by: 'rule', rule: PAYSLIP_LINK });
  return links;
}
