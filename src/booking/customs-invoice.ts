/**
 * A courier's or forwarder's customs invoice booked by its positions (issue #197): the import VAT
 * the carrier advanced for the customs office, customs duty, the carrier's fees and freight, each
 * on its account (modules/ch documents.yaml `customs`, processes/booking.guide.yaml#shape
 * shp-zollrechnung). The model reads the invoice's lines once (Receipt.lineItems, the VAT step);
 * code names each line's position by its words and books it. The lines add up to the invoice and
 * the invoices to the payment, or nothing is split and the model decides, told why.
 *
 * The import VAT is booked as a cost without input tax: the carrier's invoice is no proof of it.
 * The customs office's assessment that names the firm as importer is (pv-import-vat-evv): with it
 * the tax is deducted by a one-legged line of the import VAT account's tax-amount code, off that
 * account, into the input tax on material and goods. Import VAT paid to the customs office itself
 * has the assessment as its receipt (the matching links it, src/intake/pairing.ts). An assessment that comes after the
 * payment was booked brings its deduction then (importVatDeductions): on the payment's day while
 * its quarter is open, else in the open period as a correction of the filed one (golden rule 1).
 * Each assessment proves one import VAT line, once: copies (the same assessment number) count as
 * one, and a deduction a person removed or changed is never booked again.
 * Pure and browser-safe; the words and accounts are the jurisdiction's data, no carrier is named.
 */
import { CUSTOMS_POSITIONS, type CustomsPosition, type DocumentsData } from '../core/modules/schema.js';
import { wordsRe } from '../core/modules/words.js';
import { amounts, textFacts } from '../parsers/receipt-text.js';
import { isPurchaseDocument } from '../accounting/evidence-check.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { filingKeyOf, type FilingLength } from '../accounting/periods.js';
import { codeForRate } from '../accounting/vat-codes.js';
import { normalRate } from '../accounting/sales-without-vat.js';
import { baseCurrency, vat } from '../engines/index.js';
import type { ClassifyEntry } from '../llm/prompts.js';
import type { BankTransaction, BookedBy, JournalEntry, Mapping, Receipt, ReceiptLine } from '../types/index.js';

export type CustomsWords = DocumentsData['customs'];

/**
 * How far the payment may lie from what the invoices are worth at the day's rate, when it is made
 * in another currency than theirs (a card's own exchange margin): beyond it the split holds and says so.
 */
export const CURRENCY_SLACK = 0.05;

/** How many days an assessment no one linked may lie from the invoice whose import VAT it proves. */
export const ASSESSMENT_DAYS = 120;

/**
 * Who books the split and its deductions: code, under the input-tax check older builds know, so a
 * sealed quarter that holds such a booking reads the same in every build (seals hash `by`).
 */
export const CUSTOMS_BY: BookedBy = { kind: 'code', check: 'purchaseVat' };

/** The rule a link the app makes to a customs assessment names (Mapping.rule). */
export const ASSESSMENT_LINK = 'customs-assessment';

/** One position of a customs invoice: its gross as the invoice states it, and the carrier's rate on it. */
export interface PositionLine { position: CustomsPosition; gross: number; rate?: number }

/** A customs invoice as read: its positions add up to its total, in its currency; the assessment numbers it names. */
export interface CustomsInvoice { receipt: string; file: string; date?: string; currency: string; total: number; lines: PositionLine[]; numbers: string[] }

/** The customs office's assessment of import VAT for the firm: the tax it states, in the books' currency, and its number. */
export interface Assessment { receipt: string; file: string; date?: string; amount: number; number?: string }

/** Why a payment's customs invoices are not split in code: the model books it, its reason says why. */
export type CustomsHold =
  /** A line of the invoice names no position, or duty and import VAT both. */
  | { why: 'line'; file: string; line: string }
  /** The invoice's lines do not add up to its total. */
  | { why: 'sum'; file: string; lines: number; total: number }
  /** The invoices do not add up to what the bank paid. */
  | { why: 'paid'; invoices: number; paid: number; currency: string }
  /** Paid in another currency, further from the invoices' worth than CURRENCY_SLACK, or on a day without a rate. */
  | { why: 'currency'; invoices: number; currency: string; paid: number; paidCurrency: string; slack: number }
  /** Another purchase document is linked beside the customs invoices. */
  | { why: 'other'; file: string }
  /** The chart lacks the position's account. */
  | { why: 'account'; account: string };

