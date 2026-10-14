/**
 * Dateien hinzufügen (docs/0.4.0/intake.md, screen 8): every file dropped while it is open joins
 * the list, recognized at once by its structure; each row says what will happen to it and has its
 * own small action; nothing is written before «Hinzufügen», which fills the inbox, reads the
 * statements and starts the inbox's run. Further drops, onto the window or the dialog, add rows.
 */
import { useState, useSyncExternalStore } from 'react';
import { api, errorText } from '../lib/api.js';
import { t } from '../i18n/index.js';
import { formatDate } from '../lib/utils.js';
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

export function DropDialog({ onGo }: { onGo(route: Route): void }) {
  const s = useDrop();
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
          <b>{t('drop.dialog')}</b>
          {s.adding ? <span className="wfpill st-running">{t('drop.reading', { n: s.adding })}</span> : null}
          <button type="button" className="chip" aria-label={t('common.close')} onClick={closeDrop}>×</button>
        </div>
        {done ? (
          <div className="ddone">
            <p>{t('drop.done', { n: done.taken })}</p>
            {done.run ? <button type="button" className="linkbtn" onClick={() => { closeDrop(); onGo({ area: 'automation', view: 'run', run: done.run! }); }}>{t('drop.openRun', { id: done.run })}</button> : null}
            {done.refused.map((x) => <p key={x.name} className="warnline">{x.name}: {x.message}</p>)}
            <div className="dfoot"><button type="button" className="btn primary" onClick={closeDrop}>{t('common.close')}</button></div>
          </div>
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
