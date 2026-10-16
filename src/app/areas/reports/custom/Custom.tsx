/**
 * Bilanz & ER › Eigene Berichte: the reports the owner saved (knowledge/reports/, src/reports/
 * saved.ts), from the sidebar's card or the form. The list beside the run of the selected one,
 * which runs for its own period or, with one click, for the page's; «PDF», «CSV», «Bearbeiten»,
 * «Löschen» with «Rückgängig». Every figure is the server's run of the spec on the books.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { localToday, parsePeriod } from '../../../../accounting/periods.js';
import type { RouteOf } from '../../../shell/route.js';
import { ListHead } from '../../../shell/ListHead.js';
import { moveKey } from '../../../shell/keyboard.js';
import { periodName } from '../../../lib/period-label.js';
import { api, errorText } from '../../../lib/api.js';
import { language, t } from '../../../i18n/index.js';
import type { AreaProps } from '../../index.js';
import { Tabs } from '../Tabs.js';
import { postDownload } from '../../export/state.js';
import { specData } from '../../../../reports/spec.js';
import type { ReportResult } from '../../../../reports/run.js';
import type { SavedReport, SavedWrite } from '../../../../reports/saved.js';
import { filtersInWords, refusalText } from '../../../../reports/words.js';
import { ReportView, uiWords } from './ReportView.js';
import { editing, useEditing } from './editing.js';

type Props = AreaProps<Extract<RouteOf<'reports'>, { report: 'custom' }>>;

/** The saved reports, loaded once and again after every write of this page or the sidebar's card. */
const store: { list: SavedReport[] | undefined; error: string; subs: Set<() => void> } = { list: undefined, error: '', subs: new Set() };
const notify = () => { for (const f of store.subs) f(); };
export async function reloadSaved(): Promise<void> {
  try { store.list = await api.savedReports(); store.error = ''; } catch (e) { store.error = errorText(e); store.list = store.list ?? []; }
  notify();
}
let version = 0;
function useSaved(): { list: SavedReport[] | undefined; error: string } {
  useSyncExternalStore((f) => { const g = () => { version++; f(); }; store.subs.add(g); return () => store.subs.delete(g); }, () => version);
  useEffect(() => { if (store.list === undefined) void reloadSaved(); }, []);
  return { list: store.list, error: store.error };
}

/** A save made somewhere, with its «Rückgängig»: the file as it was. */
export async function undoWrite(w: SavedWrite): Promise<void> {
  await api.restoreReport(w);
  await reloadSaved();
}

const listed: { slugs: string[] } = { slugs: [] };