export interface CustomsSplit {
  /** One line per position and rate of each invoice (each import VAT line apart), then one deduction per assessment that proves an import VAT line. */
  lines: ClassifyEntry[];
  /** The deduction lines among `lines`: their amount is in the books' currency, whatever the payment's. */
  deductions: ReadonlySet<ClassifyEntry>;
  /** The import VAT the invoices pass on, in their currency, and how much of it no assessment proves yet. */
  importVat: number;
  unproven: number;
  currency: string;
  /** The assessments deducted. */
  assessments: Assessment[];
  /** Paid to the customs office itself: the assessments are the payment's receipts. */
  direct: boolean;
}

const positionRes = new WeakMap<CustomsWords, Array<{ position: CustomsPosition; re: RegExp }>>();
const resOf = (words: CustomsWords) => {
  let res = positionRes.get(words);
  if (!res) positionRes.set(words, res = CUSTOMS_POSITIONS.map((position) => ({ position, re: new RegExp(wordsRe(words.positions[position].words).source, 'giu') })));
  return res;
};

/**
 * The position a line names: the one of its longest word. A line that names duty and import VAT
 * both lumps two taxes into one figure and names none.
 */
export function positionOf(text: string, words: CustomsWords): CustomsPosition | undefined {
  const found = resOf(words).flatMap(({ position, re }) => [...text.matchAll(re)].map((m) => ({ position, length: m[0].length })));
  const named = new Set(found.map((f) => f.position));
  if (named.has('duty') && named.has('importVat')) return undefined;
  return found.sort((a, b) => b.length - a.length)[0]?.position;
}

/** The assessment numbers a text names (an invoice cites its shipment's, a payment's reference its own), without their version suffix. */
export function assessmentNumbers(text: string, words: CustomsWords): string[] {
  return [...new Set([...text.matchAll(new RegExp(words.assessment.number, 'g'))].map((m) => m[0].toUpperCase()))];
}

/** Whether a line names only the tax (the words of documents.yaml `customs.tax`): every word of it is one of the tax's names. */
function namesOnlyTax(text: string, words: CustomsWords): boolean {
  if (!words.tax?.length || !wordsRe(words.tax).test(text)) return false;
  return !text.replace(new RegExp(wordsRe(words.tax).source, 'giu'), '').replace(/[^\p{L}]/gu, '');
}

/** Whether a line at no rate names costs passed on free of VAT (documents.yaml `customs.untaxed`). */
const namesUntaxed = (l: ReceiptLine, words: CustomsWords): boolean => !l.ratePercent && !!words.untaxed?.length && wordsRe(words.untaxed).test(l.description);

/** The rate a line's own words state («8,10 % VAT»). */
function rateIn(text: string): number | undefined {
  const m = /(?<![\d.,])(\d{1,2}(?:[.,]\d{1,2})?)\s*%/.exec(text);
  return m ? Number(m[1].replace(',', '.')) : undefined;
}

/** A line's position, its rate, and whether it is the carrier's VAT on its own services. */
interface LineReading { position: CustomsPosition; rate?: number; carrierTax?: boolean }

/**
 * The position of a line on a customs invoice whose words name none:
 *  - a line that names only the tax and the domestic rate it is charged at («8,10 % VAT») is the
 *    carrier's VAT on its services: fees at that rate, added to the fees it is charged on;
 *  - a line that names only the tax at no rate is the import VAT the carrier advanced (the carrier's own
 *    VAT is charged at a rate on its services, never a line of 0 %); at a rate of the line's own, without
 *    the words saying which, it is none;
 *  - a line at the domestic rate is the carrier's own service, fees (duty and import VAT never carry
 *    Swiss VAT);
 *  - a line of costs passed on free of VAT at no rate, on an invoice that cites a declaration's number
 *    (`cites`), is the import VAT.
 * Else none.
 */
function unnamedPosition(l: ReceiptLine, words: CustomsWords, cites: boolean): LineReading | undefined {
  if (namesOnlyTax(l.description, words)) {
    const stated = rateIn(l.description);
    if (stated !== undefined) return vat().isDomesticRate(stated) ? { position: 'fees', rate: stated, carrierTax: true } : undefined;
    return l.ratePercent ? undefined : { position: 'importVat' };
  }
  if (l.ratePercent) return vat().isDomesticRate(l.ratePercent) ? { position: 'fees', rate: l.ratePercent } : undefined;
  return cites && namesUntaxed(l, words) ? { position: 'importVat' } : undefined;
}

