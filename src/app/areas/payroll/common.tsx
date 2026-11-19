/** Small pieces every page of Löhne uses: a link that goes inside the app, the tabs, a month's switch. */
import type { MouseEvent, ReactNode } from 'react';
import { t } from '../../i18n/index.js';
import { hrefOf } from '../../shell/history.js';
import type { Location, RouteOf } from '../../shell/route.js';
import type { Nav } from '../index.js';
import { nextMonth } from '../../../payroll/money.js';
import { monthText } from './words.js';

export type PayrollRoute = RouteOf<'payroll'>;

/** A link to a place of the app: opens in the page, or in a new tab with ⌘. */
export function Go({ loc, nav, children, className }: { loc: Location; nav: Nav; children: ReactNode; className?: string }) {
  const click = (e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); nav.go(loc); };
  return <a className={className ?? 'golink'} href={hrefOf(loc)} onClick={click}>{children}</a>;
}

export const at = (route: PayrollRoute): Location => ({ route, query: {} });
export const payslipAt = (id: string): Location => at({ area: 'payroll', view: 'payslips', month: id.slice(0, 7), employee: id.slice(8) });
export const employeeAt = (id: string): Location => at({ area: 'payroll', view: 'employees', id });
export const settingsAt = (section: string): Location => at({ area: 'payroll', view: 'settings', section });

const TABS = ['overview', 'payslips', 'employees', 'settings'] as const;

/** Übersicht, Lohnabrechnungen, Mitarbeitende, Einstellungen (§12.1; Lohnzahlungen and Dokumente come later). */
export function Tabs({ on, nav }: { on: PayrollRoute['view']; nav: Nav }) {
  return (
    <span className="seg ptabs" role="tablist" aria-label={t('payroll.tabs')}>
      {TABS.map((v) => (
        <button key={v} type="button" role="tab" aria-selected={on === v} className={on === v ? 'on' : ''} data-view={v}
          onClick={() => nav.go(at(v === 'overview' ? { area: 'payroll', view: 'overview' } : v === 'payslips' ? { area: 'payroll', view: 'payslips' } : v === 'employees' ? { area: 'payroll', view: 'employees' } : { area: 'payroll', view: 'settings' }))}>
          {t(`payroll.tab.${v}`)}
        </button>
      ))}
    </span>
  );
}

const prevMonth = (m: string): string => (m.endsWith('-01') ? `${Number(m.slice(0, 4)) - 1}-12` : `${m.slice(0, 5)}${String(Number(m.slice(5)) - 1).padStart(2, '0')}`);

/** ‹ September 2026 › */
export function MonthSwitch({ month, onMonth }: { month: string; onMonth(m: string): void }) {
  return (
    <span className="mswitch">
      <button type="button" aria-label={t('payroll.monthBefore')} onClick={() => onMonth(prevMonth(month))}>‹</button>
      <b>{monthText(month)}</b>
      <button type="button" aria-label={t('payroll.monthAfter')} onClick={() => onMonth(nextMonth(month))}>›</button>
    </span>
  );
}

/** ‹ 2026 › */
export function YearSwitch({ year, onYear }: { year: string; onYear(y: string): void }) {
  return (
    <span className="mswitch">
      <button type="button" aria-label={t('payroll.yearBefore')} onClick={() => onYear(String(Number(year) - 1))}>‹</button>
      <b className="mono">{year}</b>
      <button type="button" aria-label={t('payroll.yearAfter')} onClick={() => onYear(String(Number(year) + 1))}>›</button>
    </span>
  );
}

/** The app's disclaimer under every computed figure (§16 decision 14). */
export const Disclaimer = () => <p className="pdisclaimer">{t('payroll.disclaimer')}</p>;
