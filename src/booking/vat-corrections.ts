/**
 * Receipts that prove a VAT-only correction, not a payment (#190 part 4). Some bills are evidence for
 * input tax booked on its own: a platform keeps its fees from its payouts and bills them once a month,
 * and that bill's VAT is booked as one single-leg entry without a payment (a `-2` code: the amount is
 * the tax, docs/runbooks/booking-patterns.md). No payment will ever come for such a bill. Which bills
 * these are is a fact in the business's file, never a name in code (ADR 0015): a document type with
 * `proves: vat-correction` (its `text` patterns recognise the bill). Such a receipt is never paired
 * with a payment (src/intake/pair-chain.ts noPaymentFor); Belege says what it is, and names the
 * correction booking it belongs to when exactly one fits, for the person to link.
 *
 * Derived from the books and the business files on every read, never stored. Pure.
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
function provenBy(r: Receipt, counterparties: readonly Counterparty[]): { cp: Counterparty; document: string } | undefined {
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
