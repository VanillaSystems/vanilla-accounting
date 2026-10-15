/**
 * Dateien hinzufügen (docs/0.4.0/intake.md, screen 8): every file dropped while it is open joins
 * the list and is taken at once when nothing is unclear about it (a receipt into the inbox, a
 * statement into the books), handed to the inbox's run; a row with an open question (a password, a
 * duplicate, unknown content) waits for its answer. Each row says where its file is and has its own
 * small action, «Rückgängig» for a taken one. Further drops, onto the window or the dialog, add
 * rows until it closes; the work goes on when it does.
 */
import { useState, useSyncExternalStore } from 'react';
import { api, errorText } from '../lib/api.js';
import { language, t } from '../i18n/index.js';
import { fmt, formatDate } from '../lib/utils.js';
import { useAutomation } from '../automation/store.js';
import { textIn } from '../../workflows/model.js';
import type { Index } from '../../types/index.js';
import type { DropRow, DropSession } from '../../types/drop.js';
import type { Route } from './route.js';
import { setBankDraft } from '../areas/company/bank-draft.js';

interface State { open: boolean; session?: DropSession; adding: number; error?: string }
let state: State = { open: false, adding: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
const useDrop = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);

export const dropOpen = (): boolean => state.open;

/** Opens the dialog (or uses the open one) and adds the files to its list. */
export async function dropFiles(files: File[]): Promise<void> {
  set({ open: true, error: undefined });
  try {
    let session = state.session ?? await api.dropOpen();
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
  if (s) void api.dropClose(s.id).catch(() => undefined);
  set({ open: false, session: undefined, adding: 0, error: undefined });
}

type Tab = 'all' | 'statements' | 'receipts' | 'unclear' | 'out';
const tabOf = (r: DropRow): Tab => (r.state === 'duplicate' || r.state === 'quarantine' || r.state === 'refused' || r.state === 'undone' ? 'out'
  : r.state === 'locked' || r.state === 'unclear' || !r.kind ? 'unclear'
  : r.kind === 'camt' || r.kind === 'statement-pdf' ? 'statements' : 'receipts');
const needsYou = (r: DropRow) => r.state === 'locked' || r.state === 'unclear';

const act = (session: DropSession, r: DropRow, action: Parameters<typeof api.dropRow>[2]) =>
  api.dropRow(session.id, r.key, action).then((next) => set({ session: next }), (e) => set({ error: errorText(e) }));

const groupIban = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

/** What a waiting row says about its file, the parts apart: its kind (when known), how it was recognized, the ZIP it came out of, the statement's account and period. */
function metaOf(r: DropRow): string {
  return [
    r.kind && t(`drop.kind.${r.kind}` as 'drop.kind.receipt'),
    r.how && t(`drop.how.${r.how}` as 'drop.how.structure'),
    r.from && t('drop.from', { name: r.from }),
    r.facts?.iban,
    r.facts?.from && `${formatDate(r.facts.from)} – ${formatDate(r.facts.to!)}`,
    r.facts?.entries !== undefined && t('drop.entries', { n: r.facts.entries }),
  ].filter(Boolean).join(' · ');
}

/** A row with an open question, or one not taken: what it is and its small action. */
function Waiting({ r, session, go }: { r: DropRow; session: DropSession; go(route: Route): void }) {
  const [password, setPassword] = useState('');
  const chip = r.state === 'take' ? t('drop.taking') : t(`drop.state.${r.state}` as 'drop.state.duplicate');
  return (
    <div className={`droprow s-${r.state}`}>
      <div className="dn">
        <b className="mono">{r.name}</b>
        <small>{metaOf(r)}</small>
      </div>
      <div className="dgo">
        <span className={`dchip c-${r.state}`}>{chip}</span>
        {r.unknownAccount ? (
          <>
            <small>{t('error.statement.unknownAccount', { iban: groupIban(r.unknownAccount.iban), currency: r.unknownAccount.currency })}</small>
            <button type="button" className="linkbtn" onClick={() => { setBankDraft(r.unknownAccount!); go({ area: 'company', section: 'banks' }); }}>{t('company.addBank')}</button>
          </>
        ) : r.message ? <small>{r.message}</small> : r.reason ? <small>{t(`drop.reason.${r.reason}` as 'drop.reason.duplicate')}</small> : null}
        {(r.state === 'duplicate' || r.state === 'quarantine') && r.kind !== 'camt' && r.kind !== 'statement-pdf' ? <button type="button" className="linkbtn" onClick={() => void act(session, r, { kind: 'take' })}>{t('drop.takeAnyway')}</button> : null}
        {r.state === 'locked' ? (
          <form className="dpw" onSubmit={(e) => { e.preventDefault(); if (password) void act(session, r, { kind: 'unlock', password }).then(() => setPassword('')); }}>
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('drop.password')} aria-label={t('drop.password')} />
            <button type="submit" className="btn" disabled={!password}>{t('drop.unlock')}</button>
          </form>
        ) : null}
      </div>
      {r.state === 'take' || r.state === 'undone' ? <span /> : <button type="button" className="dx" aria-label={t('drop.remove', { name: r.name })} onClick={() => void act(session, r, { kind: 'remove' })}>×</button>}
    </div>
  );
}

