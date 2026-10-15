/**
 * Dateien hinzufügen (docs/0.4.0/intake.md, screen 8): every file dropped while it is open joins
 * the list, recognized at once by its structure; each row says what will happen to it and has its
 * own small action; nothing is written before «Hinzufügen», which fills the inbox, reads the
 * statements and starts the inbox's run. Further drops, onto the window or the dialog, add rows.
 */
import { Fragment, useState, useSyncExternalStore } from 'react';
import { api, errorText } from '../lib/api.js';
import { language, t } from '../i18n/index.js';
import { fmt, formatDate } from '../lib/utils.js';
import { useAutomation } from '../automation/store.js';
import { textIn } from '../../workflows/model.js';
import type { Index } from '../../types/index.js';
import type { DropRow, DropSession } from '../../types/drop.js';
import type { Route } from './route.js';

interface State { open: boolean; session?: DropSession; adding: number; error?: string; busy?: boolean }
let state: State = { open: false, adding: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
const useDrop = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);

export const dropOpen = (): boolean => state.open;

/** Opens the dialog (or uses the open one) and adds the files to its list. */
export async function dropFiles(files: File[]): Promise<void> {
  set({ open: true, error: undefined });
  try {
    let session = state.session && !state.session.done ? state.session : await api.dropOpen();
    set({ session, adding: state.adding + files.length });
    for (const f of files) {
      session = await api.dropAdd(session.id, f);
      set({ session, adding: Math.max(0, state.adding - 1) });
    }
  } catch (e) {
    set({ error: errorText(e), adding: 0 });
  }
}

export function closeDrop(): void {
  const s = state.session;
  if (s && !s.done) void api.dropClose(s.id).catch(() => undefined);
  set({ open: false, session: undefined, adding: 0, error: undefined });
}

type Tab = 'all' | 'bank' | 'statements' | 'receipts' | 'unclear' | 'out';
const tabOf = (r: DropRow): Tab => (r.state === 'duplicate' || r.state === 'quarantine' || r.state === 'refused' ? 'out'
  : r.state === 'locked' || r.state === 'unclear' || !r.kind ? 'unclear'
  : r.kind === 'camt' ? 'bank' : r.kind === 'statement-pdf' ? 'statements' : 'receipts');
const needsYou = (r: DropRow) => r.state === 'locked' || r.state === 'unclear';

function Row({ r, session }: { r: DropRow; session: DropSession }) {
  const [password, setPassword] = useState('');
  const act = async (action: Parameters<typeof api.dropRow>[2]) => {
    try { set({ session: await api.dropRow(session.id, r.key, action) }); } catch (e) { set({ error: errorText(e) }); }
  };
  const goes = r.state === 'take'
    ? (r.kind === 'camt' || r.kind === 'statement-pdf' ? t('drop.goes.statement') : t('drop.goes.inbox'))
    : t(`drop.state.${r.state}` as 'drop.state.duplicate');
  return (
    <div className={`droprow s-${r.state}`}>
      <div className="dn">
        <b className="mono">{r.name}</b>
        <small>
          {r.kind ? t(`drop.kind.${r.kind}` as 'drop.kind.receipt') : t('drop.kind.unknown')}
          {r.how ? <span className="drophow">{t(`drop.how.${r.how}` as 'drop.how.structure')}</span> : null}
          {r.from ? ` · ${t('drop.from', { name: r.from })}` : ''}
          {r.facts ? ` · ${[r.facts.iban, r.facts.from && `${formatDate(r.facts.from)} – ${formatDate(r.facts.to!)}`, r.facts.entries !== undefined && t('drop.entries', { n: r.facts.entries })].filter(Boolean).join(' · ')}` : ''}
        </small>
      </div>
      <div className="dgo">
        <span className={`dchip c-${r.state}`}>{goes}</span>
        {r.reason ? <small>{t(`drop.reason.${r.reason}` as 'drop.reason.duplicate')}</small> : null}
        {r.state === 'duplicate' || r.state === 'quarantine' ? <button type="button" className="linkbtn" onClick={() => void act({ kind: 'take' })}>{t('drop.takeAnyway')}</button> : null}
        {r.state === 'take' && (r.kind === 'receipt' || r.kind === 'photo') ? <button type="button" className="linkbtn" onClick={() => void act({ kind: 'as', as: 'quarantine' })}>{t('drop.notReceipt')}</button> : null}
        {r.state === 'locked' ? (
          <form className="dpw" onSubmit={(e) => { e.preventDefault(); if (password) void act({ kind: 'unlock', password }).then(() => setPassword('')); }}>
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('drop.password')} aria-label={t('drop.password')} />
            <button type="submit" className="btn" disabled={!password}>{t('drop.unlock')}</button>
          </form>
        ) : null}
      </div>
      <button type="button" className="dx" aria-label={t('drop.remove', { name: r.name })} onClick={() => void act({ kind: 'remove' })}>×</button>
    </div>
  );
}

