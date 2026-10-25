/**
 * The tax point on the agreed basis (vereinbartes Entgelt, MWSTG Art. 39 Abs. 1, Art. 40 Abs. 1):
 * a sale's VAT arises when the invoice is issued, input tax when the bill is received, Bezugsteuer
 * when the bill is received too (Art. 48 Abs. 1 lit. b). The return declares what its entries'
 * dates say (src/accounting/declarations.ts), so the basis decides which entries exist and when:
 * a coded line is dated by its document and booked against the open item (Debitoren for a sale,
 * Kreditoren for a purchase); the payment only settles the open item, on its own date, and an
 * exchange difference the two rates leave goes to the Kursdifferenzen account (a foreign line takes
 * the rate of its tax point, MWSTV Art. 45 Abs. 1).
 *
 * On the cash basis (Art. 40 Abs. 2) every line keeps the payment's date and none of this applies.
 * Pure: the classifier (src/booking/classify.ts) and the invoices (src/invoices/events.ts) call it.
 */
import type { JournalEntry, Receipt } from '../types/index.js';
import type { PeriodLock } from '../books/store.js';
import { agreedBasis, baseCurrency, basisSince, vat, yearEnd } from '../engines/index.js';
import { isVatAmountCode } from './validate.js';
import { roundCHF, toRappen, fromRappen } from './rappen.js';
import { addDays, filingKeyOf, type FilingLength } from './periods.js';
import { SHOPIFY_ACCOUNT } from './payment-entries.js';

/** The accounts an open item lives on: what customers owe, what the firm owes suppliers, and where an exchange difference goes. */
export interface OpenItemAccounts { receivable: string; payable: string; fxDifference: string }

/** The jurisdiction's candidates (year-end.yaml accounts), the first the chart has, else the first. */
export function openItemAccounts(chart: readonly string[]): OpenItemAccounts {
  const has = new Set(chart);
  const pick = (candidates: readonly string[]) => candidates.find((a) => has.has(a)) ?? candidates[0];
  const roles = yearEnd().accounts;
  return { receivable: pick(roles.receivables), payable: pick(roles.payables), fxDifference: pick(roles.fxDifference) };
}

/** Whether an account holds open items: a payment's line on it may carry another date than the payment (src/server/edits.ts). */
export const isOpenItemAccount = (accounts: OpenItemAccounts, account: string): boolean => account === accounts.receivable || account === accounts.payable;

/** Which open item a code's VAT belongs to: a sale (a turnover box) or a purchase (input tax, Bezugsteuer); none for a correction, a tax amount, a zero purchase code. */
export function sideOf(code: string | undefined): 'sale' | 'purchase' | undefined {
  if (!code || isVatAmountCode(code)) return undefined;
  const info = vat().codes.parse(code);
  if (!info) return undefined;
  if (info.revenueZiffer || info.deductionZiffer) return 'sale';
  if (info.inputTaxZiffer || info.acquisitionZiffer) return 'purchase';
  return undefined;
}

/** The day an event of `date` is booked on: the date itself while the books take it, else the first day they take (after the locked line, from the books' first day). */
export function openDay(lock: Pick<PeriodLock, 'isClosed' | 'lockedThrough' | 'beforeBooks' | 'opens'>, date: string): string {
  if (lock.isClosed(date)) return addDays(lock.lockedThrough!, 1);
  if (lock.beforeBooks(date)) return lock.opens!;
  return date;
}

/**
 * Where the VAT of a document of a day the books no longer take is declared on the agreed basis:
 * in the correction return of its own filing period (golden rule 1), the firm reported
 * on this basis then (MWSTG Art. 40 Abs. 1); or, `switch`, after the switch, as an open item of it,
 * when the document lies before the books or before the year the basis began (MWSTV Art. 106 Abs. 1).
 */
export function lockedTaxPoint(lock: Pick<PeriodLock, 'beforeBooks'>, date: string, length: FilingLength): { corrects: string } | 'switch' {
  const since = basisSince();
  if (lock.beforeBooks(date) || (since !== undefined && Number(date.slice(0, 4)) < since)) return 'switch';
  return { corrects: filingKeyOf(date, length) };
}

/** One line of a settlement: the bank against the open item, or the exchange difference left on the open item. */
export type SettlementLine = Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'amount' | 'exchangeCurrency' | 'exchangeRate'> & { fx?: true };

export interface Settlement {
  /** The open-item account the payment settles. */
  account: string;
  bank: string;
  /** In the payment's currency, signed: + money in (a customer pays), − money out (the firm pays). */
  amount: number;
  currency: string;
  /** The payment's rate; absent in the books' currency. */
  rate?: number;
  /** What the open item holds in the books' currency for this amount, signed as a balance (debit +). */
  booked: number;
  fxDifference: string;
}

/**
 * The bank against the open item for what the payment moved, at the payment's rate, and, for a
 * foreign payment, the exchange difference that leaves the open item at what it held less what
 * was paid: a debit left over is a loss, a credit a gain.
 */
export function settlementLines(s: Settlement): SettlementLine[] {
  const abs = fromRappen(Math.abs(toRappen(s.amount)));
  if (abs === 0) return [];
  const foreign = s.rate !== undefined && s.currency !== baseCurrency();
  const main: SettlementLine = {
    accountDebit: s.amount > 0 ? s.bank : s.account,
    accountCredit: s.amount > 0 ? s.account : s.bank,
    amount: abs,
    ...(foreign && { exchangeCurrency: s.currency, exchangeRate: s.rate }),
  };
  if (!foreign) return [main];
  const paid = Math.sign(s.amount) * roundCHF(abs * s.rate!);
  const left = fromRappen(toRappen(s.booked) - toRappen(paid));
  if (left === 0) return [main];
  return [main, { accountDebit: left > 0 ? s.fxDifference : s.account, accountCredit: left > 0 ? s.account : s.fxDifference, amount: Math.abs(left), fx: true }];
}

