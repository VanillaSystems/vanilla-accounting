/**
 * What every import of Verkauf from a table shares (spec 4.4.5, 4.7: the switch from another tool):
 * any CSV (comma, semicolon or tab) read with a mapping of its columns to a record's fields, code
 * proposing the mapping from the header words, the person changing any column; at most
 * IMPORT_LIMIT rows, the rest named; each row with the line of the file it starts on. Pure: the
 * contact import (contact-import.ts) and the Artikel import (article-import.ts) read their rows here.
 */
import { csvLines } from '../core/files.js';
import { InvoiceRuleError } from './rules.js';

/** The most rows one import reads; the preview names those it leaves out. */
export const IMPORT_LIMIT = 2000;

/** `new`: imported; `same`: the record it matches stands, not imported again; `skip`: left out. */
export type ImportChoice = 'new' | 'same' | 'skip';

/** Field → the column's header text, as the person mapped it. */
export type Mapping<F extends string> = Partial<Record<F, string>>;

/** A header word compared without case, spaces and punctuation. */
export const normWord = (s: string): string => s.toLowerCase().normalize('NFC').replace(/[\s_\-:./()]+/g, '');

/** The mapping code proposes for a header: each field to the first column whose header names it (`words`, per field). */
export function proposeColumns<F extends string>(header: readonly string[], fields: readonly F[], words: Record<F, readonly string[]>): Mapping<F> {
  const out: Mapping<F> = {};
  const used = new Set<string>();
  for (const f of fields) {
    const ws = words[f].map(normWord);
    const col = header.find((h) => !used.has(h) && ws.includes(normWord(h)));
    if (col) { out[f] = col; used.add(col); }
  }
  return out;
}

/** A row of the table: the file's line it starts on (the header's is 1), and its cell for a field by the mapping ('' when unmapped). */
export interface TableRow<F extends string> { line: number; cell: (f: F) => string }

/**
 * The rows of `csv` read with `mapping` (absent: the proposed one): the header, the mapping used,
 * the first IMPORT_LIMIT rows and how many more there are. A mapping that names a field the import
 * has not or a column the table lacks is refused.
 */
export function readTable<F extends string>(csv: string, mapping: Mapping<F> | undefined, fields: readonly F[], words: Record<F, readonly string[]>): { header: string[]; mapping: Mapping<F>; rows: TableRow<F>[]; leftOut: number } {
  const [first, ...all] = csvLines(csv);
  const cols = (first?.cells ?? []).map((h) => h.trim());
  const map = mapping ?? proposeColumns(cols, fields, words);
  const unknown = Object.entries(map).filter(([f, col]) => !fields.includes(f as F) || (col !== undefined && !cols.includes(col as string)));
  if (unknown.length) throw new InvoiceRuleError('incomplete', `Die Zuordnung nennt, was die Tabelle nicht hat: ${unknown.map(([f, c]) => `${f} → ${c}`).join(', ')}.`);
  const rows = all.slice(0, IMPORT_LIMIT).map(({ cells, line }): TableRow<F> => ({
    line,
    cell: (f) => { const col = map[f]; const at = col === undefined ? -1 : cols.indexOf(col); return at < 0 ? '' : (cells[at] ?? '').trim(); },
  }));
  return { header: cols, mapping: map, rows, leftOut: Math.max(0, all.length - IMPORT_LIMIT) };
}

/** A cell without a currency before or after it and without its thousands marks (’ ' and spaces), «12.–» as 12. */
const bare = (s: string): string => s.trim()
  .replace(/^[A-Za-z]{2,3}\.?\s*(?=[-\d])/, '').replace(/(?<=[\d.,–-])\s*[A-Za-z]{2,3}\.?$/, '')
  .replace(/[.,][–-]$/, '').replace(/[’'\s]/g, '');

/**
 * A number that reads two ways: one comma or one point followed by exactly three digits after a
 * whole part without a leading zero («1,200», «1.200»), a thousand or one and a fifth. A table import
 * names it instead of guessing.
 */
export const ambiguousNumber = (s: string): boolean => /^-?[1-9]\d{0,2}[.,]\d{3}$/.test(bare(s));

/**
 * A number as tables write it: «1'200.50», «1’200,50», «1 200.50», «1.200,50», a currency before or
 * after it («EUR 12», «12.50 EUR»), «12.–». Undefined when it is none or reads two ways (ambiguousNumber).
 */
export function tableNumber(s: string): number | undefined {
  const t = bare(s);
  if (!t || ambiguousNumber(s)) return undefined;
  // «1.200,50»: the last separator is the decimal one when both appear; a lone comma is a decimal comma.
  const both = t.includes('.') && t.includes(',');
  const normal = both ? (t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')) : t.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normal)) return undefined;
  return Number(normal);
}
