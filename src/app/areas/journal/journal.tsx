/**
 * Buchungen: the period's journal entries month by month, newest first, as one grid of Datum,
 * Text, Soll, Haben, MWST and amount; the entries of one payment joined in the date gutter. The
 * entry with its Buchungssatz, payment, receipt and form on the right (the mockup's Buchungen).
 */
import { Fragment, useEffect, useMemo, useRef } from 'react';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { moveKey } from '../../shell/keyboard.js';
import { getAccountMap } from '../../lib/accounts.js';
import { monthName, periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { I } from '../receipts/icons.js';
import { at } from '../receipts/view.js';
import { Kbd } from '../receipts/commands.js';
import { NO_VAT } from '../codes/model.js';
import { codeText, VatCards } from '../codes/vat-card.js';
import { codesUi, setCodesUi } from '../codes/state.js';
import { byMonth, firstRowTakesOver, rowsOf, JOURNAL_FILTERS, JOURNAL_ORIGINS, type EntryView, type JournalFilter } from './model.js';
import { listed, setUi, toggleMonth, ui, useUi } from './state.js';
import { journalFor, newEntryDate, runAct } from './commands.js';
import { Detail, evidenceText } from './Detail.js';
import { NewEntry } from './NewEntry.js';
import { useSelectionFollowsRows } from '../../hooks/use-selection-follows-rows.js';
import './journal.css';
import { baseCurrency } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'journal'>>;

const FILTER_LABEL = { ohneBeleg: 'journal.filterNoReceipt', korrekturen: 'journal.filterCorrections' } as const;

function List(props: Props) {
  const { route, query, period, books, nav, canEdit } = props;
  const s = useUi();
  const j = journalFor(books);
  const acName = getAccountMap();
  const { rows, counts, origins } = useMemo(() => rowsOf(j, period, s.filter, query.vat, query.q, (n) => acName[n] ?? '', s.origin), [j, period, s.filter, query.vat, query.q, acName, s.origin]);
  const months = byMonth(rows);
  const ids = months.filter(([m]) => !s.collapsed.has(m)).flatMap(([, xs]) => xs.map((v) => v.e.id));
  listed.ids = ids;

  // Nothing selected: the first row. A link to an entry elsewhere opens its period, month and filter (urls.md rule 1).
  const seen = useRef<string>();
  const held = [listed.pending, ui().deleted?.id];
  useEffect(() => {
    const v = route.id ? j.byId.get(route.id) : undefined;
    if (!v) { if (ids[0] && firstRowTakesOver(route.id, held, seen.current)) nav.select({ area: 'journal', id: ids[0] }); return; }
    if (route.id === listed.pending) listed.pending = undefined;
    if (seen.current === route.id) return;
    seen.current = route.id;
    if (ids.includes(v.e.id)) return;
    if (v.e.date < period.from || v.e.date > period.to) { if (!query.period) nav.go(at(route, v.e.date)); return; }
    toggleMonth(v.e.date.slice(0, 7), true);
    if ((s.filter || s.origin) && !rows.includes(v)) setUi({ filter: undefined, origin: undefined });
  }, [route.id, ids[0], j]);

  const select = (id: string) => nav.select({ area: 'journal', id });
  // A pending entry (just booked) and a deleted one (its place kept with «Rückgängig», r6h-28) hold the selection.
  useSelectionFollowsRows(route.id, ids, select, !!route.id && held.includes(route.id));
  const setFilter = (filter?: JournalFilter) => setUi({ filter });

  return (
    <div className="page">
      <ListHead period={period} books={books} canEdit={canEdit}>
        <div className="counts" role="tablist" aria-label={t('journal.filters')}>
          <button type="button" role="tab" aria-selected={!s.filter} className={s.filter ? '' : 'on'} onClick={() => setFilter()}><span className="n">{counts.alle}</span>{t('journal.all')}</button>
          {JOURNAL_FILTERS.filter((f) => counts[f] > 0 || s.filter === f).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={s.filter === f} className={s.filter === f ? 'on' : ''} onClick={() => setFilter(f)}><span className="n">{counts[f]}</span>{t(FILTER_LABEL[f])}</button>
          ))}
          {JOURNAL_ORIGINS.some((o) => origins[o] > 0) && (
            <span className="origins" role="group" aria-label={t('journal.originFilter')}>
              {JOURNAL_ORIGINS.filter((o) => origins[o] > 0 || s.origin === o).map((o) => (
                <button key={o} type="button" aria-pressed={s.origin === o} className={s.origin === o ? 'on' : ''} data-origin={o} data-tip={t('journal.originFilterTip', { who: t(`journal.origin.${o}`) })}
                  onClick={() => setUi({ origin: s.origin === o ? undefined : o })}><span className="n">{origins[o]}</span>{t(`journal.origin.${o}`)}</button>
              ))}
            </span>
          )}
          {query.vat && (
            <button type="button" className="vchip" data-testid="vat-filter" data-tip={t('journal.vatFilterOff')} onClick={() => nav.setQuery({ vat: undefined })}>
              {t('journal.field.vatCode')} <b className="mono">{query.vat === NO_VAT ? t('journal.without') : query.vat}</b> ×
            </button>
          )}
          <button type="button" className="vhbtn" aria-label={t('codes.histogramTitle')} onClick={() => setCodesUi({ histogram: true })}>{BARS}</button>
          <label className="search">
            {ICONS.search}
            <span className="sr">{t('journal.searchLabel')}</span>
            <input
              type="search"
              placeholder={t('shell.search')}
              value={query.q ?? ''}
              className={query.q ? 'has' : ''}
              autoComplete="off"
              onChange={(e) => nav.setQuery({ q: e.target.value || undefined })}
              onKeyDown={(e) => { if (e.key === 'Escape') nav.setQuery({ q: undefined }); }}
            />
            <Kbd keys={['/']} tip={t('journal.searchTip')} />
          </label>
        </div>
      </ListHead>

      {rows.length === 0 ? (
        <div className="empty">
          <h2>{query.q || query.vat || s.filter || s.origin ? t('journal.nothingFound') : t('journal.emptyTitle', { period: periodName(period) })}</h2>
          {!query.q && !query.vat && !s.filter && !s.origin && canEdit && <p>{t('journal.emptyText')}</p>}
        </div>
      ) : (
        <div className="rows je" role="listbox" aria-label={t('area.journal')}>
          {months.map(([m, xs]) => {
            const shut = s.collapsed.has(m);
            let prev: EntryView | undefined;
            return (
              <Fragment key={m}>
                <button type="button" className={`group${shut ? ' shut' : ''}`} aria-expanded={!shut} data-tip={shut ? t('receipts.expand') : t('receipts.collapse')} onClick={() => toggleMonth(m)}>
                  <span className="gl">{I.gch}{monthName(`${m}-01`)}</span>
                  <span className="cap" aria-hidden="true">{shut ? '' : t('journal.field.accountDebit')}</span>
                  <span className="cap" aria-hidden="true">{shut ? '' : t('journal.field.accountCredit')}</span>
                  <span className="cap vh" aria-hidden="true">{shut ? '' : t('journal.field.vatCode')}</span>
                  <span className="mono n">{xs.length}</span>
                </button>
                {!shut && xs.map((v) => { const row = <Row key={v.e.id} v={v} prev={prev} sel={v.e.id === route.id} acName={acName} onSelect={select} />; prev = v; return row; })}
              </Fragment>
            );
          })}
        </div>
      )}
      <VatCards {...(props as AreaProps)} />
      <NewEntry {...props} />
    </div>
  );
}

