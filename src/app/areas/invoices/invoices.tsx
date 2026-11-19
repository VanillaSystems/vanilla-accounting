/**
 * Verkauf (docs/specs/invoicing.md 4.8): Rechnungen, Gutschriften, Offene Posten and Versendet, each a
 * table across the width with the document open as a panel over its right part (layout A), and the
 * customers as a list with the customer beside it. The document is shown on its A4 sheet.
 */
import { useEffect, useRef } from 'react';
import './invoices.css';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { moveKey } from '../../shell/keyboard.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { language, t } from '../../i18n/index.js';
import type { InvoiceList as Records } from '../../lib/api.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { followBooks, invoicesNow, newestIssued, reloadInvoices, useInvoices } from './data.js';
import { byRouteId, customerOpen, customerRows, customerOf } from './model.js';
import { listed, setUi, ui } from './state.js';
import { invoiceAt, newDraftFor } from './actions.js';
import { Detail } from './Detail.js';
import { Dialogs } from './dialogs.js';
import { countryName } from './address.js';
import { DocTable } from './DocTable.js';
import { OpenItems } from './OpenItems.js';
import { SentLog } from './SentLog.js';
import { Search, Views } from './views.js';

type Props = AreaProps<RouteOf<'invoices'>>;

function List(props: Props) {
  const { route, nav } = props;
  const load = useInvoices();

  useEffect(() => followBooks(props.books), [props.books]);

  // /invoices/new?customer=<id>: a new draft for that customer, then its own link.
  const creating = useRef(false);
  useEffect(() => {
    if (route.view !== 'list' || route.id !== 'new' || load.state !== 'ready' || creating.current) return;
    const c = load.data.customers.find((x) => x.id === props.query.customer);
    // Known read-only (the audit export): no draft is made, the customer is shown instead. While the API's status is not yet
    // known canEdit is false too: the link waits for it, never sends a person away from a draft she may make.
    if (!c || props.readOnly) { nav.go({ route: { area: 'invoices', view: 'customers', ...(c ? { id: c.id } : {}) }, query: {} }); return; }
    if (!props.canEdit) return;
    creating.current = true;
    void newDraftFor(nav, c).finally(() => { creating.current = false; });
  }, [route.id, load.state, props.canEdit, props.readOnly]);

  if (load.state !== 'ready') {
    return (
      <div className="page">
        <ListHead {...props} noPeriod={route.view !== 'list' && route.view !== 'credit-notes'} />
        <div className="empty"><p>{load.state === 'loading' ? t('app.loading') : t('invoices.unavailable')}</p></div>
      </div>
    );
  }
  switch (route.view) {
    case 'customers': return <CustomerList {...props} d={load.data} />;
    case 'sent': return <SentLog {...props} d={load.data} />;
    case 'open-items': return <OpenItems {...props} d={load.data} />;
    default: return <DocTable {...props} d={load.data} view={route.view} />;
  }
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

/** Layout A: every view but Kunden is a table; its document opens as a panel while the route names one. */
const tableOf = (r: RouteOf<'invoices'>) => (r.view === 'customers' ? undefined : { open: !!r.id && r.id !== 'new', close: { area: 'invoices' as const, view: r.view } });

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('invoices.keySelectTip')],
  [['Esc'], t('sales.keyClose'), t('sales.keyCloseTip')],
  [['D'], t('invoices.keyDownload'), t('invoices.keyDownloadTip')],
  [['V'], t('invoices.keyPreview'), t('invoices.keyPreviewTip')],
  [['/'], t('keys.search'), t('invoices.searchLabel')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const invoices: Area<RouteOf<'invoices'>> = {
  id: 'invoices',
  label: () => t('area.invoices'),
  dock: { key: 'i', icon: ICONS.invoices, tip: () => t('area.invoices.tip') },
  newest: newestIssued,
  List: (props) => <><List {...props} /><Dialogs {...props} /></>,
  Detail,
  add: {
    label: (r) => t(r.view === 'customers' ? 'invoices.sec.customer' : 'invoices.docKind.invoice'),
    title: (r) => t(r.view === 'customers' ? 'invoices.newCustomer' : 'invoices.newTitle'),
    run: (p) => setUi({ dialog: p.route.area === 'invoices' && p.route.view === 'customers' ? { kind: 'customer' } : { kind: 'new' } }),
  },
  legend,
  table: tableOf,
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
    const table = tableOf(p.route);
    // A table moves through its rows while a document is open; closed, ↑ ↓ leave the page to scroll.
    const d = table && !table.open ? 0 : moveKey(e);
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
      // An open panel closes first (the shell does it), then the search clears.
      case 'Escape': if (table?.open || !p.query.q) return false; p.nav.setQuery({ q: undefined }); return true;
    }
    return false;
  },
};
