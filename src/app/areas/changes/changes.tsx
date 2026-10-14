/**
 * Änderungen (docs/0.4.0/ui/design.md): what waits to be saved in how the app works (the AI's
 * draft, files changed outside the app), and Verlauf: every save by day, the books' among them.
 * The books are committed by the app itself; nothing of them waits here.
 */
import { Fragment, useState } from 'react';
import './changes.css';
import type { RouteOf } from '../../shell/route.js';
import { moveKey } from '../../shell/keyboard.js';
import { formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { changesCommand, changesNow as lastView, useChanges, useDiff, useSave } from '../../changes/store.js';
import { errorText } from '../../lib/api.js';
import { BotIcon } from '../automation/Graph.js';
import { diffLines, hunks, type ChangesView, type FileChange, type SaveSummary, type SavingCommand, type SavingResult } from '../../../saving/model.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem, Nav } from '../index.js';

type Props = AreaProps<RouteOf<'changes'>>;
type R = RouteOf<'changes'>;

/** A save's moment in the viewer's own time zone: git stores it as an instant. */
const local = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const when = (iso: string) => local(iso).slice(11, 16);
const dayOf = (iso: string) => local(iso).slice(0, 10);
const kindLabel = (k: SaveSummary['kind']) => t(`changes.kind.${k}` as 'changes.kind.books');
const stateLabel = (s: FileChange['state']) => t(`changes.state.${s}` as 'changes.state.added');

function rowsOf(view: ChangesView | undefined): R[] {
  if (!view) return [];
  return [
    ...view.draft.map((f): R => ({ area: 'changes', commit: 'draft', file: f.path })),
    ...view.outside.map((f): R => ({ area: 'changes', commit: 'outside', file: f.path })),
    ...view.history.map((s): R => ({ area: 'changes', commit: s.oid })),
  ];
}
const same = (a: R, b: R) => a.commit === b.commit && (a.file ?? '') === (b.file ?? '');

function List({ route, nav }: Props) {
  const { view, error } = useChanges();
  const selected = (r: R) => same(r, { area: 'changes', commit: route.commit, file: route.commit === 'draft' || route.commit === 'outside' ? route.file : undefined });
  const fileRow = (source: 'draft' | 'outside', f: FileChange) => {
    const r: R = { area: 'changes', commit: source, file: f.path };
    const on = selected(r);
    return (
      <div key={source + f.path} className={`row chrow${on ? ' sel' : ''}`} role="option" aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => nav.select(r)}>
        <span className="t mono">{f.path}</span>
        <span className="a">{f.effect && f.effect !== 'applies-now' ? <span className={`chkind e-${f.effect}`}>{t(`changes.effect.${f.effect}` as 'changes.effect.applies-now')}</span> : null}<span className="chcount"><span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span></span><span className="m">{stateLabel(f.state)}</span></span>
      </div>
    );
  };
  const days = new Map<string, SaveSummary[]>();
  for (const s of view?.history ?? []) days.set(dayOf(s.at), [...(days.get(dayOf(s.at)) ?? []), s]);
  return (
    <>
      <h1>{t('area.changes')}</h1>
      {view?.repository ? <SyncLine view={view} nav={nav} /> : null}
      {error ? <p className="warnline">{error}</p> : null}
      {view && !view.repository ? <p className="m">{t('changes.noRepository')}</p> : null}
      {view?.booksUnsaved ? <p className="warnline">{t('changes.booksUnsaved', { n: view.booksUnsaved })}</p> : null}
      {view && !view.draft.length && !view.outside.length && view.repository ? <p className="m chnothing">{t('changes.nothing')}</p> : null}
      <div className="rows" role="listbox" aria-label={t('area.changes')}>
        {view?.draft.length ? <><div className="group"><span>{t('changes.draft')}</span></div>{view.draft.map((f) => fileRow('draft', f))}</> : null}
        {view?.outside.length ? <><div className="group"><span>{t('changes.outside')}</span></div>{view.outside.map((f) => fileRow('outside', f))}</> : null}
        {[...days].map(([day, saves]) => (
          <Fragment key={day}>
            <div className="group"><span>{t('changes.history')} · {formatDate(day)}</span></div>
            {saves.map((s) => {
              const r: R = { area: 'changes', commit: s.oid };
              const on = route.commit === s.oid;
              return (
                <div key={s.oid} className={`row chrow${on ? ' sel' : ''}`} role="option" aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => nav.select(r)}>
                  <span className="t">{s.subject}</span>
                  <span className="a">{s.locked ? <span className="chkind">{t('changes.locked')}</span> : null}<span className={`chkind k-${s.kind}`}>{kindLabel(s.kind)}</span><span className="m mono">{when(s.at)}</span></span>
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </>
  );
}

function Detail({ route, nav }: Props) {
  const { view } = useChanges();
  if (!route.commit) return view && (view.draft.length || view.outside.length || view.proposal) ? <SavePanel view={view} nav={nav} /> : <div className="detail-empty"><div>{t('changes.pick')}</div></div>;
  if (route.file) return <FileView source={route.commit} path={route.file} rev={view?.rev} />;
  return <SaveView oid={route.commit} nav={nav} />;
}

function SaveView({ oid, nav }: { oid: string; nav: Nav }) {
  const { data, error } = useSave(oid);
  if (error) return <div className="detail-empty"><div>{error}</div></div>;
  if (!data) return <div className="detail-empty"><div>{t('changes.loading')}</div></div>;
  const body = data.body.split('\n').slice(1).filter((l) => l.trim() && !/^Vanilla-[A-Za-z]+: /.test(l)).join('\n');
  return (
    <div className="detail-in chpage" key={oid}>
      <div className="head"><h2 className="who">{data.subject}<small>{formatDate(dayOf(data.at))} {when(data.at)} · {t('changes.by', { author: data.author })} · <span className="mono">{data.short}</span></small></h2></div>
      <p className="lead"><span className={`chkind k-${data.kind}`}>{kindLabel(data.kind)}</span>{data.run ? <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: data.run! }, query: {} })}>{t('automation.run', { id: data.run })}</button> : null}</p>
      {body ? <pre className="chbody">{body}</pre> : null}
      {data.undo ? <UndoButton oid={oid} kind={data.undo} nav={nav} /> : null}
      <h3 className="chh3">{t('changes.files')}</h3>
      <div className="chfiles">
        {data.files.map((f) => (
          <button key={f.path} type="button" className="chfile" onClick={() => nav.select({ area: 'changes', commit: oid, file: f.path })}>
            <span className="mono">{f.path}</span><span className="chcount"><span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function FileView({ source, path, rev }: { source: string; path: string; rev: string | undefined }) {
  const { data, error } = useDiff(source, path, rev);
  const [whole, setWhole] = useState(false);
  if (error) return <div className="detail-empty"><div>{error}</div></div>;
  if (!data) return <div className="detail-empty"><div>{t('changes.loading')}</div></div>;
  const lines = diffLines(data.before, data.after);
  const shown = whole ? lines : hunks(lines);
  return (
    <div className="detail-in chpage" key={source + path}>
      <div className="head"><h2 className="who mono chpath">{path}<small>{source === 'draft' ? t('changes.draft') : source === 'outside' ? t('changes.outside') : source.slice(0, 7)}</small></h2></div>
      <div className="wftabs" role="tablist">
        <button type="button" role="tab" aria-selected={!whole} className={whole ? '' : 'on'} onClick={() => setWhole(false)}>{t('changes.diff')}</button>
        <button type="button" role="tab" aria-selected={whole} className={whole ? 'on' : ''} onClick={() => setWhole(true)}>{t('changes.whole')}</button>
      </div>
      {lines.every((l) => l.kind === ' ') ? <p className="m">{t('changes.same')}</p> : (
        <pre className="chdiff">
          {shown.map((l, i) => (l === null
            ? <span key={i} className="gap">⋯{'\n'}</span>
            : <span key={i} className={`ln k${l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'same'}`}><span className="no">{l.old ?? ''}</span><span className="no">{l.new ?? ''}</span>{l.kind}{l.text}{'\n'}</span>))}
        </pre>
      )}
    </div>
  );
}

/** Runs a saving command and says how it went; a refusal is a toast with its reason. */
function useCommand(nav: Nav): [string | undefined, (cmd: SavingCommand) => Promise<SavingResult | undefined>] {
  const [busy, setBusy] = useState<string>();
  const go = async (cmd: SavingCommand) => {
    setBusy(cmd.kind);
    try {
      const r = await changesCommand(cmd);
      if (!r.ok) nav.toast(r.message);
      else if (r.saved !== undefined) nav.toast(t('changes.savedToast', { n: r.saved }));
      else if (cmd.kind === 'sync') nav.toast(t('changes.syncedToast'));
      return r;
    } catch (e) {
      nav.toast(errorText(e));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };
  return [busy, go];
}

function SyncLine({ view, nav }: { view: ChangesView; nav: Nav }) {
  const [busy, go] = useCommand(nav);
  if (!view.sync.remote) return <p className="chsync"><span className="wfpill muted">{t('changes.noRemote')}</span></p>;
  return (
    <p className="chsync">
      {view.sync.ahead ? <span className="wfpill warn">{t('changes.notSynced', { n: view.sync.ahead })}</span> : <span className="wfpill st-done">{t('changes.synced')}</span>}
      {view.sync.ahead ? <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void go({ kind: 'sync' })}>{t('changes.sync')}</button> : null}
    </p>
  );
}

function UndoButton({ oid, kind, nav }: { oid: string; kind: 'draft' | 'reverse'; nav: Nav }) {
  const [busy, go] = useCommand(nav);
  return (
    <p className="chundo">
      <button type="button" className="btn ghost" disabled={!!busy} onClick={() => void go({ kind: 'undo', oid }).then((r) => {
        if (!r?.ok) return;
        nav.toast(kind === 'draft' ? t('changes.undoneToast') : t('changes.reversedToast', { n: r.reversed ?? 0 }));
        if (kind === 'draft') nav.select({ area: 'changes' });
      })}>{t('changes.undo')}</button>
      <span className="m">{kind === 'draft' ? t('changes.undoDraft') : t('changes.undoReverse')}</span>
    </p>
  );
}

/**
 * Bereit zum Speichern (saving.md): without a proposal, the changed files and «Speichern
 * vorbereiten»; with one, the AI's saves, what moved since, the conversation and the save buttons.
 */
function SavePanel({ view, nav }: { view: ChangesView; nav: Nav }) {
  const [busy, go] = useCommand(nav);
  const [text, setText] = useState('');
  const p = view.proposal;
  const files = [...view.draft.map((f) => ({ ...f, source: 'draft' })), ...view.outside.map((f) => ({ ...f, source: 'outside' }))];
  const countOf = (source: string, path: string) => files.find((f) => f.source === source && f.path === path);
  const thinking = busy === 'prepare' || busy === 'refresh' || busy === 'talk';
  if (!p) {
    return (
      <div className="detail-in chpage">
        <div className="head"><h2 className="who">{t('changes.ready')}</h2></div>
        <div className="chfiles">
          {files.map((f) => (
            <button key={f.source + f.path} type="button" className="chfile" onClick={() => nav.select({ area: 'changes', commit: f.source, file: f.path })}>
              <span className="mono">{f.path}</span><span className="chcount"><span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span></span>
            </button>
          ))}
        </div>
        <div className="chsave">
          {thinking ? <span className="wfpill st-running">{t('changes.preparing')}</span> : <button type="button" className="btn primary" onClick={() => void go({ kind: 'prepare' })}><BotIcon />{t('changes.prepare')}</button>}
          <span className="m">{t('changes.prepareTip')}</span>
        </div>
      </div>
    );
  }
  const stale = p.saves.filter((s) => p.stale.includes(s.id));
  const moved = [...stale.flatMap((s) => s.files.map((f) => f.path)), ...p.uncovered];
  const ready = p.saves.filter((s) => !s.held);
  const send = async () => { if (!text.trim()) return; if ((await go({ kind: 'talk', text }))?.ok) setText(''); };
  return (
    <div className="detail-in chpage">
      <div className="head"><h2 className="who"><BotIcon /> {t('changes.ready')}</h2></div>
      {moved.length ? (
        <div className="chbanner">
          <b>{t('changes.staleBanner', { files: moved.join(', ') })}</b>
          <span>{t('changes.staleLead')}</span>
          <button type="button" className="btn ghost" disabled={thinking} onClick={() => void go({ kind: 'refresh' })}><BotIcon />{t('changes.refresh')}</button>
        </div>
      ) : null}
      <p className="m">{t('changes.readyLead', { n: p.saves.length })}</p>
      <div className="chpreps">
        {p.saves.map((s) => {
          const [a, d] = s.files.reduce(([a, d], f) => { const c = countOf(f.source, f.path); return [a + (c?.added ?? 0), d + (c?.removed ?? 0)]; }, [0, 0]);
          return (
            <div key={s.id} className={`chprep${s.held ? ' held' : ''}${p.stale.includes(s.id) ? ' stale' : ''}`}>
              <div className="pt"><b>{s.message}</b>{s.held ? <span className="wfpill muted">{t('changes.held')}</span> : null}</div>
              {s.why ? <span className="m">{s.why}</span> : null}
              <div className="pf">
                <span className="chcount">{t('changes.fileCount', { n: s.files.length })} · <span className="plus">+{a}</span> <span className="minus">−{d}</span></span>
                {s.files.map((f) => <button key={f.path} type="button" className="linkbtn mono" onClick={() => nav.select({ area: 'changes', commit: f.source, file: f.path })}>{f.path.split('/').pop()}</button>)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="chtalk">
        {p.talk.map((m, i) => <Fragment key={i}><div className="msg me">{m.me}</div><div className="msg ai"><BotIcon /><div>{m.ai}</div></div></Fragment>)}
      </div>
      <div className="chcomposer">
        <textarea rows={2} value={text} placeholder={t('changes.ask')} aria-label={t('changes.ask')} disabled={thinking}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button type="button" className="btn" disabled={thinking || !text.trim()} onClick={() => void send()}><BotIcon />{t('changes.send')}</button>
      </div>
      <div className="chsave">
        {thinking ? <span className="wfpill st-running">{t('changes.preparing')}</span> : null}
        <button type="button" className="btn" disabled={!!busy || !p.ready || !ready.length} onClick={() => void go({ kind: 'save' })}>{t('changes.save')}</button>
        {view.sync.remote ? <button type="button" className="btn primary" disabled={!!busy || !p.ready || !ready.length} onClick={() => void go({ kind: 'save', sync: true })}>{t('changes.saveSync')}</button> : null}
        {!p.ready ? <span className="m">{t('changes.firstRefresh')}</span> : p.saves.length > ready.length ? <span className="m">{t('changes.heldNote', { n: p.saves.length - ready.length })}</span> : null}
        <button type="button" className="linkbtn" disabled={!!busy} onClick={() => void go({ kind: 'discard' })}>{t('changes.discard')}</button>
      </div>
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('keys.selectTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const changes: Area<RouteOf<'changes'>> = {
  id: 'changes',
  label: () => t('area.changes'),
  dock: { key: 'v', icon: ICONS.changes, tip: () => t('area.changes.tip') },
  List,
  Detail,
  legend,
  periodless: true,
  title: (r) => r.file ?? r.commit?.slice(0, 7),
  keys(e, { route, nav }) {
    const d = moveKey(e);
    if (!d) return false;
    const rows = rowsOf(lastView());
    const i = rows.findIndex((r) => same(r, { area: 'changes', commit: route.commit, file: route.file }));
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + d))];
    if (next) nav.select(next);
    return true;
  },
};

