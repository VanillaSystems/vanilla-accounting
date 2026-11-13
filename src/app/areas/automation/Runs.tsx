/**
 * The area's home (docs/company mockup «Letzte Läufe»): the latest runs, newest first, each with
 * what came in and what came of it, so checking the automation is the first thing a person does.
 * A run opens into one line per file that came in: a statement by its bank, account and days with
 * the payments it added and its balance against the books, a receipt with whether it was read,
 * linked and booked, a refused file with the reason. «Geprüft» marks a run as checked.
 */
import { Fragment, useState } from 'react';
import { language, t } from '../../i18n/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { automationCommand } from '../../automation/store.js';
import { openCount, textIn, type Arrival, type AutomationView, type RunSummary } from '../../../workflows/model.js';
import { linesOf, standOf, type Line, type Stand } from './runs-model.js';
import { commandRefusalText, refusalText } from '../../automation/refusal.js';
import type { Index } from '../../../types/index.js';
import { waitsForReading } from '../../../parsers/receipt-text.js';
import type { Nav } from '../index.js';
import type { Route } from '../../shell/route.js';
import { takeOpening } from '../bank/actions.js';
import { fileKey } from '../bank/model.js';
import { useWorkspace } from '../../hooks/use-workspace.js';

type Filter = 'all' | 'unreviewed' | 'check' | 'you' | 'error';
const FILTERS: Filter[] = ['all', 'unreviewed', 'check', 'you', 'error'];
const inFilter = (f: Filter, s: Stand) => f === 'all' || (f === 'unreviewed' ? s === 'ok' || s === 'check' : f === s);

const tx = (v: Parameters<typeof textIn>[0]) => textIn(v, language());
const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const swiss = (iso: string) => formatDate(iso);

/** «Juli 2026» for a whole month, else «08.07.–30.09.2026». */
function daysText(from: string | undefined, to: string): string {
  const end = new Date(`${to}T00:00:00`);
  const lastOfMonth = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate() === end.getDate();
  if (from && from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && lastOfMonth) {
    return new Intl.DateTimeFormat(language(), { month: 'long', year: 'numeric' }).format(end);
  }
  return from && from !== to ? `${swiss(from).slice(0, 6)}–${swiss(to)}` : swiss(to);
}

const statementTitle = (a: Extract<Arrival, { kind: 'statement' }>) => `${a.bank} ${a.currency} · ${daysText(a.from, a.to)}`;
const fileOf = (path: string) => path.split('/').pop() ?? path;

function byText(r: RunSummary, view: AutomationView): string {
  const by = r.startedBy;
  if (by.kind === 'outside') return r.arrived?.length ? t('runs.by.drop') : t('runs.by.inbox');
  if (by.kind === 'schedule') return t('automation.by.schedule');
  if (by.kind === 'event') {
    const from = view.runs.find((x) => x.id === by.run);
    const w = from && view.workflows.find((x) => x.id === from.workflow);
    return t('runs.by.after', { what: w ? tx(w.label) : by.name });
  }
  if (by.kind === 'manual') return t('automation.by.manual');
  return by.kind;
}

