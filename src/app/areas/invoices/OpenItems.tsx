/**
 * Offene Posten (docs/specs/invoicing.md 4.4.12): every Rechnung with something open on a reference
 * date (today unless the link names one), by contact and currency with subtotals, with its days
 * overdue and its age band; printable as the Debitorenliste on A4 and exported to CSV. The amounts
 * are `openOn`, the year end's own figure: on 31.12. the list equals the year end's receivables
 * proposal on the cash basis, and on the agreed basis what the app's invoices hold on the receivable
 * account in the books (their events less their payments and credit notes; tests/open-items-agreed.test.ts).
 */
import { Fragment } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { AGE_BANDS, csvOf, openItemGroups, openItems, type AgeBand, type BandSums } from '../../../invoices/lists.js';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import type { InvoiceList } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { saveText } from './actions.js';
import { listed } from './state.js';
import { Views } from './views.js';
import { rowTab } from './Sent.js';

type Props = AreaProps<RouteOf<'invoices'>>;

const bandLabel = (b: AgeBand) => t(`sales.band.${b}`);
const amount = (n: number) => (n ? fmt(n) : '');

export function OpenItems(props: Props & { d: InvoiceList }) {
  const { route, query, nav, d } = props;
  const ws = useWorkspace();
  const date = query.date ?? localToday();
  const items = openItems(d.invoices, date);
  const { groups, totals } = openItemGroups(items);
  listed.ids = groups.flatMap((g) => g.items.map((x) => x.inv.number));
  const selected = route.id;

  const head = [t('sales.col.contact'), t('sales.col.currency'), t('sales.col.number'), t('sales.col.date'), t('sales.col.due'), t('sales.col.daysOverdue'), t('sales.col.open'), ...AGE_BANDS.map(bandLabel)];
  const exportCsv = () => saveText(csvOf(head, groups.flatMap((g) => g.items.map((x) => [
    g.name, g.currency, x.inv.number, formatDate(x.inv.date), formatDate(x.inv.dueDate), String(x.overdue), x.open, ...AGE_BANDS.map((b) => (x.band === b ? x.open : '')),
  ]))), `${t('sales.debtorList')}-${date}.csv`);

  const bandCells = (bands: BandSums) => AGE_BANDS.map((b) => <td key={b} className="num mono">{amount(bands[b])}</td>);

  return (
    <div className="page ivtable oplist" data-view="open-items">
      <ListHead {...props} noPeriod>
        <div className="counts noprint">
          <Views on="open-items" props={props} />
        </div>
      </ListHead>
      <div className="ivprinthead">
        <b>{ws?.company.name}</b>
        <span>{t('sales.debtorListOn', { date: formatDate(date) })}</span>
        <span className="m">{t('sales.printedOn', { date: formatDate(localToday()) })}</span>
      </div>
      <div className="ivfacts noprint">
        <label className="iin">{t('sales.refDate')} <input type="date" value={date} data-testid="op-date" onChange={(e) => nav.setQuery({ date: e.target.value && e.target.value !== localToday() ? e.target.value : undefined })} /></label>
        <span>{totals.length ? totals.map((x) => t('sales.op.total', { n: x.count, amount: `${x.currency} ${fmt(x.total)}` })).join(' · ') : t('sales.op.none')}</span>
        <button type="button" className="quiet2" data-act="print" onClick={() => print()}>{t('sales.print')}</button>
        <button type="button" className="quiet2" data-act="csv" onClick={exportCsv}>{t('sales.exportCsv')}</button>
      </div>
      {groups.length === 0 ? <div className="empty"><h2>{t('sales.op.none')}</h2><p>{t('sales.op.noneText', { date: formatDate(date) })}</p></div> : (
        <div className="ivscroll">
          <table className="ivt opt" aria-label={t('invoices.view.open-items')}>
            <thead>
              <tr>
                <th>{t('sales.col.number')}</th><th>{t('sales.col.date')}</th><th>{t('sales.col.due')}</th>
                <th className="num">{t('sales.col.daysOverdue')}</th><th className="num">{t('sales.col.open')}</th>
                {AGE_BANDS.map((b) => <th key={b} className="num">{bandLabel(b)}</th>)}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={`${g.customerId} ${g.currency}`}>
                  <tr className="grp"><td colSpan={5 + AGE_BANDS.length}><b>{g.name}</b> <span className="m mono">{g.currency}</span></td></tr>
                  {g.items.map((x) => {
                    const sel = x.inv.number === selected;
                    return (
                      <tr key={x.inv.id} className={`trow${sel ? ' sel' : ''}`} data-id={x.inv.number} aria-selected={sel} tabIndex={rowTab(sel, listed.ids.indexOf(x.inv.number), listed.ids.includes(selected ?? ''))}
                        onClick={() => nav.select({ area: 'invoices', view: 'open-items', id: x.inv.number })} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) nav.select({ area: 'invoices', view: 'open-items', id: x.inv.number }); }}>
                        <td className="mono">{x.inv.number}</td>
                        <td className="mono">{formatDate(x.inv.date)}</td>
                        <td className="mono">{formatDate(x.inv.dueDate)}</td>
                        <td className={`num mono${x.overdue ? ' late' : ''}`}>{x.overdue || ''}</td>
                        <td className="num mono">{fmt(x.open)}</td>
                        {AGE_BANDS.map((b) => <td key={b} className="num mono">{x.band === b ? fmt(x.open) : ''}</td>)}
                      </tr>
                    );
                  })}
                  <tr className="sub"><td colSpan={4}>{t('sales.op.subtotal', { name: g.name })}</td><td className="num mono">{fmt(g.total)}</td>{bandCells(g.bands)}</tr>
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              {totals.map((x) => (
                <tr key={x.currency} data-testid="op-total"><td colSpan={4}>{t('sales.op.totalIn', { currency: x.currency, n: x.count })}</td><td className="num mono">{fmt(x.total)}</td>{bandCells(x.bands)}</tr>
              ))}
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
