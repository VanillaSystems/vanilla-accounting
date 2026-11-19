/**
 * Lohnzahlungen (docs/specs/payroll.md §6.3): who gets how much to which IBAN for a month, and the bank's
 * line matched by code. A payment out of the open period that no booking holds yet pays a closed payslip
 * when its amount is the payout and it names the person (her IBAN valid on the payday, or her name in the
 * bank's text); one line that pays the whole month pays each payslip of it. It is booked D 1091 / C bank
 * per payslip, by payroll's check, with the payslip's PDF linked as its receipt: «bezahlt» comes from the
 * statement, never from a click. Pure, browser-safe.
 */
import type { BankTransaction, JournalEntry, Mapping } from '../types/index.js';
import type { PeriodLock } from '../books/store.js';
import type { PayslipClose } from './model.js';
import { round2, sum } from './money.js';

type BooksLike = { transactions: readonly BankTransaction[]; journalEntries: readonly JournalEntry[]; mappings: readonly Mapping[] };

/** The bank payment of a closed payslip: the payment its PDF is linked to, if a booking holds it (any booking: a person's of that line too). */
export function paymentOf(books: BooksLike, close: Pick<PayslipClose, 'receiptId'>): BankTransaction | undefined {
  if (!close.receiptId) return undefined;
  const refs = new Set(books.mappings.filter((m) => m.receiptId === close.receiptId).map((m) => m.transactionRef));
  const held = new Set(books.journalEntries.filter((e) => refs.has(e.transactionRef)).map((e) => e.transactionRef));
  return books.transactions.find((t) => held.has(t.ref));
}

const compact = (s: string | undefined) => (s ?? '').replace(/\s/g, '').toUpperCase();
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** Whether the payment names the person: her IBAN, or her first and last name in the bank's counterparty or text. */
function names(tx: BankTransaction, close: PayslipClose): boolean {
  if (close.person.iban && compact(tx.counterpartyIban) === compact(close.person.iban)) return true;
  const said = new Set(words(`${tx.counterparty ?? ''} ${tx.description}`));
  const name = words(close.person.name);
  return name.length >= 2 && name.every((w) => said.has(w));
}

/** Days between two days. */
const apart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
/** A wage is paid around its payday: from two weeks before to a month after. */
const nearPayday = (tx: BankTransaction, close: PayslipClose) => tx.date >= addDays(close.payday, -14) && tx.date <= addDays(close.payday, 31);
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface WageMatch { tx: BankTransaction; payslips: PayslipClose[] }

/** The open, unbooked payments out that pay closed payslips not paid yet, each with the payslips it pays. */
export interface MatchOptions {
  /** The books' currency: a line in another is left to the other paths (it would need a rate of its day). */
  currency: string;
  /** A line a company rule decides stays the rule's (as the bank's fee row does). */
  ruled?: (tx: BankTransaction) => boolean;
  /** The firm's own IBANs: a line to one of them is a transfer, never a wage. */
  own?: ReadonlySet<string>;
}

export function wageMatches(books: BooksLike, closes: readonly PayslipClose[], lock: Pick<PeriodLock, 'isClosed'>, opts: MatchOptions): WageMatch[] {
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const unpaid = closes.filter((c) => c.payout > 0 && !paymentOf(books, c));
  const taken = new Set<string>();
  const out: WageMatch[] = [];
  const candidates = books.transactions.filter((t) => t.direction === 'DBIT' && t.currency === opts.currency && !booked.has(t.ref) && !lock.isClosed(t.date)
    && !opts.own?.has(compact(t.counterpartyIban)) && !opts.ruled?.(t))
    .sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  for (const tx of candidates) {
    const amount = round2(Math.abs(tx.amount));
    const one = unpaid.filter((c) => !taken.has(c.id) && c.payout === amount && nearPayday(tx, c) && names(tx, c))
      .sort((a, b) => apart(a.payday, tx.date) - apart(b.payday, tx.date) || a.month.localeCompare(b.month));
    if (one.length) {
      taken.add(one[0].id);
      out.push({ tx, payslips: [one[0]] });
      continue;
    }
    // One line for the whole month: every unpaid payslip of a month whose payouts add up to it.
    const byMonth = new Map<string, PayslipClose[]>();
    for (const c of unpaid) if (!taken.has(c.id) && nearPayday(tx, c)) byMonth.set(c.month, [...(byMonth.get(c.month) ?? []), c]);
    const month = [...byMonth.values()].find((cs) => cs.length > 1 && sum(cs.map((c) => c.payout)) === amount);
    if (month) {
      for (const c of month) taken.add(c.id);
      out.push({ tx, payslips: month });
    }
  }
  return out;
}