/** Where one taken file is, read from the books and its run: still in its step, read, matched, or waiting for a person. */
type FileState = { kind: 'working'; step?: string } | { kind: 'read' } | { kind: 'matched' } | { kind: 'waits' } | { kind: 'statement' };

const isWorking = (run?: { status: string }) => !!run && (run.status === 'queued' || run.status === 'running');

function fileState(r: DropRow, books: Index, view: ReturnType<typeof useAutomation>['view']): FileState {
  const run = r.run ? view?.runs.find((x) => x.id === r.run) : undefined;
  const steps = view?.workflows.find((w) => w.id === run?.workflow)?.steps ?? [];
  const step = run?.at ? steps.find((x) => x.id === run.at) : undefined;
  const working: FileState = { kind: 'working', ...(step ? { step: textIn(step.label, language()) } : {}) };
  // Its run is not in the last poll yet: it has only just started.
  if (r.run && !run) return working;
  if (r.statement) return isWorking(run) ? working : { kind: 'statement' };
  if (books.mappings.some((m) => m.receiptId === r.id)) return { kind: 'matched' };
  if (isWorking(run)) return working;
  const receipt = books.receipts.find((x) => x.id === r.id);
  // At rest but not in the books the page holds: they are being loaded again, unless the run stopped.
  if (!receipt) return run?.status === 'stuck' ? { kind: 'waits' } : working;
  return receipt.location === 'archived' ? { kind: 'read' } : { kind: 'waits' };
}

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

/** A taken file: where it is, its quick details, the way to its page, and «Rückgängig». */
function Taken({ r, session, books, go }: { r: DropRow; session: DropSession; books: Index; go(route: Route): void }) {
  const { view } = useAutomation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const x = fileState(r, books, view);
  const receipt = books.receipts.find((y) => y.id === r.id);
  const facts = receipt && (receipt.date || receipt.amount !== undefined)
    ? [receipt.date && formatDate(receipt.date), receipt.amount !== undefined && `${receipt.currency ?? ''} ${fmt(receipt.amount)}`.trim()].filter(Boolean).join(' · ') : '';
  const running = view?.runs.find((y) => y.id === r.run)?.status === 'running';
  const lacks = x.kind === 'waits' && receipt ? [!receipt.date && t('drop.p.date'), receipt.amount === undefined && t('drop.p.amount')].filter(Boolean).join(', ') : '';
  const missing = x.kind !== 'waits' ? '' : lacks ? t('drop.p.missing', { what: lacks }) : t('drop.p.payment');
  const shown = !!receipt && open;
  const undo = () => { setBusy(true); void act(session, r, { kind: 'undo' }).finally(() => setBusy(false)); };
  return (
    <>
      <div className={`droprow s-taken${shown ? ' open' : ''}`}>
        <div className="dn"><b className="mono">{r.name}</b><small>{r.statement ? [r.facts?.from && r.facts.to && `${formatDate(r.facts.from)} – ${formatDate(r.facts.to)}`, t('drop.entries', { n: r.statement.refs.length })].filter(Boolean).join(' · ') : receipt && receipt.filename !== r.name ? receipt.filename : t(`drop.kind.${r.kind ?? 'receipt'}` as 'drop.kind.receipt')}{facts ? ` · ${facts}` : ''}</small></div>
        <div className="dgo">
          <span className={`dchip p-${x.kind}`}>{x.kind === 'working' ? (x.step ?? t('drop.p.working')) : t(`drop.p.${x.kind}` as 'drop.p.read')}</span>
          {missing ? <small className="dwhy">{missing}</small> : null}
          <span className="dacts">
            {receipt ? <button type="button" className="linkbtn" onClick={() => go({ area: 'receipts', id: receipt.id })}>{t('drop.openReceipt')}</button> : null}
            <button type="button" className="linkbtn" disabled={running || busy} title={running ? t('drop.undoBusy') : undefined} onClick={undo}>{t('drop.undo')}</button>
          </span>
        </div>
        {receipt ? (
          <button type="button" className="dtog" aria-expanded={shown} aria-label={t('drop.d.toggle', { name: r.name })} onClick={() => setOpen(!open)}>
            <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        ) : <span />}
      </div>
      {shown ? <ReceiptDetails id={receipt.id} books={books} go={go} /> : null}
    </>
  );
}

