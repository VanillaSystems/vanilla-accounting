/**
 * Zu bezahlen (#571): Belege's bills with the day each is due, overdue first, then open, then paid,
 * each a fact of the books (src/app/areas/receipts/payables.ts); the receipt beside it is Belege's own
 * detail. Filtered by state and by Belege's chips, printed as a list and downloaded as CSV.
 */
import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { localToday } from '../../../accounting/periods.js';
import { baseCurrency, documents } from '../../../engines/index.js';
import { csvOf } from '../../../export/csv.js';
import type { InvoiceStatus, RouteOf } from '../../shell/route.js';
import { knownChips, applyChips, type Chip } from '../../shell/chips.js';
import { ChipFilter, chipWords } from '../../shell/ChipFilter.js';
import { ListHead } from '../../shell/ListHead.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { usePartnerIndex } from '../partners/data.js';
import { receiptFields } from './filter.js';
import { ledgerFor, listed } from './view.js';
import { BILL_STATES, billCounts, billsOf, billsTable, passes, unpaidSums, type Bill, type BillState, type BillWords } from './payables.js';
import { I } from './icons.js';

type Props = AreaProps<RouteOf<'receipts'>>;

/** The query's status as a bill's: Rechnungen's `draft` is none here. */
const statusOf = (s: InvoiceStatus | undefined): BillState | undefined => (s === 'open' || s === 'overdue' || s === 'paid' ? s : undefined);

/** Belege and Zu bezahlen: one switch, the period kept. */
export function ReceiptViews({ on, props }: { on: 'all' | 'bills'; props: Props }) {
  const keep = props.query.period ? { period: props.query.period } : {};
  return (
    <span className="seg2 rviews" role="tablist" aria-label={t('receipts.views')}>
      {(['all', 'bills'] as const).map((v) => (
        <button key={v} type="button" role="tab" aria-selected={on === v} className={on === v ? 'on' : ''} data-view={v}
          onClick={() => props.nav.go({ route: v === 'bills' ? { area: 'receipts', view: 'bills' } : { area: 'receipts' }, query: keep })}>
          {t(`receipts.view.${v}`)}
        </button>
      ))}
    </span>
  );
}

const words = (): BillWords => ({
  head: [t('bills.col.date'), t('bills.col.vendor'), t('bills.col.what'), t('bills.col.due'), t('bills.col.state'), t('bills.col.paidOn'), t('bills.col.currency'), t('bills.col.amount'), t('bills.col.file')],
  state: { overdue: t('bills.state.overdue'), open: t('bills.state.open'), paid: t('bills.state.paid') },
});

/** A bill's state in words, as a fact: «überfällig seit 15.11.2026», «fällig 30.11.2026», «bezahlt 28.11.2026». */
export const billFact = (b: Pick<Bill, 'state' | 'due' | 'paidOn'>) =>
  b.state === 'paid' ? t('bills.paidOn', { date: formatDate(b.paidOn) }) : t(b.state === 'overdue' ? 'bills.overdueSince' : 'bills.dueOn', { date: formatDate(b.due) });

