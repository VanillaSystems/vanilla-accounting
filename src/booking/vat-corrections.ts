/**
 * Receipts that prove a VAT-only correction, not a payment (#190 part 4). Some bills are evidence for
 * input tax booked on its own: a platform keeps its fees from its payouts and bills them once a month,
 * and that bill's VAT is booked as one single-leg entry without a payment (a `-2` code: the amount is
 * the tax, docs/runbooks/booking-patterns.md). No payment will ever come for such a bill. Which bills
 * these are is a fact in the business's file, never a name in code (ADR 0015): a document type with
 * `proves: vat-correction` (its `text` patterns recognise the bill). Such a receipt is never paired
 * with a payment (src/intake/pair-chain.ts noPaymentFor); Belege says what it is, and names the
 * correction booking it belongs to when exactly one fits. The booking step books the input tax of a
 * payment provider's such bill itself, or links the bill to the correction that fits
 * (bookVatCorrections); what it cannot decide stays with the person.
 *
 * vatCorrectionsOf is derived from the books and the business files on every read, never stored. Pure.
 */
import type { JournalEntry, Mapping, Receipt, BankTransaction } from '../types/index.js';
import type { Counterparty } from '../knowledge/counterparties.js';
import { isVatAmountCode } from '../accounting/validate.js';

/** What a document type of a business file may say it proves instead of a payment. */
export const PROVES = ['vat-correction'] as const;
export type Proves = (typeof PROVES)[number];

/** A correction booking dated this many days before to this many after its bill fits it. */
export const CORRECTION_DAYS = { before: 10, after: 90 } as const;

/**
 * A receipt that proves a VAT-only correction: whose (`business`, its id, and its `name`), the
 * document type that says so, the VAT it shows (none when it shows no VAT block), and the booking
 * without a payment that books that VAT (`booking`, its ref) when exactly one fits.
 */
export interface VatCorrection { business: string; name: string; document: string; vat?: number; booking?: string }

type Books = { receipts: readonly Receipt[]; mappings: readonly Mapping[]; transactions: readonly BankTransaction[]; journalEntries?: readonly JournalEntry[] };

const cents = (n: number) => Math.round(Math.abs(n) * 100);
const DAY = 864e5;

/** The business and document type that say a receipt proves a VAT-only correction, by its text. */
export function provenBy(r: Receipt, counterparties: readonly Counterparty[]): { cp: Counterparty; document: string } | undefined {
  const text = r.extractedText ?? '';
  for (const cp of counterparties) {
    for (const d of cp.documents) if (d.proves === 'vat-correction' && d.text.every((re) => re.test(text))) return { cp, document: d.id };
  }
  return undefined;
}

/**
 * Every receipt nothing is linked to that proves a VAT-only correction, by receipt id. Its booking:
 * the one booking without a payment (a ref no bank movement has) that carries no receipt yet, has one
 * leg with a VAT-amount code (`-2`) of the receipt's VAT to the centime, and lies within
 * CORRECTION_DAYS of the receipt's day.
 */
export function vatCorrectionsOf(books: Books, counterparties: readonly Counterparty[]): Map<string, VatCorrection> {
  const out = new Map<string, VatCorrection>();
  if (!counterparties.some((c) => c.documents.some((d) => d.proves))) return out;
  const linked = new Set(books.mappings.map((m) => m.receiptId));
  const withReceipt = new Set(books.mappings.map((m) => m.transactionRef));
  const payments = new Set(books.transactions.map((t) => t.ref));
  const corrections = (books.journalEntries ?? []).filter((e) => !payments.has(e.transactionRef) && !withReceipt.has(e.transactionRef) && isVatAmountCode(e.vatCode) && (!e.accountDebit || !e.accountCredit));
  for (const r of books.receipts) {
    if (linked.has(r.id)) continue;
    const hit = provenBy(r, counterparties);
    if (!hit) continue;
    const vat = r.vatSummary?.length ? r.vatSummary.reduce((sum, g) => sum + (g.vat ?? 0), 0) : undefined;
    const at = r.date ? Date.parse(r.date) : NaN;
    const fits = vat === undefined || !Number.isFinite(at) ? [] : corrections.filter((e) => {
      const days = (Date.parse(e.date) - at) / DAY;
      return cents(e.amount) === cents(vat) && days >= -CORRECTION_DAYS.before && days <= CORRECTION_DAYS.after;
    });
    const refs = [...new Set(fits.map((e) => e.transactionRef))];
    out.set(r.id, { business: hit.cp.id, name: hit.cp.name, document: hit.document, ...(vat !== undefined ? { vat } : {}), ...(refs.length === 1 ? { booking: refs[0] } : {}) });
  }
  return out;
}

/** The link rule of a bill linked by code to the correction that books its input tax. */
export const CORRECTION_LINK = 'vat-correction';

/**
 * Why code leaves such a bill to the person: it is dated in a filed period (`filed`), it shows no
 * Swiss VAT of its business (`noVat`), its business is no payment provider whose company file names a fee
 * account of the chart (`noAccount`), that account takes no code of the tax at the bill's rate
 * (`noCode`), or no daily rate converts its currency (`noRate`).
 */
