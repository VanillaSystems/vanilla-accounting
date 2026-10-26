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
 * account, into the input tax on material and goods. An assessment that comes after the
 * payment was booked brings its deduction then (importVatDeductions): on the payment's day while
 * its quarter is open, else in the open period as a correction of the filed one (golden rule 1).
 * Pure and browser-safe; the words and accounts are the jurisdiction's data, no carrier is named.
 */
import { CUSTOMS_POSITIONS, type CustomsPosition, type DocumentsData } from '../core/modules/schema.js';
import { wordsRe } from '../core/modules/words.js';
import { isPurchaseDocument } from '../accounting/evidence-check.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { filingKeyOf, type FilingLength } from '../accounting/periods.js';
import { codeForRate } from '../accounting/vat-codes.js';
import { normalRate } from '../accounting/sales-without-vat.js';
import { baseCurrency, vat } from '../engines/index.js';
import type { ClassifyEntry } from '../llm/prompts.js';
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../types/index.js';

export type CustomsWords = DocumentsData['customs'];

/**
 * How far the payment may lie from what the invoices are worth at the day's rate, when it is made
 * in another currency than theirs (a card's own exchange margin): beyond it the split holds and says so.
 */
export const CURRENCY_SLACK = 0.05;

/** How many days an assessment no one linked may lie from the invoice whose import VAT it proves. */
export const ASSESSMENT_DAYS = 120;

/** One position of a customs invoice: its gross as the invoice states it, and the carrier's rate on it. */
export interface PositionLine { position: CustomsPosition; gross: number; rate?: number }

/** A customs invoice as read: its positions add up to its total, in its currency. */
export interface CustomsInvoice { receipt: string; file: string; date?: string; currency: string; total: number; lines: PositionLine[] }

/** The customs office's assessment of import VAT for the firm: the tax it states, in the books' currency. */
export interface Assessment { receipt: string; file: string; date?: string; amount: number }

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
  /** One line per position and rate of each invoice, then one deduction per assessment that proves an import VAT line. */
  lines: ClassifyEntry[];
  /** The deduction lines among `lines`: their amount is in the books' currency, whatever the payment's. */
  deductions: ReadonlySet<ClassifyEntry>;
  /** The import VAT the invoices pass on, in their currency, and how much of it no assessment proves yet. */
  importVat: number;
  unproven: number;
  currency: string;
  /** The assessments deducted. */
  assessments: Assessment[];
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

/**
 * A receipt read as a customs invoice: undefined when it is none (no line charges duty or import
 * VAT, or its lines were not read), a hold when one of its lines names no position or the lines do
 * not add up to its total. Lines of nothing (0.00) are left out; positions are summed per rate.
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
    const same = lines.find((x) => x.position === position && x.rate === rate);
    if (same) same.gross = fromRappen(toRappen(same.gross) + toRappen(l.gross));
    else lines.push({ position: position!, gross: l.gross, ...(rate !== undefined ? { rate } : {}) });
  }
  const sum = lines.reduce((s, x) => s + toRappen(x.gross), 0);
  if (r.amount !== undefined && toRappen(r.amount) !== sum) return { hold: { why: 'sum', file: r.filename, lines: fromRappen(sum), total: r.amount } };
  return { invoice: { receipt: r.id, file: r.filename, ...(r.date ? { date: r.date } : {}), currency: r.currency ?? baseCurrency(), total: fromRappen(sum), lines } };
}

const MONEY = /(\d{1,3}(?:['’]\d{3})+|\d+)[.,](\d{2})(?!\d)/;
const UID = /CHE[-\s.]?(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})/g;

/**
 * A receipt read as the customs office's assessment of import VAT for the firm whose UID is `uid`:
 * its title, the total of the tax after its label, and the firm's UID as importer, anywhere in the
 * text (a courier may put the assessment's pages behind its invoice). Undefined otherwise: an
 * assessment without the firm's UID proves nothing for the firm.
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
  return amount > 0 ? { receipt: r.id, file: r.filename, ...(r.date ? { date: r.date } : {}), amount } : undefined;
}

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
 * Each assessment with the import VAT line it proves: the line of the same amount, each line and
 * each assessment once, in order. An assessment whose amount no line has proves none.
 */
export function pairAssessments<L extends { amount: number }, A extends { amount: number }>(lines: readonly L[], assessments: readonly A[]): Array<{ line: L; assessment: A }> {
  const free = [...lines];
  return assessments.flatMap((assessment) => {
    const at = free.findIndex((l) => toRappen(l.amount) === toRappen(assessment.amount));
    return at < 0 ? [] : [{ line: free.splice(at, 1)[0], assessment }];
  });
}

