/**
 * «Verlauf» (#215): on a receipt's, a payment's and a journal entry's detail, folded, the runs that
 * worked on the object, newest first (src/workflows/history.ts, read from the run log): the
 * workflow, when, where it stands with its step and reason, and what it wrote, each a link. A run
 * opens its view in Automatisierung; one whose details the run store no longer holds says so.
 * A person's own edits are not in it: the books keep who changed an entry, not when (later).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { language, t } from '../i18n/index.js';
import { api, errorText, STATIC_EXPORT } from '../lib/api.js';
import { fmt, formatDate } from '../lib/utils.js';
import { useAutomation } from '../automation/store.js';
import { refusalText } from '../automation/refusal.js';
import { stepOf, textIn } from '../../workflows/model.js';
import type { HistoryObject, HistoryRun, ObjectHistory } from '../../workflows/history.js';
import type { RunLogLine } from '../../workflows/runlog.js';
import type { Period } from '../../accounting/periods.js';
import type { Index } from '../../types/index.js';
import type { Nav } from '../areas/index.js';
import { Go } from '../areas/vat/links.js';
import { amountOf, at, bankOf } from '../areas/receipts/view.js';
import { stored, store } from '../shell/storage.js';
import './history.css';

/** What a log line or a history row says about one run. */
export type RunEvent = Pick<HistoryRun, 'workflow' | 'event' | 'at' | 'step' | 'reason'> & { wrote?: Partial<HistoryRun['wrote']> };

const OPEN_KEY = 'history.open';

/** 15.10.2026 11:30 in the viewer's time zone (the log stores UTC). */
const when = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/** The run's workflow and step in the viewer's language, its id when the workflow is gone. */
function useWords() {
  const { view } = useAutomation();
  const wf = (id: string) => view?.workflows.find((w) => w.id === id);
  return {
    workflow: (id: string) => { const w = wf(id); return w ? textIn(w.label, language()) : id; },
    step: (workflow: string, id: string) => { const w = wf(workflow); const s = w && stepOf(w, id); return s ? textIn(s.label, language()) : id; },
    rev: view?.rev,
  };
}

/** Where the run stands, with its step and reason: «wartet bei «Prüfen»», «steckt bei «Buchen»: …». */
export function eventText(r: RunEvent, step: (workflow: string, id: string) => string): string {
  const s = r.step ? step(r.workflow, r.step) : '';
  const why = r.reason ? refusalText(r.reason) : '';
  if (r.event === 'waiting' && s) return t('history.waitsAt', { step: s });
  if (r.event === 'stuck') return s ? t('history.stuckAt', { step: s, reason: why }) : why;
  if (r.event === 'discarded' && why) return t('history.discardedWhy', { reason: why });
  return '';
}

