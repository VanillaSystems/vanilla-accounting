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
import { textFacts } from '../parsers/receipt-text.js';
import { isPurchaseDocument } from '../accounting/evidence-check.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { filingKeyOf, type FilingLength } from '../accounting/periods.js';
import { codeForRate } from '../accounting/vat-codes.js';
import { normalRate } from '../accounting/sales-without-vat.js';
import { baseCurrency, vat } from '../engines/index.js';
import type { ClassifyEntry } from '../llm/prompts.js';
import type { BankTransaction, BookedBy, JournalEntry, Mapping, Receipt } from '../types/index.js';

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

/**
 * A receipt read as a customs invoice: undefined when it is none (no line charges duty or import
 * VAT, or its lines were not read), a hold when one of its lines names no position or the lines do
 * not add up to its total. Lines of nothing (0.00) are left out. Fees and freight are summed per
 * rate; each import VAT line stays apart, for an invoice of several shipments has one assessment each.
 */
export function readCustomsInvoice(r: Receipt, words: CustomsWords): { invoice: CustomsInvoice } | { hold: CustomsHold } | undefined {
  const items = (r.lineItems ?? []).filter((l) => toRappen(l.gross) !== 0);
  const named = items.map((l) => ({ l, position: positionOf(l.description, words) }));
  if (!named.some((n) => n.position === 'importVat' || n.position === 'duty')) return undefined;
  const loose = named.find((n) => !n.position || n.l.gross < 0);
  if (loose) return { hold: { why: 'line', file: r.filename, line: loose.l.description } };
  const lines: PositionLine[] = [];
  for (const { l, position } of named) {
    const rate = position === 'fees' || position === 'freight' ? l.ratePercent : undefined;
    const same = position === 'importVat' ? undefined : lines.find((x) => x.position === position && x.rate === rate);
    if (same) same.gross = fromRappen(toRappen(same.gross) + toRappen(l.gross));
    else lines.push({ position: position!, gross: l.gross, ...(rate !== undefined ? { rate } : {}) });
  }
  const sum = lines.reduce((s, x) => s + toRappen(x.gross), 0);
  if (r.amount !== undefined && toRappen(r.amount) !== sum) return { hold: { why: 'sum', file: r.filename, lines: fromRappen(sum), total: r.amount } };
  return { invoice: { receipt: r.id, file: r.filename, ...(r.date ? { date: r.date } : {}), currency: r.currency ?? baseCurrency(), total: fromRappen(sum), lines, numbers: assessmentNumbers(r.extractedText ?? '', words) } };
}

const MONEY = /(\d{1,3}(?:['’]\d{3})+|\d+)[.,](\d{2})(?!\d)/;
const UID = /CHE[-\s.]?(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})/g;

/**
 * A receipt read as the customs office's assessment of import VAT for the firm whose UID is `uid`:
 * its title, the total of the tax after its label, and the firm's UID as importer, anywhere in the
 * text (a courier may put the assessment's pages behind its invoice), with its number when it shows
 * one. Undefined otherwise: an assessment without the firm's UID proves nothing for the firm.
 */
export function readAssessment(r: Pick<Receipt, 'id' | 'filename' | 'date' | 'extractedText'>, words: CustomsWords, uid: string | undefined): Assessment | undefined {
  const text = r.extractedText ?? '';
  const digits = uid?.replace(/\D/g, '');
  if (!digits || !wordsRe(words.assessment.title).test(text)) return undefined;
  if (![...text.matchAll(UID)].some((m) => m.slice(1).join('') === digits)) return undefined;
  const label = wordsRe(words.assessment.total).exec(text);
  const money = label && MONEY.exec(text.slice(label.index + label[0].length, label.index + label[0].length + 80));
  if (!money) return undefined;
  const amount = Number(`${money[1].replace(/['’]/g, '')}.${money[2]}`);
  const [number] = assessmentNumbers(text, words);
  return amount > 0 ? { receipt: r.id, file: r.filename, ...(r.date ? { date: r.date } : {}), amount, ...(number ? { number } : {}) } : undefined;
}

/**
 * The tax and the day an assessment's text states, read when it arrives: a document beside an
 * invoice gets no facts from the match step, but the matching pairs an assessment with a payment
 * to the customs office by them (src/intake/pairing.ts). In the books' currency.
 */
export function assessmentFacts(text: string, words: CustomsWords): Pick<Receipt, 'amount' | 'currency' | 'date'> {
  const label = wordsRe(words.assessment.total).exec(text);
  const money = label && MONEY.exec(text.slice(label.index + label[0].length, label.index + label[0].length + 80));
  const date = textFacts(text).date;
  return { ...(money ? { amount: Number(`${money[1].replace(/['’]/g, '')}.${money[2]}`), currency: baseCurrency() } : {}), ...(date ? { date } : {}) };
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

/** Records on each assessment the deduction booked from it, by whomever: the passes never book from it again. */
function markDeducted(books: CustomsBooks, account: string, code: string): void {
  for (const e of books.journalEntries) {
    if (e.vatCode !== code || e.accountCredit !== account || e.accountDebit) continue;
    for (const r of books.receipts) if (!r.importVatDeduction && e.receipts?.includes(r.id) && r.extractedText) r.importVatDeduction = e.id;
  }
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
 * to an open payment is the split's (customsSplit books it with the payment). Idempotent. Returns how many.
 */
export function importVatDeductions(books: CustomsBooks, ctx: DeductionContext): number {
  const account = ctx.words.positions.importVat.account;
  const code = deductionCode(account);
  if (!ctx.inputTax || !code) return 0;
  markDeducted(books, account, code);
  const byId = new Map(books.receipts.map((r) => [r.id, r]));
  const linked = new Set(books.mappings.map((m) => m.receiptId));
  const isDeduction = (e: JournalEntry) => e.vatCode === code && e.accountCredit === account && !e.accountDebit;
  const lines = books.transactions.flatMap((t) => {
    const original = books.journalEntries.find((e) => e.transactionRef === t.ref && e.origin === 'classify' && e.accountDebit === account && !!e.accountCredit && e.by?.kind !== 'person' && e.by?.kind !== 'assistant');
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
    const candidates = open.filter((l) => proves(a, l) && (r.filedPayment ? l.payment === r.filedPayment : near(l)));
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
  return booked;
}
