/**
 * Verkauf (docs/specs/invoicing.md 4.8): Rechnungen, Gutschriften, Offene Posten and Versendet, each a
 * table across the width with the document open as a panel over its right part (layout A); Kontakte
 * likewise, a contact opened as the panel (contacts.tsx). The document is shown on its A4 sheet.
 */
import { useEffect, useRef } from 'react';
import './invoices.css';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { moveKey } from '../../shell/keyboard.js';
import { formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { followBooks, invoicesNow, newestIssued, reloadInvoices, useInvoices } from './data.js';
import { byRouteId, customerOf, townOf } from './model.js';
import { listed, setUi, ui } from './state.js';
import { invoiceAt, newDraftFor } from './actions.js';
import { Detail } from './Detail.js';
import { Dialogs } from './dialogs.js';
import { DocTable } from './DocTable.js';
import { DOC_VIEWS, kindOfView, type DocView } from './table.js';
import type { DocumentKind } from '../../../invoices/model.js';
import { OpenItems } from './OpenItems.js';
import { SentLog } from './SentLog.js';
import { ContactTable } from './contacts.js';
import { ArticleTable } from './articles.js';

type Props = AreaProps<RouteOf<'invoices'>>;

function List(props: Props) {
  const { route, nav } = props;
  const load = useInvoices();

  useEffect(() => followBooks(props.books), [props.books]);

  // /invoices/new?customer=<id>: a new draft for that contact, then its own link.
  const creating = useRef(false);
  useEffect(() => {
    if (route.view !== 'list' || route.id !== 'new' || load.state !== 'ready' || creating.current) return;
    const c = load.data.contacts.find((x) => x.id === props.query.customer);
    // Known read-only (the audit export), or an archived contact: no draft is made, the contact is shown instead. While the API's status is not yet
    // known canEdit is false too: the link waits for it, never sends a person away from a draft she may make.
    if (!c || props.readOnly || c.archived) { nav.go({ route: { area: 'invoices', view: 'contacts', ...(c ? { id: c.id } : {}) }, query: {} }); return; }
    if (!props.canEdit) return;
    creating.current = true;
    void newDraftFor(nav, c).finally(() => { creating.current = false; });
  }, [route.id, load.state, props.canEdit, props.readOnly]);

  if (load.state !== 'ready') {
    return (
      <div className="page">
        <ListHead {...props} noPeriod={!(DOC_VIEWS as readonly string[]).includes(route.view)} />
        <div className="empty"><p>{load.state === 'loading' ? t('app.loading') : t('invoices.unavailable')}</p></div>
      </div>
    );
  }
  switch (route.view) {
    case 'contacts': return <ContactTable {...props} d={load.data} />;
    case 'articles': return <ArticleTable {...props} d={load.data} />;
    case 'sent': return <SentLog {...props} d={load.data} />;
    case 'open-items': return <OpenItems {...props} d={load.data} />;
    default: return <DocTable {...props} d={load.data} view={route.view} />;
  }
}

/** The kind the «+» of a view makes: its own; a Gutschrift comes only from its Rechnung, so there a Rechnung. */
const newKind = (view: RouteOf<'invoices'>['view']): DocumentKind => {
  if (!(DOC_VIEWS as readonly string[]).includes(view)) return 'invoice';
  const k = kindOfView(view as DocView);
  return k === 'credit-note' ? 'invoice' : k;
};

/** Layout A: every view is a table; its document or contact opens as a panel while the route names one. */
const tableOf = (r: RouteOf<'invoices'>) => ({ open: !!r.id && r.id !== 'new', close: { area: 'invoices' as const, view: r.view } });

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
  // The «+» of each table makes a document of its kind (spec 4.8); elsewhere a Rechnung.
  add: {
    label: (r) => (r.view === 'contacts' ? t('contacts.one') : r.view === 'articles' ? t('articles.one') : t(`invoices.docKind.${newKind(r.view)}`)),
    title: (r) => (r.view === 'contacts' ? t('contacts.new') : r.view === 'articles' ? t('articles.new') : t(`sales.newTitle.${newKind(r.view)}` as 'sales.newTitle.invoice')),
    run: (p) => setUi({ dialog: p.route.area === 'invoices' && p.route.view === 'contacts' ? { kind: 'contact' } : p.route.area === 'invoices' && p.route.view === 'articles' ? { kind: 'article' } : { kind: 'new', doc: p.route.area === 'invoices' ? newKind(p.route.view) : 'invoice' } }),
  },
  legend,
  table: tableOf,
  title: (r) => {
    const d = invoicesNow();
    if (!r.id || !d) return r.id;
    if (r.view === 'contacts') return d.contacts.find((c) => c.id === r.id)?.name;
    if (r.view === 'articles') return d.articles.find((a) => a.id === r.id)?.name;
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
      ...d.contacts.map((c) => ({
        label: [c.number, c.name].filter(Boolean).join(' · '),
        side: townOf(c),
        run: () => nav.go({ route: { area: 'invoices', view: 'contacts', id: c.id }, query: {} }),
      })),
      ...d.articles.filter((a) => !a.archived).map((a) => ({
        label: [a.code, a.name].filter(Boolean).join(' · '),
        side: t('articles.one'),
        run: () => nav.go({ route: { area: 'invoices', view: 'articles', id: a.id }, query: {} }),
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
        const a = document.querySelector<HTMLElement>('.detail .ivacts .dl, .detail a.dl');
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
