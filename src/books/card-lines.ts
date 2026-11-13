/**
 * The lines of a credit card's statement (#409). The statement is the receipt of the card's
 * settlement on the bank account (#401); its lines are read by code and kept on it
 * (Receipt.cardLines), so that the bill behind one line (a hotel, a foreign service) can be linked
 * to that line: a mapping on the settlement with the line's index (Mapping.line). The booking then
 * splits the settlement by its lines, and only a line with its own bill takes that bill's VAT
 * (src/booking/classify.ts byParts). Pure and browser-safe; the write is linkCardLines, inside the
 * caller's write door.
 */
import type { DocumentsData } from '../core/modules/schema.js';
import type { BankTransaction, BankTransactionPart, CardLine, Mapping, Receipt } from '../types/index.js';
import { toRappen } from '../accounting/rappen.js';
import { documentWordsInUse, isCardStatement } from './statement-facts.js';

/** How many days a bill's date may lie from its line's: a hotel's bill is dated the day she left, the card's line the day it was charged. */
export const CARD_LINE_DAYS = 5;

const DATE = String.raw`(?:\d{1,2}\.\d{1,2}\.(?:20)?\d{2}|20\d{2}-\d{2}-\d{2})`;
/** An amount as a statement prints it: «164.00», «1'234.50», «1 234,50», a minus before or after it. */
const AMOUNT = String.raw`[-−]?\d+(?:['’ ]\d{3})*[.,]\d{2}(?:\s?[-−])?`;
const ROW = new RegExp(`^\\s*(${DATE})(?:\\s+${DATE})?\\s+(.+?)\\s+(${AMOUNT})\\s*$`, 'u');
const ONLY_DATES = new RegExp(`^(${DATE})(?:\\s+${DATE})?$`, 'u');
const ONLY_AMOUNT = new RegExp(`^(?:[A-Z]{3}\\s*)?(${AMOUNT})$`, 'u');
const AMOUNTS = new RegExp(`(?<![\\d.,'’])${AMOUNT}(?![\\d])`, 'gu');
/** A foreign amount a line names: «USD 180.00», «180.00 USD». */
const FOREIGN = new RegExp(`(?:\\b([A-Z]{3})\\s+(${AMOUNT})|(${AMOUNT})\\s+([A-Z]{3})\\b)`, 'u');
/** The heading of the amount column: «Betrag EUR», «Amount USD». */
const CURRENCY_HEAD = /^[^\d\n]*\p{L}[^\d\n]*\s([A-Z]{3})\s*$/mu;

const isoDay = (d: string): string | undefined => {
  if (/^\d{4}-/.test(d)) return d;
  const [day, month, year] = d.split('.');
  const y = year.length === 2 ? `20${year}` : year;
  const out = `${y}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const t = new Date(`${out}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== out ? undefined : out;
};

