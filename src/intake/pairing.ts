/**
 * The candidate search of the matching chain (#187): which payments a receipt nothing is linked to
 * could belong to, and which receipts a payment without one could, in code. Import order does not
 * matter: a receipt that came before its statement is found when the statement comes, and the
 * other way round. Pure and browser-safe.
 *
 * A payment is a candidate when it lies within the bounds (BOUNDS: the money's way, the amount, the
 * day). Each candidate gets a score from one table (WEIGHTS: amount, day, the vendor's name, a
 * document number) and its margin to the next best. A pair is «clear» when its score is high and
 * its margin clear both ways (CLEAR): the best candidate of its receipt by a margin, and its
 * payment's best receipt by a margin. A receipt with a few candidates (a short list) is the
 * model's to choose from; with none, or more than a short list, it is the person's.
 */
import type { BankTransaction, Mapping, Receipt } from '../types/index.js';
import { numbersIn, squash } from '../accounting/document-numbers.js';
import { creditSigned } from '../accounting/credit-signed.js';
import { baseCurrency, documents } from '../engines/index.js';
import { HEAD, wordsRe } from '../core/modules/words.js';

/** Which payments are candidates at all. */
export const BOUNDS = {
  /** Across currencies, both converted at the official daily rate of the payment's day: how much the amounts may differ, as a share (a bank's rate is not the official one). In one currency the amount is the same to the cent. */
  crossCurrency: 0.04,
  /** The payment's day lies from this many days before the receipt's day to this many after it. */
  daysBefore: 10,
  daysAfter: 60,
} as const;

/**
 * What speaks for a candidate, in points. The amount: the same to the cent in one currency (or
 * the original amount the bank names for a payment in another, Wise's «Card transaction of 12.40
 * USD»), else across currencies within `nearShare` or within the bounds. The day: the first band
 * the distance falls in. The name: words of the payment's text in the receipt's vendor. A number of
 * the receipt («FM-78230») in the payment's text. Room for more signals (a supplier's usual delay,
 * a learned alias): a new row here, nothing else.
 */
export const WEIGHTS = {
  amount: { same: 40, near: 25, within: 10, nearShare: 0.02 },
  day: [{ upTo: 3, points: 15 }, { upTo: 10, points: 10 }, { upTo: 30, points: 5 }],
  /** A payment before the receipt by more than this many days scores no day points: an invoice is rarely paid before it is written. */
  dayEarly: 3,
  name: { one: 12, more: 20 },
  number: 30,
} as const;

/** A clear pair: at least `score` points, and `margin` points ahead of the next candidate both ways (alone, its score is its margin). */
export const CLEAR = { score: 50, margin: 15 } as const;

/** A short list is the model's to choose from: more candidates than this are the person's, who sees the best of them and how many there were. */
export const SHORT_LIST = 5;

/** Who made a link, as the receipt shows it (Mapping.by and Mapping.rule). */
export type LinkMaker = 'code' | 'checked' | 'model' | 'person' | 'unknown';

/** The rules of the chain's links: a clear pair code linked alone, or one the model confirmed, or the model's choice from a short list. */
export const PAIR_RULE = { code: 'pair', checked: 'pair-checked', model: 'pair-choice' } as const;

export function makerOf(m: Pick<Mapping, 'by' | 'rule'>): LinkMaker {
  if (m.by === 'human') return 'person';
  if (m.rule === PAIR_RULE.checked) return 'checked';
  if (m.by === 'llm') return 'model';
  if (m.by === 'rule') return 'code';
  return 'unknown';
}

/** Who of the chain made a link: code alone, code checked by the model, the model from a short list. */
export type Maker = 'code' | 'checked' | 'model';

/**
 * What «Zahlung suchen» on a receipt or «Beleg suchen» on a payment found (POST /api/receipts/:id/find-payment,
 * /api/transactions/:ref/find-receipt): the pair linked (or, for a filed payment, the receipt pointed
 * at it) and who decided; else the code's candidates for the person to pick, the best SHORT_LIST of
 * `total`; else nothing within the bounds. `model`: a model took part.
 */