/** What the run wrote, each record a link to its detail; `skip` is the object the list is on. */
export function Wrote({ wrote, books, nav, period, skip }: { wrote?: RunEvent['wrote']; books: Index; nav: Nav; period?: Period; skip?: HistoryObject }) {
  const entries = (wrote?.entries ?? []).filter((id) => !(skip?.kind === 'entry' && skip.id === id));
  const receipts = (wrote?.receipts ?? []).filter((id) => !(skip?.kind === 'receipt' && skip.id === id));
  const links = wrote?.mappings ?? [];
  if (!entries.length && !receipts.length && !links.length) return null;
  const gone = (id: string) => <span key={id} className="mono m" data-tip={t('history.gone')}>{id}</span>;
  const entry = (id: string) => {
    const e = books.journalEntries.find((x) => x.id === id);
    return e ? <Go key={id} to={at({ area: 'journal', id }, e.date, period)} nav={nav}>{formatDate(e.date)} {e.accountDebit || '–'}/{e.accountCredit || '–'} <span className="mono">{fmt(e.amount)}</span></Go> : gone(id);
  };
  const receipt = (id: string) => {
    const r = books.receipts.find((x) => x.id === id);
    return r ? <Go key={id} to={at({ area: 'receipts', id }, r.date, period)} nav={nav}>{r.description?.split(/[,(]/)[0].trim() || r.filename}</Go> : gone(id);
  };
  const payment = (ref: string) => {
    const tx = books.transactions.find((x) => x.ref === ref);
    return tx ? <Go key={ref} to={at({ area: 'bank', payment: ref }, tx.date, period)} nav={nav}>{formatDate(tx.date)} {bankOf(tx)} <span className="mono">{amountOf(tx)}</span></Go> : gone(ref);
  };
  /** A link names the other side: on a receipt its payment, elsewhere its receipt. */
  const link = (key: string) => {
    const i = key.lastIndexOf(':');
    return skip?.kind === 'receipt' ? payment(key.slice(0, i)) : receipt(key.slice(i + 1));
  };
  const part = (label: string, items: ReactNode[]) => (items.length ? <span className="hpart"><span className="m">{label}</span> {items.map((x, i) => <span key={i}>{i > 0 ? ', ' : ''}{x}</span>)}</span> : null);
  return (
    <span className="hwrote">
      {part(t('history.wroteEntries'), entries.map(entry))}
      {part(t('history.wroteLinks'), links.map(link))}
      {part(t('history.wroteReceipts'), receipts.map(receipt))}
    </span>
  );
}

function Row({ r, books, nav, period, on }: { r: HistoryRun; books: Index; nav: Nav; period?: Period; on: HistoryObject }) {
  const words = useWords();
  const how = eventText(r, words.step);
  return (
    <li className="hrun" data-run={r.run}>
      <span className="hhead">
        <Go to={{ route: { area: 'automation', view: 'run', run: r.run }, query: {} }} nav={nav} className="hwf">{words.workflow(r.workflow)}</Go>
        <span className={`wfpill st-${r.event}`}>{t(`automation.status.${r.event}` as 'automation.status.done')}</span>
        <span className="m mono hwhen">{when(r.at)}</span>
      </span>
      {how ? <span className={r.event === 'stuck' ? 'hhow hwarn' : 'hhow m'}>{how}</span> : null}
      <Wrote wrote={r.wrote} books={books} nav={nav} period={period} skip={on} />
      {r.stored ? null : <span className="hgone m" data-testid="history-no-details" data-tip={t('history.noDetailsTip')}>{t('history.noDetails')}</span>}
    </li>
  );
}

/**
 * A run's view when the run store no longer holds it (another computer ran it, or its file is
 * gone): what the run log kept, line by line, and that the details are not stored. Without a log
 * line either, the refusal the run view got.
 */
export function RunFromLog({ id, error, books, nav }: { id: string; error: string; books: Index; nav: Nav }) {
  const [got, setGot] = useState<{ id: string; lines: RunLogLine[] }>();
  const words = useWords();
  useEffect(() => {
    let live = true;
    api.runLog(id).then((r) => { if (live) setGot({ id, lines: r.lines }); }, () => { if (live) setGot({ id, lines: [] }); });
    return () => { live = false; };
  }, [id]);
  if (got?.id !== id) return null;
  if (!got.lines.length) return <div className="detail-empty"><div>{error}</div></div>;
  const first = got.lines[0];
  return (
    <div className="detail-in wfpage runhist" key={id} data-testid="run-from-log">
      <div className="head"><h2 className="who">{t('history.logOnlyTitle', { workflow: words.workflow(first.workflow) })}<small className="mono">{id}</small></h2></div>
      <p className="notice" data-testid="history-no-details">{t('history.logOnly')}</p>
      <ol className="hruns runlog-lines">
        {got.lines.map((l, i) => {
          const how = eventText(l, words.step);
          return (
            <li key={i} className="hrun">
              <span className="hhead">
                <span className={`wfpill st-${l.event}`}>{t(`automation.status.${l.event}` as 'automation.status.done')}</span>
                <span className="m mono hwhen">{when(l.at)}</span>
              </span>
              {how ? <span className={l.event === 'stuck' ? 'hhow hwarn' : 'hhow m'}>{how}</span> : null}
              <Wrote wrote={l.wrote} books={books} nav={nav} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The folded section; `on` is the object, `period` the page's (links land in a period that holds the record's date). */
export function RunHistory({ on, books, nav, period }: { on: HistoryObject; books: Index; nav: Nav; period?: Period }) {
  const [open, setOpen] = useState(() => stored(OPEN_KEY) === '1');
  const [all, setAll] = useState(false);
  const [got, setGot] = useState<{ key: string; h?: ObjectHistory; error?: string }>();
  const { rev } = useWords();
  const key = `${on.kind}:${on.id}:${all}`;
  useEffect(() => setAll(false), [on.kind, on.id]);
  useEffect(() => {
    if (STATIC_EXPORT) return;
    let live = true;
    api.history(on.kind, on.id, all).then((h) => { if (live) setGot({ key, h }); }, (e) => { if (live) setGot({ key, error: errorText(e) }); });
    return () => { live = false; };
  }, [key, rev]);
  if (STATIC_EXPORT) return null;
  const h = got?.key === key ? got.h : undefined;
  const toggle = () => { setOpen(!open); store(OPEN_KEY, open ? null : '1'); };
  return (
    <div className={`sec runhist${open ? ' open' : ''}`} data-sec="verlauf" data-testid="run-history">
      <button type="button" className="sum" aria-expanded={open} onClick={toggle}>
        <svg className="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <span className="lbl">{t('history.title')}</span>
        <span className="val">{h ? (h.total ? String(h.total) : '—') : ''}</span>
      </button>
      <div className="in"><div><div className="pad">
        {got?.key === key && got.error ? <p className="hwarn">{t('history.failed', { error: got.error })}</p>
          : !h ? null
          : !h.total ? <p className="m hempty">{t('history.empty')}</p>
          : (
            <>
              <ol className="hruns">{h.runs.map((r) => <Row key={r.run} r={r} books={books} nav={nav} period={period} on={on} />)}</ol>
              {h.total > h.runs.length ? (
                <p className="m hmore" data-testid="history-more">
                  {t('history.shown', { shown: h.runs.length, total: h.total })}{' '}
                  <button type="button" className="linkbtn" onClick={() => setAll(true)}>{t('history.showAll')}</button>
                </p>
              ) : null}
            </>
          )}
      </div></div></div>
    </div>
  );
}