/**
 * A receipt read as a customs invoice: undefined when it is none (no line, not even one of 0.00,
 * charges duty or import VAT by its words, nor costs free of VAT on an invoice that cites a customs
 * declaration's number, or its lines were not read), a hold when one of its
 * lines names no position or the lines do not add up to its total. A courier prints duty at 0.00
 * when none was due: such a line tells what the invoice is, and is left out of the booking. On a
 * customs invoice a line that names only the tax is import VAT and a line at the domestic rate is
 * fees (unnamedPosition). Fees and freight are summed per rate; each import VAT line stays apart,
 * for an invoice of several shipments has one assessment each.
 */
export function readCustomsInvoice(r: Receipt, words: CustomsWords): { invoice: CustomsInvoice } | { hold: CustomsHold } | undefined {
  const numbers = assessmentNumbers(r.extractedText ?? '', words);
  const all = (r.lineItems ?? []).map((l) => ({ l, position: positionOf(l.description, words) }));
  const customs = all.some((n) => n.position === 'importVat' || n.position === 'duty') || (numbers.length > 0 && all.some((n) => !n.position && namesUntaxed(n.l, words)));
  if (!customs) return undefined;
  const named = all.filter((n) => toRappen(n.l.gross) !== 0).map((n) => ({ l: n.l, reading: n.position ? { position: n.position } as LineReading : unnamedPosition(n.l, words, numbers.length > 0) }));
  const rateOf = (l: ReceiptLine, reading: LineReading) => reading.position === 'fees' || reading.position === 'freight' ? reading.rate ?? l.ratePercent : undefined;
  // The carrier's VAT is added to the fees it is charged on: without a fee at its rate, it is a line no position names.
  const loose = named.find(({ l, reading }) => !reading || l.gross < 0
    || (reading.carrierTax && !named.some((n) => n.reading && !n.reading.carrierTax && n.reading.position === 'fees' && rateOf(n.l, n.reading) === reading.rate)));
  if (loose) return { hold: { why: 'line', file: r.filename, line: loose.l.description } };
  const lines: PositionLine[] = [];
  for (const { l, reading } of named) {
    const { position } = reading!;
    const rate = rateOf(l, reading!);
    const same = position === 'importVat' ? undefined : lines.find((x) => x.position === position && x.rate === rate);
    if (same) same.gross = fromRappen(toRappen(same.gross) + toRappen(l.gross));
    else lines.push({ position, gross: l.gross, ...(rate !== undefined ? { rate } : {}) });
  }
  const sum = lines.reduce((s, x) => s + toRappen(x.gross), 0);
  if (r.amount !== undefined && toRappen(r.amount) !== sum) return { hold: { why: 'sum', file: r.filename, lines: fromRappen(sum), total: r.amount } };
  return { invoice: { receipt: r.id, file: r.filename, ...(r.date ? { date: r.date } : {}), currency: r.currency ?? baseCurrency(), total: fromRappen(sum), lines, numbers } };
}

const UID = /CHE[-\s.]?(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})/g;

/**
 * The assessment's total: the first money value after its label, on the label's page. The text
 * may put the values of the header's other fields between the two (the assessment's header is a
 * column of labels and a column of values: bordereau number, country, positions, the account, the
 * UID, the currency), none of them money; a date, a UID or a tariff number never reads as one.
 */
function assessmentTotal(text: string, words: CustomsWords): number | undefined {
  const label = wordsRe(words.assessment.total).exec(text);
  if (!label) return undefined;
  const from = label.index + label[0].length;
  const end = text.indexOf('\f', from);
  return amounts(text.slice(from, end < 0 ? undefined : end))[0];
}

/**
 * A receipt read as the customs office's assessment of import VAT for the firm whose UID is `uid`:
 * its title, its total (assessmentTotal), and the firm's UID as importer, anywhere in the text (a
 * courier may put the assessment's pages behind its invoice), with its number when it shows one.
 * Undefined otherwise: an assessment without the firm's UID proves nothing for the firm.
 */
export function readAssessment(r: Pick<Receipt, 'id' | 'filename' | 'date' | 'extractedText'>, words: CustomsWords, uid: string | undefined): Assessment | undefined {
  const text = r.extractedText ?? '';
  const digits = uid?.replace(/\D/g, '');
  if (!digits || !wordsRe(words.assessment.title).test(text)) return undefined;
  if (![...text.matchAll(UID)].some((m) => m.slice(1).join('') === digits)) return undefined;
  const amount = assessmentTotal(text, words);
  const [number] = assessmentNumbers(text, words);
  return amount ? { receipt: r.id, file: r.filename, ...(r.date ? { date: r.date } : {}), amount, ...(number ? { number } : {}) } : undefined;
}

/**
 * The tax and the day an assessment's text states, read when it arrives: a document beside an
 * invoice gets no facts from the match step, but the matching pairs an assessment with a payment
 * to the customs office by them (src/intake/pairing.ts). In the books' currency.
 */
