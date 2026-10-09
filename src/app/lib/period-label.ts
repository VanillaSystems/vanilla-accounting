import type { Period, IsoDate } from '../../accounting/periods.js';
import { monthLocale, t } from '../i18n/index.js';
import { formatDate } from './utils.js';

/** A period's name: "Quartal bis heute", "Q3 2026", "September 2026", "2026", or its dates. */
export function periodName(p: Period): string {
  switch (p.kind) {
    case 'all': return t('app.allPeriods');
    case 'year': return p.token;
    case 'half': return t('period.half', { half: p.token.slice(-1), year: p.token.slice(0, 4) });
    case 'quarter': return t('period.quarter', { quarter: p.token.slice(-1), year: p.token.slice(0, 4) });
    case 'month': return monthName(p.from);
    case 'range': return rangeText(p.from, p.to);
    default: return t(`period.${p.kind}`);
  }
}

/** The header button's text: the name, and for a relative preset the days it means today. */
export function periodLabel(p: Period): string {
  return p.kind === p.token && p.kind !== 'all' ? `${periodName(p)} · ${rangeText(p.from, p.to)}` : periodName(p);
}

/** "01.10.–09.10.2026", "15.12.2025 – 15.01.2026", or one day. */
export function rangeText(from: IsoDate, to: IsoDate): string {
  if (from === to) return formatDate(from);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${formatDate(from).slice(0, 6)}–${formatDate(to)}`;
  return `${formatDate(from)} – ${formatDate(to)}`;
}

export function monthName(date: IsoDate): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(monthLocale(), { month: 'long', year: 'numeric' });
}
