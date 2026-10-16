/**
 * Rechnungen: the invoices of a period by state (overdue first), the customers, and every
 * document sent; on the right the invoice on its A4 sheet, the customer, or the sent PDF
 * (the mockup's Rechnungen, ADR 0010).
 */
import { Fragment, useEffect, useRef } from 'react';
import './invoices.css';
import { INVOICE_STATUSES, type InvoiceStatus, type RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { moveKey } from '../../shell/keyboard.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { language, t } from '../../i18n/index.js';
import { monthName } from '../../lib/period-label.js';
import type { InvoiceList as Records } from '../../lib/api.js';
import { ICONS } from '../icons.js';
import { I } from '../receipts/icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { followBooks, invoicesNow, reloadInvoices, useInvoices } from './data.js';
import { byRouteId, counts, customerOpen, customerRows, customerOf, groupsOf, openSums, routeId, rowsOf, sentRows, type InvoiceRow } from './model.js';
import { listed, setUi, toggleGroup, ui, useUi } from './state.js';
import { invoiceAt, invoicePath, newDraftFor } from './actions.js';
import { Detail } from './Detail.js';
import { Dialogs } from './dialogs.js';
import { countryName } from './address.js';
import { localToday } from '../../../accounting/periods.js';
import { baseCurrency } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'invoices'>>;

const STATUS_LABEL = { open: 'invoices.filterOpen', overdue: 'invoices.filterOverdue', draft: 'invoices.filterDraft', paid: 'invoices.filterPaid' } as const;

function Views({ on, props }: { on: Props['route']['view']; props: Props }) {
  return (
    <span className="seg gb" role="tablist" aria-label={t('invoices.views')}>
      {(['list', 'customers', 'sent'] as const).map((v) => (
        <button key={v} type="button" role="tab" aria-selected={on === v} className={on === v ? 'on' : ''} data-view={v}
          onClick={() => props.nav.go({ route: { area: 'invoices', view: v }, query: v === 'list' ? { ...(props.query.period ? { period: props.query.period } : {}) } : {} })}>
          {t(`invoices.view.${v}`)}
        </button>
      ))}
    </span>
  );
}

function Search({ props }: { props: Props }) {
  const { query, nav } = props;
  return (
    <label className="search">
      {ICONS.search}
      <span className="sr">{t('invoices.searchLabel')}</span>
      <input type="search" placeholder={t('shell.search')} value={query.q ?? ''} className={query.q ? 'has' : ''} autoComplete="off"
        onChange={(e) => nav.setQuery({ q: e.target.value || undefined })}
        onKeyDown={(e) => { if (e.key === 'Escape') nav.setQuery({ q: undefined }); }} />
    </label>
  );
}

function List(props: Props) {
  const { route, nav } = props;
  const load = useInvoices();
  useUi();

  useEffect(() => followBooks(props.books), [props.books]);

  // /invoices/new?customer=<id>: a new draft for that customer, then its own link.
  const creating = useRef(false);
  useEffect(() => {
    if (route.view !== 'list' || route.id !== 'new' || load.state !== 'ready' || creating.current) return;
    const c = load.data.customers.find((x) => x.id === props.query.customer);
    if (!c) { nav.go({ route: { area: 'invoices', view: 'customers' }, query: {} }); return; }
    creating.current = true;
    void newDraftFor(nav, c).finally(() => { creating.current = false; });
  }, [route.id, load.state]);

  if (load.state !== 'ready') {
    return (
      <div className="page">
        <ListHead {...props} noPeriod={route.view !== 'list'} />
        <div className="empty"><p>{load.state === 'loading' ? t('app.loading') : t('invoices.unavailable')}</p></div>
      </div>
    );
  }
  if (route.view === 'customers') return <CustomerList {...props} d={load.data} />;
  if (route.view === 'sent') return <SentList {...props} d={load.data} />;
  return <InvoiceList {...props} d={load.data} />;
}

function InvoiceList(props: Props & { d: Records }) {
  const { route, query, period, nav, d } = props;
  const s = useUi();
  const today = localToday();
  const rows = rowsOf(d, period, query.q, today);
  const n = counts(rows);
  const groups = groupsOf(rows, query.status);
  const sums = openSums(rows, d.invoices);
  listed.ids = groups.filter((g) => !s.collapsed.has(g.state)).flatMap((g) => g.rows.map((r) => routeId(r.inv)));

  const selected = route.id && route.id !== 'new' ? route.id : undefined;
  useFirstRow(props, selected);
  // A link to an invoice of another period opens that period (urls.md rule 1).
  useEffect(() => {
    const inv = byRouteId(d.invoices, selected);
    if (inv?.status === 'issued' && !query.period && !rows.some((r) => r.inv.id === inv.id)) nav.go(invoiceAt(inv));
  }, [selected]);

  return (
    <div className="page">
      <ListHead {...props}>
        <div className="counts" role="tablist" aria-label={t('invoices.filters')}>
          <button type="button" role="tab" aria-selected={!query.status} className={query.status ? '' : 'on'} onClick={() => nav.setQuery({ status: undefined })}>
            <span className="n">{n.all}</span>{t('invoices.filterAll')}
          </button>
          {INVOICE_STATUSES.filter((st) => n[st] > 0 || query.status === st).map((st: InvoiceStatus) => (
            <button key={st} type="button" role="tab" aria-selected={query.status === st} className={query.status === st ? 'on' : ''} data-status={st} onClick={() => nav.setQuery({ status: st })}>
              <span className="n">{n[st]}</span>{t(STATUS_LABEL[st])}
            </button>
          ))}
          <Views on="list" props={props} />
        </div>
      </ListHead>
      <div className="vresult static"><span>{t('invoices.open')}</span><b className="mono"><small>CHF</small>{fmt(sums.open)}</b></div>
      {sums.overdue > 0 && <div className="notice warn rgap">{I.dot}<span>{t('invoices.overdueSum', { amount: fmt(sums.overdue) })}</span></div>}
      {groups.length === 0 ? (
        <div className="empty">
          <h2>{query.q ? t('invoices.nothingFound') : t('invoices.none')}</h2>
          <p>{query.q ? t('invoices.nothingFoundText', { q: query.q }) : t('invoices.noneText')}</p>
        </div>
      ) : (
        <div className="rows" role="listbox" aria-label={t('area.invoices')}>
          {groups.map((g) => {
            const shut = s.collapsed.has(g.state);
            return (
              <Fragment key={g.state}>
                <button type="button" className={`group${shut ? ' shut' : ''}`} aria-expanded={!shut} onClick={() => toggleGroup(g.state)}>
                  <span>{I.gch}{t(`invoices.state.${g.state}`)}</span><span className="mono">{g.rows.length}</span>
                </button>
                {!shut && g.rows.map((r) => <Row key={r.inv.id} r={r} sel={routeId(r.inv) === selected} onSelect={() => nav.select(invoicePath(r.inv))} />)}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Row({ r, sel, onSelect }: { r: InvoiceRow; sel: boolean; onSelect(): void }) {
  const { inv } = r;
  return (
    <div className={`row inv st-${r.state}${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={routeId(inv)} onClick={onSelect}>
      <span className="d mono">{inv.status === 'issued' ? inv.number : <span className="draftno">{t('invoices.draft')}</span>}</span>
      <span className="t">{r.state === 'overdue' && I.dot}{r.customer} {inv.subject && <small>{inv.subject}</small>}</span>
      <span className="a mono">{inv.currency !== baseCurrency() && <span className="c">{inv.currency}</span>}{fmt(r.gross)}</span>
    </div>
  );
}

/** With nothing selected, the first row is (a link to something else wins). */
function useFirstRow(props: Props, selected: string | undefined) {
  const first = listed.ids[0];
  useEffect(() => {
    if (!selected && first && props.route.id !== 'new') props.nav.select({ ...props.route, id: first });
  }, [selected, first, props.route.view]);
}

function CustomerList(props: Props & { d: Records }) {
  const { route, query, nav, d } = props;
  const rows = customerRows(d, query.q);
  listed.ids = rows.map((c) => c.id);
  useFirstRow(props, route.id);
  return (
    <div className="page">
      <ListHead {...props} noPeriod>
        <div className="counts">
          <span>{t('invoices.nCustomers', { n: d.customers.length })}</span>
          <Views on="customers" props={props} />
          <Search props={props} />
        </div>
      </ListHead>
      {rows.length === 0 ? <div className="empty"><h2>{t('invoices.noCustomers')}</h2><p>{t('invoices.noCustomersText')}</p></div> : (
        <div className="rows" role="listbox" aria-label={t('invoices.view.customers')}>
          {rows.map((c) => {
            const sel = c.id === route.id;
            const open = customerOpen(d, c.id);
            return (
              <div key={c.id} className={`row cust${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={c.id}
                onClick={() => nav.select({ area: 'invoices', view: 'customers', id: c.id })}>
                <span className="t">{c.name} <small>{c.address.town}{c.address.country !== 'CH' ? `, ${c.address.country}` : ''}</small></span>
                <span className="a mono">{open ? fmt(open) : ''}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SentList(props: Props & { d: Records }) {
  const { route, query, nav, d } = props;
  const rows = sentRows(d, query.q);
  listed.ids = rows.map((x) => x.id);
  useFirstRow(props, route.id);
  let month = '';
  return (
    <div className="page">
      <ListHead {...props} noPeriod>
        <div className="counts">
          <span>{t('invoices.nSent', { n: rows.length })}</span>
          <Views on="sent" props={props} />
          <Search props={props} />
        </div>
      </ListHead>
      {rows.length === 0 ? <div className="empty"><h2>{t('invoices.nothingSent')}</h2><p>{t('invoices.nothingSentText')}</p></div> : (
        <div className="rows" role="listbox" aria-label={t('invoices.view.sent')}>
          {rows.map((doc) => {
            const sel = doc.id === route.id;
            const inv = d.invoices.find((i) => i.id === doc.invoiceId);
            const m = doc.sentAt.slice(0, 7);
            const head = m !== month;
            month = m;
            return (
              <Fragment key={doc.id}>
                {head && <div className="group"><span>{monthName(`${m}-01`)}</span></div>}
                <div className={`row sentrow${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={doc.id}
                  onClick={() => nav.select({ area: 'invoices', view: 'sent', id: doc.id })}>
                  <span className="d mono">{formatDate(doc.sentAt.slice(0, 10)).slice(0, 6)}</span>
                  <span className="t">{doc.title} <small>{inv ? customerOf(d, inv)?.name : ''} · {t(`invoices.docKind.${doc.kind}`)}</small></span>
                  <span className="a mono">{new Date(doc.sentAt).toTimeString().slice(0, 5)}</span>
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('invoices.keySelectTip')],
  [['D'], t('invoices.keyDownload'), t('invoices.keyDownloadTip')],
  [['V'], t('invoices.keyPreview'), t('invoices.keyPreviewTip')],
  [['/'], t('keys.search'), t('invoices.searchLabel')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const invoices: Area<RouteOf<'invoices'>> = {
  id: 'invoices',
  label: () => t('area.invoices'),
  dock: { key: 'i', icon: ICONS.invoices, tip: () => t('area.invoices.tip') },
  List: (props) => <><List {...props} /><Dialogs {...props} /></>,
  Detail,
  add: {
    label: (r) => t(r.view === 'customers' ? 'invoices.sec.customer' : 'invoices.docKind.invoice'),
    title: (r) => t(r.view === 'customers' ? 'invoices.newCustomer' : 'invoices.newTitle'),
    run: (p) => setUi({ dialog: p.route.area === 'invoices' && p.route.view === 'customers' ? { kind: 'customer' } : { kind: 'new' } }),
  },
  legend,
  title: (r) => {
    const d = invoicesNow();
    if (!r.id || !d) return r.id;
    if (r.view === 'customers') return d.customers.find((c) => c.id === r.id)?.name;
    if (r.view === 'sent') return d.sent.find((x) => x.id === r.id)?.title;
    const inv = byRouteId(d.invoices, r.id);
    return inv ? (inv.status === 'issued' ? inv.number : `${t('invoices.draft')} · ${customerOf(d, inv)?.name ?? ''}`) : r.id;
  },
  palette: ({ nav, period }) => {
    const d = invoicesNow();
    if (!d) { void reloadInvoices(); return []; }
    return [
      ...[...d.invoices].sort((a, b) => b.date.localeCompare(a.date)).map((inv) => ({
        label: [inv.status === 'issued' ? inv.number : t('invoices.draft'), customerOf(d, inv)?.name, inv.subject].filter(Boolean).join(' · '),
        side: formatDate(inv.date),
        run: () => nav.go(invoiceAt(inv, period)),
      })),
      ...d.customers.map((c) => ({
        label: c.name,
        side: `${c.address.town}${c.address.country !== 'CH' ? `, ${countryName(c.address.country, language())}` : ''}`,
        run: () => nav.go({ route: { area: 'invoices', view: 'customers', id: c.id }, query: {} }),
      })),
    ];
  },
  keys(e, p) {
    if (ui().dialog) {
      if (e.key === 'Escape') setUi({ dialog: null });
      return true;
    }
    const d = moveKey(e);
    if (d) {
      const i = p.route.id ? listed.ids.indexOf(p.route.id) : -1;
      const next = listed.ids[Math.min(listed.ids.length - 1, Math.max(0, i + d))];
      if (next) p.nav.select({ ...p.route, id: next });
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case 'd': case 'D': {
        const a = document.querySelector<HTMLAnchorElement>('.detail a.dl');
        a?.click();
        return !!a;
      }
      case 'v': case 'V': {
        const b = document.querySelector<HTMLButtonElement>('.detail [data-act="preview"]');
        b?.click();
        return !!b;
      }
      case 'Escape': if (!p.query.q) return false; p.nav.setQuery({ q: undefined }); return true;
    }
    return false;
  },
};
