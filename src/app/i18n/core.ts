/**
 * Filling a text of a dictionary, without Vite: the UI (./index.ts) and the server's export
 * (src/export/texts.ts) say the same words.
 */
import type { Key, Locale } from './types.js';

export type Language = { code: string } & Pick<Locale, 'messages'>;

export function formatIn(lang: Language, key: Key, values: Record<string, string | number>): string {
  const entry = lang.messages[key];
  const text = typeof entry === 'string'
    ? entry
    : entry[new Intl.PluralRules(`${lang.code}-CH`).select(Number(values.n)) === 'one' ? 'one' : 'other'];
  return text.replace(/\{(\w+)\}/g, (hole, name: string) => (name in values ? String(values[name]) : hole));
}

/** A statement section or row that src/accounting names in German, in `lang`; unknown names stay. */
export function accountingNameIn(lang: Language, german: string): string {
  const key = ACCOUNTING_NAMES[german];
  return key ? formatIn(lang, key, {}) : german;
}

const ACCOUNTING_NAMES: Record<string, Key> = {
  'Umlaufvermögen': 'statement.currentAssets',
  'Anlagevermögen': 'statement.fixedAssets',
  'Kurzfristiges Fremdkapital': 'statement.shortTermLiabilities',
  'Langfristiges Fremdkapital': 'statement.longTermLiabilities',
  'Eigenkapital': 'statement.equity',
  'Jahresergebnis (noch nicht abgeschlossen)': 'statement.openYearResult',
  'Erlöse': 'statement.revenue',
  'Aufwand für Material und Waren': 'statement.costOfGoods',
  'Betriebsaufwand': 'statement.operatingExpenses',
  'Nebenbetrieblicher Ertrag': 'statement.otherIncome',
  'Nebenbetrieblicher Aufwand': 'statement.otherExpenses',
  'Ausserordentliches': 'statement.extraordinary',
  'Normalsatz': 'vat.rateStandard',
  'Reduzierter Satz': 'vat.rateReduced',
  'Beherbergungssatz': 'vat.rateAccommodation',
  'Bezugsteuer': 'vat.rateAcquisition',
};
