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
import { legOf } from '../workspace/money-accounts.js';
import { chargesOf } from './charges.js';
import { duplicatesIn } from './duplicates.js';
import { assessmentNumbers, namesAssessment } from '../booking/customs-invoice.js';

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

/**
 * The rules of the chain's links: a clear pair code linked alone, or one the model confirmed, or
 * the model's choice from a short list. The rule names what matched after a colon
 * («pair:amount+day+name»), so the receipt says what code saw (signalsOf).
 */
export const PAIR_RULE = { code: 'pair', checked: 'pair-checked', model: 'pair-choice' } as const;

/** What matched in a pair: the amount (in one currency, the bank's original amount, or across currencies), the day, the vendor's name, a document number. */
export const SIGNALS = ['amount', 'original', 'currency', 'day', 'name', 'number'] as const;
export type Signal = (typeof SIGNALS)[number];

const ruleOf = (rule: string | undefined) => rule?.split(':')[0];

export function makerOf(m: Pick<Mapping, 'by' | 'rule'>): LinkMaker {
  if (m.by === 'human') return 'person';
  if (ruleOf(m.rule) === PAIR_RULE.checked) return 'checked';
  if (m.by === 'llm') return 'model';
  if (m.by === 'rule') return 'code';
  return 'unknown';
}

/** What matched in a link the chain made, from its rule; none for any other link. */
export function signalsOf(m: Pick<Mapping, 'rule'>): Signal[] {
  const [rule, list] = (m.rule ?? '').split(':');
  if (!Object.values(PAIR_RULE).includes(rule as never) || !list) return [];
  return list.split('+').filter((x): x is Signal => (SIGNALS as readonly string[]).includes(x));
}

