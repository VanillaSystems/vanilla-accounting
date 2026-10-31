/** The tabs of Bilanz & ER: the three reports of the books, then Eigene Berichte (the reports the owner saved). */
import type { ReactNode } from 'react';
import { REPORTS, type Report, type RouteOf } from '../../shell/route.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';

export const REPORT_LABEL = { income: 'tab.incomeStatement', balance: 'tab.balanceSheet', trial: 'tab.trialBalance' } as const satisfies Record<Report, string>;

export function Tabs({ route, nav, children }: { route: RouteOf<'reports'>; nav: Nav; children?: ReactNode }) {
  return (
    <div className="counts" role="tablist" aria-label={t('reports.report')}>
      {REPORTS.map((r) => (
        <button key={r} type="button" role="tab" aria-selected={r === route.report} className={r === route.report ? 'on' : ''} onClick={() => nav.select({ area: 'reports', report: r })}>{t(REPORT_LABEL[r])}</button>
      ))}
      <button type="button" role="tab" aria-selected={route.report === 'custom'} className={route.report === 'custom' ? 'on' : ''} data-testid="tab-custom" onClick={() => nav.select({ area: 'reports', report: 'custom' })}>{t('custom.tab')}</button>
      {children}
    </div>
  );
}