export function assessmentFacts(text: string, words: CustomsWords): Pick<Receipt, 'amount' | 'currency' | 'date'> {
  const amount = assessmentTotal(text, words);
  const date = textFacts(text).date;
  return { ...(amount !== undefined ? { amount, currency: baseCurrency() } : {}), ...(date ? { date } : {}) };
}

/** Whether `a` proves an import VAT line of `invoice`: the same tax, and its number among those the invoice names, when the invoice names any. */
export const proves = (a: Assessment, line: { amount: number; invoice: Pick<CustomsInvoice, 'numbers'> }): boolean =>
  toRappen(a.amount) === toRappen(line.amount) && (!a.number || !line.invoice.numbers.length || line.invoice.numbers.includes(a.number));

/** The assessments, a copy of one (the same number) left out: copies prove one line between them. */
const distinct = <A extends Assessment>(list: readonly A[]): A[] => list.filter((a, i) => !a.number || list.findIndex((b) => b.number === a.number) === i);

/** Shares of `total` cents in proportion to `weights`, adding up to it exactly (the largest remainders get the odd cent). */
function shares(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  const order = raw.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest);
  const left = total - out.reduce((s, x) => s + x, 0);
  for (let k = 0; k < left; k++) out[order[k % order.length].i]++;
  return out;
}

/** The booking texts (German, docs/i18n.md): a position's name, a deduction's description and reason, a correction's description naming the filed entry. */
export interface CustomsTexts {
  position: (position: CustomsPosition) => string;
  deduction: (a: Assessment) => string;
  reason: (a: Assessment) => string;
  correction: (a: Assessment, entry: JournalEntry, period: string) => string;
}

/** What the split needs besides the payment: the words, the firm's accounts, the day's rate, and whether the firm deducts input tax at all. */
export interface SplitContext {
  words: CustomsWords;
  chart: ReadonlySet<string>;
  /** `amount` in `from` worth in the payment's currency on its day; undefined without a rate. */
  convert: (amount: number, from: string) => number | undefined;
  /** The firm's UID: an assessment proves import VAT for the firm it names. */
  uid?: string;
  /** False for a firm without input tax (not registered, net tax rate method): no deduction is ever booked. */
  inputTax: boolean;
  texts: Pick<CustomsTexts, 'position' | 'deduction'>;
  /** The payment's name, as each line's description begins. */
  name: string;
}

/**
 * Each assessment with the import VAT line it proves (proves), each line and each assessment once,
 * in order; copies of one assessment count once. An assessment that proves no line proves none.
 */
export function pairAssessments<L extends { amount: number; invoice: Pick<CustomsInvoice, 'numbers'> }, A extends Assessment>(lines: readonly L[], assessments: readonly A[]): Array<{ line: L; assessment: A }> {
  const free = [...lines];
  return distinct(assessments).flatMap((assessment) => {
    const at = free.findIndex((l) => proves(assessment, l));
    return at < 0 ? [] : [{ line: free.splice(at, 1)[0], assessment }];
  });
}

/**
 * The payment `tx` split by the customs invoices linked to it (`documents`), or by the assessments
 * alone when it paid the customs office itself; undefined when neither is linked or the money came
 * in. A hold when the invoices do not book it in code.
 */
