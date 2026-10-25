/**
 * What a document's text says it is, before it enters the books: a receipt, a document kept beside
 * an invoice (an order confirmation, a delivery note), clearly no receipt (a newsletter, terms, a
 * price list, a tracking mail), or unclear. No model: the words come from the jurisdiction's
 * documents.yaml, the facts from the text itself (src/parsers/receipt-text.ts).
 */
import type { DocumentsData, OtherWhy, SupportingWhy } from '../core/modules/schema.js';
import { hasVatIndicator, textFacts } from '../parsers/receipt-text.js';
import { HEAD, firstOf, wordsRe } from '../core/modules/words.js';

export type DocumentVerdict =
  | { is: 'receipt'; score: number }
  | { is: 'supporting'; why: SupportingWhy }
  | { is: 'other'; why: OtherWhy }
  | { is: 'unclear'; score: number };

/** Where a document's title stands, and its very first words (HEAD, its first lines: src/core/modules/words.ts). */
const TOP = 250;
const TITLE = 80;
/** Invoice evidence from which a document counts as a receipt, and up to which a non-receipt word decides. */
const RECEIPT = 3;
const WEAK = 1;

const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}/;

/** How much of an invoice the text shows: its title (more in its first lines), a total, VAT, a payment slip or account, a due date. */
export function receiptScore(text: string, words: DocumentsData): number {
  const head = text.slice(0, HEAD);
  const title = wordsRe(words.receipt.title);
  const has = (list: string[]) => list.length > 0 && wordsRe(list).test(text);
  return (title.test(head) ? 2 : title.test(text) ? 1 : 0)
    + (textFacts(text).amount !== undefined ? 1 : 0)
    + (hasVatIndicator(text) ? 1 : 0)
    + (IBAN.test(text) || has(words.receipt.slip) ? 1 : 0)
    + (has(words.receipt.due) ? 1 : 0);
}

export function documentKind(text: string, words: DocumentsData): DocumentVerdict {
  const score = receiptScore(text, words);
  const head = text.slice(0, HEAD);
  const titleAt = wordsRe(words.receipt.title).exec(head)?.index ?? Infinity;
  const supporting = firstOf(words.supporting, text.slice(0, TOP))[0];
  if (supporting && supporting.at < titleAt) return { is: 'supporting', why: supporting.key };
  // Terms, a price list or a tracking mail say what they are in their first lines, a newsletter in its
  // footer. Named in its title, it is no receipt unless the text shows most of one; a title that
  // says it is none (what the vision read writes on a photo of no receipt) decides.
  const { newsletter, ...titled } = words.other;
  const named = firstOf(titled, head)[0];
  if (wordsRe(words.other['no-receipt']).test(text.slice(0, TITLE))) return { is: 'other', why: 'no-receipt' };
  if (named && (score <= WEAK || (named.at < TITLE && score < RECEIPT))) return { is: 'other', why: named.key };
  if (score <= WEAK && firstOf({ newsletter }, text).length) return { is: 'other', why: 'newsletter' };
  return score >= RECEIPT ? { is: 'receipt', score } : { is: 'unclear', score };
}