export type Found =
  | { outcome: 'linked' | 'filed'; receipt: string; payment: string; by: Maker; model: boolean }
  | { outcome: 'candidates'; candidates: Array<{ receipt: string; payment: string; score: number; filed: boolean }>; total: number; model: boolean }
  | { outcome: 'none'; model: boolean };

/** The link a stage of the chain makes. */
export function pairMapping(maker: Maker, transactionRef: string, receiptId: string): Mapping {
  return maker === 'code'
    ? { transactionRef, receiptId, by: 'rule', rule: PAIR_RULE.code }
    : { transactionRef, receiptId, by: 'llm', rule: PAIR_RULE[maker] };
}

/** An amount in the books' currency on a day: the official daily rate (src/accounting/fx-rates.ts), undefined without one. */
export type ToChf = (amount: number, currency: string, date: string) => number | undefined;

/** One receipt and one payment that may belong together, with what speaks for it. */
export interface PairCandidate {
  receipt: string;
  payment: string;
  /** The payment lies in a filed quarter: the receipt is pointed at it (Receipt.filedPayment), never linked. */
  filed: boolean;
  /** WEIGHTS summed. */
  score: number;
  /** How the amount fits: the same, the payment's original amount, or across currencies near or within the bounds. */
  amount: 'same' | 'original' | 'near' | 'within';
  /** One of the receipt's numbers is in the payment's text. */
  number: boolean;
  /** Words of the payment's text that name the receipt's vendor. */
  words: number;
  /** The payment's day minus the receipt's. */
  days: number;
}

export interface PairSearch {
  /** Every pairable receipt, with its candidates, best first. */
  byReceipt: Map<string, PairCandidate[]>;
  /** Every pairable payment, with its candidate receipts, best first. */
  byPayment: Map<string, PairCandidate[]>;
}

type Books = { receipts: readonly Receipt[]; transactions: readonly BankTransaction[]; mappings: readonly Mapping[] };

/** Words of a payment's text that name who was paid, not what the bank calls the booking. */
export const BANK_WORDS = new Set(['zahlung', 'gutschrift', 'belastung', 'lastschrift', 'einkauf', 'karte', 'debit', 'kredit', 'transfer', 'payment', 'rechnung', 'auftrag', 'dauerauftrag', 'ebanking', 'twint', 'mastercard', 'visa', 'august', 'september', 'oktober', 'november', 'dezember', 'januar', 'februar', 'april', 'juni', 'juli', 'card', 'transaction', 'issued', 'purchase', 'online', 'schweiz', 'switzerland', 'zürich', 'zurich']);
export const nameWords = (tx: BankTransaction): string[] => [...new Set([tx.description, tx.counterparty ?? '', ...(tx.parts ?? []).flatMap((p) => [p.counterparty, p.reference ?? ''])].join(' ').toLowerCase().match(/\p{L}{4,}/gu) ?? [])].filter((w) => !BANK_WORDS.has(w));

const DAY = 864e5;
const cents = (n: number) => Math.round(Math.abs(n) * 100);

/**
 * The amount a payment had in the currency it was made in, when its bank names one besides the
 * account's: the field the statement import keeps (BankTransaction.original), else an amount with a
 * currency code in its text («Card transaction of 12.40 USD», «USD 12.40»). The first such amount counts.
 */
export function originalOf(tx: BankTransaction): { amount: number; currency: string } | undefined {
  if (tx.original) return tx.original;
  const m = tx.description.match(/(?<![\w.])(-?\d+(?:[.,]\d{2}))\s+([A-Z]{3})\b|\b([A-Z]{3})\s+(-?\d+(?:[.,]\d{2}))(?![\d.])/);
  if (!m) return undefined;
  const amount = Number((m[1] ?? m[4]).replace(',', '.'));
  return Number.isFinite(amount) ? { amount: Math.abs(amount), currency: m[2] ?? m[3] } : undefined;
}