export function customsSplit(tx: Pick<BankTransaction, 'amount' | 'currency' | 'direction'>, documents: readonly Receipt[], ctx: SplitContext): CustomsSplit | { hold: CustomsHold } | undefined {
  if (tx.direction !== 'DBIT') return undefined;
  const invoices: CustomsInvoice[] = [];
  const others: Receipt[] = [];
  const assessments = distinct(documents.map((r) => readAssessment(r, ctx.words, ctx.uid)).filter((a): a is Assessment => !!a));
  for (const r of documents.filter(isPurchaseDocument)) {
    const read = readCustomsInvoice(r, ctx.words);
    if (read && 'hold' in read) return read;
    if (read) invoices.push(read.invoice);
    else if (!assessments.some((a) => a.receipt === r.id)) others.push(r);
  }
  const paid = toRappen(Math.abs(tx.amount));
  if (!invoices.length) return others.length ? undefined : directSplit(tx, paid, assessments, ctx);
  if (others.length) return { hold: { why: 'other', file: others[0].filename } };
  const missing = invoices.flatMap((i) => i.lines).map((l) => ctx.words.positions[l.position].account).find((a) => !ctx.chart.has(a));
  if (missing) return { hold: { why: 'account', account: missing } };

  const currency = invoices[0].currency;
  const total = invoices.reduce((s, i) => s + toRappen(i.total), 0);
  if (invoices.some((i) => i.currency !== currency)) return { hold: { why: 'paid', invoices: fromRappen(total), paid: fromRappen(paid), currency: tx.currency } };
  if (currency === tx.currency && total !== paid) return { hold: { why: 'paid', invoices: fromRappen(total), paid: fromRappen(paid), currency } };
  if (currency !== tx.currency) {
    const worth = ctx.convert(fromRappen(total), currency);
    if (worth === undefined || Math.abs(toRappen(worth) - paid) > CURRENCY_SLACK * paid) {
      return { hold: { why: 'currency', invoices: fromRappen(total), currency, paid: fromRappen(paid), paidCurrency: tx.currency, slack: CURRENCY_SLACK * 100 } };
    }
  }
  // The payment's own amount, in proportion to what each position states.
  const flat = invoices.flatMap((invoice) => invoice.lines.map((line) => ({ line, invoice })));
  const amounts = currency === tx.currency ? flat.map(({ line }) => toRappen(line.gross)) : shares(paid, flat.map(({ line }) => toRappen(line.gross)));
  const lines: ClassifyEntry[] = flat.map(({ line: l }, k) => {
    const charged = l.rate !== undefined && l.rate > 0 && vat().isDomesticRate(l.rate);
    return {
      accountDebit: ctx.words.positions[l.position].account, accountCredit: '', amount: fromRappen(amounts[k]),
      vat: charged ? 'charged' : 'none', ...(charged ? { vatRate: l.rate } : {}),
      description: `${ctx.name}, ${ctx.texts.position(l.position)}`,
    };
  });
  const importVat = flat.filter(({ line }) => line.position === 'importVat').map(({ line, invoice }) => ({ amount: line.gross, invoice }));
  return withDeductions(lines, importVat, ctx.inputTax ? pairAssessments(importVat, assessments).map((p) => p.assessment) : [], currency, false, ctx);
}

/** Import VAT paid to the customs office itself: one import VAT line per assessment, which add up to the payment in the books' currency. */
function directSplit(tx: Pick<BankTransaction, 'currency'>, paid: number, assessments: readonly Assessment[], ctx: SplitContext): CustomsSplit | undefined {
  if (!assessments.length || tx.currency !== baseCurrency() || assessments.reduce((s, a) => s + toRappen(a.amount), 0) !== paid) return undefined;
  if (!ctx.chart.has(ctx.words.positions.importVat.account)) return undefined;
  const lines: ClassifyEntry[] = assessments.map((a) => ({ accountDebit: ctx.words.positions.importVat.account, accountCredit: '', amount: a.amount, vat: 'none', description: `${ctx.name}, ${ctx.texts.position('importVat')}` }));
  return withDeductions(lines, assessments.map((a) => ({ amount: a.amount })), ctx.inputTax ? [...assessments] : [], baseCurrency(), true, ctx);
}

function withDeductions(lines: ClassifyEntry[], importVat: ReadonlyArray<{ amount: number }>, proven: Assessment[], currency: string, direct: boolean, ctx: SplitContext): CustomsSplit {
  const deductions = new Set(proven.map((a) => deductionLine(a, ctx.words, `${ctx.name}, ${ctx.texts.deduction(a)}`)).filter((l): l is ClassifyEntry => !!l));
  const vatTotal = importVat.reduce((s, l) => s + toRappen(l.amount), 0);
  const deducted = proven.reduce((s, a) => s + toRappen(a.amount), 0);
  return { lines: [...lines, ...deductions], deductions, currency, importVat: fromRappen(vatTotal), unproven: fromRappen(vatTotal - deducted), assessments: proven, direct };
}

/**
 * The tax-amount code of the import VAT account at the normal rate (M81-2): its input tax goes to
 * the box of material and goods. The box takes the assessment's tax as stated, whatever its rate.
 */
function deductionCode(account: string): string | undefined {
  const gross = codeForRate(normalRate(), account, account);
  return gross ? vat().codes.taxAmountCode(gross) : undefined;
}

/** The one-legged line that deducts an assessment's tax off the import VAT account. */
function deductionLine(a: Assessment, words: CustomsWords, description: string): ClassifyEntry | undefined {
  const account = words.positions.importVat.account;
  const code = deductionCode(account);
  return code ? { accountDebit: '', accountCredit: account, amount: a.amount, vatCode: code, description } : undefined;
}

/** The books the passes read and write. */
export interface CustomsBooks { transactions: readonly BankTransaction[]; journalEntries: JournalEntry[]; mappings: Mapping[]; receipts: Receipt[] }

