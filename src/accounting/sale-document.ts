/**
 * What a sale's document PROVES about its VAT, for the hand form (#382): the form proposes a code
 * only for that, and asks the sale question in every other case. Read in this order:
 * - Swiss rates the document shows (read, or its own text's arithmetic, textFacts): those rates,
 *   with a zero-rate group beside them a line of its own (a mixed invoice);
 * - a VAT at a rate that is no rate of the jurisdiction beside a VAT label («MwSt. 19 %»): a
 *   foreign VAT, asked (the split of the foreign tax is the answer's);
 * - a Swiss rate written in a text nothing read, or a wording that the VAT is included («inkl.
 *   MwSt.»): unclear;
 * - a place of supply outside the VAT territory after one of the labels («Leistungsort
 *   Deutschland»): abroad, a service supplied there;
 * - anything else (a bare label, a place at home, a statement without a place): unclear.
 * The words are the jurisdiction's (invoicing.yaml placeOfSupply, vatIncluded, vatLabels); the
 * countries are the runtime's names of them (src/core/countries.ts). PR #390's read fact
 * `noSwissVat` says that the text states no Swiss VAT; it does not say where, so it replaces none
 * of this. Pure and browser-safe.
 */
import type { Receipt, VatRateGroup } from '../types/index.js';
import { invoicing } from '../engines/index.js';
import { textFacts } from '../parsers/receipt-text.js';
import { countryNamed } from '../core/countries.js';

export type SaleProof =
  /** The Swiss rates the document shows, each group with its gross where the document gives it; a zero group is abroad when the document proves that. */
  | { kind: 'rates'; groups: Array<{ rate: number; gross?: number; abroad?: true }> }
  | { kind: 'abroad' }
  | { kind: 'foreignVat' }
  | { kind: 'unclear'; why: 'notRead' | 'noVat' };

const escaped = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const anyOf = (words: readonly string[] | undefined) => (words?.length ? new RegExp(`(^|[^\\p{L}])(?:${words.map(escaped).join('|')})($|[^\\p{L}])`, 'iu') : undefined);

/** The document with the Swiss VAT its own text proves while nothing read it. */
export function withTextVat(r: Receipt): Receipt {
  if (r.hasSwissVat !== undefined || r.vatSummary?.length || !r.extractedText) return r;
  const read = textFacts(r.extractedText).vatSummary;
  return read?.length ? { ...r, hasSwissVat: true, vatSummary: read } : r;
}

const swissRates = () => invoicing().rates.filter((x) => x > 0);
const rateRe = (x: number) => String(x).replace('.', '[.,]');

/** A rate of the jurisdiction written as a percentage («8.1 %», «8,1%»). */
export const namesSwissRate = (text: string): boolean => swissRates().some((x) => new RegExp(`(^|[^\\d.,])${rateRe(x)}\\s*%`).test(text));

/** A percentage beside a VAT label that is no rate of the jurisdiction («MwSt. 19 %»). */
export function namesForeignVat(text: string): boolean {
  const labels = invoicing().vatLabels ?? [];
  if (!labels.length) return false;
  const label = `(?:${labels.map(escaped).join('|')})`;
  const pct = String.raw`(?<![\d.,])(\d{1,2}(?:[.,]\d{1,2})?)\s*%`;
  const res = [new RegExp(`${label}[^\\n%]{0,20}?${pct}`, 'giu'), new RegExp(`${pct}[^\\n]{0,20}?${label}`, 'giu')];
  const swiss = new Set([0, ...swissRates()]);
  return res.some((re) => [...text.matchAll(re)].some((m) => !swiss.has(Number(m[1].replace(',', '.')))));
}

/**
 * Where the text says the supply takes place, after one of the place-of-supply labels: 'home' for a
 * country of the VAT territory, 'abroad' for any other, undefined (the form asks) for anything else.
 * Strict, and asks when in doubt: the place is what follows the label and its separator up to the
 * line's end, a colon, a semicolon or a full stop. It names a country only when it IS a country's full
 * name («Deutschland», «Vereinigte Staaten»), or when it is a short place of one to three capitalised
 * words without digits followed by a country in full after a comma or in brackets and nothing after
 * it («Konstanz, Deutschland», «Konstanz (Deutschland)»). Never a code, never a country somewhere
 * among other words («Zürich, Kunde aus Deutschland», «Hotel Jersey Chur»).
 */
export function placeOfSupply(text: string): 'home' | 'abroad' | undefined {
  const territory = invoicing().territory;
  const of = (code: string | undefined) => (code ? (territory.includes(code) ? 'home' as const : 'abroad' as const) : undefined);
  for (const label of invoicing().placeOfSupply ?? []) {
    for (const m of text.matchAll(new RegExp(`${escaped(label)}[ \\t]*[:\\-–]?\\s*([^\\n:;]*)`, 'giu'))) {
      const place = m[1].replace(/\.\s.*$|\.$/u, '').trim();
      const whole = of(countryNamed(place));
      if (whole) return whole;
      const short = /^((?:\p{Lu}[\p{L}'’-]*)(?:\s+\p{Lu}[\p{L}'’-]*){0,2})\s*(?:,\s*([^,()]+)|\(([^()]+)\))$/u.exec(place);
      const after = short && of(countryNamed(short[2] ?? short[3] ?? ''));
      if (after) return after;
    }
  }
  return undefined;
}

/** What the sale document `doc` proves about its VAT (see the head of this file). */
export function saleProofOf(doc: Receipt): SaleProof {
  const r = withTextVat(doc);
  const text = r.extractedText ?? '';
  const groups: VatRateGroup[] = r.hasSwissVat ? r.vatSummary ?? [] : [];
  const gross = (g: VatRateGroup) => g.gross ?? (g.net !== undefined ? g.net + g.vat : undefined);
  const abroad = placeOfSupply(text) === 'abroad' && !anyOf(invoicing().vatIncluded)?.test(text);
  if (groups.some((g) => g.ratePercent > 0)) {
    return { kind: 'rates', groups: groups.map((g) => ({ rate: g.ratePercent, ...(gross(g) !== undefined && { gross: gross(g) }), ...(g.ratePercent === 0 && abroad && { abroad: true as const }) })) };
  }
  if (namesForeignVat(text)) return { kind: 'foreignVat' };
  const read = r.hasSwissVat !== undefined || !!r.vatSummary?.length;
  if (!read && namesSwissRate(text)) return { kind: 'unclear', why: 'notRead' };
  if (abroad) return { kind: 'abroad' };
  return { kind: 'unclear', why: read ? 'noVat' : 'notRead' };
}