/**
 * Books the matches into `books` (inside the caller's write door, as a module): D 1091 / C the payment's
 * bank account per payslip, and the payslip's PDF linked to the payment. Returns the refs it booked.
 */
export function bookWagePayments(
  books: { transactions: BankTransaction[]; journalEntries: JournalEntry[]; mappings: Mapping[] },
  closes: readonly PayslipClose[], lock: Pick<PeriodLock, 'isClosed'>,
  bankAccountOf: (tx: BankTransaction) => string | undefined, clearing: string, newId: () => string, opts: MatchOptions,
): string[] {
  const matches = wageMatches(books, closes, lock, opts).filter((m) => bankAccountOf(m.tx));
  for (const { tx, payslips } of matches) {
    const bank = bankAccountOf(tx)!;
    for (const c of payslips) {
      const [y, m] = c.month.split('-');
      books.journalEntries.push({
        id: newId(), transactionRef: tx.ref, date: tx.date, accountDebit: clearing, accountCredit: bank, amount: c.payout,
        description: `Lohnzahlung ${m}/${y} ${c.person.name}`, by: { kind: 'code', check: 'payroll' }, ...(c.receiptId ? { receipts: [c.receiptId] } : {}),
      });
      if (c.receiptId) books.mappings.push({ transactionRef: tx.ref, receiptId: c.receiptId, by: 'rule', rule: 'payroll' });
    }
  }
  return matches.map((x) => x.tx.ref);
}

/**
 * What the bank line paid for this payslip: its entries off 1091 that name the payslip's PDF (one line may pay
 * a whole month); a line booked by hand naming no PDF counts whole when it pays only this payslip.
 */
export function paidFor(books: BooksLike, tx: BankTransaction, c: Pick<PayslipClose, 'receiptId'>): number {
  const onRef = books.journalEntries.filter((e) => e.transactionRef === tx.ref);
  const named = onRef.filter((e) => c.receiptId && e.receipts?.includes(c.receiptId));
  const lines = named.length ? named : books.mappings.filter((m) => m.transactionRef === tx.ref).length <= 1 ? onRef : [];
  return round2(lines.reduce((s, e) => s + e.amount, 0));
}

export interface PaymentRow {
  id: string; employee: string; name: string; iban?: string; payout: number;
  purpose: string; valueDate: string;
  /** The bank line that paid it, once a booking holds it: the line's amount, and what of it paid this payslip. */
  paid?: { ref: string; date: string; amount: number; forThis: number };
  /**
   * The payout less what the bank paid for it, when they differ (a payslip reopened and closed again with
   * another payout after its wage was paid): that much stays on 1091 until a payment or a booking settles it.
   */
  difference?: number;
}

/** The month's Lohnzahlungen: one row per closed payslip with something to pay. */
export function paymentRows(books: BooksLike, closes: readonly PayslipClose[], month: string): PaymentRow[] {
  return closes.filter((c) => c.month === month && c.payout !== 0).map((c) => {
    const tx = paymentOf(books, c);
    const [y, m] = c.month.split('-');
    const forThis = tx ? paidFor(books, tx, c) : 0;
    const difference = tx ? round2(c.payout - forThis) : 0;
    return {
      id: c.id, employee: c.employee, name: c.person.name, ...(c.person.iban ? { iban: c.person.iban } : {}), payout: c.payout,
      purpose: `Lohn ${m}/${y}`, valueDate: c.payday,
      ...(tx ? { paid: { ref: tx.ref, date: tx.date, amount: Math.abs(tx.amount), forThis } } : {}),
      ...(difference ? { difference } : {}),
    };
  });
}
