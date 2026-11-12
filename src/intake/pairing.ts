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
import { numbersIn, squash, tokensIn } from '../accounting/document-numbers.js';
import { creditSigned } from '../accounting/credit-signed.js';
import { baseCurrency, documents } from '../engines/index.js';
import { HEAD, wordsRe } from '../core/modules/words.js';
import { legOf } from '../workspace/money-accounts.js';
import { chargesOf } from './charges.js';
import { duplicatesIn } from './duplicates.js';
import { assessmentNumbers, namesAssessment } from '../booking/customs-invoice.js';
import type { Businesses } from './batch-payers.js';
import { DELAY, type Delays } from './delays.js';
import { isBankFee } from '../booking/separate-fee.js';
import { partPayment, partReceipts, partsOf } from '../accounting/batch-parts.js';

/** Which payments are candidates at all. */
export const BOUNDS = {
  /** Across currencies, both converted at the official daily rate of the payment's day: how much the amounts may differ, as a share (a bank's rate is not the official one). In one currency the amount is the same to the cent. */
  crossCurrency: 0.04,
  /** The payment's day lies from this many days before the receipt's day to this many after it; after it, further when the supplier's usual delay reaches further (src/intake/delays.ts DELAY.reach). */
  daysBefore: 10,
  daysAfter: 60,
  /** A payment this many days or more off the day a receipt expects it, while another payment fits that day, pays the neighbouring bill of a series: last month's invoice of a subscription is no pair for this month's charge (periodApart, #291). */
  period: 25,
} as const;

/**
 * What speaks for a candidate, in points. The amount: the same to the cent in one currency (or
 * the original amount the bank names for a payment in another, Wise's «Card transaction of 12.40
 * USD»), else across currencies within `nearShare` or within the bounds. The day: the first band
 * the distance falls in, from the day the supplier's usual delay expects the payment
 * (src/intake/delays.ts) when it pays days or weeks later, else from the receipt's day. The name: words of the payment's text in the receipt's vendor. A number of
 * the receipt («FM-78230») in the payment's text. The business: the payment names the business
 * the receipt is of by that business's file (src/intake/batch-payers.ts businesses). Room for more
 * signals: a new row here, nothing else.
 */
export const WEIGHTS = {
  amount: { same: 40, near: 25, within: 10, nearShare: 0.02 },
  day: [{ upTo: 3, points: 15 }, { upTo: 10, points: 10 }, { upTo: 30, points: 5 }],
  /** A payment before the receipt by more than this many days scores no day points: an invoice is rarely paid before it is written. */
  dayEarly: 3,
  name: { one: 12, more: 20 },
  /** The payment names the receipt's business by its file (match.tx, iban; learned names among them, src/knowledge/learned-names.ts): as strong as two words of its name. */
  business: 20,
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

/** A link the chain made: a better receipt may take it over (#291), a person's never. */
export const chainMade = (m: Pick<Mapping, 'rule'>): boolean => (Object.values(PAIR_RULE) as string[]).includes(ruleOf(m.rule) ?? '');

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
  return [c.amount === 'same' ? 'amount' : c.amount === 'original' ? 'original' : 'currency', ...(dayOf(c) > 0 ? ['day' as const] : []), ...(c.words > 0 || c.business ? ['name' as const] : []), ...(c.number ? ['number' as const] : [])];
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
  /** Of a collective payment (partsOf), the index of the part the receipt pays: each part is a candidate of its own, the link names the payment. */
  part?: number;
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
  /** The payment names the business the receipt is of, by that business's file. */
  business: boolean;
  /** The payment's day minus the receipt's. */
  days: number;
  /** The payment's day minus the day the supplier's usual delay expects it (src/intake/delays.ts); `days` for a supplier without one, or one that pays within the first day band. */
  offDays: number;
  /** The receipt the chain linked to this payment a whole period off it, whose link this receipt takes over (#291). */
  replaces?: string;
  /**
   * An invoice paid by money in (paysIn says money out): the firm's own invoice, which nothing but
   * its number tells from a supplier's. Only money in naming one of its numbers as a whole token, on
   * or after its day, is such a candidate; it is a clear pair only when no other payment names that
   * number (`number`), else it is proposed (#365). Money out never pays a credit note.
   */
  against?: true;
}