/** What the passes over the books need: the words and the firm, the books' lock, and how a new entry is made. */
export interface DeductionContext {
  words: CustomsWords;
  uid?: string;
  inputTax: boolean;
  isClosed: (date: string) => boolean;
  /** The first day of the open period: a correction of a filed quarter is dated there or later. */
  firstOpenDay: string;
  length: FilingLength;
  newId: () => string;
  /** The next free ref of a booking without a payment, in `date`'s year, in the books as they stand. */
  manualRef: (date: string) => string;
  texts: CustomsTexts;
}

/**
 * The assessments the passes may still use: read for the firm, not a copy or noise, not one a
 * person typed as something else, and not one a deduction was ever booked from (importVatDeduction,
 * also on a copy of it): a deduction a person removed or changed is hers.
 */
function usable(books: CustomsBooks, ctx: Pick<DeductionContext, 'words' | 'uid'>): Array<{ r: Receipt; a: Assessment }> {
  const read = books.receipts
    .filter((r) => r.kind !== 'duplicate' && r.kind !== 'noise' && !(r.kindBy === 'human' && r.kind !== 'supporting'))
    .map((r) => ({ r, a: readAssessment(r, ctx.words, ctx.uid) }))
    .filter((x): x is { r: Receipt; a: Assessment } => !!x.a);
  const used = new Set(read.filter(({ r }) => r.importVatDeduction).map(({ a }) => a.number ?? a.receipt));
  return read.filter(({ r, a }) => !r.importVatDeduction && !used.has(a.number ?? a.receipt));
}

/**
 * Records on each assessment the deduction booked from it, by whomever (the split, the pass, a
 * person): the passes never book from it again. Returns how many it marked.
 */
export function markDeducted(books: Pick<CustomsBooks, 'journalEntries' | 'receipts'>, ctx: Pick<DeductionContext, 'words' | 'uid'>): number {
  const account = ctx.words.positions.importVat.account;
  const code = deductionCode(account);
  if (!code) return 0;
  let marked = 0;
  for (const e of books.journalEntries) {
    if (e.vatCode !== code || e.accountCredit !== account || e.accountDebit) continue;
    for (const r of books.receipts) {
      if (r.importVatDeduction || !e.receipts?.includes(r.id) || !readAssessment(r, ctx.words, ctx.uid)) continue;
      r.importVatDeduction = e.id;
      marked++;
    }
  }
  return marked;
}

const DAY = 864e5;

/**
 * Whether a document reads as a customs assessment by its words (its title and the label of its
 * total), whoever it names: what the matching takes as a receipt of a payment to the customs office.
 */
export function namesAssessment(r: Pick<Receipt, 'extractedText'>, words: CustomsWords): boolean {
  const text = r.extractedText ?? '';
  return wordsRe(words.assessment.title).test(text) && wordsRe(words.assessment.total).test(text);
}

/**
 * The deductions assessments bring to import VAT the app booked before them, booked into `books`:
 * a payment whose app booking (not a person's) has an import VAT line gets, for each import VAT line
 * of its linked customs invoices that no deduction covers yet, the one-legged line of the tax, from
 * an assessment no one linked yet that proves it. The assessment points at the payment as its filed
 * payment, or stands alone, proving that line alone within ASSESSMENT_DAYS of its invoice. While the
 * payment's period is open the line takes its day and the assessment is linked to the payment;
 * once filed it is booked on the open period's first day (or the assessment's, when later) as a
 * correction of the filed period, a booking of its own without a payment that names the filed entry
 * and holds the assessment, which points at the filed payment (golden rule 1). An assessment linked
 * to an open payment is the split's (customsSplit books it with the payment). A payment whose import
 * VAT line claims input tax already (a rate code: the model or a rule booked it so) gets none, and a
 * payment a person took the assessment from (Receipt.notPaidBy) gets none from it. Idempotent.
 * Returns how many it booked, and how many assessments it marked as used (markDeducted): the
 * caller saves the books when either is more than none.
 */
