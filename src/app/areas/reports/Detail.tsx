/** One account's ledger for the period: opening, debits, credits and closing, then every entry with its running balance. */
import { useMemo } from 'react';
import type { RouteOf } from '../../shell/route.js';
import { periodName } from '../../lib/period-label.js';
import { getAccountMap } from '../../lib/accounts.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { Go, entryAt } from '../vat/links.js';
import { NO_ACCOUNT, ledgerOf, reportOfAccount } from './model.js';
import { accountName, accountOfRoute } from './view.js';

type Props = AreaProps<RouteOf<'reports'>>;

export function Detail({ route, books, period, nav }: Props) {
  const account = accountOfRoute(route);
  const l = useMemo(() => (account === undefined ? undefined : ledgerOf(books, account, period)), [books, account, period]);
  if (account === undefined || !l) return <div className="detail-empty"><div>{t('reports.noAccounts', { period: periodName(period) })}</div></div>;
  const none = account === NO_ACCOUNT;
  const names = getAccountMap();
  const of = reportOfAccount(account);
  return (
    <div className="detail-in" key={account}>
      <div className="head">
        <h2 className="who">{none ? t('reports.noAccount') : accountName(account, names)}<small>{none ? t('reports.oneSided') : t('reports.accountOf', { account, report: t(of === 'balance' ? 'tab.balanceSheet' : of === 'income' ? 'tab.incomeStatement' : 'tab.trialBalance') })}</small></h2>
        <div className="amount"><small>CHF</small>{fmt(l.closing)}</div>
      </div>
      <div className="facts">
        <span title={t('reports.balanceOn', { date: formatDate(period.from) })}>{t('reports.factOpening', { amount: fmt(l.opening) })}</span>
        <span>{t('reports.factDebit', { amount: fmt(l.debit) })}</span>
        <span>{t('reports.factCredit', { amount: fmt(l.credit) })}</span>
        <span title={t('reports.balanceOn', { date: formatDate(period.to) })}>{t('reports.factClosing', { amount: fmt(l.closing) })}</span>
        <span>{t('common.entryCount', { n: l.rows.length })}</span>
      </div>
      {none && <p className="zexpl">{t('reports.oneSidedText')}</p>}
      <div className="ledger">
        <div className="lh"><span>{t('col.date')}</span><span>{t('vat.colEntry')}</span><span>{t('reports.counter')}</span><span className="r">{t('reports.debit')}</span><span className="r">{t('reports.credit')}</span><span className="r">{t('reports.balance')}</span></div>
        {l.opening !== 0 && (
          <div className="lr open"><span className="mono d">{formatDate(period.from)}</span><span className="tt">{t('reports.openingBalance')}</span><span /><span /><span /><span className="r mono">{fmt(l.opening)}</span></div>
        )}
        {l.rows.map((r) => {
          const cells = (
            <>
              <span className="mono d">{formatDate(r.date)}</span>
              <span className="tt">{r.description || r.entryId}</span>
              <span className="mono oc" title={r.other ? names[r.other] : t('reports.noAccount')}>{r.other || '·'}</span>
              <span className="r mono">{r.debit != null ? fmt(r.debit) : ''}</span>
              <span className="r mono">{r.credit != null ? fmt(r.credit) : ''}</span>
              <span className="r mono">{fmt(r.balance)}</span>
            </>
          );
          return r.entry
            ? <Go key={r.entryId} to={entryAt(r.entry, period)} nav={nav} className="lr">{cells}</Go>
            : <div key={r.entryId} className="lr">{cells}</div>;
        })}
      </div>
    </div>
  );
}
