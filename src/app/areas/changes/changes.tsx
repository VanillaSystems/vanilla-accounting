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
import { changesNow as lastView, useChanges, useDiff, useSave } from '../../changes/store.js';
import { diffLines, hunks, type ChangesView, type FileChange, type SaveSummary } from '../../../saving/model.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem, Nav } from '../index.js';

type Props = AreaProps<RouteOf<'changes'>>;
type R = RouteOf<'changes'>;

const when = (iso: string) => iso.slice(11, 16);
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
        <span className="a"><span className="chcount"><span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span></span><span className="m">{stateLabel(f.state)}</span></span>
      </div>
    );
  };
  const days = new Map<string, SaveSummary[]>();
  for (const s of view?.history ?? []) days.set(s.at.slice(0, 10), [...(days.get(s.at.slice(0, 10)) ?? []), s]);
  return (
    <>
      <h1>{t('area.changes')}</h1>
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
                  <span className="a"><span className={`chkind k-${s.kind}`}>{kindLabel(s.kind)}</span><span className="m mono">{when(s.at)}</span></span>
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
  if (!route.commit) return <div className="detail-empty"><div>{t('changes.pick')}</div></div>;
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
      <div className="head"><h2 className="who">{data.subject}<small>{formatDate(data.at.slice(0, 10))} {when(data.at)} · {t('changes.by', { author: data.author })} · <span className="mono">{data.short}</span></small></h2></div>
      <p className="lead"><span className={`chkind k-${data.kind}`}>{kindLabel(data.kind)}</span>{data.run ? <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: data.run! }, query: {} })}>{t('automation.run', { id: data.run })}</button> : null}</p>
      {body ? <pre className="chbody">{body}</pre> : null}
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