export function importVatDeductions(books: CustomsBooks, ctx: DeductionContext): { booked: number; marked: number } {
  const account = ctx.words.positions.importVat.account;
  const code = deductionCode(account);
  if (!ctx.inputTax || !code) return { booked: 0, marked: 0 };
  const marked = markDeducted(books, ctx);
  // Only a line that claimed no input tax waits for its proof: one booked at a rate claimed it already.
  const withoutInputTax = (e: JournalEntry) => !e.vatCode || vat().codes.parse(e.vatCode)?.rate === 0;
  const byId = new Map(books.receipts.map((r) => [r.id, r]));
  const linked = new Set(books.mappings.map((m) => m.receiptId));
  const isDeduction = (e: JournalEntry) => e.vatCode === code && e.accountCredit === account && !e.accountDebit;
  const lines = books.transactions.flatMap((t) => {
    const original = books.journalEntries.find((e) => e.transactionRef === t.ref && e.origin === 'classify' && e.accountDebit === account && !!e.accountCredit && e.by?.kind !== 'person' && e.by?.kind !== 'assistant');
    if (original && !withoutInputTax(original)) return [];
    if (!original) return [];
    return books.mappings.filter((m) => m.transactionRef === t.ref).map((m) => byId.get(m.receiptId)).flatMap((r) => {
      const read = r && isPurchaseDocument(r) ? readCustomsInvoice(r, ctx.words) : undefined;
      return read && 'invoice' in read ? read.invoice.lines.filter((l) => l.position === 'importVat').map((l) => ({ payment: t.ref, original, invoice: read.invoice, amount: l.gross })) : [];
    });
  });
  // A line counts as deducted once a deduction of its amount stands for its payment: on it, or as a correction holding an assessment that points at it.
  const done = books.journalEntries.filter(isDeduction).map((e) => ({ e, payments: [e.transactionRef, ...(e.receipts ?? []).map((id) => byId.get(id)?.filedPayment).filter((p): p is string => !!p)] }));
  const open = lines.filter((l) => {
    const at = done.findIndex((d) => d.payments.includes(l.payment) && toRappen(d.e.amount) === toRappen(l.amount));
    if (at >= 0) done.splice(at, 1);
    return at < 0;
  });
  let booked = 0;
  for (const { r, a } of usable(books, ctx).filter(({ r }) => !linked.has(r.id))) {
    const near = (l: (typeof lines)[number]) => !a.date || !l.invoice.date || Math.abs(Date.parse(a.date) - Date.parse(l.invoice.date)) <= ASSESSMENT_DAYS * DAY;
    const candidates = open.filter((l) => proves(a, l) && !r.notPaidBy?.includes(l.payment) && (r.filedPayment ? l.payment === r.filedPayment : near(l)));
    if (candidates.length !== 1) continue;
    const [line] = candidates;
    open.splice(open.indexOf(line), 1);
    const { original } = line;
    const filed = ctx.isClosed(original.date);
    const entry: JournalEntry = filed
      ? ((date) => ({
        id: ctx.newId(), transactionRef: ctx.manualRef(date), date, accountDebit: '', accountCredit: account, amount: a.amount, vatCode: code,
        description: ctx.texts.correction(a, original, filingKeyOf(original.date, ctx.length)), origin: 'classify', receipts: [a.receipt],
        corrects: filingKeyOf(original.date, ctx.length), reason: ctx.texts.reason(a), by: CUSTOMS_BY,
      }))([ctx.firstOpenDay, a.date ?? ''].sort().at(-1)!)
      : {
        id: ctx.newId(), transactionRef: line.payment, date: original.date, accountDebit: '', accountCredit: account, amount: a.amount, vatCode: code,
        description: `${(original.description ?? '').split(',')[0]}, ${ctx.texts.deduction(a)}`, origin: 'classify',
        receipts: [...new Set([...books.mappings.filter((m) => m.transactionRef === line.payment).map((m) => m.receiptId), a.receipt])].sort(),
        reason: ctx.texts.reason(a), by: CUSTOMS_BY,
      };
    if (filed) r.filedPayment = line.payment;
    else {
      // The payment's bookings saw this receipt now: a later run does not book it again for it.
      for (const e of books.journalEntries) if (e.transactionRef === line.payment && e.origin === 'classify' && e.receipts && !e.corrects) e.receipts = [...e.receipts, a.receipt].sort();
    }
    books.journalEntries.push(entry);
    books.mappings.push({ transactionRef: entry.transactionRef, receiptId: r.id, by: 'rule', rule: ASSESSMENT_LINK });
    r.importVatDeduction = entry.id;
    linked.add(r.id);
    booked++;
  }
  return { booked, marked };
}

/** What a courier's invoice says is needed to fetch its assessment: the declaration numbers it cites, and the access code and the link beside it, each when it shows one. */
export interface AssessmentAccess { numbers: string[]; code?: string; url?: string }

const URL_RE = /https?:\/\/[^\s|<>()\]]+/g;
/** How near the label of the access code a link stands to be the one that fetches the assessment, in characters. */
const NEAR = 300;

