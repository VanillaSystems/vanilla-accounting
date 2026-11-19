/**
 * Rechnungen and Gutschriften as one table each (docs/specs/invoicing.md 4.8, layout A): the status tabs
 * from facts with count and total, the facts line, the columns that sort, the totals of what is shown,
 * 50 rows a page with the rest named, ticked rows with their bulk bar and «⋯» on each row. A row opens
 * its document as the panel over the table's right part.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { localToday } from '../../../accounting/periods.js';
import type { Issued } from '../../../invoices/model.js';
import { csvOf } from '../../../invoices/lists.js';
import { levelTitle, nextLevel, DEFAULT_DUNNING } from '../../../invoices/dunning.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { CONVERSIONS } from '../../../invoices/chain.js';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { Menu, type MenuItem } from '../../shell/Menu.js';
import { hrefOf } from '../../shell/history.js';
import { periodName } from '../../lib/period-label.js';
import { sources, type InvoiceList } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { baseCurrency } from '../../../engines/index.js';
import type { AreaProps } from '../index.js';
import { byRouteId } from './model.js';
import { copyAsDraft, invoiceAt, remind, saveText } from './actions.js';
import { listed, setUi, toggleTick, useUi } from './state.js';
import {
  PAGE_SIZE, docRows, factsOf, groupOf, inTab, kindOfView, sortRows, sumsOf, tabCounts, tabOf,
  type DocKind, type DocRow, type DocView, type SortKey, type Sum, type Tab,
} from './table.js';
import { SentCell, channelText, rowTab } from './Sent.js';
import { Search, Views } from './views.js';

type Props = AreaProps<RouteOf<'invoices'>>;

interface Column { key: SortKey; label: string; num?: boolean; cell(r: DocRow): ReactNode; csv(r: DocRow): string | number }

const money = (r: DocRow, n: number) => (r.inv.currency !== baseCurrency() ? <><span className="c">{r.inv.currency}</span>{fmt(n)}</> : fmt(n));

/** The status with the sent mark: «Offen · gesendet», «Überfällig · 12 Tage · nicht gesendet», «Entwurf». */
export function statusText(r: DocRow, kind: DocKind): string {
  const base = r.overdue > 0 ? t('sales.status.overdueDays', { n: r.overdue }) : t(`sales.status.${groupOf(kind)}.${r.status}` as 'sales.status.invoice.open');
  if (r.inv.status !== 'issued') return base;
  // A cancelled document waits for nothing: it reads «gesendet» when it went out, never «nicht gesendet».
  if (r.status === 'cancelled' && !r.sent.sent) return base;
  return `${base} · ${t(r.sent.sent ? 'sales.mark.sent' : 'sales.mark.unsent')}`;
}

function StatusChip({ r, kind }: { r: DocRow; kind: DocKind }) {
  const tone = r.overdue > 0 ? 'overdue' : r.status;
  return <span className={`ivchip st-${tone}${r.unsent ? ' unsent' : ''}`} data-testid="status-chip">{statusText(r, kind)}</span>;
}