/** Whether the run that takes up the dropped files has come to rest (or there is none). */
const restingRun = (view: ReturnType<typeof useAutomation>['view'], done: NonNullable<DropSession['done']>): boolean => {
  const run = done.run ? view?.runs.find((r) => r.id === done.run) : undefined;
  return !done.run || (!!run && run.status !== 'queued' && run.status !== 'running');
};

/** Where one taken file is, read from the books and the run: still in its step, read, matched, or waiting for a person. */
type FileState = { kind: 'working'; step?: string } | { kind: 'read' } | { kind: 'matched' } | { kind: 'waits' } | { kind: 'statement' };

/** A taken receipt's quick details: what was read off it, the payment it was linked to and the entries booked on that payment, each a link. */
function ReceiptDetails({ id, books, go }: { id: string; books: Index; go(route: Route): void }) {
  const receipt = books.receipts.find((x) => x.id === id);
  if (!receipt) return null;
  const refs = new Set(books.mappings.filter((m) => m.receiptId === id).map((m) => m.transactionRef));
  const payments = books.transactions.filter((x) => refs.has(x.ref));
  const entries = (books.journalEntries ?? []).filter((e) => refs.has(e.transactionRef));
  const read = [receipt.description, receipt.date && formatDate(receipt.date), receipt.amount !== undefined && `${receipt.currency ?? ''} ${fmt(receipt.amount)}`.trim()].filter(Boolean).join(' · ');
  const vat = receipt.vatSummary?.length ? receipt.vatSummary.map((g) => `${g.ratePercent} % ${fmt(g.vat)}`).join(' · ')
    : receipt.hasSwissVat === false ? t('drop.d.noSwissVat') : '–';
  return (
    <dl className="ddet">
      <dt>{t('drop.d.read')}</dt><dd>{read || '–'}</dd>
      <dt>{t('drop.d.vat')}</dt><dd>{vat}{receipt.vatId ? ` · ${receipt.vatId}` : ''}</dd>
      <dt>{t('drop.d.payment')}</dt>
      <dd>{payments.length ? payments.map((x) => (
        <button key={x.ref} type="button" className="linkbtn" onClick={() => go({ area: 'bank', payment: x.ref })}>
          {formatDate(x.date)} · {x.bank} · {x.currency} {fmt(x.direction === 'DBIT' ? -x.amount : x.amount)}
        </button>
      )) : t('drop.d.none')}</dd>
      <dt>{t('drop.d.entry')}</dt>
      <dd>{entries.length ? entries.map((e) => (
        <button key={e.id} type="button" className="linkbtn" onClick={() => go({ area: 'journal', id: e.id })}>
          {e.accountDebit} / {e.accountCredit}{e.vatCode ? ` · ${e.vatCode}` : ''} · {fmt(e.amount)}
        </button>
      )) : t('drop.d.none')}</dd>
      <dt>{t('drop.d.file')}</dt><dd className="mono">{receipt.filename}</dd>
    </dl>
  );
}

/**
 * After «Hinzufügen» (mockup screen 8): the run's progress over all files, each file with where it
 * is, and «Im Hintergrund weiter», since the run goes on the same when the dialog closes.
 */