/** «1'234.50-» → -1234.5. */
function amountOf(s: string): number {
  const t = s.replace(/\s/g, '');
  const minus = /^[-−]|[-−]$/.test(t);
  const digits = t.replace(/[-−]/g, '').replace(/['’]/g, '').replace(',', '.');
  const n = Number(digits);
  return minus ? -n : n;
}

/** The merchant's own amount and currency a line's text names, and the text without it. */
function foreignOf(text: string, currency: string | undefined): { merchant: string; original?: CardLine['original'] } {
  const m = FOREIGN.exec(text);
  const code = m?.[1] ?? m?.[4];
  if (!m || !code || code === currency) return { merchant: text.trim() };
  const merchant = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/[\s,;·–-]+$/u, '').replace(/\s{2,}/g, ' ').trim();
  return { merchant: merchant || text.trim(), original: { amount: Math.abs(amountOf(m[2] ?? m[3])), currency: code } };
}

const lineOf = (day: string, text: string, amount: string, currency: string | undefined): CardLine => {
  const { merchant, original } = foreignOf(text.replace(/\s{2,}/g, ' '), currency);
  return { day, merchant, amount: amountOf(amount), ...(currency ? { currency } : {}), ...(original ? { original } : {}) };
};

/** Rows that read «day [day] text amount» on one line: a statement laid out by its columns, or as a model read it. */
function rowLines(text: string, currency: string | undefined): CardLine[] {
  const out: CardLine[] = [];
  for (const raw of text.split(/\n/)) {
    const m = ROW.exec(raw);
    const day = m && isoDay(m[1]);
    if (m && day) out.push(lineOf(day, m[2], m[3], currency));
  }
  return out;
}

/**
 * A table read column by column (a PDF's text in reading order): a block of days, a block of texts
 * and a block of amounts, each under its heading when the days have one; the texts and the amounts
 * may hold one row more, the total.
 */
function columnLines(text: string, currency: string | undefined): CardLine[] {
  const blocks = text.split(/\n\s*\n|\f/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  for (let i = 0; i < blocks.length; i++) {
    // The days are the block's last lines (the address and the period may stand above them in one block), under the heading before them.
    const block = blocks[i];
    let from = block.length;
    while (from > 0 && ONLY_DATES.test(block[from - 1])) from--;
    const days = block.slice(from);
    const headed = from > 0;
    if (!days.length) continue;
    const k = days.length;
    const rest = blocks.slice(i + 1);
    const body = (b: string[]) => (headed && b.length ? b.slice(1) : b);
    const amounts = rest.map(body).find((b) => (b.length === k || b.length === k + 1) && b.every((l) => ONLY_AMOUNT.test(l)));
    const texts = rest.map(body).find((b) => (b.length === k || b.length === k + 1) && !b.some((l) => ONLY_AMOUNT.test(l) || ONLY_DATES.test(l)));
    if (!amounts || !texts) continue;
    const out: CardLine[] = [];
    for (let n = 0; n < k; n++) {
      const day = isoDay(ONLY_DATES.exec(days[n])![1]);
      if (!day) return [];
      out.push(lineOf(day, texts[n], ONLY_AMOUNT.exec(amounts[n])![1], currency));
    }
    return out;
  }
  return [];
}

/** Whether the statement prints the lines' sum as an amount of its own (its total), besides the lines. */
function totalShown(text: string, lines: readonly CardLine[]): boolean {
  const all = [...text.matchAll(AMOUNTS)].map((m) => toRappen(Math.abs(amountOf(m[0]))));
  for (const l of lines) {
    const i = all.indexOf(toRappen(Math.abs(l.amount)));
    if (i >= 0) all.splice(i, 1);
  }
  const sum = Math.abs(lines.reduce((s, l) => s + toRappen(l.amount), 0));
  return all.includes(sum);
}

/**
 * The lines of a card statement's text, read by code: each with its day, merchant and amount (and
 * the merchant's own currency and amount when the line names it). Undefined when no table is found
 * or its lines do not add up to a total the statement prints: a guess is never kept.
 */
export function parseCardLines(text: string): CardLine[] | undefined {
  const currency = CURRENCY_HEAD.exec(text)?.[1];
  for (const lines of [rowLines(text, currency), columnLines(text, currency)]) {
    if (lines.length && totalShown(text, lines)) return lines;
  }
  return undefined;
}

/** The words of a text that name something (four letters or more), lower case. */
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && /\p{L}/u.test(w));

const daysApart = (a: string, b: string): number => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * A bill fits a line: its amount is the line's to the cent in the line's currency (or the
 * merchant's own amount in its currency), its date lies within CARD_LINE_DAYS of the line's day, and
 * it names a word of the line's merchant.
 */
export function lineFits(line: CardLine, r: Pick<Receipt, 'amount' | 'currency' | 'date' | 'extractedText' | 'description' | 'title' | 'filename'>, settlementCurrency: string): boolean {
  if (r.amount == null || !r.date) return false;
  const own = toRappen(Math.abs(r.amount));
  const currency = r.currency || settlementCurrency;
  const amount = (currency === (line.currency ?? settlementCurrency) && own === toRappen(Math.abs(line.amount)))
    || (!!line.original && currency === line.original.currency && own === toRappen(line.original.amount));
  if (!amount || daysApart(r.date, line.day) > CARD_LINE_DAYS) return false;
  const words = new Set(wordsOf([r.extractedText, r.description, r.title?.vendor, r.filename].filter(Boolean).join(' ')));
  return wordsOf(line.merchant).some((w) => words.has(w));
}

type LineBooks = { receipts: readonly Receipt[]; mappings: readonly Mapping[]; transactions: readonly BankTransaction[] };

/**
 * The card statement a payment is settled by, with its lines: the one receipt with lines linked
 * to the whole payment, whose lines add up to what the bank paid. Undefined for any other payment.
 */
export function cardLinesOf(books: LineBooks, tx: Pick<BankTransaction, 'ref' | 'amount'>): { statement: Receipt; lines: CardLine[] } | undefined {
  const statements = books.mappings
    .filter((m) => m.transactionRef === tx.ref && m.line === undefined)
    .map((m) => books.receipts.find((r) => r.id === m.receiptId))
    .filter((r): r is Receipt => !!r?.cardLines?.length);
  if (statements.length !== 1) return undefined;
  const [statement] = statements;
  const sum = Math.abs(statement.cardLines!.reduce((s, l) => s + toRappen(l.amount), 0));
  return sum === toRappen(Math.abs(tx.amount)) ? { statement, lines: statement.cardLines! } : undefined;
}

/** The lines of a payment's card statement as the parts of a collective payment: each line's merchant, and the merchant's own amount as its reference. */
export function cardParts(lines: readonly CardLine[], currency: string): BankTransactionPart[] {
  return lines.map((l) => ({ amount: Math.abs(l.amount), currency, counterparty: l.merchant, ...(l.original ? { reference: `${l.original.currency} ${l.original.amount.toFixed(2)}` } : {}) }));
}

/** The receipts linked to each line of a payment's card statement, by the line's index. */
export function lineReceiptsOf(books: LineBooks, ref: string, count: number): Receipt[][] {
  const out: Receipt[][] = Array.from({ length: count }, () => []);
  for (const m of books.mappings) {
    if (m.transactionRef !== ref || m.line === undefined || m.line < 0 || m.line >= count) continue;
    const r = books.receipts.find((x) => x.id === m.receiptId);
    if (r) out[m.line].push(r);
  }
  return out;
}

/** A receipt free to be a line's bill: an invoice linked to nothing, not taken apart from the settlement by a person, not a card statement itself (one still in the inbox counts: code links it only once it is filed). */
function free(books: LineBooks, r: Receipt, ref: string): boolean {
  return (r.kind === undefined || r.kind === 'invoice') && !r.cardLines && !r.filedPayment
    && !r.notPaidBy?.includes(ref) && !books.mappings.some((m) => m.receiptId === r.id);
}

/** A line of a payment's card statement one receipt fits, for the person to link (two bills may fit one line: code links neither). */
export interface LineOffer { payment: string; statement: string; index: number; line: CardLine }

/** For each free line of the payment's card statement, the free receipts that fit it. */
function fitsOf(books: LineBooks, tx: BankTransaction): { statement: Receipt; fits: Map<number, Receipt[]> } | undefined {
  const card = cardLinesOf(books, tx);
  if (!card) return undefined;
  const taken = new Set(books.mappings.filter((m) => m.transactionRef === tx.ref && m.line !== undefined).map((m) => m.line));
  const fits = new Map<number, Receipt[]>();
  card.lines.forEach((line, i) => {
    if (taken.has(i)) return;
    const rs = books.receipts.filter((r) => r.id !== card.statement.id && free(books, r, tx.ref) && lineFits(line, r, tx.currency));
    if (rs.length) fits.set(i, rs);
  });
  return { statement: card.statement, fits };
}

/** The free lines of open settlements a receipt fits: what its page offers to link by hand. */
export function lineOffers(books: LineBooks, receiptId: string, isOpen: (date: string) => boolean): LineOffer[] {
  const out: LineOffer[] = [];
  for (const tx of books.transactions) {
    if (!isOpen(tx.date)) continue;
    const found = fitsOf(books, tx);
    if (!found) continue;
    for (const [index, rs] of found.fits) if (rs.some((r) => r.id === receiptId)) out.push({ payment: tx.ref, statement: found.statement.id, index, line: found.statement.cardLines![index] });
  }
  return out;
}

/** The line a receipt is the bill of: the payment, its card statement and the line. */
export function lineOfReceipt(books: LineBooks, receiptId: string): LineOffer | undefined {
  const m = books.mappings.find((x) => x.receiptId === receiptId && x.line !== undefined);
  const tx = m && books.transactions.find((t) => t.ref === m.transactionRef);
  const card = tx && cardLinesOf(books, tx);
  const line = card?.lines[m!.line!];
  return line ? { payment: tx!.ref, statement: card!.statement.id, index: m!.line!, line } : undefined;
}

export interface CardLinesDone {
  /** Card statements whose lines were read now. */
  read: string[];
  /** Bills linked to their line by code. */
  linked: Array<{ receipt: string; payment: string; line: number }>;
}

/**
 * The card statements' lines and the bills behind them, by code (inside the write door): a card
 * statement of an open period without lines gets them, read from its text (parseCardLines); one
 * dated in a filed period, or linked to a filed payment, keeps every byte. Then each free line of an
 * open settlement that exactly one free receipt fits, and that fits no other line, takes it: a
 * mapping on the settlement with the line's index (`rule: 'card-line'`). Books from before schema 8
 * gain their lines here, on the next run of the inbox. `payment`: only that payment's statement and
 * lines (a person linked its statement by hand: nothing else changes with her link).
 */
export function linkCardLines(books: { receipts: Receipt[]; mappings: Mapping[]; transactions: BankTransaction[] }, isOpen: (date: string) => boolean, words: DocumentsData | undefined = documentWordsInUse(), payment?: string): CardLinesDone {
  const done: CardLinesDone = { read: [], linked: [] };
  if (!words) return done;
  for (const r of books.receipts) {
    if (r.cardLines || !r.extractedText || !isCardStatement(r.extractedText, words)) continue;
    const refs = books.mappings.filter((m) => m.receiptId === r.id).map((m) => m.transactionRef);
    if (payment && !refs.includes(payment)) continue;
    const dates = [r.date, ...refs.map((ref) => books.transactions.find((t) => t.ref === ref)?.date)].filter((d): d is string => !!d);
    if (dates.some((d) => !isOpen(d))) continue;
    const lines = parseCardLines(r.extractedText);
    if (!lines) continue;
    r.cardLines = lines;
    done.read.push(r.id);
  }
  // A bill that fits lines of two settlements, or two lines of one, is linked to none: the person chooses.
  const found = books.transactions.filter((tx) => isOpen(tx.date) && (!payment || tx.ref === payment)).flatMap((tx) => {
    const f = fitsOf(books, tx);
    return f ? [{ tx, fits: f.fits }] : [];
  });
  const claims = new Map<string, number>();
  for (const { fits } of found) for (const rs of fits.values()) for (const r of rs) claims.set(r.id, (claims.get(r.id) ?? 0) + 1);
  for (const { tx, fits } of found) {
    for (const [line, rs] of fits) {
      if (rs.length !== 1 || claims.get(rs[0].id) !== 1 || rs[0].location !== 'archived') continue;
      books.mappings.push({ transactionRef: tx.ref, receiptId: rs[0].id, by: 'rule', rule: 'card-line', line });
      done.linked.push({ receipt: rs[0].id, payment: tx.ref, line });
    }
  }
  return done;
}
