/** Verkauf's views as tabs (docs/specs/invoicing.md 4.8; phases 1 and 2: Angebote · Aufträge · Lieferscheine · Rechnungen · Gutschriften · Offene Posten · Kontakte · Artikel · Versendet) and its search. */
import type { InvoiceView, RouteOf } from '../../shell/route.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { AreaProps } from '../index.js';

type Props = AreaProps<RouteOf<'invoices'>>;

/** The order of the chain (spec 4.8): Angebote · Aufträge · Lieferscheine · Rechnungen · Gutschriften, then the rest. */
export const VIEWS: readonly InvoiceView[] = ['quotes', 'orders', 'deliveries', 'list', 'credit-notes', 'open-items', 'contacts', 'articles', 'sent'];

/** The period stays when the view has periods (the document tables); the others start without filters. */
const PERIOD_VIEWS: readonly InvoiceView[] = ['quotes', 'orders', 'deliveries', 'list', 'credit-notes'];

export function Views({ on, props }: { on: InvoiceView; props: Props }) {
  return (
    <span className="seg gb ivviews" role="tablist" aria-label={t('invoices.views')}>
      {VIEWS.map((v) => (
        <button key={v} type="button" role="tab" aria-selected={on === v} className={on === v ? 'on' : ''} data-view={v}
          onClick={() => props.nav.go({ route: { area: 'invoices', view: v }, query: PERIOD_VIEWS.includes(v) && props.query.period ? { period: props.query.period } : {} })}>
          {t(`invoices.view.${v}`)}
        </button>
      ))}
    </span>
  );
}

export function Search({ props }: { props: Props }) {
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
