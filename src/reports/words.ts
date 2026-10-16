/**
 * A report's parts in the person's words, for the UI, the files and the API's German text alike:
 * its period, a section's filters, a group's heading, a refusal (src/reports/spec.ts ReportRefusal).
 * Without node modules, so the browser takes it too.
 */
import type { Key } from '../app/i18n/types.js';
import type { Words } from '../export/tables.js';
import { COLUMNS, FILTERS, GROUPINGS, accountRangeText, type ReportRefusal, type ReportSection } from './spec.js';
import type { ReportGroup, ReportResult } from './run.js';

type T = (key: Key, vars?: Record<string, string | number>) => string;

const date = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export const sectionName = (s: ReportSection, i: number, w: Words): string => s.title || `${i + 1}. ${w.t(`custom.source.${s.source}` as Key)}`;


/** A filter's, grouping's or column's name. */
export function fieldName(what: string, t: T): string {
  if ((FILTERS as readonly string[]).includes(what)) return t(`custom.filter.${what}` as Key);
  if ((GROUPINGS as readonly string[]).includes(what)) return t(`custom.group.${what}` as Key);
  if ((COLUMNS as readonly string[]).includes(what)) return t(`custom.col.${what}` as Key);
  return what;
}

export function refusalText(r: ReportRefusal, t: T): string {
  switch (r.code) {
    case 'notForSource': return t('custom.refusal.notForSource', { what: fieldName(r.params.what, t), source: t(`custom.source.${r.params.source}` as Key) });
    case 'shape': return t('custom.refusal.shape', r.params);
    case 'period': return t('custom.refusal.period', r.params);
    case 'unknownAccount': return t('custom.refusal.unknownAccount', r.params);
    case 'unknownVatCode': return t('custom.refusal.unknownVatCode', r.params);
    case 'placeholder': return t('custom.refusal.placeholder', r.params);
    case 'figureInComment': return t('custom.refusal.figureInComment', r.params);
  }
}

/** The period in words: 01.07.2026 – 30.09.2026. */
export const spanOf = (r: ReportResult): string => (r.period.kind === 'all' ? '' : `${date(r.period.from)} – ${date(r.period.to)}`);

/** A section's filters and grouping in words: «Buchungen · Konten 6000-6999 · mit Beleg · nach Konto». */
export function filtersInWords(s: ReportSection, w: Words): string {
  const { t } = w;
  const f = s.filter;
  return [
    t(`custom.source.${s.source}` as Key),
    f.accounts && t('custom.f.accounts', { list: f.accounts.map(accountRangeText).join(', ') }),
    f.vatCodes && t('custom.f.vatCodes', { list: f.vatCodes.join(', ') }),
    f.text && t('custom.f.text', { text: f.text }),
    f.origins && t('custom.f.origins', { list: f.origins.map((o) => t(`custom.origin.${o}` as Key)).join(', ') }),
    f.receipt && t(f.receipt === 'with' ? 'custom.f.receiptWith' : 'custom.f.receiptWithout'),
    f.currencies && t('custom.f.currencies', { list: f.currencies.join(', ') }),
    s.group !== 'none' && t(`custom.group.${s.group}` as Key),
  ].filter(Boolean).join(' · ');
}

/** A group's heading: the key and the account's name, or «ohne» for rows without one. */
export const groupName = (g: ReportGroup, w: Words): string => (g.key ? [g.key, g.label].filter(Boolean).join(' ') : w.t('custom.none'));