export type CorrectionWait = 'noVat' | 'filed' | 'noAccount' | 'noCode' | 'noRate';

export interface CorrectionContext {
  /** The firm deducts input tax (the effective method). */
  inputTax: boolean;
  isClosed(date: string): boolean;
  inChart(account: string): boolean;
  base: string;
  /** The official daily sell rate of `currency` on `date`. */
  rate(currency: string, date: string): number | undefined;
  /** The code of the tax itself at `rate` on `account`: the company's `billVat` when it is of that rate. */
  code(rate: number, account: string, billVat: string | undefined): string | undefined;
  newId(): string;
  manualRef(date: string): string;
  texts: {
    description(business: string, date: string): string;
    reason(business: string, date: string, rate: number, currency: string, vat: number, code: string, account: string): string;
  };
}

export interface CorrectionsDone {
  booked: Array<{ receipt: string; ref: string }>;
  linked: Array<{ receipt: string; ref: string }>;
  waiting: Array<{ receipt: string; why: CorrectionWait }>;
}

/**
 * The input tax a payment provider's fee bill shows, booked into `books` (call it inside the write
 * door): one single-leg entry per rate on the provider's fee account (`provider.fees` of the company's
 * file), empty debit, the code of the tax itself, in the bill's currency at the daily rate of its day,
 * under a ref of its own, with the bill linked to it. A correction booking that books the bill's VAT
 * already (vatCorrectionsOf `booking`, a person's) takes the link instead. A bill linked to anything,
 * or one a person took apart from a booking (Receipt.notPaidBy: the link undone or the booking
 * deleted), is done, so each bill books once and never again over the person. Only the business's
 * Swiss VAT (its UID when its file names one), only in an open period. `only`: the one bill to book, as
 * a person's «Vorsteuer buchen» on it asks (#458); absent, every bill.
 */
export function bookVatCorrections(books: Books & { mappings: Mapping[]; journalEntries: JournalEntry[] }, counterparties: readonly Counterparty[], ctx: CorrectionContext, only?: string): CorrectionsDone {
  const done: CorrectionsDone = { booked: [], linked: [], waiting: [] };
  if (!ctx.inputTax) return done;
  const byId = new Map(counterparties.map((c) => [c.id, c]));
  const receipts = new Map(books.receipts.map((r) => [r.id, r]));
  for (const [id, found] of vatCorrectionsOf(books, counterparties)) {
    if (only !== undefined && id !== only) continue;
    const r = receipts.get(id)!;
    if (r.notPaidBy?.length || !r.date) continue;
    const date = r.date;
    const wait = (why: CorrectionWait) => done.waiting.push({ receipt: id, why });
    if (found.booking) {
      const entries = books.journalEntries.filter((e) => e.transactionRef === found.booking);
      if (entries.some((e) => ctx.isClosed(e.date))) continue;
      books.mappings.push({ transactionRef: found.booking, receiptId: id, by: 'rule', rule: CORRECTION_LINK });
      for (const e of entries) e.receipts = [...new Set([...(e.receipts ?? []), id])].sort();
      done.linked.push({ receipt: id, ref: found.booking });
      continue;
    }
    const cp = byId.get(found.business)!;
    const groups = (r.vatSummary ?? []).filter((g) => g.ratePercent > 0 && g.vat > 0);
    if (ctx.isClosed(date)) { wait('filed'); continue; }
    if (!r.hasSwissVat || !groups.length || (cp.match.uid.length > 0 && !cp.match.uid.includes(r.vatId ?? ''))) { wait('noVat'); continue; }
    const fees = cp.provider?.fees;
    if (!fees || !ctx.inChart(fees.account)) { wait('noAccount'); continue; }
    const currency = r.currency ?? ctx.base;
    const rate = currency === ctx.base ? undefined : ctx.rate(currency, date);
    if (currency !== ctx.base && rate === undefined) { wait('noRate'); continue; }
    const codes = groups.map((g) => ctx.code(g.ratePercent, fees.account, fees.billVat));
    if (codes.some((c) => !c)) { wait('noCode'); continue; }
    const ref = ctx.manualRef(date);
    groups.forEach((g, k) => books.journalEntries.push({
      id: ctx.newId(), transactionRef: ref, date, accountDebit: '', accountCredit: fees.account, amount: g.vat, vatCode: codes[k],
      description: ctx.texts.description(cp.name, date),
      ...(rate !== undefined ? { exchangeCurrency: currency, exchangeRate: rate } : {}),
      origin: 'classify', receipts: [id], reason: ctx.texts.reason(cp.name, date, g.ratePercent, currency, g.vat, codes[k]!, fees.account),
      by: { kind: 'code', check: 'purchaseVat' },
    }));
    books.mappings.push({ transactionRef: ref, receiptId: id, by: 'rule', rule: CORRECTION_LINK });
    done.booked.push({ receipt: id, ref });
  }
  return done;
}