/**
 * The payment `tx` split by the customs invoices linked to it (`documents`), or undefined when none
 * of them is one or the money came in. A hold when the invoices do not book it in code.
 */
export function customsSplit(tx: Pick<BankTransaction, 'amount' | 'currency' | 'direction'>, documents: readonly Receipt[], ctx: SplitContext): CustomsSplit | { hold: CustomsHold } | undefined {
  if (tx.direction !== 'DBIT') return undefined;
  const invoices: CustomsInvoice[] = [];
  const others: Receipt[] = [];
  const assessments = documents.map((r) => readAssessment(r, ctx.words, ctx.uid)).filter((a): a is Assessment => !!a);
  for (const r of documents.filter(isPurchaseDocument)) {
    const read = readCustomsInvoice(r, ctx.words);
    if (read && 'hold' in read) return read;
    if (read) invoices.push(read.invoice);
    else if (!assessments.some((a) => a.receipt === r.id)) others.push(r);
  }
  if (!invoices.length) return undefined;
  if (others.length) return { hold: { why: 'other', file: others[0].filename } };
  const missing = invoices.flatMap((i) => i.lines).map((l) => ctx.words.positions[l.position].account).find((a) => !ctx.chart.has(a));
  if (missing) return { hold: { why: 'account', account: missing } };

  const currency = invoices[0].currency;
  const total = invoices.reduce((s, i) => s + toRappen(i.total), 0);
  const paid = toRappen(Math.abs(tx.amount));
  if (invoices.some((i) => i.currency !== currency)) return { hold: { why: 'paid', invoices: fromRappen(total), paid: fromRappen(paid), currency: tx.currency } };
  if (currency === tx.currency && total !== paid) return { hold: { why: 'paid', invoices: fromRappen(total), paid: fromRappen(paid), currency } };
  if (currency !== tx.currency) {
    const worth = ctx.convert(fromRappen(total), currency);
    if (worth === undefined || Math.abs(toRappen(worth) - paid) > CURRENCY_SLACK * paid) {
      return { hold: { why: 'currency', invoices: fromRappen(total), currency, paid: fromRappen(paid), paidCurrency: tx.currency, slack: CURRENCY_SLACK * 100 } };
    }
  }
  // The payment's own amount, in proportion to what each position states.
  const flat = invoices.flatMap((i) => i.lines);
  const amounts = currency === tx.currency ? flat.map((l) => toRappen(l.gross)) : shares(paid, flat.map((l) => toRappen(l.gross)));
  const lines: ClassifyEntry[] = flat.map((l, k) => {
    const charged = l.rate !== undefined && l.rate > 0 && vat().isDomesticRate(l.rate);
    return {
      accountDebit: ctx.words.positions[l.position].account, accountCredit: '', amount: fromRappen(amounts[k]),
      vat: charged ? 'charged' : 'none', ...(charged ? { vatRate: l.rate } : {}),
      description: `${ctx.name}, ${ctx.texts.position(l.position)}`,
    };
  });
  const importVat = flat.filter((l) => l.position === 'importVat').map((l) => ({ amount: l.gross }));
  const proven = ctx.inputTax ? pairAssessments(importVat, assessments) : [];
  const deductions = new Set(proven.map(({ assessment }) => deductionLine(assessment, ctx.words, `${ctx.name}, ${ctx.texts.deduction(assessment)}`)).filter((l): l is ClassifyEntry => !!l));
  const vatTotal = importVat.reduce((s, l) => s + toRappen(l.amount), 0);
  const deducted = proven.reduce((s, p) => s + toRappen(p.assessment.amount), 0);
  return {
    lines: [...lines, ...deductions], deductions, currency,
    importVat: fromRappen(vatTotal), unproven: fromRappen(vatTotal - deducted),
    assessments: proven.map((p) => p.assessment),
  };
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

/** What the pass over the books needs: the split's words and firm, the books' lock, and how a new entry is made. */
export interface DeductionContext {
  words: CustomsWords;
  uid?: string;
  inputTax: boolean;
  isClosed: (date: string) => boolean;
  /** The first day of the open period: a correction of a filed quarter is dated there or later. */
  firstOpenDay: string;
  length: FilingLength;
  newId: () => string;
  texts: CustomsTexts;
}

const DAY = 864e5;

/**
 * The deductions assessments bring to import VAT the app split off a payment before them: every
 * payment whose booking has an import VAT line the split made (by customsSplit) gets, for each
 * import VAT position of its linked invoices that an assessment proves and no line deducts yet, the
 * one-legged line of the tax. The assessment is linked to the payment, points at it as its filed
 * payment, or stands alone and has that position's amount, dated within ASSESSMENT_DAYS of its
 * invoice, with no other position of that amount. While the payment's period is open the line
 * takes its day; once filed it is booked on the open period's first day (or the assessment's, when
 * later) as a correction of the filed period, with the filed entry's id in its description. Also
 * returns the assessments that stood alone, with the payment they now belong to. Idempotent.
 */
export function importVatDeductions(books: { journalEntries: readonly JournalEntry[]; mappings: readonly Mapping[]; receipts: readonly Receipt[] }, ctx: DeductionContext): { entries: JournalEntry[]; found: Array<{ receipt: string; payment: string }> } {
  if (!ctx.inputTax) return { entries: [], found: [] };
  const account = ctx.words.positions.importVat.account;
  const code = deductionCode(account);
  if (!code) return { entries: [], found: [] };
  const byId = new Map(books.receipts.map((r) => [r.id, r]));
  const linkedTo = new Map<string, string[]>();
  for (const m of books.mappings) linkedTo.set(m.receiptId, [...(linkedTo.get(m.receiptId) ?? []), m.transactionRef]);
  const split = books.journalEntries.filter((e) => e.by?.kind === 'code' && e.by.check === 'customsSplit' && e.accountDebit === account && e.accountCredit !== '');
  const payments = [...new Set(split.map((e) => e.transactionRef))];
  const lines = payments.flatMap((payment) => books.mappings
    .filter((m) => m.transactionRef === payment)
    .map((m) => byId.get(m.receiptId))
    .flatMap((r) => {
      const read = r && isPurchaseDocument(r) ? readCustomsInvoice(r, ctx.words) : undefined;
      return read && 'invoice' in read ? read.invoice.lines.filter((l) => l.position === 'importVat').map((l) => ({ payment, invoice: read.invoice, amount: l.gross })) : [];
    }));
  const assessments = books.receipts
    .filter((r) => r.kind !== 'duplicate')
    .map((r) => ({ r, a: readAssessment(r, ctx.words, ctx.uid) }))
    .filter((x): x is { r: Receipt; a: Assessment } => !!x.a);
  const deductions = books.journalEntries.filter((e) => e.vatCode === code && e.accountCredit === account && !e.accountDebit);
  const deducted = new Set(deductions.flatMap((e) => e.receipts ?? []));
  // An import VAT line counts as deducted once its payment has a deduction of its amount, whichever assessment brought it (a second copy brings none).
  const open = lines.filter((l) => {
    const at = deductions.findIndex((e) => e.transactionRef === l.payment && toRappen(e.amount) === toRappen(l.amount));
    if (at >= 0) deductions.splice(at, 1);
    return at < 0;
  });
  const entries: JournalEntry[] = [];
  const found: Array<{ receipt: string; payment: string }> = [];
  for (const { r, a } of assessments) {
    if (deducted.has(a.receipt)) continue;
    const pointed = [...(linkedTo.get(r.id) ?? []), ...(r.filedPayment ? [r.filedPayment] : [])];
    const near = (l: (typeof lines)[number]) => !a.date || !l.invoice.date || Math.abs(Date.parse(a.date) - Date.parse(l.invoice.date)) <= ASSESSMENT_DAYS * DAY;
    const candidates = open.filter((l) => toRappen(l.amount) === toRappen(a.amount) && (pointed.length ? pointed.includes(l.payment) : near(l)));
    if (candidates.length !== 1) continue;
    const [line] = candidates;
    const original = split.find((e) => e.transactionRef === line.payment);
    if (!original) continue;
    open.splice(open.indexOf(line), 1);
    if (!pointed.length) found.push({ receipt: r.id, payment: line.payment });
    const filed = ctx.isClosed(original.date);
    const date = filed ? [ctx.firstOpenDay, a.date ?? ''].sort().at(-1)! : original.date;
    const period = filed ? filingKeyOf(original.date, ctx.length) : undefined;
    entries.push({
      id: ctx.newId(), transactionRef: line.payment, date, accountDebit: '', accountCredit: account, amount: a.amount, vatCode: code,
      description: period ? ctx.texts.correction(a, original, period) : `${(original.description ?? '').split(',')[0]}, ${ctx.texts.deduction(a)}`,
      origin: 'classify', receipts: [a.receipt, line.invoice.receipt].sort(), ...(period ? { corrects: period } : {}),
      reason: ctx.texts.reason(a), by: { kind: 'code', check: 'customsSplit' },
    });
  }
  return { entries, found };
}
