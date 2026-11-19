/**
 * Löhne › Übersicht (docs/specs/payroll.md §12.1, §6.1): the year strip (twelve months, closed, partly
 * closed, open, to come, today's marked, the gross of the closed payslips), the facts (an insurance the
 * firm must have and has not, an account the payroll books on that the chart lacks, a past month still
 * open), and the selected month's Lohnlauf beside it. Without insurances or people, what to do first.
 */
import { localToday, parsePeriod } from '../../../accounting/periods.js';
import { t } from '../../i18n/index.js';
import { errorText } from '../../lib/api.js';
import { fmt } from '../../lib/utils.js';
import { hrefOf } from '../../shell/history.js';
import { ListHead } from '../../shell/ListHead.js';
import type { Location } from '../../shell/route.js';
import type { AreaProps, Nav } from '../index.js';
import { urls, usePayroll, type Overview as Data, type SettingsView } from './data.js';
import { at, Disclaimer, employeeAt, Go, settingsAt, Tabs, YearSwitch, type PayrollRoute } from './common.js';
import { MonthRun } from './Payslips.js';
import { data, kindLabel, monthShort, monthText } from './words.js';

type Props = AreaProps<PayrollRoute>;

/** The year and month the Übersicht shows: `?period=` a month or a year, else today's. */
export function overviewMonth(props: Pick<Props, 'query'>, months?: Data['months']): { year: string; month: string } {
  const p = props.query.period;
  const today = localToday();
  if (p?.kind === 'month') return { year: p.from.slice(0, 4), month: p.from.slice(0, 7) };
  const year = p?.kind === 'year' ? p.from.slice(0, 4) : today.slice(0, 4);
  if (year === today.slice(0, 4)) return { year, month: today.slice(0, 7) };
  const open = months?.find((m) => m.state === 'open' || m.state === 'partial');
  return { year, month: open?.month ?? months?.filter((m) => m.state !== 'none').at(-1)?.month ?? `${year}-01` };
}

const monthLoc = (month: string): Location => ({ route: { area: 'payroll', view: 'overview' }, query: { period: parsePeriod(month, localToday()) ?? undefined } });

export function OverviewList(props: Props) {
  const { nav } = props;
  const { year } = overviewMonth(props);
  const load = usePayroll<Data>(urls.overview(year));
  const settings = usePayroll<SettingsView>(urls.settings);
  const { month } = overviewMonth(props, load.state === 'ready' ? load.data.months : undefined);
  const setYear = (y: string) => nav.setQuery({ period: parsePeriod(y, localToday()) ?? undefined });
  return (
    <div className="page">
      <ListHead {...props}><div className="counts"><Tabs on="overview" nav={nav} /></div></ListHead>
      <div className="plist">
        <YearSwitch year={year} onYear={setYear} />
        {load.state !== 'ready' ? <div className="empty"><p>{load.state === 'loading' ? t('app.loading') : errorText(load.error)}</p></div> : (
          <>
            {!load.data.insurances.length && !load.data.employees.length ? <Empty nav={nav} /> : null}
            <Strip d={load.data} month={month} nav={nav} />
            <Facts d={load.data} settings={settings.state === 'ready' ? settings.data : undefined} nav={nav} />
          </>
        )}
      </div>
    </div>
  );
}

/** What to do first: the insurances, then the people (§6.1 step 1). */
function Empty({ nav }: { nav: Nav }) {
  return (
    <div className="pempty" data-testid="payroll-empty">
      <h2>{t('payroll.overview.emptyTitle')}</h2>
      <p>{t('payroll.overview.emptyText')}</p>
      <ol>
        <li><Go nav={nav} loc={settingsAt('insurances')}>{t('payroll.overview.addInsurances')}</Go><span className="m"> · {t('payroll.overview.addInsurancesText')}</span></li>
        <li><Go nav={nav} loc={employeeAt('new')}>{t('payroll.employee.add')}</Go><span className="m"> · {t('payroll.overview.addPersonText')}</span></li>
      </ol>
    </div>
  );
}

function Strip({ d, month, nav }: { d: Data; month: string; nav: Nav }) {
  const now = d.today.slice(0, 7);
  return (
    <div className="ystrip" role="listbox" aria-label={t('payroll.overview.strip')}>
      {d.months.map((m) => {
        const sel = m.month === month;
        const loc = monthLoc(m.month);
        return (
          <a key={m.month} href={hrefOf(loc)} role="option" aria-selected={sel} className={`ym ${m.state}${sel ? ' sel' : ''}${m.month === now ? ' now' : ''}`} data-month={m.month}
            onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); nav.setQuery(loc.query); }}>
            <span className="mn">{monthShort(m.month)}</span>
            <span className="ms">{m.state === 'partial' ? t('payroll.state.partial', { closed: m.closed, of: m.of }) : t(`payroll.state.${m.state}`)}</span>
            <span className="mg mono">{m.gross ? fmt(m.gross) : ''}</span>
          </a>
        );
      })}
    </div>
  );
}

/** The facts beside the year: never reminders, each with where to act. */
function Facts({ d, settings, nav }: { d: Data; settings?: SettingsView; nav: Nav }) {
  const pd = data();
  const missingKinds = Object.entries(pd?.insurances ?? {}).filter(([kind, k]) => k.required && !d.insurances.some((i) => i.kind === kind)).map(([k]) => k);
  const missingAccounts = settings?.accounts.filter((a) => !a.exists) ?? [];
  const now = d.today.slice(0, 7);
  const open = d.months.filter((m) => m.month < now && (m.state === 'open' || m.state === 'partial'));
  if (!missingKinds.length && !missingAccounts.length && !open.length && !d.federal.includes(d.year)) {
    return <p className="m pfact">{t('payroll.overview.allSet')}</p>;
  }
  return (
    <ul className="pfactlist">
      {missingKinds.length ? <li><Go nav={nav} loc={settingsAt('insurances')}>{t('payroll.overview.missingInsurances', { list: missingKinds.map(kindLabel).join(', ') })}</Go></li> : null}
      {missingAccounts.length ? <li><Go nav={nav} loc={settingsAt('accounts')}>{t('payroll.overview.missingAccounts', { list: missingAccounts.map((a) => a.number).join(', ') })}</Go></li> : null}
      {open.map((m) => <li key={m.month}><Go nav={nav} loc={at({ area: 'payroll', view: 'payslips', month: m.month })}>{t('payroll.overview.monthOpen', { month: monthText(m.month), closed: m.closed, of: m.of })}</Go></li>)}
      {!d.federal.includes(d.year) ? <li className="warn">{t('payroll.overview.noFederal', { year: d.year })}</li> : null}
    </ul>
  );
}

export function OverviewDetail(props: Props) {
  const { nav, canEdit } = props;
  const { year } = overviewMonth(props);
  const load = usePayroll<Data>(urls.overview(year));
  const { month } = overviewMonth(props, load.state === 'ready' ? load.data.months : undefined);
  return (
    <div className="detail-in prunview" key={month}>
      <div className="head">
        <h2 className="who">{t('payroll.run.title', { month: monthText(month) })}<small>{t('payroll.run.lead')}</small></h2>
      </div>
      <div className="docbody">
        <MonthRun month={month} nav={nav} canEdit={canEdit} />
        <p><Go nav={nav} loc={at({ area: 'payroll', view: 'payslips', month })}>{t('payroll.run.open')}</Go></p>
        <Disclaimer />
      </div>
    </div>
  );
}
