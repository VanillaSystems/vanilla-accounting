/**
 * Number series per document kind (docs/specs/invoicing.md 4.4.4): the next number of a series, by the
 * grammar of src/workspace/numbering.ts. A number is given at issue, the next of its series; drafts carry
 * none. Whether a format fits the payment references is the provider's (formatFits, numberingFits).
 */
import type { Invoice } from './model.js';
import { DOCUMENT_KINDS, counterOf, formatNumber, type DocumentKind, type Numbering } from '../workspace/numbering.js';

export { DEFAULT_NUMBERING, LEGACY_FORMAT, LEGACY_NUMBERING, counterOf, formatNumber, parseFormat } from '../workspace/numbering.js';
export type { FormatRefusal, NumberFormat, Numbering } from '../workspace/numbering.js';

/**
 * The number a document of `kind` dated `date` takes at issue: one more than the highest its series
 * has given (the kinds with the same format count together, cancelled documents and drafts that keep
 * their number included, so no number is given twice), in the document's year when the series restarts yearly; a number some
 * other document holds already (a format changed back and forth) is passed over.
 */
export function nextNumberFor(docs: readonly Invoice[], kind: DocumentKind, date: string, numbering: Numbering): string {
  const nf = numbering[kind];
  const year = date.slice(0, 4);
  const kinds = DOCUMENT_KINDS.filter((k) => numbering[k].format === nf.format);
  // A draft back from issue keeps its number (Draft.number): that number stays taken like an issued one.
  const numbered = docs.filter((d): d is Invoice & { number: string } => !d.deleted && typeof d.number === 'string' && d.number !== '');
  const taken = new Set(numbered.map((d) => d.number));
  const counters = numbered.filter((d) => kinds.includes(d.kind)).map((d) => counterOf(nf, d.number, year)).filter((c): c is number => c !== undefined);
  let next = Math.max(0, ...counters) + 1;
  while (taken.has(formatNumber(nf, year, next))) next++;
  return formatNumber(nf, year, next);
}