export function CustomList(props: Props) {
  const { route, period, books, nav, canEdit } = props;
  const { list, error } = useSaved();
  const edit = useEditing();
  listed.slugs = (list ?? []).map((r) => r.slug);
  useEffect(() => {
    if (!edit && list?.length && !list.some((r) => r.slug === route.saved)) nav.select({ area: 'reports', report: 'custom', saved: list[0].slug });
  }, [list, route.saved, edit]);
  return (
    <div className="page">
      <ListHead period={period} books={books} canEdit={canEdit} />
      <Tabs route={route} nav={nav}>
      </Tabs>
      {error ? <p className="warnline">{error}</p> : null}
      {list && !list.length && !edit ? <div className="empty"><p className="m">{t('custom.empty')}</p></div> : null}
      <div className="rows" role="listbox" aria-label={t('custom.tab')}>
        {(list ?? []).map((r) => {
          const sel = !edit && r.slug === route.saved;
          return (
            <div key={r.slug} className={`row crep${sel ? ' sel' : ''}`} role="option" aria-selected={sel} data-slug={r.slug} tabIndex={sel ? 0 : -1} onClick={() => { editing.set(null); nav.select({ area: 'reports', report: 'custom', saved: r.slug }); }}>
              <span className="t">
                <b>{'spec' in r ? r.spec.title : r.slug}</b>
                <small className="m">{'spec' in r ? r.spec.sections.map((s) => filtersInWords(s, uiWords)).join(' | ') : t('custom.unreadable', { why: refusalText(r.refusal, uiWords.t) })}</small>
              </span>
              <span className="a mono">{'spec' in r ? periodName(parsePeriod(r.spec.period, localToday()) ?? period) : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One saved report run, its period switched with one click, its files, its edit and delete. */
export function CustomDetail(props: Props) {
  const { route, query, period, nav, canEdit } = props;
  const { list } = useSaved();
  const edit = useEditing();
  const saved = list?.find((r) => r.slug === route.saved);
  const spec = saved && 'spec' in saved ? saved.spec : undefined;
  const own = spec ? parsePeriod(spec.period, localToday()) : null;
  const [onPage, setOnPage] = useState(false);
  useEffect(() => { setOnPage(!!query.period); }, [route.saved, query.period?.token]);
  const token = onPage || !own ? period.token : own.token;
  const [result, setResult] = useState<ReportResult>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!spec) return;
    let live = true;
    setResult(undefined); setError('');
    api.runReport(specData(spec), token).then((r) => { if (live) setResult(r); }, (e: unknown) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [spec, token]);

  if (edit) return null;
  if (!saved) return <div className="detail-empty"><div>{t('custom.select')}</div></div>;
  if (!spec) return <div className="detail-empty"><div>{t('custom.unreadable', { why: 'refusal' in saved ? refusalText(saved.refusal, uiWords.t) : '' })}</div></div>;

  const file = (format: 'pdf' | 'csv') => {
    postDownload('/api/reports/file', { spec: specData(spec), period: token, format, language: language() }, `report.${format}`)
      .catch((e: unknown) => nav.toast(t('assistant.report.fileFailed', { why: errorText(e) })));
  };
  const remove = async () => {
    try {
      const w = await api.deleteReport(saved.slug);
      await reloadSaved();
      nav.toast(t('custom.deleted', { title: spec.title }), () => { void undoWrite(w).then(() => nav.select({ area: 'reports', report: 'custom', saved: w.slug })); });
    } catch (e) { nav.toast(errorText(e)); }
  };
  return (
    <div className="detail-in" key={saved.slug} data-testid="custom-detail">
      <div className="head">
        <h2 className="who">{spec.title}<small>{t('custom.sections', { n: spec.sections.length })}</small></h2>
      </div>
      <div className="counts cper" role="group" aria-label={t('custom.periodLabel')}>
        {own ? <button type="button" className={!onPage ? 'on' : ''} aria-pressed={!onPage} data-testid="own-period" onClick={() => setOnPage(false)}>{t('custom.ownPeriod', { period: periodName(own) })}</button> : null}
        <button type="button" className={onPage || !own ? 'on' : ''} aria-pressed={onPage || !own} data-testid="page-period" onClick={() => setOnPage(true)}>{t('custom.pagePeriod', { period: periodName(period) })}</button>
      </div>
      <div className="ruleacts cacts">
        <button type="button" className="btn ghost" onClick={() => file('pdf')}>{t('assistant.report.pdf')}</button>
        <button type="button" className="btn ghost" onClick={() => file('csv')}>{t('assistant.report.csv')}</button>
        {canEdit ? <button type="button" className="btn ghost" data-testid="report-delete" onClick={() => void remove()}>{t('custom.delete')}</button> : null}
      </div>
      {error ? <p className="warnline">{error}</p> : null}
      {!result && !error ? <p className="m">{t('custom.running')}</p> : null}
      {result ? <ReportView result={result} go={nav.go} /> : null}
    </div>
  );
}

export function customKeys(e: KeyboardEvent, p: Props): boolean {
  const d = moveKey(e);
  if (!d || editing.get()) return false;
  const i = listed.slugs.indexOf(p.route.saved ?? '');
  const next = listed.slugs[Math.min(listed.slugs.length - 1, Math.max(0, i + d))];
  if (next) p.nav.select({ area: 'reports', report: 'custom', saved: next });
  return true;
}