export interface TaxPointContext {
  accounts: OpenItemAccounts;
  /** The payment's bank account: the side a coded line gives up to the open item. */
  bankAccount: string;
  lock: Pick<PeriodLock, 'isClosed' | 'lockedThrough' | 'beforeBooks' | 'opens'>;
  /** The official daily sell rate (ADR 0001) of a foreign line's new date. */
  rateOn: (currency: string, date: string) => number | undefined;
  /** The payment's documents (its linked receipts): their dates are the tax point. */
  documents: ReadonlyArray<Pick<Receipt, 'date' | 'kind'>>;
  /** The firm's filing length: a document of a filed period of the open year is declared in its correction (`corrects`). */
  length: FilingLength;
  newId: () => string;
}

type Payment = { ref: string; date: string; currency: string; description?: string };

/**
 * A payment's entries as the agreed basis books them. Each line with a sale or purchase code
 * (sideOf) that the payment's bank pays is dated by its documents: a
 * sale by the earliest (the tax is never declared late), a purchase by the latest (input tax never
 * claimed early), a minus code by the latest (a credit note or refund counts when it is booked,
 * MWSTG Art. 41), and booked against its open item. Only a purchase line may move after the payment:
 * a prepayment's tax arises when it is received (Art. 40 Abs. 1 lit. c); the payment settles each open item on its own
 * date. A document of a filed period of the books' open year leaves the line on the payment's date,
 * declared in that period's correction return (golden rule 1), and so does one of a closed earlier
 * year the firm reported on this basis; one before the books or before the year the basis began
 * leaves it on the payment's date as it is (lockedTaxPoint: the switch, MWSTV Art. 106 Abs. 1).
 * Lines on the payout clearing account (dated by their order already), with `corrects`, or without
 * a document date stay as they are.
 */
export function atTaxPoint(tx: Payment, entries: readonly JournalEntry[], ctx: TaxPointContext): JournalEntry[] {
  if (!agreedBasis()) return [...entries];
  const dates = ctx.documents.filter((d) => d.kind !== 'duplicate' && d.date).map((d) => d.date!).sort();
  if (!dates.length) return [...entries];
  const groups = new Map<string, { booked: number; amount: number; template: JournalEntry }>();
  const out = entries.map((e): JournalEntry => {
    const side = sideOf(e.vatCode);
    const bankDebit = e.accountDebit === ctx.bankAccount && e.accountCredit !== ctx.bankAccount;
    const bankCredit = e.accountCredit === ctx.bankAccount && e.accountDebit !== ctx.bankAccount;
    const onClearing = e.accountDebit === SHOPIFY_ACCOUNT || e.accountCredit === SHOPIFY_ACCOUNT;
    if (!side || e.corrects || onClearing || (!bankDebit && !bankCredit)) return e;
    // A later change (a minus code: a credit note, a refund) counts when it is booked, by the latest document (Art. 41).
    const change = e.vatCode!.startsWith(vat().codes.negativePrefix);
    const date = side === 'sale' && !change ? dates[0] : dates[dates.length - 1];
    if (date === tx.date) return e;
    // Only a bill's input tax may wait for a document after the payment. A sale's tax on a prepayment arises when it is
    // received (Art. 40 Abs. 1 lit. c), a change when it is paid (Art. 41); a document of a later year is a prepayment or a misread date.
    if (date > tx.date && (side === 'sale' || change || date.slice(0, 4) !== tx.date.slice(0, 4))) return e;
    if (ctx.lock.isClosed(date) || ctx.lock.beforeBooks(date)) {
      const point = lockedTaxPoint(ctx.lock, date, ctx.length);
      return point === 'switch' ? e : { ...e, corrects: point.corrects };
    }
    const account = side === 'sale' ? ctx.accounts.receivable : ctx.accounts.payable;
    const foreign = !!e.exchangeCurrency && e.exchangeCurrency !== baseCurrency();
    const rate = foreign ? ctx.rateOn(e.exchangeCurrency!, date) ?? e.exchangeRate : undefined;
    const moved: JournalEntry = {
      ...e,
      date,
      accountDebit: bankDebit ? account : e.accountDebit,
      accountCredit: bankCredit ? account : e.accountCredit,
      ...(rate !== undefined && { exchangeRate: rate }),
    };
    const sign = bankDebit ? 1 : -1;
    const group = groups.get(account) ?? { booked: 0, amount: 0, template: e };
    group.amount = fromRappen(toRappen(group.amount) + sign * toRappen(e.amount));
    group.booked = fromRappen(toRappen(group.booked) + sign * toRappen(rate !== undefined ? roundCHF(e.amount * rate) : e.amount));
    groups.set(account, group);
    return moved;
  });
  for (const [account, g] of groups) {
    const lines = settlementLines({ account, bank: ctx.bankAccount, amount: g.amount, currency: tx.currency, rate: g.template.exchangeRate, booked: g.booked, fxDifference: ctx.accounts.fxDifference });
    const { vatCode: _v, supply: _s, supplierCountry: _c, exchangeCurrency: _x, exchangeRate: _r, ...meta } = g.template;
    out.push(...lines.map(({ fx, ...l }): JournalEntry => ({ ...meta, ...l, id: ctx.newId(), date: tx.date, description: fx ? `Kursdifferenz ${tx.description ?? ''}`.trim() : meta.description })));
  }
  return out;
}