export function BillList(props: Props) {
  const { route, query, period, books, nav } = props;
  const l = ledgerFor(books);
  const today = localToday();
  const partners = usePartnerIndex();
  const company = useWorkspace()?.company.name ?? '';
  const base = baseCurrency();
  // Belege's chips but its state and link fields: a bill's state is the tabs above.
  const fields = useMemo(() => receiptFields(l, partners, chipWords).filter((f) => f.id !== 'state' && f.id !== 'linked'), [l, partners]);
  const chips = useMemo(() => knownChips(query.chips ?? [], fields), [query.chips, fields]);
  const setChips = (next: Chip[]) => nav.setQuery({ chips: next.length ? next : undefined });
  const all = useMemo(() => billsOf(l, period, today, documents()), [l, period.from, period.to, today]);
  const needle = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const found = (b: Bill) => { const h = [b.v.vendor, b.v.desc, b.v.r.filename, b.amount.toFixed(2), b.v.r.remarks].join(' ').toLowerCase(); return needle.every((w) => h.includes(w)); };
  const chosen = useMemo(() => new Set(applyChips(all.map((b) => b.v), chips, fields)), [all, chips, fields]);
  const pool = all.filter((b) => chosen.has(b.v) && found(b));
  const status = statusOf(query.status);
  const shown = pool.filter((b) => passes(b, status));
  const n = billCounts(pool);
  const sums = unpaidSums(pool, base);
  const groups = BILL_STATES.map((state) => ({ state, rows: shown.filter((b) => b.state === state) })).filter((g) => g.rows.length);
  const ids = shown.map((b) => b.v.r.id);
  listed.ids = ids;
  listed.suggestions = new Map();

  // With nothing selected, the first row is (a link to a receipt wins).
  useEffect(() => { if (!route.id && ids[0]) nav.select({ area: 'receipts', view: 'bills', id: ids[0] }); }, [route.id, ids[0]]);

  const table = billsTable(shown, words(), base);
  const csv = `data:text/csv;charset=utf-8,${encodeURIComponent(csvOf(table))}`;
  const file = `${t('bills.fileName')}-${period.token.replace('..', '_')}.csv`;
  const sum = (s: { currency: string; open: number }) => `${s.currency} ${fmt(s.open)}`;
  const overdue = sums.filter((s) => s.overdue > 0).map((s) => `${s.currency} ${fmt(s.overdue)}`).join(' + ');

  return (
    <div className="page bills">
      <ListHead {...props}>
        <div className="counts" role="tablist" aria-label={t('bills.filters')}>
          <button type="button" role="tab" aria-selected={!status} className={status ? '' : 'on'} onClick={() => nav.setQuery({ status: undefined })}>
            <span className="n">{n.all}</span>{t('receipts.filterAll')}
          </button>
          {(['open', 'overdue', 'paid'] as const).filter((st) => n[st] > 0 || status === st).map((st) => (
            <button key={st} type="button" role="tab" aria-selected={status === st} className={status === st ? 'on' : ''} data-status={st} onClick={() => nav.setQuery({ status: st })}>
              <span className="n">{n[st]}</span>{t(`bills.filter.${st}`)}
            </button>
          ))}
          <ReceiptViews on="bills" props={props} />
        </div>
        <ChipFilter fields={fields} rows={all.map((b) => b.v)} chips={chips} onChips={setChips} q={query.q} onQ={(q) => nav.setQuery({ q })} searchLabel={t('receipts.searchLabel')} />
      </ListHead>
      <div className="bills-sum" data-testid="bills-sum">
        <span>{t('bills.toPay')}{overdue && <small data-testid="bills-overdue"> · {t('bills.ofWhichOverdue', { amount: overdue })}</small>}</span>
        <b className="mono">{sums.length ? sums.map((s, i) => <span key={s.currency} className={i ? 'also' : ''}>{i ? ' + ' : ''}<small>{s.currency}</small>{fmt(s.open)}</span>) : <><small>{base}</small>{fmt(0)}</>}</b>
      </div>
      <div className="bills-acts">
        <button type="button" className="linkbtn" data-testid="bills-print" disabled={!shown.length} onClick={printBills}>{t('bills.print')}</button>
        {shown.length ? <a className="linkbtn" data-testid="bills-csv" href={csv} download={file} data-tip={t('bills.csvTip')}>{t('bills.csv')}</a> : null}
      </div>
      {groups.length === 0 ? (
        <div className="empty">
          <h2>{query.q || chips.length || status ? t('bills.nothingFound') : t('bills.none', { period: periodName(period) })}</h2>
          <p>{t('bills.noneText')}</p>
        </div>
      ) : (
        <div className="rows" role="listbox" aria-label={t('receipts.view.bills')}>
          {groups.map((g) => (
            <div key={g.state} role="group" aria-label={t(`bills.state.${g.state}`)}>
              <div className="group" data-group={g.state}><span>{t(`bills.state.${g.state}`)}</span><span className="mono">{g.rows.length}</span></div>
              {g.rows.map((b) => <BillRow key={b.v.r.id} b={b} base={base} sel={b.v.r.id === route.id} onSelect={() => nav.select({ area: 'receipts', view: 'bills', id: b.v.r.id })} />)}
            </div>
          ))}
        </div>
      )}
      {createPortal(
        <div className="bills-print" aria-hidden="true">
          <h1>{t('bills.printTitle')}{company && <small> · {company}</small>}</h1>
          <p>{t('bills.printAsOf', { date: formatDate(today), period: periodName(period) })}{status ? ` · ${t(`bills.filter.${status}`)}` : ''}</p>
          <table>
            {/* The file's name stays in the CSV: on paper it only wraps. */}
            <thead><tr>{table.head.slice(0, -1).map((h, i) => <th key={i} className={table.money.includes(i) ? 'r' : ''}>{h}</th>)}</tr></thead>
            <tbody>{table.rows.map((row, j) => <tr key={j}>{row.slice(0, -1).map((c, i) => <td key={i} className={table.money.includes(i) ? 'r' : ''}>{typeof c === 'number' ? fmt(c) : c}</td>)}</tr>)}</tbody>
          </table>
          {sums.length > 0 && <p className="tot">{t('bills.toPay')}: {sums.map(sum).join(' + ')}{overdue && ` · ${t('bills.ofWhichOverdue', { amount: overdue })}`}</p>}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Prints the list, and only while its own button asked: another print of this screen stays its own. */
function printBills() {
  document.body.classList.add('print-bills');
  try { window.print(); } finally { document.body.classList.remove('print-bills'); }
}

function BillRow({ b, base, sel, onSelect }: { b: Bill; base: string; sel: boolean; onSelect(): void }) {
  const cur = b.currency || base;
  return (
    <div className={`row bill st-${b.state}${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={b.v.r.id} data-state={b.state} onClick={onSelect}>
      <span className="d mono" data-tip={t(b.dueBy === 'hand' ? 'bills.dueHandTip' : 'bills.dueReadTip')}>{formatDate(b.due)}</span>
      <span className="t" data-tip={b.v.desc || undefined}>{b.state === 'overdue' && I.dot}{b.v.vendor}<small className="bfact"> · {billFact(b)}</small>{b.v.desc && <small> · {b.v.desc}</small>}</span>
      <span className="a mono">{cur !== base && <span className="c">{cur}</span>}{fmt(b.amount)}</span>
    </div>
  );
}