/** The receipts the chain looks for a payment for: read, kept, an invoice or a sales record with an amount and a date, nothing linked, not pointed at a filed payment, and no payout report or order page (their own links, order-links.ts and the model). */
export function pairableReceipt(r: Receipt, linked: ReadonlySet<string>): boolean {
  return r.location === 'archived' && !linked.has(r.id) && !r.filedPayment && (!r.kind || r.kind === 'invoice' || r.kind === 'sales-record')
    && !!r.amount && !!r.date && !r.payout && !r.order;
}

/** The payments the chain looks for a receipt for: money moved, no receipt linked, no bank fee. */
export function pairablePayment(t: BankTransaction, linked: ReadonlySet<string>): boolean {
  return t.amount !== 0 && t.type !== 'wise-fee' && !linked.has(t.ref);
}

/**
 * Money comes in for this receipt: a sales record, or a credit note, which says so by its total
 * below zero, by its VAT (creditSigned), or by its title in its first lines (documents.yaml
 * `credit`: «Gutschrift», «Credit note», «Note de crédit», «Nota di credito»).
 */
export function paysIn(r: Pick<Receipt, 'amount' | 'vatSummary' | 'kind' | 'extractedText'>): boolean {
  if (r.kind === 'sales-record' || (creditSigned(r) ?? 0) < 0) return true;
  const credit = documents().credit ?? [];
  return credit.length > 0 && wordsRe(credit).test((r.extractedText ?? '').slice(0, HEAD));
}

function dayPoints(days: number): number {
  if (days < -WEIGHTS.dayEarly) return 0;
  return WEIGHTS.day.find((b) => Math.abs(days) <= b.upTo)?.points ?? 0;
}

/**
 * How a payment fits a receipt, or undefined when it lies outside the bounds: the money's way, the
 * day, and the amount (to the cent in one currency, its own, a part's or the original the bank
 * names; across currencies both at the official daily rate of the payment's day). Scored by WEIGHTS.
 */
export function fitOf(r: Receipt, tx: BankTransaction, toChf: ToChf, isClosed: (date: string) => boolean): PairCandidate | undefined {
  if (paysIn(r) !== (tx.direction === 'CRDT')) return undefined;
  const days = Math.round((Date.parse(tx.date) - Date.parse(r.date!)) / DAY);
  if (days < -BOUNDS.daysBefore || days > BOUNDS.daysAfter) return undefined;
  const cur = r.currency || baseCurrency();
  const want = cents(r.amount!);
  const original = originalOf(tx);
  let amount: PairCandidate['amount'];
  if (cur === tx.currency && cents(tx.amount) === want) amount = 'same';
  else if ((tx.parts ?? []).some((p) => p.currency === cur && cents(p.amount) === want)) amount = 'same';
  else if (original && original.currency !== tx.currency && original.currency === cur) {
    // The bank names the amount in the receipt's currency: it is the amount, to the cent, or the payment is not this receipt's.
    if (cents(original.amount) !== want) return undefined;
    amount = 'original';
  } else if (cur === tx.currency) return undefined;
  else {
    const a = toChf(Math.abs(r.amount!), cur, tx.date);
    const b = toChf(Math.abs(tx.amount), tx.currency, tx.date);
    if (a === undefined || b === undefined || a === 0) return undefined;
    const off = Math.abs(b - a) / a;
    if (off > BOUNDS.crossCurrency) return undefined;
    amount = off <= WEIGHTS.amount.nearShare ? 'near' : 'within';
  }
  const text = squash([tx.description, tx.reference ?? '', tx.remarks ?? '', ...(tx.parts ?? []).map((p) => p.reference ?? '')].join(' '));
  const number = numbersIn(r.extractedText ?? '').some((n) => text.includes(n));
  const vendor = [r.title?.vendor ?? '', r.description ?? '', r.filename].join(' ').toLowerCase();
  const words = nameWords(tx).filter((w) => vendor.includes(w)).length;
  const score = WEIGHTS.amount[amount === 'original' ? 'same' : amount] + dayPoints(days)
    + (words >= 2 ? WEIGHTS.name.more : words === 1 ? WEIGHTS.name.one : 0) + (number ? WEIGHTS.number : 0);
  return { receipt: r.id, payment: tx.ref, filed: isClosed(tx.date), score, amount, number, words, days };
}

