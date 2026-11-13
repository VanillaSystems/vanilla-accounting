/**
 * How the words of a jurisdiction's documents.yaml are found in a document's text: as whole
 * words, ignoring case, each list by its first match. Core, so the books (a statement among the
 * receipts, src/books/statement-facts.ts) and the intake (src/intake/document-kind.ts) read the
 * same words the same way.
 */
import type { DocumentsData } from './schema.js';

/** Where a document names what it is: its first lines. */
export const HEAD = 600;

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const wordsRe = (words: readonly string[]) => new RegExp(`(?<![\\p{L}\\d])(?:${[...words].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\p{L}])`, 'iu');

/** A list's word closes a compound only when it is this long: «Akontorechnung», never «Waybill». */
const COMPOUND_HEAD = 6;

/**
 * The lines whose first word is a compound that one of `words` closes («Akontorechnung»,
 * «Prämienrechnung» for «Rechnung»): a single word of COMPOUND_HEAD letters or more, with letters
 * before it, and not one that ends in a word of `not` (documents.yaml notCompound: «Lohnabrechnung»
 * is a payslip, «Berechnung» a calculation). Each with where the word starts and what follows it.
 */
export function compoundLines(text: string, words: readonly string[], not: readonly string[] = []): Array<{ at: number; rest: string }> {
  const heads = words.filter((w) => !/\s/.test(w) && w.length >= COMPOUND_HEAD).map((w) => w.toLowerCase());
  const tails = not.map((w) => w.toLowerCase());
  if (!heads.length) return [];
  const out: Array<{ at: number; rest: string }> = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const m = /^\s*(\p{L}+)(?![\p{L}\d])(.*)$/u.exec(line);
    const first = m?.[1].toLowerCase();
    if (first && heads.some((h) => first.length > h.length && first.endsWith(h)) && !tails.some((w) => first.endsWith(w))) out.push({ at: at + line.indexOf(m![1]), rest: m![2] });
    at += line.length + 1;
  }
  return out;
}

/** The first match of each list in `text`, by its position. */
export function firstOf<K extends string>(lists: Record<K, string[]>, text: string): Array<{ key: K; at: number }> {
  return (Object.entries(lists) as Array<[K, string[]]>)
    .filter(([, words]) => words.length)
    .map(([key, words]) => ({ key, at: wordsRe(words).exec(text)?.index ?? -1 }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at);
}

/**
 * A bank statement says so in its first lines, before any word of a receipt, of a document beside
 * one or of one that is none: «Kontoauszug», a currency account's «… statement», «Relevé de compte». A «Gutschrift»
 * line below the title leaves it a statement; an invoice that mentions a statement stays an invoice.
 */
export function namesStatement(text: string, words: DocumentsData): boolean {
  const head = text.slice(0, HEAD);
  // A card statement's title holds a statement's word («Credit card statement», «Estratto conto carta di credito»): within it, the card's words win.
  const cards = words.cardStatement?.length ? [...head.matchAll(new RegExp(wordsRe(words.cardStatement).source, 'giu'))].map((m) => [m.index!, m.index! + m[0].length]) : [];
  const at = words.statement.length ? [...head.matchAll(new RegExp(wordsRe(words.statement).source, 'giu'))].map((m) => m.index!).find((i) => !cards.some(([from, to]) => i >= from && i < to)) : undefined;
  if (at === undefined) return false;
  const lists = [words.receipt.title, ...Object.values(words.supporting), ...Object.values(words.other)];
  return !firstOf(Object.fromEntries(lists.map((l, i) => [i, l])), head).some((x) => x.at < at);
}

/** A credit card's statement says so in its first lines («Kreditkartenabrechnung», «Card statement»). */
export function namesCardStatement(text: string, words: DocumentsData): boolean {
  return !!words.cardStatement?.length && wordsRe(words.cardStatement).test(text.slice(0, HEAD));
}

/** An account's IBAN as a document prints it, its groups with or without spaces. */
export const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/;

/** The columns of an account's movements: a word for money out and one for money in («Belastung» and «Gutschrift», «Outgoing» and «Incoming»). */
export function namesMovements(text: string, words: DocumentsData): boolean {
  const { out, in: into } = words.movements;
  return out.length > 0 && into.length > 0 && wordsRe(out).test(text) && wordsRe(into).test(text);
}

/**
 * A bank statement names itself so (namesStatement) and shows what only an account's statement
 * has: the account's IBAN or the columns of its movements. A supplier's «Statement» of its
 * charges, with a period and balances of its own but neither, stays a receipt (#289).
 */
export const isBankStatement = (text: string, words: DocumentsData): boolean =>
  namesStatement(text, words) && (IBAN.test(text) || namesMovements(text, words));
