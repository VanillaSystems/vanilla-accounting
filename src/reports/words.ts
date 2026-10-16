/** A report's refusal in the person's words (src/reports/spec.ts ReportRefusal), for the UI and the API's German text alike. */
import type { Key } from '../app/i18n/types.js';
import { COLUMNS, FILTERS, GROUPINGS, type ReportRefusal } from './spec.js';

type T = (key: Key, vars?: Record<string, string | number>) => string;

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