/** WAS HEREINKAM, in one line and a smaller one. */
function inText(r: RunSummary, lines: Line[], view: AutomationView, books: Index): [string, string] {
  const st = lines.filter((l): l is Extract<Line, { kind: 'statement' }> => l.kind === 'statement');
  const rc = lines.filter((l): l is Extract<Line, { kind: 'receipt' }> => l.kind === 'receipt');
  const rf = lines.filter((l) => l.kind === 'refused');
  if (r.arrived?.length) {
    const head = [st.length && t('runs.in.statements', { n: st.length }), rc.length && t('runs.in.receipts', { n: rc.length }), rf.length && t('runs.in.refused', { n: rf.length })].filter(Boolean).join(', ');
    const banks = [...new Set(st.map((l) => `${l.a.bank} ${l.a.currency}`))];
    const names = rc.map((l) => l.receipt?.description?.split(/[,(]/)[0].trim() || l.a.file);
    const small = [banks.join(', '), names.slice(0, 3).join(', ') + (names.length > 3 ? ` ${t('runs.in.more', { n: names.length - 3 })}` : '')].filter(Boolean).join(' · ');
    return [head, small];
  }
  const w = view.workflows.find((x) => x.id === r.workflow);
  if (r.digest.files.length) return [t('runs.in.files', { n: r.digest.files.length }), r.digest.files.slice(0, 3).join(', ')];
  if (r.item.kind === 'transaction') {
    const p = books.transactions.find((x) => x.ref === r.item.id);
    return [w ? tx(w.label) : r.workflow, p ? `${p.description} · ${p.currency} ${fmt(p.direction === 'DBIT' ? -p.amount : p.amount)}` : r.item.id];
  }
  return [w ? tx(w.label) : r.workflow, ''];
}

/** WAS DARAUS WURDE, in one line and a smaller one. */
function outText(r: RunSummary, lines: Line[]): [string, string] {
  if (r.status === 'stuck' || r.status === 'discarded') return [refusalText(r.error, r.why), ''];
  const st = lines.filter((l): l is Extract<Line, { kind: 'statement' }> => l.kind === 'statement');
  const added = st.reduce((n, l) => n + l.a.added, 0);
  const d = r.digest;
  const head = [
    st.length ? t('runs.out.added', { n: added }) : '',
    d.receipts ? t('runs.out.read', { n: d.receipts }) : '',
    d.links ? t('runs.out.linked', { n: d.links }) : '',
    d.entries ? t('runs.out.booked', { n: d.entries }) : '',
  ].filter(Boolean).join(', ');
  const ok = st.filter((l) => l.balance.kind === 'matches').length;
  const off = st.filter((l) => l.balance.kind === 'differs').length;
  const poor = r.digest.poorScans?.length ?? 0;
  const copies = r.digest.copies?.length ?? 0;
  const noOpening = st.some((l) => l.opening);
  const noVat = st.reduce((n, l) => n + l.withoutVat.length, 0);
  const small = [ok ? t('runs.out.balOk', { n: ok }) : '', off ? t('runs.out.balOff', { n: off }) : '', noOpening ? t('runs.out.noOpening') : '', noVat ? t('runs.out.noVat', { n: noVat }) : '', poor ? t('runs.out.poorScan', { n: poor }) : '', copies ? t('runs.out.copies', { n: copies }) : ''].filter(Boolean).join(', ');
  return [head || t('runs.out.nothing'), small];
}

function LineRow({ l, go, nav }: { l: Line; go(route: Route): void; nav: Nav }) {
  if (l.kind === 'poorScan') {
    return (
      <tr className="rline"><td /><td />
        <td className="what"><span className="rk">{t('runs.kind.receipt')}</span><span className="mono">{l.file}</span></td>
        <td className="res"><span className="warn-t">{t('runs.line.poorScan')}</span></td>
        <td className="st"><span className="rpill check">{t('runs.st.check')}</span>{l.receipt ? <button type="button" className="linkbtn" onClick={() => go({ area: 'receipts', id: l.receipt!.id })}>{t('runs.view')}</button> : null}</td></tr>
    );
  }
  if (l.kind === 'copy') {
    return (
      <tr className="rline"><td /><td />
        <td className="what"><span className="rk">{t('runs.kind.receipt')}</span><span className="mono">{l.file}</span></td>
        <td className="res">{t('runs.line.copy', { of: l.of })}</td>
        <td className="st">{l.receipt ? <button type="button" className="linkbtn" onClick={() => go({ area: 'receipts', id: l.receipt!.id })}>{t('runs.view')}</button> : null}</td></tr>
    );
  }
  if (l.kind === 'file') {
    return <tr className="rline"><td /><td /><td className="what"><span className="rk">{t('runs.kind.file')}</span><span className="mono">{l.name}</span></td><td className="res" /><td /></tr>;
  }
  if (l.kind === 'refused') {
    return (
      <tr className="rline"><td /><td />
        <td className="what"><span className="rk">{t('runs.kind.file')}</span>{l.a.file}</td>
        <td className="res"><span className="warn-t">{t('runs.line.refused', { reason: l.a.reason === 'unreadable' ? t('drop.reason.unreadable') : l.a.reason })}</span></td>
        <td className="st"><span className="rpill check">{t('runs.st.check')}</span></td></tr>
    );
  }
  if (l.kind === 'statement') {
    const b = l.balance;
    const o = l.opening;
    return (
      <>
      <tr className="rline"><td /><td />
        <td className="what"><span className="rk">{t(/\.xml$/i.test(l.a.file) ? 'runs.kind.camt' : 'runs.kind.pdf')}</span>{statementTitle(l.a)}<small className="mono">{fileOf(l.a.file)}</small></td>
        <td className="res">
          {t('runs.out.added', { n: l.a.added })}
          {' · '}
          {b.kind === 'matches' ? <span className="ok-t">{t('runs.line.balOk', { date: swiss(b.date) })}</span>
            : b.kind === 'differs' ? <span className="warn-t">{t('runs.line.balOff', { date: swiss(b.date), amount: `${l.a.currency} ${fmt(Math.abs(b.diff))}`, dir: t(b.diff > 0 ? 'runs.line.more' : 'runs.line.less') })}</span>
            : <span className="m">{t('runs.line.noBalance')}</span>}
        </td>
        <td className="st">
          {b.kind === 'differs' || l.withoutVat.length ? <span className="rpill check">{t('runs.st.check')}</span> : null}
          <button type="button" className="linkbtn" onClick={() => go({ area: 'bank', statement: l.a.from ? fileKey(l.a.account, l.a.from, l.a.to) : `${l.a.account}-${l.a.to.slice(0, 7)}` })}>{t('runs.view')}</button>
        </td></tr>
      {o ? (
        <tr className="rline"><td /><td /><td />
          <td className="res" colSpan={2}>
            {t('runs.line.openingOffer', { amount: `${l.a.currency} ${fmt(o.amount)}`, date: swiss(o.date) })}{' '}
            <button type="button" className="btn primary" onClick={() => void takeOpening(nav, o)}>{t('runs.line.openingTake')}</button>
          </td></tr>
      ) : null}
      {l.startMissing ? (
        <tr className="rline" data-testid="run-start-missing"><td /><td /><td />
          <td className="res" colSpan={2}>
            {t('runs.line.startMissing', { year: l.startMissing.year, date: swiss(l.startMissing.from) })}{' '}
            {l.startMissing.canType ? <button type="button" className="linkbtn" onClick={() => go({ area: 'company', section: 'opening' })}>{t('reports.openingSet')}</button> : null}
          </td></tr>
      ) : null}
      {l.withoutVat.length ? (
        <tr className="rline"><td /><td /><td />
          <td className="res" colSpan={2}>
            <span className="warn-t">{t('sales.noVat', { n: l.withoutVat.length })}</span> {t('sales.noVatDo')}{' '}
            {l.withoutVat.map(({ payment: p }) => <button key={p.ref} type="button" className="linkbtn" onClick={() => go({ area: 'bank', payment: p.ref })}>{swiss(p.date)} · {p.currency} {fmt(p.amount)}</button>)}
          </td></tr>
      ) : null}
      </>
    );
  }
  const x = l.receipt;
  const facts = x ? [x.date && swiss(x.date), x.amount !== undefined && `${x.currency ?? ''} ${fmt(x.amount)}`.trim()].filter(Boolean).join(' · ') : '';
  return (
    <tr className="rline"><td /><td />
      <td className="what"><span className="rk">{t('runs.kind.receipt')}</span>{x?.description?.split(/[,(]/)[0].trim() || l.a.file}{facts ? <span className="m"> · {facts}</span> : null}<small className="mono">{l.a.file}</small></td>
      <td className="res">
        {!x ? <span className="warn-t">{t('runs.line.notRead')}</span>
          : waitsForReading(x) ? <span className="warn-t" data-testid="run-not-read">{t('receipts.notRead')}</span>
          : !l.payments.length ? <span className="warn-t">{t('runs.line.noPayment')}</span>
          : <>
              <span className="ok-t">{t('runs.line.linked')}</span>{' '}
              {l.payments.map((p) => <button key={p.ref} type="button" className="linkbtn" onClick={() => go({ area: 'bank', payment: p.ref })}>{swiss(p.date)} · {p.bank}</button>)}
              {l.entries ? <span className="ok-t"> · {t('runs.line.booked')}</span> : null}
            </>}
      </td>
      <td className="st">{x ? <button type="button" className="linkbtn" onClick={() => go({ area: 'receipts', id: x.id })}>{t('runs.view')}</button> : null}</td></tr>
  );
}

export function RunsHome({ view, books, nav }: { view: AutomationView; books: Index; nav: Nav }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(30);
  const go = (route: Route) => nav.go({ route, query: {} });
  const vatRegistered = useWorkspace()?.company.vat.registered ?? true;
  const rows = view.runs.filter((r) => r.mode === 'live').map((r) => { const lines = linesOf(r, books, vatRegistered); return { r, lines, stand: standOf(r, lines) }; });
  const counts = Object.fromEntries(FILTERS.map((f) => [f, rows.filter((x) => inFilter(f, x.stand)).length])) as Record<Filter, number>;
  const visible = rows.filter((x) => inFilter(filter, x.stand));
  const today = new Date();
  const todays = rows.filter((x) => sameDay(new Date(x.r.startedAt), today));
  const arrivedToday = todays.flatMap((x) => x.r.arrived ?? []);
  const toggle = (id: string) => setOpen((was) => { const next = new Set(was); if (!next.delete(id)) next.add(id); return next; });
  const review = (id: string, on: boolean) => void automationCommand({ kind: 'review', run: id, on }).then((res) => { if (!res.ok) nav.toast(commandRefusalText(res)); });
  const sum = [
    arrivedToday.some((a) => a.kind === 'statement') ? t('runs.in.statements', { n: arrivedToday.filter((a) => a.kind === 'statement').length }) : '',
    arrivedToday.some((a) => a.kind === 'receipt') ? t('runs.in.receipts', { n: arrivedToday.filter((a) => a.kind === 'receipt').length }) : '',
  ].filter(Boolean).join(t('runs.and'));
  const waiting = openCount(view);
  return (
    <div className="runshome">
      <div className="rhead">
        <h1>{t('area.automation')} · {t('automation.home.runs')}</h1>
        <span className="racts">
          <button type="button" className="btn ghost" onClick={() => nav.select({ area: 'automation', view: 'home' })}>{t('automation.home.title')}</button>
          <button type="button" className="btn ghost" onClick={() => nav.select({ area: 'automation', view: 'workflow', tab: 'graph' })}>{t('automation.workflows')}</button>
          <button type="button" className="btn ghost" onClick={() => nav.select({ area: 'automation', view: 'map', map: 'phases' })}>{t('automation.map')}</button>
          <button type="button" className="btn ghost" onClick={() => nav.select({ area: 'automation', view: 'queue' })}>{t('automation.queue')}</button>
          <button type="button" className="btn ghost" onClick={() => nav.select({ area: 'automation', view: 'tasks' })}>{t('automation.tasks')}{view.tasks.length ? <span className="wfpill warn">{view.tasks.length}</span> : null}</button>
        </span>
      </div>
      <p className="rsub">
        {t('runs.today', { n: todays.length })}{sum ? `: ${sum}` : ''}.
        {counts.check ? <> <b className="warn-t">{t('runs.sum.check', { n: counts.check })}</b>.</> : null}
        {waiting ? <> <b className="warn-t">{t('runs.sum.you', { n: waiting })}</b>.</> : null}
      </p>
      <div className="rfilters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
            {t(`runs.filter.${f}` as 'runs.filter.all')} <span className="mono">{counts[f]}</span>
          </button>
        ))}
      </div>
      {!rows.length ? <p className="rempty">{t('runs.empty')}</p> : !visible.length ? <p className="rempty">{t('runs.filterEmpty')}</p> : (
        <table className="rtable">
          <thead><tr><th /><th>{t('runs.col.when')}</th><th>{t('runs.col.in')}</th><th>{t('runs.col.out')}</th><th className="st">{t('runs.col.state')}</th></tr></thead>
          <tbody>
            {visible.slice(0, shown).map(({ r, lines, stand }) => {
              const started = new Date(r.startedAt);
              const isOpen = open.has(r.id);
              const [inHead, inSmall] = inText(r, lines, view, books);
              const [outHead, outSmall] = outText(r, lines);
              const expandable = lines.length > 0;
              return (
                <Fragment key={r.id}>
                  <tr className={`rrun s-${stand}${isOpen ? ' open' : ''}${!r.reviewed && (stand === 'ok' || stand === 'check') ? ' unseen' : ''}`} onClick={() => (expandable ? toggle(r.id) : go({ area: 'automation', view: 'run', run: r.id }))}>
                    <td className="tog">{expandable ? <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg> : null}</td>
                    <td className="when"><b className="mono">{sameDay(started, today) ? `${pad(started.getHours())}:${pad(started.getMinutes())}` : `${pad(started.getDate())}.${pad(started.getMonth() + 1)}.`}</b><small>{sameDay(started, today) ? '' : `${pad(started.getHours())}:${pad(started.getMinutes())} · `}{byText(r, view)}</small></td>
                    <td className="what"><b>{inHead}</b>{inSmall ? <small>{inSmall}</small> : null}</td>
                    <td className="res"><b>{outHead}</b>{outSmall ? <small className={lines.some((l) => (l.kind === 'statement' && (l.balance.kind === 'differs' || l.withoutVat.length > 0)) || l.kind === 'poorScan') ? 'warn-t' : ''}>{outSmall}</small> : null}</td>
                    <td className="st" onClick={(e) => e.stopPropagation()}>
                      <span className={`rpill ${stand}`}>{t(`runs.st.${stand}` as 'runs.st.ok')}</span>
                      {stand === 'ok' || stand === 'check' ? <button type="button" className="linkbtn rreview" onClick={() => review(r.id, true)}>{t('runs.review')}</button> : null}
                      {stand === 'reviewed' ? <button type="button" className="linkbtn rreview m" onClick={() => review(r.id, false)}>{t('runs.unreview')}</button> : null}
                    </td>
                  </tr>
                  {isOpen ? (
                    <>
                      {lines.map((l, i) => <LineRow key={i} l={l} go={go} nav={nav} />)}
                      <tr className="rline last"><td /><td /><td colSpan={3}><button type="button" className="linkbtn" onClick={() => go({ area: 'automation', view: 'run', run: r.id })}>{t('runs.open')}</button></td></tr>
                    </>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {visible.length > shown ? <button type="button" className="linkbtn rmore" onClick={() => setShown(shown + 30)}>{t('runs.more')}</button> : null}
    </div>
  );
}