export interface PairSearch {
  /** Every pairable receipt, with its candidates, best first. */
  byReceipt: Map<string, PairCandidate[]>;
  /** Every pairable payment by its ref (its legs together), or a collective payment's part by slotOf, with its candidate receipts, best first. */
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
 * page (their own links, order-links.ts and the model), nor an order page of the provider way
 * (`noPayment`, src/booking/order-pages.ts, #253). A customs assessment, a document beside the
 * courier's invoice, is one too: import VAT paid to the customs office itself has it as its receipt
 * (fitOf holds it to a payment that names its number).
 */
export function pairableReceipt(r: Receipt, linked: ReadonlySet<string>, noPayment?: (r: Receipt) => boolean): boolean {
  return r.location === 'archived' && !linked.has(r.id) && !r.filedPayment && (!r.kind || r.kind === 'invoice' || r.kind === 'sales-record' || (r.kind === 'supporting' && namesAssessment(r, documents().customs)))
    && !!r.amount && !!r.date && !r.payout && !r.order && !noPayment?.(r);
}

/**
 * The payments the chain looks for a receipt for: money moved, no receipt linked or pointed at it
 * (`taken`), and not one that has no receipt of its own: marked as needing none, or what
 * `noReceipt` says (src/booking/receipt-wait.ts noReceiptOfItsOwn: an own transfer, a booking that
 * only settles, a fee row, a business or wording a rule exempts).
 */
export function pairablePayment(t: BankTransaction, taken: ReadonlySet<string>, noReceipt?: (t: BankTransaction) => boolean): boolean {
  return t.amount !== 0 && !isBankFee(t) && !t.noReceiptNeeded && !taken.has(t.ref) && !noReceipt?.(t);
}

/** What a candidate competes for: a payment, or one part of a collective payment (`ref#part`). */
export const slotOf = (c: Pick<PairCandidate, 'payment' | 'part'>): string => (c.part === undefined ? c.payment : `${c.payment}#${c.part}`);

/** The receipts that hold each payment by its ref: linked, or, for a filed payment, pointed at (Receipt.filedPayment, which the next correction counts). A link to a receipt the books lack holds it whole. */
function holdersOf(books: Pick<Books, 'mappings' | 'receipts'>, ref?: string): Map<string, Array<Pick<Receipt, 'amount' | 'currency'>>> {
  const byId = new Map(books.receipts.map((r) => [r.id, r]));
  const out = new Map<string, Array<Pick<Receipt, 'amount' | 'currency'>>>();
  const add = (at: string, r: Pick<Receipt, 'amount' | 'currency'>) => { if (ref === undefined || at === ref) (out.get(at) ?? out.set(at, []).get(at)!).push(r); };
  for (const m of books.mappings) add(m.transactionRef, byId.get(m.receiptId) ?? {});
  for (const r of books.receipts) if (r.filedPayment) add(r.filedPayment, r);
  return out;
}

/** The parts of a collective payment (partsOf) no receipt holds yet, by index (partReceipts): none when a receipt holds it whole. Undefined: no collective payment. */
export function freeParts(tx: BankTransaction, holders: ReadonlyArray<Pick<Receipt, 'amount' | 'currency'>>): number[] | undefined {
  if (!partsOf(tx)) return undefined;
  return partReceipts(tx, holders)?.flatMap((rs, i) => (rs.length ? [] : [i])) ?? [];
}

/** The payments receipts hold: every one a receipt is linked or pointed at, except a collective payment with a part no receipt holds yet. */
export function takenPayments(books: Pick<Books, 'mappings' | 'receipts' | 'transactions'>): Set<string> {
  const batches = new Map(books.transactions.filter((t) => partsOf(t)).map((t) => [t.ref, t]));
  return new Set([...holdersOf(books)].flatMap(([ref, rs]) => { const t = batches.get(ref); return t && freeParts(t, rs)!.length ? [] : [ref]; }));
}

/** Whether receipt `r` may be linked to payment `t` on these books: no receipt holds it, or it is a collective payment with a part of `r`'s amount no receipt holds yet. */
export function freeFor(books: Pick<Books, 'mappings' | 'receipts'>, t: BankTransaction, r: Pick<Receipt, 'amount' | 'currency'>): boolean {
  const holders = holdersOf(books, t.ref).get(t.ref) ?? [];
  return !holders.length || (!!partsOf(t) && !!partReceipts(t, [...holders, r]));
}

/** What a receipt is fitted against of one payment: the payment, or each part of a collective payment no receipt holds yet as a payment of its own (partPayment). */
function slotsOf(t: BankTransaction, holders: ReadonlyArray<Pick<Receipt, 'amount' | 'currency'>>): Array<{ tx: BankTransaction; part?: number }> {
  const free = freeParts(t, holders);
  return free ? free.map((i) => ({ tx: partPayment(t, t.parts![i]), part: i })) : [{ tx: t }];
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

/** The last day after the receipt's a payment is a candidate: the fixed window, or as far past the supplier's usual delay as DELAY.reach when that is further. */
const daysAfterOf = (usual: number | undefined): number => Math.max(BOUNDS.daysAfter, (usual ?? 0) + DELAY.reach);

/**
 * The day's points: the band the distance to the expected day falls in (offDays), none for a payment
 * early by more than WEIGHTS.dayEarly both before the receipt and before the expected day.
 */
function dayOf(c: Pick<PairCandidate, 'days' | 'offDays'>): number {
  if (c.days < -WEIGHTS.dayEarly && c.offDays < -WEIGHTS.dayEarly) return 0;
  return WEIGHTS.day.find((b) => Math.abs(c.offDays) <= b.upTo)?.points ?? 0;
}

/**
 * How a payment fits a receipt, or undefined when it lies outside the bounds: the money's way, the
 * day, and the amount (to the cent in one currency, its own, a part's or the original the bank
 * names; across currencies both at the official daily rate of the payment's day). Scored by WEIGHTS.
 */
export function fitOf(r: Receipt, tx: BankTransaction, toChf: ToChf, isClosed: (date: string) => boolean, businesses?: Businesses, usual?: number, namedBy?: NamedBy): PairCandidate | undefined {
  const days = Math.round((Date.parse(tx.date) - Date.parse(r.date!)) / DAY);
  if (days < -BOUNDS.daysBefore || days > daysAfterOf(usual)) return undefined;
  // Money in for an invoice only when it names one of its numbers as a whole token, on or after its day: the firm's own invoice (#365).
  const into = paysIn(r);
  const named = into === (tx.direction === 'CRDT') ? undefined : into || days < 0 ? [] : namedNumbers(r, tx);
  if (named && !named.length) return undefined;
  // A usual delay within the first day band says nothing the receipt's day does not: only a supplier that pays days or weeks later moves the expected day.
  const offDays = usual !== undefined && Math.abs(usual) > WEIGHTS.day[0].upTo ? days - usual : days;
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
  const text = squash(paymentText(tx));
  // A customs assessment pays nothing of its own, unless the payment names its number: then it went to the customs office for it.
  const assessment = r.kind === 'supporting' ? assessmentNumbers(r.extractedText ?? '', documents().customs) : undefined;
  if (assessment && !assessment.some((n) => text.includes(n))) return undefined;
  // Against its way the number counts only when this payment alone names it: a number other payments name too (digits common in them) is proposed, never paired.
  const number = named ? named.some((n) => namedBy?.(n) === 1) : !!assessment || numbersIn(r.extractedText ?? '').some((n) => text.includes(n));
  const vendor = [r.title?.vendor ?? '', r.description ?? '', r.filename].join(' ').toLowerCase();
  const words = nameWords(tx).filter((w) => vendor.includes(w)).length;
  const of = businesses?.ofReceipt(r);
  const business = !!of && businesses!.ofPayment(tx) === of;
  // The name counts once: by its words or by the business's file, whichever says more.
  const name = Math.max(words >= 2 ? WEIGHTS.name.more : words === 1 ? WEIGHTS.name.one : 0, business ? WEIGHTS.business : 0);
  const score = WEIGHTS.amount[amount === 'original' ? 'same' : amount] + dayOf({ days, offDays }) + name + (number ? WEIGHTS.number : 0);
  return { receipt: r.id, payment: tx.ref, leg: legOf(tx), charge: [tx.ref], filed: isClosed(tx.date), score, amount, number, words, business, days, offDays, ...(named ? { against: true as const } : {}) };
}

/** What a payment says of what it pays: its text, reference, remarks and its parts' references. */
const paymentText = (tx: BankTransaction): string => [tx.description, tx.reference ?? '', tx.remarks ?? '', ...(tx.parts ?? []).map((p) => p.reference ?? '')].join(' ');

/** How many payments of the books name a number (squashed) as a whole token of their text. */
export type NamedBy = (number: string) => number;

/** The receipt's numbers the payment names as whole tokens of its text. */
const namedNumbers = (r: Receipt, tx: BankTransaction): string[] => { const words = tokensIn(paymentText(tx)); return numbersIn(r.extractedText ?? '').filter((n) => words.has(n)); };

/** NamedBy over these payments, each counted once by its ref. */
function namedByOf(transactions: readonly BankTransaction[]): NamedBy {
  const refs = new Map<string, Set<string>>();
  for (const t of transactions) for (const w of tokensIn(paymentText(t))) (refs.get(w) ?? refs.set(w, new Set()).get(w)!).add(t.ref);
  return (n) => refs.get(n)?.size ?? 0;
}

/**
 * Of `payments`, every one fitOf could take for a receipt, in their order (which decides between
 * equal legs): in the receipt's currency only those of its amount to the cent (their own or a
 * part's), in another currency every one, each within the day bounds give or take a day, and
 * every payment without a day Date.parse reads. The rest fitOf refuses, so a receipt is held
 * against the few payments near it instead of a year's.
 */
function paymentsNear(payments: readonly BankTransaction[]): (r: Receipt, usual?: number) => readonly BankTransaction[] {
  const at = payments.map((t) => Date.parse(t.date));
  const key = (currency: string | undefined, amount: number) => `${currency}|${cents(amount)}`;
  const byAmount = new Map<string, number[]>();
  const byCurrency = new Map<string | undefined, number[]>();
  const undated: number[] = [];
  const add = <K>(index: Map<K, number[]>, k: K, i: number) => { const list = index.get(k); if (list) list.push(i); else index.set(k, [i]); };
  payments.forEach((t, i) => {
    add(byAmount, key(t.currency, t.amount), i);
    for (const p of t.parts ?? []) add(byAmount, key(p.currency, p.amount), i);
    if (Number.isFinite(at[i])) add(byCurrency, t.currency, i);
    else undated.push(i);
  });
  for (const list of byCurrency.values()) list.sort((a, b) => at[a] - at[b]);
  return (r, usual) => {
    const from = Date.parse(r.date!);
    if (!Number.isFinite(from)) return payments;
    const lo = from - (BOUNDS.daysBefore + 1) * DAY, hi = from + (daysAfterOf(usual) + 1) * DAY;
    const cur = r.currency || baseCurrency();
    const found = new Set(undated);
    for (const i of byAmount.get(key(cur, r.amount!)) ?? []) if (!(at[i] < lo || at[i] > hi)) found.add(i);
    for (const [currency, list] of byCurrency) {
      if (currency === cur) continue;
      let a = 0, b = list.length;
      while (a < b) { const mid = (a + b) >> 1; if (at[list[mid]] < lo) a = mid + 1; else b = mid; }
      for (let k = a; k < list.length && at[list[k]] <= hi; k++) found.add(list[k]);
    }
    return [...found].sort((a, b) => a - b).map((i) => payments[i]);
  };
}

/**
 * `far` lies a whole billing period off the day its receipt expects, while `near` fits on that day
 * with as much for it besides the day (amount, name, number): `far` pairs the neighbouring bill of a
 * series (#291). Of one receipt and two payments, `far` is no candidate; of one payment and two
 * receipts, `near`'s receipt is the payment's.
 */
export function periodApart(far: PairCandidate, near: PairCandidate): boolean {
  return Math.abs(far.offDays) >= BOUNDS.period && Math.abs(near.offDays) <= WEIGHTS.day[0].upTo && near.score - dayOf(near) >= far.score - dayOf(far);
}

/** The payments the chain alone linked to one receipt, in the open period and of one movement, with that receipt: a receipt that fits the payment's day better takes the link over (#291). */
function chainLinksOf(books: Books, isClosed: (date: string) => boolean): Map<string, { receipt: Receipt; payment: BankTransaction }> {
  const receipt = new Map(books.receipts.map((r) => [r.id, r]));
  const byPayment = new Map<string, Mapping[]>();
  const byReceipt = new Map<string, number>();
  for (const m of books.mappings) {
    byPayment.set(m.transactionRef, [...(byPayment.get(m.transactionRef) ?? []), m]);
    byReceipt.set(m.receiptId, (byReceipt.get(m.receiptId) ?? 0) + 1);
  }
  const out = new Map<string, { receipt: Receipt; payment: BankTransaction }>();
  for (const t of books.transactions) {
    const [m, ...more] = byPayment.get(t.ref) ?? [];
    const r = m && receipt.get(m.receiptId);
    if (r?.date && r.amount && !more.length && chainMade(m) && byReceipt.get(r.id) === 1 && !isClosed(t.date)) out.set(t.ref, { receipt: r, payment: t });
  }
  return out;
}

/** Best first: the score, then the day nearer the expected one. */
const rank = (a: PairCandidate, b: PairCandidate) => b.score - a.score || Math.abs(a.offDays) - Math.abs(b.offDays) || a.payment.localeCompare(b.payment);

/** What the search knows of the books beyond them: the payments without a receipt of their own, the receipts without a payment of their own, and whose a receipt and a payment are by the business files. */
export interface SearchOptions {
  noReceipt?: (t: BankTransaction) => boolean;
  noPayment?: (r: Receipt) => boolean;
  businesses?: Businesses;
  /** Each supplier's usual delay between receipt and payment, from the books' links (src/intake/delays.ts delaysOf). */
  delays?: Delays;
}

/**
 * The candidates of every pairable receipt and payment, each list best first. A pair a person took
 * apart (Receipt.notPaidBy) is never a candidate again. A filed payment is a candidate too: its
 * receipt is pointed at it, never linked (golden rule 1). Of a series of bills (#291): a payment a
 * whole period off a receipt's day is none while a payment of that day holds a receipt, and a
 * payment the chain linked to a receipt a period off is a candidate of the receipt of its day,
 * which takes the link over (periodApart).
 */
export function searchPairs(books: Books, toChf: ToChf, isClosed: (date: string) => boolean, { noReceipt, noPayment, businesses, delays }: SearchOptions = {}): PairSearch {
  const linkedReceipts = new Set(books.mappings.map((m) => m.receiptId));
  const taken = takenPayments(books);
  const charges = chargesOf(books.transactions, toChf);
  // A charge split across balances is pairable while none of its legs holds a receipt (one that does: linkSplitLegs completes the others).
  const payments = books.transactions.filter((t) => charges.of(t).refs.every((ref) => ref === t.ref ? pairablePayment(t, taken, noReceipt) : !taken.has(ref)));
  const byReceipt = new Map<string, PairCandidate[]>();
  const holders = holdersOf(books);
  const byPayment = new Map<string, PairCandidate[]>(payments.filter((t) => !partsOf(t)).map((t) => [charges.of(t).refs[0], []]));
  const pairable = books.receipts.filter((r) => pairableReceipt(r, linkedReceipts, noPayment));
  // Of two documents of one invoice (duplicatesIn), the copy is no candidate: it would compete with its original for one payment, or pair beside the one linked already (#190). It stays for Belege's copy question.
  const twins = pairable.length ? duplicatesIn([...pairable, ...books.receipts.filter((r) => linkedReceipts.has(r.id))], linkedReceipts, documents()) : new Map();
  const near = paymentsNear(payments);
  // The payments a receipt holds already: one on a receipt's day speaks against a candidate a whole period off it, and one the chain linked to a receipt a period off goes to the receipt of its day (#291).
  const held = books.transactions.filter((t) => taken.has(t.ref) && t.amount !== 0);
  const nearHeld = paymentsNear(held);
  const chainLinks = chainLinksOf(books, isClosed);
  const namedBy = namedByOf(books.transactions);
  for (const r of pairable) {
    if (twins.get(r.id)?.relation === 'duplicate') continue;
    const apart = new Set(r.notPaidBy ?? []);
    // One candidate per charge (per part of a collective payment): of a charge split over two currencies, the leg that fits best.
    const best = new Map<string, PairCandidate>();
    const usual = delays?.(r);
    for (const t of near(r, usual)) {
      const charge = charges.of(t);
      const split = charge.refs.length > 1;
      const fits = charge.refs.some((ref) => apart.has(ref)) ? [] : slotsOf(t, holders.get(t.ref) ?? []).flatMap(({ tx, part }) => {
        const f = fitOf(r, tx, toChf, isClosed, businesses, usual, namedBy);
        return f ? [part === undefined ? f : { ...f, part }] : [];
      }).sort(rank);
      // A collective payment fits by its best part, and by every part nothing tells from it (alikeSets pairs those).
      for (const fit of fits.filter((f, i) => i === 0 || (f.part !== undefined && likeness(f) === likeness(fits[0])))) {
        // A split charge is paid by what its original amount names, never by what one leg moved.
        const c = !split || fit.amount === 'original' ? { ...fit, payment: charge.refs[0], charge: charge.refs } : undefined;
        const had = c && best.get(slotOf(c));
        if (c && (!had || rank(c, had) < 0)) best.set(slotOf(c), c);
      }
    }
    const onItsDay = nearHeld(r, usual).flatMap((t) => (apart.has(t.ref) ? [] : fitOf(r, t, toChf, isClosed, businesses, usual, namedBy) ?? []));
    const mine = [...best.values()].filter((c) => !onItsDay.some((h) => periodApart(c, h)));
    for (const h of onItsDay) {
      const linked = chainLinks.get(h.payment);
      const theirs = linked && fitOf(linked.receipt, linked.payment, toChf, isClosed, businesses, delays?.(linked.receipt), namedBy);
      if (theirs && periodApart(theirs, h)) mine.push({ ...h, replaces: linked!.receipt.id });
    }
    for (const c of mine) (byPayment.get(slotOf(c)) ?? byPayment.set(slotOf(c), []).get(slotOf(c))!).push(c);
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

/** A candidate code may pair: one against the receipt's way only by a number no other payment names (#365). */
const pairable = (c: PairCandidate): boolean => !c.against || c.number;

/** The candidates of a list (best first) tied with its best, when they score CLEAR.score and lead the rest by CLEAR.margin; none otherwise. */
function tiedTop(list: readonly PairCandidate[]): PairCandidate[] {
  if (!list.length || list[0].score < CLEAR.score || !pairable(list[0])) return [];
  const top = list.filter((c) => c.score === list[0].score);
  const next = list[top.length];
  return next && list[0].score - next.score < CLEAR.margin ? [] : top;
}

/** What tells one pair from another: the fit, the day, the vendor's name, a number. */
const likeness = (c: PairCandidate): string => `${c.amount}|${c.days}|${c.offDays}|${c.words}|${c.business}|${c.number}|${c.filed}|${c.replaces ?? ''}|${c.against ?? ''}`;

/**
 * Receipts and payments nothing tells apart: n receipts whose clear candidates are the same n
 * payments (or parts of a collective payment, by slotOf), each of whose clear candidates are
 * those n receipts, every pair alike (the same fit, the same days, the same name). Two labels of
 * one shop on one day, paid by two card charges of that day: which goes with which changes no
 * booking, so they are paired one to one, the receipts by id against the payments by ref. A set
 * of unequal counts or with pairs that differ is none, unless every slot is a part of one
 * collective payment: fewer receipts than its alike parts are linked to that one payment all the
 * same.
 */
function alikeSets(search: PairSearch): Map<string, PairCandidate> {
  const out = new Map<string, PairCandidate>();
  const seen = new Set<string>();
  for (const [id, list] of search.byReceipt) {
    if (seen.has(id)) continue;
    const payments = tiedTop(list).map(slotOf).sort();
    if (payments.length < 2) continue;
    const receipts = tiedTop(search.byPayment.get(payments[0]) ?? []).map((c) => c.receipt).sort();
    for (const r of receipts) seen.add(r);
    const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const block = receipts.map((r) => tiedTop(search.byReceipt.get(r) ?? []));
    const onePayment = new Set(block.flat().map((c) => c.payment)).size === 1;
    const alike = (receipts.length === payments.length || (onePayment && receipts.length < payments.length))
      && block.every((top) => same(top.map(slotOf).sort(), payments))
      && payments.every((p) => same(tiedTop(search.byPayment.get(p) ?? []).map((c) => c.receipt).sort(), receipts))
      && new Set(block.flat().map(likeness)).size === 1;
    if (alike) receipts.forEach((r, i) => out.set(r, block[i].find((c) => slotOf(c) === payments[i])!));
  }
  return out;
}

/**
 * The stage of each pairable receipt, or of the one receipt or the receipts of the one payment
 * `only` names («Zahlung suchen», «Beleg suchen»). Clear: the receipt's best candidate scores
 * CLEAR.score and leads by CLEAR.margin, and the receipt leads its payment's list by as much; or
 * the receipt is one of a set nothing tells apart (alikeSets), paired one to one. A short list: 1
 * to SHORT_LIST candidates otherwise. No candidate, or more: the person's.
 */
export function stagesOf(search: PairSearch, only?: { receipt: string } | { payment: string }): PairStage[] {
  const ids = !only ? [...search.byReceipt.keys()]
    : 'receipt' in only ? (search.byReceipt.has(only.receipt) ? [only.receipt] : [])
      : [...new Set([...search.byPayment.values()].flatMap((list) => list.filter((c) => c.payment === only.payment).map((c) => c.receipt)))];
  const alike = alikeSets(search);
  return ids.map((id): PairStage => {
    const candidates = search.byReceipt.get(id) ?? [];
    const best = candidates[0];
    const theirs = best ? search.byPayment.get(slotOf(best)) ?? [] : [];
    if (best && pairable(best) && best.score >= CLEAR.score && marginOf(candidates) >= CLEAR.margin && theirs[0] === best && marginOf(theirs) >= CLEAR.margin) return { kind: 'clear', pair: best };
    const twin = alike.get(id);
    if (twin) return { kind: 'clear', pair: twin };
    if (candidates.length >= 1 && candidates.length <= SHORT_LIST) return { kind: 'short', receipt: id, candidates };
    return { kind: 'person', receipt: id, candidates: candidates.slice(0, SHORT_LIST), total: candidates.length };
  });
}