/** What matched in a candidate. */
export function signalsOfCandidate(c: PairCandidate): Signal[] {
  return [c.amount === 'same' ? 'amount' : c.amount === 'original' ? 'original' : 'currency', ...(dayPoints(c.days) > 0 ? ['day' as const] : []), ...(c.words > 0 ? ['name' as const] : []), ...(c.number ? ['number' as const] : [])];
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
  | { outcome: 'linked' | 'filed'; receipt: string; payment: string; by: Maker; signals: Signal[]; model: boolean }
  | { outcome: 'candidates'; candidates: Array<{ receipt: string; payment: string; score: number; filed: boolean }>; total: number; model: boolean }
  | { outcome: 'none'; model: boolean };

/** The link a stage of the chain makes, naming what matched. */
export function pairMapping(maker: Maker, transactionRef: string, receiptId: string, signals: readonly Signal[]): Mapping {
  const rule = signals.length ? `${PAIR_RULE[maker]}:${signals.join('+')}` : PAIR_RULE[maker];
  return { transactionRef, receiptId, by: maker === 'code' ? 'rule' : 'llm', rule };
}

/** An amount in the books' currency on a day: the official daily rate (src/accounting/fx-rates.ts), undefined without one. */
export type ToChf = (amount: number, currency: string, date: string) => number | undefined;

/** One receipt and one payment that may belong together, with what speaks for it. */
export interface PairCandidate {
  receipt: string;
  /** The payment's ref: what a link names. */
  payment: string;
  /** The payment's leg (legOf): a card charge split over two currencies is two transactions with one ref. */
  leg: string;
  /** Every movement of its charge by ref, `payment` first: more than one for a card charge split across balances with a ref per leg (src/intake/charges.ts), each of which the link names. */
  charge: string[];
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
  /** Every pairable payment by its ref (its legs together), with its candidate receipts, best first. */
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
  const hits = ORIGINAL.flatMap(({ re, amount, currency }) => { const m = re.exec(tx.description); return m ? [{ at: m.index, amount: m[amount], currency: m[currency] }] : []; });
  const first = hits.sort((a, b) => a.at - b.at)[0];
  if (!first) return undefined;
  const amount = amountIn(first.amount);
  return Number.isFinite(amount) ? { amount: Math.abs(amount), currency: first.currency } : undefined;
}

/**
 * An amount with two decimals as banks write it: thousands grouped by «,» with a decimal point, by
 * «'» or «’», by «.» with a decimal comma, or not grouped («1,234.56», «1'234.56», «1.234,56»,
 * «1234.56»). A space groups thousands only right after «of» or the currency code («of 1 234.56
 * EUR», «EUR 1 234.56»): elsewhere «Order 12 345.00 USD» would read as 12,345.
 */
// A plain amount with exactly three digits before its decimals right after a number and a space is the tail of a space-grouped one («12 345.00»): not read.
const GROUPED = String.raw`-?\d{1,3}(?:,\d{3})+\.\d{2}|-?\d{1,3}(?:['’]\d{3})+[.,]\d{2}|-?\d{1,3}(?:\.\d{3})+,\d{2}|(?<!\d )-?\d{3}[.,]\d{2}|-?(?:\d{1,2}|\d{4,})[.,]\d{2}`;
const SPACED = String.raw`-?\d{1,3}(?: \d{3})+[.,]\d{2}`;
const END = String.raw`(?![\d.,'’])`;
const ORIGINAL: ReadonlyArray<{ re: RegExp; amount: number; currency: number }> = [
  { re: new RegExp(String.raw`(?<=\bof )(${SPACED})\s+([A-Z]{3})\b`), amount: 1, currency: 2 },
  { re: new RegExp(String.raw`\b([A-Z]{3}) (${SPACED})${END}`), amount: 2, currency: 1 },
  { re: new RegExp(String.raw`(?<![\w.,'’])(${GROUPED})\s+([A-Z]{3})\b`), amount: 1, currency: 2 },
  { re: new RegExp(String.raw`\b([A-Z]{3})\s+(${GROUPED})${END}`), amount: 2, currency: 1 },
];

/** The number an amount writes: the last separator before two digits is the decimal point, every other one groups thousands. */
const amountIn = (text: string): number => Number(text.replace(/[.,](\d{2})$/, 'D$1').replace(/[,'’ .]/g, '').replace('D', '.'));

/**
 * The receipts the chain looks for a payment for: read, kept, an invoice or a sales record with an
 * amount and a date, nothing linked, not pointed at a filed payment, and no payout report or order
 * page (their own links, order-links.ts and the model). A customs assessment, a document beside the
 * courier's invoice, is one too: import VAT paid to the customs office itself has it as its receipt
 * (fitOf holds it to a payment that names its number).
 */
export function pairableReceipt(r: Receipt, linked: ReadonlySet<string>): boolean {
  return r.location === 'archived' && !linked.has(r.id) && !r.filedPayment && (!r.kind || r.kind === 'invoice' || r.kind === 'sales-record' || (r.kind === 'supporting' && namesAssessment(r, documents().customs)))
    && !!r.amount && !!r.date && !r.payout && !r.order;
}

/**
 * The payments the chain looks for a receipt for: money moved, no receipt linked or pointed at it
 * (`taken`), and not one that has no receipt of its own: marked as needing none, or what
 * `noReceipt` says (src/booking/receipt-wait.ts noReceiptOfItsOwn: an own transfer, a booking that
 * only settles, a fee row, a business or wording a rule exempts).
 */
export function pairablePayment(t: BankTransaction, taken: ReadonlySet<string>, noReceipt?: (t: BankTransaction) => boolean): boolean {
  return t.amount !== 0 && t.type !== 'wise-fee' && !t.noReceiptNeeded && !taken.has(t.ref) && !noReceipt?.(t);
}

/** The payments a receipt holds: linked, or, for a filed payment, pointed at (Receipt.filedPayment, which the next correction counts). */
export const takenPayments = (books: Pick<Books, 'mappings' | 'receipts'>): Set<string> =>
  new Set([...books.mappings.map((m) => m.transactionRef), ...books.receipts.flatMap((r) => (r.filedPayment ? [r.filedPayment] : []))]);

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
  // A customs assessment pays nothing of its own, unless the payment names its number: then it went to the customs office for it.
  const assessment = r.kind === 'supporting' ? assessmentNumbers(r.extractedText ?? '', documents().customs) : undefined;
  if (assessment && !assessment.some((n) => text.includes(n))) return undefined;
  const number = !!assessment || numbersIn(r.extractedText ?? '').some((n) => text.includes(n));
  const vendor = [r.title?.vendor ?? '', r.description ?? '', r.filename].join(' ').toLowerCase();
  const words = nameWords(tx).filter((w) => vendor.includes(w)).length;
  const score = WEIGHTS.amount[amount === 'original' ? 'same' : amount] + dayPoints(days)
    + (words >= 2 ? WEIGHTS.name.more : words === 1 ? WEIGHTS.name.one : 0) + (number ? WEIGHTS.number : 0);
  return { receipt: r.id, payment: tx.ref, leg: legOf(tx), charge: [tx.ref], filed: isClosed(tx.date), score, amount, number, words, days };
}

/** Best first: the score, then the nearer day. */
const rank = (a: PairCandidate, b: PairCandidate) => b.score - a.score || Math.abs(a.days) - Math.abs(b.days) || a.payment.localeCompare(b.payment);

/**
 * The candidates of every pairable receipt and payment, each list best first. A pair a person took
 * apart (Receipt.notPaidBy) is never a candidate again. A filed payment is a candidate too: its
 * receipt is pointed at it, never linked (golden rule 1).
 */
export function searchPairs(books: Books, toChf: ToChf, isClosed: (date: string) => boolean, noReceipt?: (t: BankTransaction) => boolean): PairSearch {
  const linkedReceipts = new Set(books.mappings.map((m) => m.receiptId));
  const taken = takenPayments(books);
  const charges = chargesOf(books.transactions, toChf);
  // A charge split across balances is pairable while none of its legs holds a receipt (one that does: linkSplitLegs completes the others).
  const payments = books.transactions.filter((t) => charges.of(t).refs.every((ref) => ref === t.ref ? pairablePayment(t, taken, noReceipt) : !taken.has(ref)));
  const byReceipt = new Map<string, PairCandidate[]>();
  const byPayment = new Map<string, PairCandidate[]>(payments.map((t) => [charges.of(t).refs[0], []]));
  const pairable = books.receipts.filter((r) => pairableReceipt(r, linkedReceipts));
  // Of two documents of one invoice (duplicatesIn), the copy is no candidate: it would compete with its original for one payment, or pair beside the one linked already (#190). It stays for Belege's copy question.
  const twins = pairable.length ? duplicatesIn([...pairable, ...books.receipts.filter((r) => linkedReceipts.has(r.id))], linkedReceipts, documents()) : new Map();
  for (const r of pairable) {
    if (twins.get(r.id)?.relation === 'duplicate') continue;
    const apart = new Set(r.notPaidBy ?? []);
    // One candidate per charge: of a charge split over two currencies, the leg that fits best.
    const best = new Map<string, PairCandidate>();
    for (const t of payments) {
      const charge = charges.of(t);
      const split = charge.refs.length > 1;
      const fit = charge.refs.some((ref) => apart.has(ref)) ? undefined : fitOf(r, t, toChf, isClosed);
      // A split charge is paid by what its original amount names, never by what one leg moved.
      const c = fit && (!split || fit.amount === 'original') ? { ...fit, payment: charge.refs[0], charge: charge.refs } : undefined;
      const had = c && best.get(c.payment);
      if (c && (!had || rank(c, had) < 0)) best.set(c.payment, c);
    }
    const mine = [...best.values()];
    for (const c of mine) byPayment.get(c.payment)!.push(c);
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