/** Best first: the score, then the nearer day. */
const rank = (a: PairCandidate, b: PairCandidate) => b.score - a.score || Math.abs(a.days) - Math.abs(b.days) || a.payment.localeCompare(b.payment);

/**
 * The candidates of every pairable receipt and payment, each list best first. A pair a person took
 * apart (Receipt.notPaidBy) is never a candidate again. A filed payment is a candidate too: its
 * receipt is pointed at it, never linked (golden rule 1).
 */
export function searchPairs(books: Books, toChf: ToChf, isClosed: (date: string) => boolean): PairSearch {
  const linkedReceipts = new Set(books.mappings.map((m) => m.receiptId));
  const linkedPayments = new Set(books.mappings.map((m) => m.transactionRef));
  const payments = books.transactions.filter((t) => pairablePayment(t, linkedPayments));
  const byReceipt = new Map<string, PairCandidate[]>();
  const byPayment = new Map<string, PairCandidate[]>(payments.map((t) => [t.ref, []]));
  for (const r of books.receipts) {
    if (!pairableReceipt(r, linkedReceipts)) continue;
    const apart = new Set(r.notPaidBy ?? []);
    const mine: PairCandidate[] = [];
    for (const t of payments) {
      const c = apart.has(t.ref) ? undefined : fitOf(r, t, toChf, isClosed);
      if (!c) continue;
      mine.push(c);
      byPayment.get(t.ref)!.push(c);
    }
    byReceipt.set(r.id, mine);
  }
  for (const list of [...byReceipt.values(), ...byPayment.values()]) list.sort(rank);
  return { byReceipt, byPayment };
}

/** How far the best of a list (best first) is ahead of the next: its score when alone. */
export const marginOf = (list: readonly PairCandidate[]): number => (list.length ? list[0].score - (list[1]?.score ?? 0) : 0);

/** What the chain does with one receipt: link its clear pair, let the model choose from its short list, or leave it to the person with its candidates. */
export type PairStage =
  | { kind: 'clear'; pair: PairCandidate }
  | { kind: 'short'; receipt: string; candidates: PairCandidate[] }
  /** `total`: how many candidates there were; more than SHORT_LIST are cut to the best SHORT_LIST, and the person is told so. */
  | { kind: 'person'; receipt: string; candidates: PairCandidate[]; total: number };

/**
 * The stage of each pairable receipt, or of the one receipt or the receipts of the one payment
 * `only` names («Zahlung suchen», «Beleg suchen»). Clear: the receipt's best candidate scores
 * CLEAR.score and leads by CLEAR.margin, and the receipt leads its payment's list by as much. A
 * short list: 1 to SHORT_LIST candidates otherwise. No candidate, or more: the person's.
 */
export function stagesOf(search: PairSearch, only?: { receipt: string } | { payment: string }): PairStage[] {
  const ids = !only ? [...search.byReceipt.keys()]
    : 'receipt' in only ? (search.byReceipt.has(only.receipt) ? [only.receipt] : [])
      : (search.byPayment.get(only.payment) ?? []).map((c) => c.receipt);
  return ids.map((id): PairStage => {
    const candidates = search.byReceipt.get(id) ?? [];
    const best = candidates[0];
    const theirs = best ? search.byPayment.get(best.payment) ?? [] : [];
    if (best && best.score >= CLEAR.score && marginOf(candidates) >= CLEAR.margin && theirs[0] === best && marginOf(theirs) >= CLEAR.margin) return { kind: 'clear', pair: best };
    if (candidates.length >= 1 && candidates.length <= SHORT_LIST) return { kind: 'short', receipt: id, candidates };
    return { kind: 'person', receipt: id, candidates: candidates.slice(0, SHORT_LIST), total: candidates.length };
  });
}
