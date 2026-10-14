/**
 * Belege: the receipts of a period, what needs you first, then month by month; the receipt with
 * its paper, its payment, its details and its file on the right (the mockup's Belege).
 */
import { Fragment, useEffect, useMemo, useRef } from 'react';
import type { InboxFile } from '../../../types/index.js';
import { RECEIPT_FILTERS, type ReceiptFilter, type RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { moveKey } from '../../shell/keyboard.js';
import { useFx } from '../../hooks/use-fx.js';
import { periodName, monthName } from '../../lib/period-label.js';
import { fmt, formatAmount, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { badgeCount, chfOf, groups, isOpen, suggestion, visible, type Candidate, type GroupKey, type ReceiptView } from './model.js';
import { pollInbox, setUi, toggleGroup, ui, useUi } from './state.js';
import { at, ledgerFor, listed } from './view.js';
import { Kbd, accept, runAct, type Act } from './commands.js';
import { intakeAdd } from './intake.js';
import { startIntake, useIntake } from '../../shell/Intake.js';
import { Detail } from './Detail.js';
import { I } from './icons.js';
import { useSelectionFollowsRows } from '../../hooks/use-selection-follows-rows.js';
import { baseCurrency } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'receipts'>>;

const FILTER_LABEL = { zugeordnet: 'receipts.filterLinked', offen: 'receipts.filterOpen', ohneDatum: 'receipts.filterNoDate' } as const;


const groupLabel = (key: GroupKey) =>
  key === 'need' ? t('receipts.groupNeed') : key === 'noDate' ? t('receipts.noDate') : monthName(`${key.slice(6)}-01`);

function List(props: Props) {
  const { route, query, period, books, nav, canEdit } = props;
  const s = useUi();
  const { rates } = useFx();
  const l = ledgerFor(books);
  const toChf = useMemo(() => chfOf(rates), [rates]);
  const { rows, counts, hidden } = useMemo(() => visible(l, period, query.filter, query.q), [l, period, query.filter, query.q]);
  const suggestions = useMemo(() => {
    const out = new Map<string, Candidate>();
    for (const v of rows) { const c = suggestion(v, l, toChf); if (c) out.set(v.r.id, c); }
    return out;
  }, [rows, l, toChf]);
  const { groups: gs, later } = groups(rows, l, query.filter, (v) => suggestions.has(v.r.id));
  const pending = period.to >= l.openFrom && !query.filter && !query.q ? s.inbox.filter((f) => !l.byId.has(f.id)) : [];
  const filed = !!l.closedThrough && period.kind !== 'all' && period.to <= l.closedThrough;

  const ids = [
    ...pending.map((f) => f.id),
    ...gs.filter((g) => !s.collapsed.has(g.key)).flatMap((g) => g.rows.map((v) => v.r.id)),
    ...(s.showLater ? later.map((v) => v.r.id) : []),
    ...(s.showHidden ? hidden.map((v) => v.r.id) : []),
  ];
  listed.ids = ids;
  listed.suggestions = suggestions;

  useEffect(() => { pollInbox(nav.refresh); }, [nav]);

  // A list with nothing selected selects its first row; a link to a receipt of another period opens that period (urls.md rule 1).
  const seen = useRef<string>();
  useEffect(() => {
    if (!route.id) { if (ids[0]) nav.select({ area: 'receipts', id: ids[0] }); return; }
    if (seen.current === route.id) return;
    seen.current = route.id;
    const v = l.byId.get(route.id);
    if (v && !ids.includes(route.id) && !query.period && v.day && (v.day < period.from || v.day > period.to)) nav.go(at(route, v.day));
  }, [route.id, ids[0], l]);

  const select = (id: string) => nav.select({ area: 'receipts', id });
  useSelectionFollowsRows(route.id, ids, select);
  const row = (v: ReceiptView, same: boolean) => (
    <Row key={v.r.id} v={v} sel={v.r.id === route.id} same={same} canEdit={canEdit} onSelect={select} onAct={(a) => runAct(props, a, v.r.id)} />
  );

  return (
    <div className="page">
      <ListHead period={period} books={books} canEdit={canEdit}>
        <div className="counts" role="tablist" aria-label={t('receipts.filters')}>
          {counts.alle > 0 ? (
            <>
              <button type="button" role="tab" aria-selected={!query.filter} className={query.filter ? '' : 'on'} onClick={() => nav.setQuery({ filter: undefined })}>
                <span className="n">{counts.alle}</span>{t('receipts.filterAll')}
              </button>
              {RECEIPT_FILTERS.filter((f) => counts[f] > 0 || query.filter === f).map((f: ReceiptFilter) => (
                <button key={f} type="button" role="tab" aria-selected={query.filter === f} className={query.filter === f ? 'on' : ''} data-filter={f} onClick={() => nav.setQuery({ filter: f })}>
                  <span className="n">{counts[f]}</span>{t(FILTER_LABEL[f])}
                </button>
              ))}
            </>
          ) : <span>{filed ? t('receipts.filedReadOnly') : t('receipts.stillEmpty')}</span>}
          {canEdit && <RunInbox />}
          <label className="search">
            {ICONS.search}
            <span className="sr">{t('receipts.searchLabel')}</span>
            <input
              type="search"
              placeholder={t('shell.search')}
              value={query.q ?? ''}
              className={query.q ? 'has' : ''}
              autoComplete="off"
              onChange={(e) => nav.setQuery({ q: e.target.value || undefined })}
              onKeyDown={(e) => { if (e.key === 'Escape') nav.setQuery({ q: undefined }); }}
            />
            <Kbd keys={['/']} tip={t('receipts.searchTip')} />
          </label>
        </div>
      </ListHead>

      {counts.alle === 0 && hidden.length === 0 && pending.length === 0 ? (
        <div className="empty">
          <h2>{t('receipts.emptyTitle', { period: periodName(period) })}</h2>
          <p>{t('receipts.emptyText')}</p>
          {canEdit && (
            <button type="button" className="well" style={{ width: '100%' }} onClick={() => intakeAdd.run(props as AreaProps)}>
              <span><b>{t('receipts.well')}</b>{t('receipts.wellHint')}</span>
            </button>
          )}
        </div>
      ) : rows.length === 0 && pending.length === 0 ? (
        query.q ? (
          <div className="empty"><h2>{t('receipts.nothingFound')}</h2><p>{t('receipts.nothingFoundText', { q: query.q })}</p></div>
        ) : (
          <div className="empty">
            <h2>{query.filter === 'offen' || query.filter === 'ohneDatum' ? t('receipts.allLinked') : t('receipts.none')}</h2>
            <p>{t('receipts.allLinkedText')}</p>
          </div>
        )
      ) : (
        <div className="rows" role="listbox" aria-label={t('area.receipts')}>
          {pending.length > 0 && (
            <>
              <div className="group"><span>{t('receipts.groupNeed')}</span><span className="mono">{pending.length}</span></div>
              {pending.map((f) => <PendingRow key={f.id} file={f} sel={f.id === route.id} onSelect={select} />)}
            </>
          )}
          {gs.map((g) => {
            const shut = s.collapsed.has(g.key);
            let prev: string | undefined;
            return (
              <Fragment key={g.key}>
                <button type="button" className={`group${shut ? ' shut' : ''}`} aria-expanded={!shut} title={shut ? t('receipts.expand') : t('receipts.collapse')} onClick={() => toggleGroup(g.key)}>
                  <span>{I.gch}{groupLabel(g.key)}</span><span className="mono">{g.rows.length}</span>
                </button>
                {!shut && g.rows.map((v) => { const same = !!v.date && v.date === prev; prev = v.date; return row(v, same); })}
              </Fragment>
            );
          })}
          {later.length > 0 && (
            <>
              <div className="hidden-note">
                {t('receipts.laterNote', { n: later.length })} · <button type="button" onClick={() => setUi({ showLater: !s.showLater })}>{s.showLater ? t('receipts.hide') : t('receipts.show')}</button>
              </div>
              {s.showLater && later.map((v) => row(v, false))}
            </>
          )}
        </div>
      )}
      {hidden.length > 0 && (
        <>
          <div className="hidden-note">
            {!s.showHidden && `${t('receipts.hiddenNote', { n: hidden.length })} · `}
            <button type="button" data-testid="toggle-hidden" onClick={() => setUi({ showHidden: !s.showHidden })}>{s.showHidden ? t('receipts.hideAgain') : t('receipts.show')}</button>
          </div>
          {s.showHidden && (
            <div className="rows" role="listbox" aria-label={t('receipts.notReceipts')} style={{ marginTop: 8 }}>
              {hidden.map((v) => row(v, false))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({ v, sel, same, canEdit, onSelect, onAct }: { v: ReceiptView; sel: boolean; same: boolean; canEdit: boolean; onSelect(id: string): void; onAct(a: Act): void }) {
  const { r } = v;
  const act = (run: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); onSelect(r.id); run(); };
  const edit = canEdit && !v.locked;
  return (
    <div
      className={`row${sel ? ' sel' : ''}${v.none ? ' nonreceipt' : ''}`}
      role="option"
      aria-selected={sel}
      tabIndex={sel ? 0 : -1}
      data-id={r.id}
      onClick={() => onSelect(r.id)}
    >
      <span className="d mono">{same ? <span className="sr">{formatDate(v.date)}</span> : v.date ? formatDate(v.date) : <span className="d none">{t('receipts.noDate')}</span>}</span>
      <span className="t">{isOpen(v) && !v.locked && !v.none && I.dot}{v.vendor}{v.desc && <small> {v.desc}</small>}</span>
      <span className="a mono">{r.amount != null && <>{(r.currency ?? baseCurrency()) !== baseCurrency() && <span className="c">{r.currency}</span>}{fmt(r.amount)}</>}</span>
      <span className="acts">
        {v.none ? (
          edit && <button type="button" title={t('receipts.isReceipt')} aria-label={t('receipts.isReceipt')} onClick={act(() => onAct('mark'))}>{I.check}</button>
        ) : (
          <>
            <button type="button" title={t('receipts.previewKey')} aria-label={t('receipts.preview')} onClick={act(() => setUi({ overlay: 'quick' }))}>{I.eye}</button>
            {edit && (
              <>
                <button type="button" title={t('receipts.linkKey')} aria-label={t('receipts.link')} onClick={act(() => onAct('link'))}>{I.link}</button>
                <button type="button" title={t('receipts.editKey')} aria-label={t('receipts.edit')} onClick={act(() => onAct('edit'))}>{I.edit}</button>
                <button type="button" className="del" title={t('receipts.deleteKey')} aria-label={t('receipts.delete')} onClick={act(() => onAct('del'))}>{I.trash}</button>
              </>
            )}
          </>
        )}
      </span>
    </div>
  );
}

/** "Eingang verarbeiten": reads the inbox and statements, the VAT facts, names, links and books (src/intake/). */
function RunInbox() {
  const { running } = useIntake();
  return (
    <button type="button" className="runinbox" data-testid="run-inbox" disabled={running} title={t('intake.runTip')} onClick={() => void startIntake()}>
      {I.spark}{running ? t('intake.running') : t('intake.run')}
    </button>
  );
}

function PendingRow({ file, sel, onSelect }: { file: InboxFile; sel: boolean; onSelect(id: string): void }) {
  return (
    <div className={`row reading${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={file.id} title={t('receipts.readingTip')} onClick={() => onSelect(file.id)}>
      <span className="d mono"><span className="shimmer" style={{ width: 70 }} /></span>
      <span className="t"><span className="shimmer" style={{ width: 150 }} /> <span style={{ fontSize: 12, marginLeft: 6 }}>{t('receipts.reading')}</span></span>
      <span className="a mono" />
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('receipts.keySelectTip')],
  [['↵'], t('receipts.keyAccept'), t('receipts.keyAcceptTip')],
  [['␣'], t('receipts.keyPreview'), t('receipts.keyPreviewTip')],
  [['D'], t('receipts.keyDownload'), t('receipts.keyDownloadTip')],
  [['E'], t('receipts.keyEdit'), t('receipts.keyEditTip')],
  [['L'], t('receipts.keyLink'), t('receipts.keyLinkTip')],
  [['/'], t('keys.search'), t('receipts.searchTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const receipts: Area<RouteOf<'receipts'>> = {
  id: 'receipts',
  periodRows: true,
  label: () => t('area.receipts'),
  dock: { key: 'b', icon: ICONS.receipts, tip: () => t('area.receipts.tip'), badge: (books) => badgeCount(ledgerFor(books)) },
  List,
  Detail,
  add: intakeAdd,
  legend,
  title: (r, books) => { const v = r.id ? ledgerFor(books).byId.get(r.id) : undefined; return v && (v.vendor || v.r.filename); },
  palette: ({ books, nav, period, canEdit }) => [
    ...(canEdit ? [{ label: t('intake.run'), side: t('area.receipts'), run: () => void startIntake() }] : []),
    ...[...ledgerFor(books).views].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).map((v) => ({
    label: v.desc ? `${v.vendor} · ${v.desc}` : v.vendor,
    side: [v.date && formatDate(v.date), v.r.amount != null && formatAmount(v.r.amount, v.r.currency)].filter(Boolean).join('  '),
    run: () => nav.go(at({ area: 'receipts', id: v.r.id }, v.day, period)),
  }))],
  keys(e, p) {
    const s = ui();
    if (s.overlay === 'quick') {
      if (e.key === ' ' || e.key === 'Escape') setUi({ overlay: null });
      return !e.metaKey && !e.ctrlKey;
    }
    if (s.overlay === 'delete') {
      if (e.key === 'Escape') setUi({ overlay: null });
      if (e.key === 'Enter') document.querySelector<HTMLButtonElement>('.confirm .danger')?.click();
      return true;
    }
    if (s.overlay) return false;
    const d = moveKey(e);
    if (d) {
      const i = p.route.id ? listed.ids.indexOf(p.route.id) : -1;
      const next = listed.ids[Math.min(listed.ids.length - 1, Math.max(0, i + d))];
      if (next) p.nav.select({ area: 'receipts', id: next });
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const v = p.route.id ? ledgerFor(p.books).byId.get(p.route.id) : undefined;
    switch (e.key) {
      case 'Enter': {
        const c = v && listed.suggestions.get(v.r.id);
        if (!v || !c || !p.canEdit) return false;
        accept(p, v, c);
        return true;
      }
      case ' ': if (!p.route.id) return false; setUi({ overlay: 'quick' }); return true;
      case 'd': case 'D': {
        const a = document.querySelector<HTMLAnchorElement>('.detail a.dl');
        a?.click();
        return !!a;
      }
      case 'e': case 'E': runAct(p, 'edit'); return true;
      case 'l': case 'L': runAct(p, 'link'); return true;
      case 'Backspace': case 'Delete': runAct(p, 'del'); return true;
      case 'Escape': if (!p.query.q) return false; p.nav.setQuery({ q: undefined }); return true;
    }
    return false;
  },
};