/** The cell under the column `label` names in a table of the reading (`| … | EVV Code | … |`): its first row's, when not empty. */
function tableCell(text: string, label: RegExp): string | undefined {
  const rows = text.split('\n');
  for (let k = 0; k < rows.length - 2; k++) {
    if (!rows[k].trim().startsWith('|')) continue;
    const at = rows[k].split('|').map((c) => c.trim()).findIndex((c) => label.test(c) && !c.replace(label, '').replace(/[^\p{L}]/gu, ''));
    if (at < 0 || !/^\|[\s|:-]+$/.test(rows[k + 1].trim())) continue;
    const value = rows[k + 2].split('|').map((c) => c.trim())[at];
    if (value) return value;
  }
  return undefined;
}

/**
 * What the invoice's text says is needed to fetch the assessment (processes/authorities/bazg.yaml#evv-download):
 * the declaration numbers it cites, the access code after its label («Zugangscode: …») or under it in
 * a table, and the first link that stands near the label.
 */
export function assessmentAccess(text: string, words: CustomsWords): AssessmentAccess {
  const access = words.assessment.access ?? [];
  const label = access.length ? wordsRe(access) : undefined;
  const said = label && new RegExp(`${label.source}\\s*[:：]\\s*([^\\s|]{6,})`, 'iu').exec(text)?.[1];
  const code = said || (label ? tableCell(text, label) : undefined);
  const labels = label ? [...text.matchAll(new RegExp(label.source, 'giu'))].map((m) => m.index) : [];
  const url = [...text.matchAll(URL_RE)].find((m) => labels.some((at) => Math.abs(at - m.index) <= NEAR))?.[0].replace(/[.,;:]+$/, '');
  return { numbers: assessmentNumbers(text, words), ...(code ? { code } : {}), ...(url ? { url } : {}) };
}

/** An import VAT line of a booked payment's customs invoice that no deduction covers yet: the person fetches its assessment. */
export interface MissingAssessment {
  payment: string;
  date: string;
  /** The customs invoice: its receipt and file. */
  receipt: string;
  file: string;
  amount: number;
  currency: string;
  access: AssessmentAccess;
}

/**
 * The import VAT the app cannot deduct for want of the customs office's assessment («Veranlagungsverfügung
 * fehlt»): each import VAT line of a booked payment's linked customs invoices that no deduction stands
 * for (on the payment, or as a correction holding an assessment that points at it), with what the
 * invoice says is needed to fetch the assessment. None for a firm without input tax. Pure, so the
 * tasks and the books read the same lines.
 */
export function missingAssessments(books: Pick<CustomsBooks, 'transactions' | 'mappings' | 'receipts'> & { journalEntries?: readonly JournalEntry[] }, words: CustomsWords, inputTax: boolean): MissingAssessment[] {
  const account = words.positions.importVat.account;
  const code = deductionCode(account);
  if (!inputTax || !code) return [];
  const entries = books.journalEntries ?? [];
  const byId = new Map(books.receipts.map((r) => [r.id, r]));
  const booked = new Set(entries.map((e) => e.transactionRef));
  const done = entries.filter((e) => e.vatCode === code && e.accountCredit === account && !e.accountDebit)
    .map((e) => ({ e, payments: [e.transactionRef, ...(e.receipts ?? []).map((id) => byId.get(id)?.filedPayment).filter((p): p is string => !!p)] }));
  // An invoice linked to two payments (paid in parts) asks for its assessments once.
  const seen = new Set<string>();
  return books.transactions.filter((t) => t.direction === 'DBIT' && booked.has(t.ref)).flatMap((t) => books.mappings.filter((m) => m.transactionRef === t.ref).flatMap((m) => {
    const r = byId.get(m.receiptId);
    const read = r && !seen.has(r.id) && isPurchaseDocument(r) ? readCustomsInvoice(r, words) : undefined;
    if (!r || !read || !('invoice' in read)) return [];
    seen.add(r.id);
    const paidBy = books.mappings.filter((x) => x.receiptId === r.id).map((x) => x.transactionRef);
    return read.invoice.lines.filter((l) => l.position === 'importVat').flatMap((l): MissingAssessment[] => {
      const at = done.findIndex((d) => d.payments.some((p) => paidBy.includes(p)) && toRappen(d.e.amount) === toRappen(l.gross));
      if (at >= 0) { done.splice(at, 1); return []; }
      return [{ payment: t.ref, date: t.date, receipt: r.id, file: r.filename, amount: l.gross, currency: read.invoice.currency, access: assessmentAccess(r.extractedText ?? '', words) }];
    });
  }));
}