function Progress({ done, rows, books, onGo }: { done: NonNullable<DropSession['done']>; rows: DropRow[]; books: Index; onGo(route: Route): void }) {
  const { view } = useAutomation();
  const run = done.run ? view?.runs.find((r) => r.id === done.run) : undefined;
  const steps = view?.workflows.find((w) => w.id === run?.workflow)?.steps ?? [];
  const resting = restingRun(view, done);
  const stepAt = run?.at ? steps.findIndex((x) => x.id === run.at) : -1;
  const stepLabel = stepAt >= 0 ? textIn(steps[stepAt].label, language()) : undefined;
  const taken = rows.filter((r) => r.state === 'take');
  const stateOf = (r: DropRow): FileState => {
    if (r.kind === 'camt' || r.kind === 'statement-pdf') return { kind: 'statement' };
    if (books.mappings.some((m) => m.receiptId === r.id)) return { kind: 'matched' };
    const receipt = books.receipts.find((x) => x.id === r.id);
    if (receipt?.location === 'archived') return resting ? { kind: 'read' } : { kind: 'working', step: stepLabel };
    return resting ? { kind: 'waits' } : { kind: 'working', step: stepLabel };
  };
  const states = taken.map(stateOf);
  const finished = states.filter((x) => x.kind !== 'working').length;
  const pct = taken.length ? Math.round((resting ? 1 : (finished + (stepAt >= 0 ? (stepAt + 1) / (steps.length + 1) : 0) * (taken.length - finished)) / taken.length) * 100) : 100;
  const waits = run?.status === 'waiting' || states.some((x) => x.kind === 'waits');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setOpen((was) => { const next = new Set(was); if (!next.delete(key)) next.add(key); return next; });
  const go = (route: Route) => { closeDrop(); onGo(route); };
  return (
    <div className="dprog">
      <div className="dbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
      <p className="m">
        {t('drop.overall', { pct, done: finished, n: taken.length })}
        {!resting && stepLabel ? ` · ${t('drop.atStep', { i: stepAt + 1, n: steps.length, step: stepLabel })}` : ''}
      </p>
      <div className="drows">
        {taken.map((r, i) => {
          const x = states[i];
          const receipt = books.receipts.find((y) => y.id === r.id);
          const facts = receipt && (receipt.date || receipt.amount !== undefined)
            ? [receipt.date && formatDate(receipt.date), receipt.amount !== undefined && `${receipt.currency ?? ''} ${fmt(receipt.amount)}`.trim()].filter(Boolean).join(' · ') : '';
          const shown = !!receipt && open.has(r.key);
          return (
            <Fragment key={r.key}>
              <div className={`droprow${shown ? ' open' : ''}`}>
                <div className="dn"><b className="mono">{r.name}</b><small>{receipt && receipt.filename !== r.name ? receipt.filename : t(`drop.kind.${r.kind ?? 'receipt'}` as 'drop.kind.receipt')}{facts ? ` · ${facts}` : ''}</small></div>
                <div className="dgo">
                  <span className={`dchip p-${x.kind}`}>{x.kind === 'working' ? (x.step ?? t('drop.p.working')) : t(`drop.p.${x.kind}` as 'drop.p.read')}</span>
                  {receipt ? <button type="button" className="linkbtn" onClick={() => go({ area: 'receipts', id: receipt.id })}>{t('drop.openReceipt')}</button> : null}
                </div>
                {receipt ? (
                  <button type="button" className="dtog" aria-expanded={shown} aria-label={t('drop.d.toggle', { name: r.name })} onClick={() => toggle(r.key)}>
                    <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                  </button>
                ) : <span />}
              </div>
              {shown ? <ReceiptDetails id={receipt.id} books={books} go={go} /> : null}
            </Fragment>
          );
        })}
      </div>
      {done.refused.map((x) => <p key={x.name} className="warnline">{x.name}: {x.message}</p>)}
      {resting && waits ? <p className="m">{t('drop.waitsHint')}</p> : null}
      <div className="dfoot">
        <span className="m">{done.run ? <button type="button" className="linkbtn" onClick={() => go({ area: 'automation', view: 'run', run: done.run! })}>{t('drop.openRun')}</button> : null}</span>
        <button type="button" className="btn primary" onClick={closeDrop}>{resting ? t('common.close') : t('drop.background')}</button>
      </div>
    </div>
  );
}

export function DropDialog({ onGo, books }: { onGo(route: Route): void; books: Index }) {
  const s = useDrop();
  const { view } = useAutomation();
  const [tab, setTab] = useState<Tab>('all');
  if (!s.open) return null;
  const rows = s.session?.rows ?? [];
  const tabs: Tab[] = ['all', 'bank', 'statements', 'receipts', ...(rows.some((r) => tabOf(r) === 'unclear') ? ['unclear' as const] : []), 'out'];
  const shown = tab === 'all' ? rows : rows.filter((r) => tabOf(r) === tab);
  const taken = rows.filter((r) => r.state === 'take');
  const toInbox = taken.filter((r) => r.kind === 'receipt' || r.kind === 'photo').length;
  const statements = taken.length - toInbox;
  const done = s.session?.done;
  const commit = async () => {
    if (!s.session) return;
    set({ busy: true });
    try { set({ session: await api.dropCommit(s.session.id), busy: false }); } catch (e) { set({ error: errorText(e), busy: false }); }
  };
  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 45%, transparent)' }} onClick={() => !s.busy && closeDrop()} />
      <div className="palette dropdlg" role="dialog" aria-label={t('drop.dialog')}>
        <div className="dhd">
          <b>{done ? t(restingRun(view, done) ? 'drop.titleDone' : 'drop.titleWorking') : t('drop.dialog')}</b>
          {s.adding ? <span className="wfpill st-running">{t('drop.reading', { n: s.adding })}</span> : null}
          <button type="button" className="chip" aria-label={t('common.close')} onClick={closeDrop}>×</button>
        </div>
        {done ? (
          <Progress done={done} rows={rows} books={books} onGo={onGo} />
        ) : (
          <>
            <div className="wftabs" role="tablist">
              {tabs.map((x) => {
                const of = x === 'all' ? rows : rows.filter((r) => tabOf(r) === x);
                return (
                  <button key={x} type="button" role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>
                    {t(`drop.tab.${x}` as 'drop.tab.all')} <span className="mono">{of.length}</span>{of.some(needsYou) ? <i className="ddot" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
            <div className="drows">
              {shown.length ? shown.map((r) => <Row key={r.key} r={r} session={s.session!} />) : <p className="m">{rows.length ? t('drop.emptyTab') : t('drop.empty')}</p>}
            </div>
            {s.error ? <p className="warnline">{s.error}</p> : null}
            <div className="dfoot">
              <span className="m">{taken.length ? [toInbox && t('drop.sumInbox', { n: toInbox }), statements && t('drop.sumStatements', { n: statements })].filter(Boolean).join(' · ') : t('drop.sumNothing')}</span>
              <button type="button" className="btn ghost" onClick={closeDrop}>{t('common.cancel')}</button>
              <button type="button" className="btn primary" disabled={!taken.length || !!s.adding || s.busy} onClick={() => void commit()}>{t('drop.add', { n: taken.length })}</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
