/** Small pieces every page of Löhne uses: a link that goes inside the app, the tabs, a month's switch, a refusal in the page. */
import { useState, type MouseEvent, type ReactNode } from 'react';
import { t } from '../../i18n/index.js';
import { errorText } from '../../lib/api.js';
import { hrefOf } from '../../shell/history.js';
import type { Location, Route, RouteOf } from '../../shell/route.js';
import { localToday, parsePeriod, periodContaining } from '../../../accounting/periods.js';
import { filing } from '../../../engines/index.js';
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
export const paymentAt = (id: string): Location => at({ area: 'payroll', view: 'payments', month: id.slice(0, 7), employee: id.slice(8) });
export const documentAt = (year: string, doc?: string): Location => at({ area: 'payroll', view: 'documents', year, ...(doc ? { doc } : {}) });

/** A place outside Löhne (a bank payment, a journal entry) in the period that holds its date (urls.md rule 1). */
export const inPeriodOf = (route: Route, date: string): Location =>
  ({ route, query: { period: parsePeriod(periodContaining(date, undefined, filing().length), localToday()) ?? undefined } });

/** Each tab's own page: its route without a selection. */
const TABS: { [V in PayrollRoute['view']]: PayrollRoute } = {
  overview: { area: 'payroll', view: 'overview' },
  payslips: { area: 'payroll', view: 'payslips' },
  payments: { area: 'payroll', view: 'payments' },
  employees: { area: 'payroll', view: 'employees' },
  documents: { area: 'payroll', view: 'documents' },
  settings: { area: 'payroll', view: 'settings' },
};

/** Übersicht, Lohnabrechnungen, Lohnzahlungen, Mitarbeitende, Dokumente, Einstellungen (§12.1). */
export function Tabs({ on, nav }: { on: PayrollRoute['view']; nav: Nav }) {
  return (
    <span className="seg ptabs" role="tablist" aria-label={t('payroll.tabs')}>
      {(Object.keys(TABS) as Array<PayrollRoute['view']>).map((v) => (
        <button key={v} type="button" role="tab" aria-selected={on === v} className={on === v ? 'on' : ''} data-view={v}
          onClick={() => nav.go(at(TABS[v]))}>
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

/** The app's note under every computed figure (§22 decision 47, replacing the wording of §16 decision 14): what it is computed from, the federal figures of `year`. */
export const Disclaimer = ({ year }: { year: string }) => <p className="pdisclaimer">{t('payroll.disclaimer', { year })}</p>;

/**
 * A refusal of the server (a line without an amount, the social security number as a password, a closed period) as a
 * panel in the page, where the person acts: it stays until she hides it or tries again, never only a toast.
 */
export function useRefusal(): { node: ReactNode; refuse(e: unknown): void; clear(): void } {
  const [why, setWhy] = useState<string | null>(null);
  const node = why ? (
    <div className="pcard warnpanel" role="alert" data-testid="refused">
      <p>{why}</p>
      <button type="button" className="quiet2" onClick={() => setWhy(null)}>{t('payroll.mail.dismiss')}</button>
    </div>
  ) : null;
  return { node, refuse: (e) => setWhy(errorText(e)), clear: () => setWhy(null) };
}