const BARS = <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h6" /></svg>;

function Row({ v, prev, sel, acName, onSelect }: { v: EntryView; prev?: EntryView; sel: boolean; acName: Record<string, string>; onSelect(id: string): void }) {
  const { e } = v;
  const same = prev?.e.date === e.date;
  const cont = prev?.e.transactionRef === e.transactionRef;
  const side = (n: string, which: 'dr' | 'cr') => {
    const label = which === 'dr' ? t('journal.field.accountDebit') : t('journal.field.accountCredit');
    return n
      ? <span className={`mono ${which}`} data-tip={`${label} ${n} ${acName[n] ?? ''}`}>{n}</span>
      : <span className={`mono ${which} none`} data-tip={t('journal.noCounterSide', { side: label })}>·</span>;
  };
  return (
    <div className={`row${sel ? ' sel' : ''}${cont ? ' cont' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={e.id} onClick={() => onSelect(e.id)}>
      <span className="d mono">{same ? <span className="sr">{formatDate(e.date)}</span> : formatDate(e.date)}</span>
      <span className="t">{v.missing && I.dot}{v.title}{v.sub && <small> {v.sub}</small>}</span>
      {side(e.accountDebit, 'dr')}
      {side(e.accountCredit, 'cr')}
      {e.vatCode
        ? <span className={`mono vc${e.vatCode.startsWith('-') ? ' rev' : ''}`} data-vat={e.vatCode} aria-label={t('journal.vatLabel', { code: e.vatCode, text: codeText(e.vatCode) })} data-tip={v.evidence && evidenceText(e, v.evidence)}>{v.evidence && I.dot}{e.vatCode}</span>
        : <span className="mono vc none" data-tip={t('journal.noVat')}>·</span>}
      <span className="mono cu">{e.exchangeCurrency && e.exchangeCurrency !== baseCurrency() ? e.exchangeCurrency : ''}</span>
      <span className="a mono">{fmt(e.amount)}</span>
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('journal.keySelectTip')],
  [['↵'], t('journal.keyReceipt'), t('journal.keyReceiptTip')],
  [['⇧', '↵'], t('journal.keyPayment'), t('journal.keyPaymentTip')],
  [['E'], t('journal.keyEdit'), t('journal.keyEditTip')],
  [['D'], t('journal.keyDownload'), t('journal.keyDownloadTip')],
  [['/'], t('keys.search'), t('journal.searchTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const journal: Area<RouteOf<'journal'>> = {
  id: 'journal',
  periodRows: true,
  label: () => t('area.journal'),
  dock: { key: 'u', icon: ICONS.journal, tip: () => t('area.journal.tip') },
  List,
  Detail,
  add: {
    label: () => t('journal.add'),
    title: () => t('journal.addTitle'),
    run: (p) => setUi({ overlay: { kind: 'new', draft: { date: newEntryDate(p.books) } } }),
  },
  legend,
  wide: true,
  title: (r, books) => { const v = r.id ? journalFor(books).byId.get(r.id) : undefined; return v && v.title; },
  palette: ({ books, nav, period }) => [...journalFor(books).views].sort((a, b) => b.e.date.localeCompare(a.e.date)).map((v) => ({
    label: v.sub ? `${v.title} · ${v.sub}` : v.title,
    side: `${formatDate(v.e.date)}  ${v.e.exchangeCurrency && v.e.exchangeCurrency !== baseCurrency() ? `${v.e.exchangeCurrency} ` : ''}${fmt(v.e.amount)}`,
    run: () => nav.go(at({ area: 'journal', id: v.e.id }, v.e.date, period)),
  })),
  keys(e, p) {
    if (ui().overlay || codesUi().histogram) {
      if (e.key !== 'Escape') return false;
      setUi({ overlay: null });
      setCodesUi({ histogram: false });
      return true;
    }
    const d = moveKey(e);
    if (d) {
      const i = p.route.id ? listed.ids.indexOf(p.route.id) : -1;
      const next = listed.ids[Math.min(listed.ids.length - 1, Math.max(0, i + d))];
      if (next) p.nav.select({ area: 'journal', id: next });
      return true;
    }
    // Deleting takes ⌘⌫ or the Delete key: a bare Backspace meant for a field that lost focus must not delete the booking (r7f-31).
    if (e.key === 'Backspace') return e.metaKey && !e.ctrlKey && !e.altKey ? runAct(p, 'del') : false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case 'Enter': return runAct(p, e.shiftKey ? 'payment' : 'receipt');
      case 'e': case 'E': return runAct(p, 'edit');
      case 'd': case 'D': return runAct(p, 'download');
      case 'Delete': return runAct(p, 'del');
      case 'Escape':
        if (p.query.q) { p.nav.setQuery({ q: undefined }); return true; }
        if (p.query.vat) { p.nav.setQuery({ vat: undefined }); return true; }
        return false;
    }
    return false;
  },
};
