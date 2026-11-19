/**
 * The grammar of number series (docs/specs/invoicing.md 4.4.4), read by the manifest and by invoicing:
 * each kind of document has a format, a prefix, the year if wanted and a digit count
 * (`AN-{JJJJ}-{NNNNN}`), and whether it restarts each year. Kinds whose format is the same share one
 * counter (today's `{JJJJ}-{NNN}` of invoices and credit notes). Pure functions, no jurisdiction:
 * whether a number fits a payment reference is the provider's (src/invoices/numbering.ts binds it).
 */
import { docRef, isReservedRef } from '../books/refs.js';

/** The kinds of document of invoicing (src/invoices/model.ts re-exports them). */
export const DOCUMENT_KINDS = ['quote', 'sales-order', 'delivery-note', 'invoice', 'credit-note'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface NumberFormat {
  /** Letters, digits, `-` and `_`, at most one `{JJJJ}` (the document's year) and exactly one `{N…}` (the counter, padded to as many digits). */
  format: string;
  /** The counter starts at 1 each year; needs `{JJJJ}` in the format, else two years would give the same number. */
  restartYearly: boolean;
}
export type Numbering = Record<DocumentKind, NumberFormat>;

/** The series of a new firm: a prefix per kind, the year, five digits, restarted each year. */
export const DEFAULT_NUMBERING: Numbering = {
  quote: { format: 'AN-{JJJJ}-{NNNNN}', restartYearly: true },
  'sales-order': { format: 'AU-{JJJJ}-{NNNNN}', restartYearly: true },
  'delivery-note': { format: 'LS-{JJJJ}-{NNNNN}', restartYearly: true },
  invoice: { format: 'RE-{JJJJ}-{NNNNN}', restartYearly: true },
  'credit-note': { format: 'GS-{JJJJ}-{NNNNN}', restartYearly: true },
};

/** The one series invoices and credit notes shared before phase 2 (2026-001): what the manifest step 5 → 6 writes for both. */
export const LEGACY_FORMAT: NumberFormat = { format: '{JJJJ}-{NNN}', restartYearly: true };

/** What a book without settings numbers by: the old shared series for invoices and credit notes, the defaults for the rest. */
export const LEGACY_NUMBERING: Numbering = { ...DEFAULT_NUMBERING, invoice: LEGACY_FORMAT, 'credit-note': LEGACY_FORMAT };

/** The kinds whose number becomes a payment reference: the reference must hold it. */
export const REFERENCED: readonly DocumentKind[] = ['invoice', 'credit-note'];

/** Why a format is refused; the UI says it in the person's words (src/types/api-error.ts `numberFormat`). */
/**
 * `reserved`: a number that would read as something else, a link to a draft (`draft-…`) or a ref the
 * books keep for themselves (src/books/refs.ts isReservedRef); `sharedKinds`: a booked kind (Rechnung,
 * Gutschrift) sharing its series with one that is not; `referenceTaken`: the next number would make the
 * payment reference or booking ref of a document issued already (checked with the documents, not here).
 */
export type FormatRefusal = 'syntax' | 'noCounter' | 'twoCounters' | 'twoYears' | 'restartWithoutYear' | 'tooLongQrr' | 'tooLongScor' | 'sharedRestart'
  | 'reserved' | 'sharedKinds' | 'referenceTaken';

/** Whether a number fits the payment references of the jurisdiction's payment slip; undefined when it does. */
export type ReferenceFit = (number: string) => FormatRefusal | undefined;

type Part = { lit: string } | { year: true } | { digits: number };

const TOKEN = /\{(JJJJ|N{1,9})\}/g;

/** The format's parts, or why it is no format. */
export function parseFormat(format: string): Part[] | FormatRefusal {
  const parts: Part[] = [];
  let at = 0, years = 0, counters = 0;
  for (const m of format.matchAll(TOKEN)) {
    if (m.index! > at) parts.push({ lit: format.slice(at, m.index) });
    if (m[1] === 'JJJJ') { years++; parts.push({ year: true }); } else { counters++; parts.push({ digits: m[1].length }); }
    at = m.index! + m[0].length;
  }
  if (at < format.length) parts.push({ lit: format.slice(at) });
  if (parts.some((p) => 'lit' in p && !/^[A-Za-z0-9_-]+$/.test(p.lit))) return 'syntax';
  if (counters === 0) return 'noCounter';
  if (counters > 1) return 'twoCounters';
  if (years > 1) return 'twoYears';
  return parts;
}

const partsOf = (nf: NumberFormat): Part[] => {
  const p = parseFormat(nf.format);
  if (typeof p === 'string') throw new Error(`${nf.format}: no number format (${p})`);
  return p;
};

/** The number of `counter` in `year` by the format. */
export function formatNumber(nf: NumberFormat, year: string, counter: number): string {
  return partsOf(nf).map((p) => ('lit' in p ? p.lit : 'year' in p ? year : String(counter).padStart(p.digits, '0'))).join('');
}

/** The counter a number holds by the format, in `year` when the format restarts yearly; undefined when it is no number of the series. */
export function counterOf(nf: NumberFormat, number: string, year: string): number | undefined {
  const re = new RegExp(`^${partsOf(nf).map((p) => ('lit' in p ? p.lit.replace(/-/g, '\\-') : 'year' in p ? (nf.restartYearly ? year : '\\d{4}') : '(\\d+)')).join('')}$`);
  const m = re.exec(number);
  return m ? Number(m[1]) : undefined;
}

/**
 * Why the format of `kind` cannot be taken, or undefined. A yearly restart needs the year in the
 * number; a kind whose number is a payment reference must fit `fits` at its full digit count.
 */
export function checkFormat(kind: DocumentKind, nf: NumberFormat, fits?: ReferenceFit): FormatRefusal | undefined {
  const p = parseFormat(nf.format);
  if (typeof p === 'string') return p;
  if (nf.restartYearly && !p.some((x) => 'year' in x)) return 'restartWithoutYear';
  const digits = p.find((x): x is { digits: number } => 'digits' in x)!.digits;
  const sample = formatNumber(nf, '2026', 1);
  // `/invoices/draft-<id>` is a draft's link; a booked kind's number may be its own booking ref (docRef).
  if (/^draft-/i.test(sample) || (REFERENCED.includes(kind) && isReservedRef(docRef({ number: sample, kind })))) return 'reserved';
  if (!fits || !REFERENCED.includes(kind)) return undefined;
  return fits(formatNumber(nf, '2026', 10 ** digits - 1));
}

/** Why the whole numbering cannot be taken: a kind's format, or two kinds sharing a format with different restarts. */
export function checkNumbering(n: Numbering, fits?: ReferenceFit): { kind: DocumentKind; refusal: FormatRefusal } | undefined {
  for (const kind of DOCUMENT_KINDS) {
    const refusal = checkFormat(kind, n[kind], fits);
    if (refusal) return { kind, refusal };
    if (DOCUMENT_KINDS.some((k) => k !== kind && n[k].format === n[kind].format && n[k].restartYearly !== n[kind].restartYearly)) return { kind, refusal: 'sharedRestart' };
    // A Rechnung's series is gapless and paid by its reference: it shares its counter with none of the kinds that are not booked.
    if (REFERENCED.includes(kind) && DOCUMENT_KINDS.some((k) => !REFERENCED.includes(k) && n[k].format === n[kind].format)) return { kind, refusal: 'sharedKinds' };
  }
  return undefined;
}