export function DropDialog({ onGo, books }: { onGo(route: Route): void; books: Index }) {
  const s = useDrop();
  const { view } = useAutomation();
  const [tab, setTab] = useState<Tab>('all');
  if (!s.open) return null;
  const rows = s.session?.rows ?? [];
  const tabs: Tab[] = ['all', 'statements', 'receipts', ...(rows.some((r) => tabOf(r) === 'unclear') ? ['unclear' as const] : []), 'out'];
  const shown = tab === 'all' ? rows : rows.filter((r) => tabOf(r) === tab);
  const taken = rows.filter((r) => r.state === 'taken');
  const states = taken.map((r) => fileState(r, books, view));
  const working = s.adding > 0 || rows.some((r) => r.state === 'take') || states.some((x) => x.kind === 'working');
  const finished = states.filter((x) => x.kind !== 'working').length;
  const pct = taken.length ? Math.round((finished / taken.length) * 100) : 0;
  const waits = !working && states.some((x) => x.kind === 'waits');
  const go = (route: Route) => { closeDrop(); onGo(route); };
  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 45%, transparent)' }} onClick={closeDrop} />
      <div className="palette dropdlg" role="dialog" aria-label={t('drop.dialog')}>
        <div className="dhd">
          <b>{!taken.length ? t('drop.dialog') : working ? t('drop.titleWorking') : t('drop.titleDone')}</b>
          {s.adding ? <span className="wfpill st-running">{t('drop.reading', { n: s.adding })}</span> : null}
          <button type="button" className="chip" aria-label={t('common.close')} onClick={closeDrop}>×</button>
        </div>
        {taken.length ? (
          <div className="dprog">
            <div className="dbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
            <p className="m">{t('drop.overall', { pct, done: finished, n: taken.length })}</p>
          </div>
        ) : null}
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
          {shown.length ? shown.map((r) => (r.state === 'taken'
            ? <Taken key={r.key} r={r} session={s.session!} books={books} go={go} />
            : <Waiting key={r.key} r={r} session={s.session!} go={go} />)) : <p className="m">{rows.length ? t('drop.emptyTab') : t('drop.empty')}</p>}
        </div>
        {s.error ? <p className="warnline">{s.error}</p> : null}
        {waits ? <p className="m">{t('drop.waitsHint')}</p> : null}
        <div className="dfoot">
          <span className="m">{taken.length ? <button type="button" className="linkbtn" onClick={() => go({ area: 'automation', view: 'runs' })}>{t('drop.toRuns')}</button> : t('drop.moreHint')}</span>
          <button type="button" className="btn primary" onClick={closeDrop}>{working ? t('drop.background') : t('common.close')}</button>
        </div>
      </div>
    </>
  );
}
