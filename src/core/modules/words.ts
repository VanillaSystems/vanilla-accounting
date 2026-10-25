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
  const at = words.statement.length ? wordsRe(words.statement).exec(head)?.index : undefined;
  if (at === undefined) return false;
  const lists = [words.receipt.title, ...Object.values(words.supporting), ...Object.values(words.other)];
  return !firstOf(Object.fromEntries(lists.map((l, i) => [i, l])), head).some((x) => x.at < at);
}