function columns(kind: DocKind, go: (loc: ReturnType<typeof invoiceAt>) => void): Column[] {
  const date: Column = { key: 'date', label: t('sales.col.date'), cell: (r) => <span className="mono">{formatDate(r.inv.date)}</span>, csv: (r) => formatDate(r.inv.date) };
  const number: Column = { key: 'number', label: t('sales.col.number'), cell: (r) => (r.inv.status === 'issued' ? <span className="mono">{r.inv.number}</span> : <span className="draftno" data-tip={r.inv.number ? t('invoices.draftKeeps', { number: r.inv.number }) : undefined}>{t('invoices.draft')}{r.inv.number ? ` ${r.inv.number}` : ''}</span>), csv: (r) => r.inv.number ?? '' };
  const contact: Column = { key: 'contact', label: t('sales.col.contact'), cell: (r) => <span className="tt">{r.customer}{r.inv.subject && <small>{r.inv.subject}</small>}</span>, csv: (r) => [r.customer, r.inv.subject].filter(Boolean).join(' · ') };
  const status: Column = { key: 'status', label: t('sales.col.status'), cell: (r) => <StatusChip r={r} kind={kind} />, csv: (r) => statusText(r, kind) };
  const sent: Column = {
    key: 'sent', label: t('sales.col.sent'), cell: (r) => <SentCell facts={r.sent} />,
    csv: (r) => (r.sent.last ? `${formatDate(r.sent.last.sentAt.slice(0, 10))} ${channelText(r.sent.last)}` : ''),
  };
  const gross: Column = { key: 'gross', label: t('sales.col.gross'), num: true, cell: (r) => money(r, r.gross), csv: (r) => r.gross };
  const share = (key: 'delivered' | 'invoiced'): Column => ({
    key, label: t(`sales.col.${key}`), num: true,
    cell: (r) => (r[key] === undefined ? '–' : <span className={r[key]! >= 1 ? 'full' : ''}>{Math.round(r[key]! * 100)} %</span>), csv: (r) => (r[key] === undefined ? '' : `${Math.round(r[key]! * 100)} %`),
  });
  if (kind === 'quote') {
    const until: Column = { key: 'validUntil', label: t('sales.col.validUntil'), cell: (r) => (r.inv.validUntil ? <span className={`mono${r.status === 'expired' ? ' late' : ''}`}>{formatDate(r.inv.validUntil)}</span> : '–'), csv: (r) => (r.inv.validUntil ? formatDate(r.inv.validUntil) : '') };
    return [date, number, contact, status, sent, until, gross];
  }
  if (kind === 'sales-order') return [date, number, contact, status, share('delivered'), share('invoiced'), gross];
  if (kind === 'delivery-note') {
    const order: Column = {
      key: 'order', label: t('sales.col.order'),
      cell: (r) => (r.target ? <a className="golink mono" href={hrefOf(invoiceAt(r.target))} onClick={(e) => { e.stopPropagation(); if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(invoiceAt(r.target!)); }}>{r.target.number}</a> : '–'),
      csv: (r) => r.target?.number ?? '',
    };
    return [date, number, contact, order, status, sent];
  }
  if (kind === 'credit-note') {
    const invoice: Column = {
      key: 'invoice', label: t('sales.col.invoice'),
      cell: (r) => (r.target ? <a className="golink mono" href={hrefOf(invoiceAt(r.target))} onClick={(e) => { e.stopPropagation(); if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(invoiceAt(r.target!)); }}>{r.target.number}</a> : '–'),
      csv: (r) => r.target?.number ?? '',
    };
    return [date, number, contact, invoice, status, sent, gross, { key: 'open', label: t('sales.col.refund'), num: true, cell: (r) => (r.open ? money(r, r.open) : '–'), csv: (r) => r.open }];
  }
  return [
    date, number, contact, status, sent,
    { key: 'due', label: t('sales.col.due'), cell: (r) => (r.inv.status === 'issued' ? <span className={`mono${r.overdue ? ' late' : ''}`}>{formatDate(r.inv.dueDate)}</span> : '–'), csv: (r) => (r.inv.status === 'issued' ? formatDate(r.inv.dueDate) : '') },
    { key: 'currency', label: t('sales.col.currency'), cell: (r) => <span className="mono">{r.inv.currency}</span>, csv: (r) => r.inv.currency },
    gross,
    { key: 'open', label: t('sales.col.open'), num: true, cell: (r) => (r.open ? money(r, r.open) : '–'), csv: (r) => r.open },
    // The Mahnstufe by its name, as the last Mahnung printed it; one written and not sent yet beside it.
    { key: 'level', label: t('sales.col.level'), cell: (r) => (r.levelTitle || r.reminderDraft ? <span data-testid="level-cell">{r.levelTitle ?? ''}{r.reminderDraft ? <small className="m">{r.levelTitle ? ' · ' : ''}{t('sales.levelDraft', { title: r.reminderDraft })}</small> : null}</span> : '–'), csv: (r) => r.levelTitle ?? '' },
  ];
}

const sumText = (sums: readonly Sum[], pick: 'gross' | 'open') => sums.filter((s) => s[pick] !== 0 || sums.length === 1).map((s) => `${s.currency} ${fmt(s[pick])}`).join(' + ') || '–';
/** A total per currency, one line each, so the column keeps its width. */
const sumLines = (sums: readonly Sum[], pick: 'gross' | 'open') => {
  const xs = sums.filter((s) => s[pick] !== 0 || sums.length === 1);
  return xs.length ? xs.map((s) => <div key={s.currency}><span className="c">{s.currency}</span>{fmt(s[pick])}</div>) : '–';
};

