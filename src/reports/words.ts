/**
 * A report's parts in the person's words, for the UI, the files and the API's German text alike:
 * its period, a section's filters, a group's heading, a refusal (src/reports/spec.ts ReportRefusal).
 * Without node modules, so the browser takes it too.
 */
import type { Words } from '../export/tables.js';

/** A key of the UI's dictionaries, as the words take it. */
type Key = Parameters<Words['t']>[0];
import { COLUMNS, FILTERS, GROUPINGS, accountRangeText, groupDimension, type ReportRefusal, type ReportSection } from './spec.js';
import type { ReportGroup, ReportResult } from './result.js';
import { vatParts } from '../accounting/vat-in-figures.js';

type T = (key: Key, vars?: Record<string, string | number>) => string;

const date = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export const sectionName = (s: ReportSection, i: number, w: Words): string => s.title || `${i + 1}. ${w.t(`custom.source.${s.source}` as Key)}`;


/** A filter's, grouping's or column's name. */
export function fieldName(what: string, t: T): string {
  if ((FILTERS as readonly string[]).includes(what)) return t(`custom.filter.${what}` as Key);
  if ((GROUPINGS as readonly string[]).includes(what)) return t(`custom.group.${what}` as Key);
  if (what.startsWith('tag:')) return t('custom.group.tag', { dimension: what.slice(4) });
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
    case 'unknownDimension': return t('custom.refusal.unknownDimension', r.params);
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
    f.tags && t('custom.f.tags', { list: Object.entries(f.tags).map(([d, vs]) => `${d}: ${vs.map((v) => v || t('custom.none')).join(', ')}`).join('; ') }),
    s.group !== 'none' && (groupDimension(s.group) ? t('custom.group.tag', { dimension: groupDimension(s.group)! }) : t(`custom.group.${s.group}` as Key)),
  ].filter(Boolean).join(' · ');
}

/** A group's heading: the key and the account's name, or «ohne» for rows without one. */
export const groupName = (g: ReportGroup, w: Words): string => (g.key ? [g.key, g.label].filter(Boolean).join(' ') : w.t('custom.none'));


/**
 * The VAT the rows' amounts hold, as Bilanz and ER say it: settled at the year close where the
 * statements are gross within the year; where they are net, that the net column is what they show
 * and on which account the VAT stands there.
 */
export function vatNoteOf(r: ReportResult, w: Words, money: (n: number) => string): string | undefined {
  if (!r.vat) return undefined;
  const vars = { net: money(r.vat.net), parts: vatParts(r.vat).filter((x) => x.amount !== 0).map((x) => w.t(x.key, { amount: money(x.amount) })).join(', ') };
  return r.vatAccount ? w.t('custom.vatNoteNet', { ...vars, account: r.vatAccount }) : w.t('custom.vatNote', vars);
}