export function DocTable(props: Props & { d: InvoiceList; view: DocView }) {
  const { route, query, period, nav, d, view } = props;
  const s = useUi();
  const kind = kindOfView(view);
  const today = localToday();
  const all = docRows(d, kind, period, query.q, today);
  const tab = tabOf(kind, query.status);
  const shown = sortRows(all.filter((r) => inTab(r, tab)), s.sort[view]);
  const [pages, setPages] = useState(1);
  const [menu, setMenu] = useState<{ r: DocRow; at: DOMRect } | null>(null);
  const page = shown.slice(0, pages * PAGE_SIZE);
  listed.ids = page.map((r) => r.id);
  const selected = route.id && route.id !== 'new' ? route.id : undefined;
  const cols = columns(kind, nav.go);
  const ticked = shown.filter((r) => s.ticked.has(r.inv.id));
  const sums = sumsOf(shown);

  // Another view, tab, period or search starts with nothing ticked and on its first page.
  useEffect(() => { setUi({ ticked: new Set() }); setPages(1); }, [view, tab, period.token, query.q]);

  // A link to a document of the other kind opens it in its own view; one of another period opens that period (urls.md rule 1).
  useEffect(() => {
    const inv = byRouteId(d.invoices, selected);
    if (!inv) return;
    // invoiceAt names the view of the document's kind and a period that holds its date.
    if (inv.kind !== kind) { nav.go(invoiceAt(inv, period)); return; }
    if (inv.status === 'issued' && !query.period && !all.some((r) => r.inv.id === inv.id)) nav.go(invoiceAt(inv));
  }, [selected, view]);

  const sortBy = (key: SortKey) => {
    const cur = s.sort[view];
    setUi({ sort: { ...s.sort, [view]: { key, dir: cur.key === key ? (cur.dir === 1 ? -1 : 1) : key === 'date' || key === 'gross' || key === 'open' ? -1 : 1 } } });
  };
  const open = (r: DocRow) => nav.select({ area: 'invoices', view, id: r.id });
  /** The rows as CSV: the whole tab, filter and search from the facts line; the ticked ones from the bulk bar. */
  const exportCsv = (rows: readonly DocRow[] = shown) => saveText(csvOf(cols.map((c) => c.label), rows.map((r) => cols.map((c) => c.csv(r)))), `${t(`invoices.view.${view}`)}-${period.token.replace('..', '_')}.csv`);
  const allTicked = page.length > 0 && page.every((r) => s.ticked.has(r.inv.id));

  return (
    <div className="page ivtable" data-view={view}>
      <ListHead {...props}>
        <div className="counts">
          <Views on={view} props={props} />
          <Search props={props} />
        </div>
      </ListHead>
      <Tabs {...props} kind={kind} tab={tab} rows={all} />
      <FactLine rows={all} kind={kind} onExport={() => exportCsv()} {...(props.canEdit && kind === 'invoice' ? { onDunning: () => setUi({ dialog: { kind: 'dunning' } }) } : {})} />
      {ticked.length > 0 && (
        <div className="ivbulk" role="toolbar" aria-label={t('sales.bulk.label')} data-testid="bulk-bar">
          <b>{t('sales.bulk.ticked', { n: ticked.length })}</b>
          {props.canEdit && <button type="button" className="btn primary" data-act="bulk-send" onClick={() => setUi({ dialog: { kind: 'bulk-send', ids: ticked.map((r) => r.inv.id) } })}>{t('invoices.send')}</button>}
          {props.canEdit && kind === 'invoice' && <button type="button" className="btn ghost" data-act="bulk-remind" onClick={() => setUi({ dialog: { kind: 'dunning', ids: ticked.map((r) => r.inv.id) } })}>{t('dunning.bulk')}</button>}
          <button type="button" className="btn ghost" data-act="bulk-pdf" onClick={() => setUi({ dialog: { kind: 'bulk-pdf', ids: ticked.map((r) => r.inv.id) } })}>{t('sales.bulk.pdf')}</button>
          <button type="button" className="btn ghost" data-act="bulk-csv" onClick={() => exportCsv(ticked)}>{t('sales.exportCsv')}</button>
          <button type="button" className="quiet2" onClick={() => setUi({ ticked: new Set() })}>{t('sales.bulk.clear')}</button>
        </div>
      )}
      {shown.length === 0 ? (
        <div className="empty">
          <h2>{query.q ? t('invoices.nothingFound') : t(kind === 'invoice' ? 'invoices.none' : kind === 'credit-note' ? 'sales.noCredits' : `sales.none.${groupOf(kind)}` as 'sales.noCredits', { period: periodName(period) })}</h2>
          <p>{query.q ? t('invoices.nothingFoundText', { q: query.q }) : t(kind === 'invoice' ? 'invoices.noneText' : kind === 'credit-note' ? 'sales.noCreditsText' : `sales.noneText.${groupOf(kind)}` as 'sales.noCreditsText')}</p>
        </div>
      ) : (
        <div className="ivscroll">
          <table className="ivt" aria-label={t(`invoices.view.${view}`)}>
            <thead>
              <tr>
                <th className="tick"><input type="checkbox" aria-label={t('sales.bulk.tickPage')} checked={allTicked} onChange={() => setUi({ ticked: allTicked ? new Set([...s.ticked].filter((id) => !page.some((r) => r.inv.id === id))) : new Set([...s.ticked, ...page.map((r) => r.inv.id)]) })} /></th>
                {cols.map((c) => {
                  const on = s.sort[view].key === c.key;
                  return (
                    <th key={c.key} className={`c-${c.key}${c.num ? ' num' : ''}`} aria-sort={on ? (s.sort[view].dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" className={on ? 'on' : ''} data-sort={c.key} onClick={() => sortBy(c.key)}>{c.label}{on ? (s.sort[view].dir === 1 ? ' ↑' : ' ↓') : ''}</button>
                    </th>
                  );
                })}
                <th className="more" aria-label={t('sales.rowActions')} />
              </tr>
            </thead>
            <tbody>
              {page.map((r, i) => {
                const sel = r.id === selected;
                return (
                  <tr key={r.inv.id} className={`trow${sel ? ' sel' : ''}${r.status === 'cancelled' ? ' gone' : ''}`} data-id={r.id} aria-selected={sel} tabIndex={rowTab(sel, i, page.some((x) => x.id === selected))} onClick={() => open(r)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(r); }}>
                    <td className="tick" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={t('sales.bulk.tick', { what: r.inv.status === 'issued' ? r.inv.number : t('invoices.draft') })} checked={s.ticked.has(r.inv.id)} onChange={() => toggleTick(r.inv.id)} /></td>
                    {cols.map((c) => <td key={c.key} className={`c-${c.key}${c.num ? ' num mono' : ''}`}>{c.cell(r)}</td>)}
                    <td className="more" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="ivmore" aria-label={t('sales.rowActions')} data-act="row-menu" onClick={(e) => setMenu({ r, at: e.currentTarget.getBoundingClientRect() })}>⋯</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr data-testid="totals-row">
                <td />
                {/* One cell per column (no colSpan), so a column hidden at a narrow width takes its cell along. */}
                {cols.map((c, i) => (
                  <td key={c.key} className={`c-${c.key}${c.num ? ' num mono' : ''}`}>
                    {i === 0 ? <span className="ivtotal">{t('sales.totalOf', { n: shown.length })}</span> : c.key === 'gross' || c.key === 'open' ? sumLines(sums, c.key) : null}
                  </td>
                ))}
                <td />
              </tr>
            </tfoot>
          </table>
          {shown.length > page.length && (
            <p className="ivpager" data-testid="pager">
              {t('sales.pageOf', { shown: page.length, total: shown.length })}{' '}
              <button type="button" className="quiet2" onClick={() => setPages(pages + 1)}>{t('sales.pageMore', { n: Math.min(PAGE_SIZE, shown.length - page.length) })}</button>
            </p>
          )}
        </div>
      )}
      {menu && <RowMenu {...props} r={menu.r} at={menu.at} view={view} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The status tabs with their counts and totals, and «Nicht gesendet» set apart. */
function Tabs({ nav, kind, tab, rows }: Props & { kind: DocKind; tab: Tab; rows: DocRow[] }) {
  const counts = tabCounts(rows, kind);
  return (
    <div className="ivtabs" role="tablist" aria-label={t('invoices.filters')}>
      {counts.map((c) => (
        <button key={c.tab} type="button" role="tab" aria-selected={tab === c.tab} className={`${tab === c.tab ? 'on' : ''}${c.tab === 'unsent' ? ' apart' : ''}`} data-status={c.tab}
          onClick={() => nav.setQuery({ status: c.tab === 'all' ? undefined : c.tab })}>
          <span className="l">{t(`sales.tab.${groupOf(kind)}.${c.tab}` as 'sales.tab.invoice.all')}</span>
          <span className="n mono">{c.n}</span>
          {c.n > 0 && kind !== 'delivery-note' && <small className="mono">{sumText(c.sums, 'gross')}</small>}
        </button>
      ))}
    </div>
  );
}

/** One line of facts above the table: what is open and what of it is overdue, per currency. */
function FactLine({ rows, kind, onExport, onDunning }: { rows: DocRow[]; kind: DocKind; onExport(): void; onDunning?(): void }) {
  // An Angebot, Auftrag or Lieferschein asks for no money: the line names what waits, by count.
  if (kind !== 'invoice' && kind !== 'credit-note') {
    const waiting = rows.filter((r) => r.status === 'open' || r.status === 'partly').length;
    return (
      <p className="ivfacts" data-testid="facts-line">
        <span>{kind === 'delivery-note' ? t('sales.facts.deliveries', { n: rows.filter((r) => r.status === 'done').length }) : t(`sales.facts.waiting.${groupOf(kind)}` as 'sales.facts.waiting.quote', { n: waiting })}</span>
        <button type="button" className="quiet2" data-act="csv" onClick={onExport}>{t('sales.exportCsv')}</button>
      </p>
    );
  }
  const facts = factsOf(rows);
  const open = facts.map((f) => `${f.currency} ${fmt(f.open)}`).join(' + ');
  const overdue = facts.filter((f) => f.overdue > 0).map((f) => `${f.currency} ${fmt(f.overdue)}`).join(' + ');
  return (
    <p className="ivfacts" data-testid="facts-line">
      <span>{facts.length ? t(kind === 'invoice' ? 'sales.facts.open' : 'sales.facts.refund', { amount: open }) : t(kind === 'invoice' ? 'sales.facts.nothingOpen' : 'sales.facts.nothingRefund')}</span>
      {overdue && <span className="warn">{t('sales.facts.overdue', { amount: overdue })}</span>}
      {/* The Mahnlauf is an action, not a place: a dialog over the table. */}
      {onDunning && <button type="button" className="quiet2" data-act="dunning" onClick={onDunning}>{t('dunning.open')}</button>}
      <button type="button" className="quiet2" data-act="csv" onClick={onExport}>{t('sales.exportCsv')}</button>
    </p>
  );
}

/** «⋯» on a row: Öffnen, PDF, Senden, Mahnen, Als Entwurf kopieren, as far as the document allows. */
function RowMenu({ r, at, view, nav, canEdit, onClose }: Props & { d: InvoiceList; r: DocRow; at: DOMRect; view: DocView; onClose(): void }) {
  const inv = r.inv;
  const dunning = useWorkspace()?.invoicing?.dunning ?? DEFAULT_DUNNING;
  const go = () => nav.select({ area: 'invoices', view, id: r.id });
  const items: MenuItem[] = [{ label: t('sales.menu.open'), run: go }];
  if (inv.status === 'issued') {
    items.push({ label: t('sales.bulk.pdf'), run: () => { const a = Object.assign(document.createElement('a'), { href: sources.invoicePdf(inv.number), download: `${inv.number}.pdf` }); document.body.append(a); a.click(); a.remove(); } });
    if (canEdit && !inv.cancelled) items.push({ label: r.sent.sent ? t('invoices.resend') : t('invoices.send'), run: () => { go(); setUi({ dialog: { kind: 'send' } }); } });
    if (canEdit && inv.kind === 'invoice' && !inv.cancelled && r.open > 0) items.push({ label: t('invoices.remind', { title: levelTitle(nextLevel(inv, dunning).def, inv.language) }), run: () => { go(); void remind(nav, inv); } });
    if (canEdit && !inv.cancelled) for (const to of CONVERSIONS[inv.kind] ?? []) items.push({ label: t(`sales.convert.${to}` as 'sales.convert.invoice'), run: () => { go(); setUi({ dialog: { kind: 'convert', to } }); } });
    // A Lieferschein comes only from an Auftrag: it is not copied into a draft of its own.
    if (canEdit && inv.kind !== 'credit-note' && inv.kind !== 'delivery-note') items.push({ label: t('invoices.copy'), run: () => { void copyAsDraft(nav, inv as Issued); } });
  }
  return (
    // The menu keeps its keys: ↑ ↓ move in it, not through the table's rows; Esc closes it, not the panel.
    <div onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
      <Menu anchor={at} items={items} onClose={onClose} />
    </div>
  );
}
