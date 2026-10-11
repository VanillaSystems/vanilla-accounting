/**
 * The app's frame: list and detail with the divider, the top bar and the dock at the edges, the
 * ⌘K palette, the toast, the key legend and the drop zone; the URL in step with all of it.
 * Areas own only their list, detail and keys (docs/redesign/architecture.md §3).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { localToday, openQuarter, parsePeriod } from '../../accounting/periods.js';
import { AREAS, DOCK, areaOf, type Area, type AreaProps, type LegendItem, type Nav, type PaletteItem } from '../areas/index.js';
import { useIndex } from '../hooks/use-index.js';
import { useApiStatus } from '../hooks/use-api-status.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { FxProvider } from '../hooks/use-fx.js';
import { LOCALES, t } from '../i18n/index.js';
import { periodName } from '../lib/period-label.js';
import { formatDate } from '../lib/utils.js';
import { ICONS } from '../areas/icons.js';
import { Dock } from './Dock.js';
import { hrefOf, useLocationState } from './history.js';
import { intake } from '../areas/receipts/intake.js';
import { ExportDialog } from '../areas/export/ExportDialog.js';
import { configOf, ownConfig, ownPresets, presetFor, type DialogConfig } from '../areas/export/state.js';
import { PRESETS } from '../../export/model.js';
import { accountOfRoute } from '../areas/reports/view.js';
import { focusSelectedRow, useShellKeys } from './keyboard.js';
import { Menu } from './Menu.js';
import { Palette, type PaletteGroup } from './Palette.js';
import { PeriodPicker } from './PeriodPicker.js';
import { usePersistedFlag, useTheme, useZoom, type Theme } from './prefs.js';
import { AREA_HOME, type AreaId, type Query } from './route.js';
import { Split, useListWidth } from './Split.js';
import { useToast } from './Toast.js';
import { TopBar } from './TopBar.js';
import { ShellUiContext, type ShellUi } from './ui.js';

type Overlay =
  | { kind: 'palette' }
  | { kind: 'period'; anchor: DOMRect }
  | { kind: 'language'; anchor: DOMRect }
  | { kind: 'export'; config: DialogConfig };

export function Shell({ language, onLanguage }: { language: string; onLanguage(code: string): void }) {
  const { data: books, loading, error, refresh } = useIndex();
  const { online, readonly, snapshot } = useApiStatus();
  const canEdit = online && !readonly;
  const workspace = useWorkspace();
  const [loc, go] = useLocationState();
  const [theme, setTheme, dark] = useTheme();
  const [zoom, zoomStep] = useZoom();
  const { toast, undo, node: toastNode } = useToast();
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [dockKeys, setDockKeys] = useState(false);
  const [legend, setLegend] = usePersistedFlag('legend', true);
  const [dropping, setDropping] = useState(false);

  const area = areaOf(loc.route);
  const open = openQuarter(books.config?.closedThrough, localToday());
  const period = loc.query.period ?? open;

  const current = useRef(loc);
  current.current = loc;
  const nav: Nav = useMemo(() => ({
    // urls.md: the open period is left out of a link.
    go: (loc) => go(loc.query.period?.token === open.token ? { ...loc, query: { ...loc.query, period: undefined } } : loc),
    select: (route) => go({ route, query: current.current.query }),
    setQuery: (patch) => {
      const query: Query = { ...current.current.query, ...patch };
      if (query.period?.token === open.token) delete query.period;
      for (const k of Object.keys(query) as Array<keyof Query>) if (query[k] === undefined) delete query[k];
      go({ route: current.current.route, query });
    },
    toast,
    refresh,
  }), [go, toast, refresh, open.token]);

  const props: AreaProps = { route: loc.route, query: loc.query, period, books, nav, canEdit };
  const propsRef = useRef(props);
  propsRef.current = props;

  const goArea = useCallback((id: AreaId) => {
    const { route, query } = current.current;
    if (route.area === id) return;
    go({ route: AREA_HOME[id], query: query.period ? { period: query.period } : {} });
  }, [go]);

  const cycleTheme = () => {
    const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
    const name = t(next === 'light' ? 'app.themeLight' : next === 'dark' ? 'app.themeDark' : 'app.themeSystem');
    const before = theme;
    toast(t('shell.themeSet', { theme: next === 'system' ? t('shell.themeFollows', { theme: name }) : name }), () => setTheme(before));
  };
  const toggleTheme = () => setTheme(dark ? 'light' : 'dark');
  const runAdd = () => { if (area.add && canEdit) area.add.run(propsRef.current); };

  // The palette's search keeps the first render's closure: the open quarter is read from the props of now.
  const openNow = () => openQuarter(propsRef.current.books.config?.closedThrough, localToday());
  const openExport = (config?: DialogConfig) => {
    const { route, period } = propsRef.current;
    setOverlay({ kind: 'export', config: config ?? presetFor(route, period, openNow()) });
  };

  const ui: ShellUi = {
    area: area as Area,
    openPeriod: (anchor) => setOverlay({ kind: 'period', anchor: anchor.getBoundingClientRect() }),
    add: runAdd,
    openExport,
    theme, setTheme, dark, zoom, language,
  };

  useShellKeys({
    overlayOpen: () => overlay !== null,
    closeOverlay: () => { setOverlay(null); focusSelectedRow(); },
    palette: () => setOverlay({ kind: 'palette' }),
    undo,
    area: (letter) => {
      const id = DOCK.flat().find((a) => AREAS[a].dock?.key === letter);
      if (id) goArea(id);
      return !!id;
    },
    showDockKeys: setDockKeys,
    add: () => { if (!area.add || !canEdit) return false; runAdd(); return true; },
    areaKeys: (e) => area.keys?.(e, propsRef.current) ?? false,
    toggleTheme,
    toggleLegend: () => setLegend(!legend),
    exportOpen: () => openExport(),
  });

  // urls.md rule 6: the tab names the object.
  useEffect(() => {
    document.title = [area.title(loc.route, books), area.label()].filter(Boolean).join(' · ');
  }, [area, loc.route, books, language]);

  // The keyboard stays on the selected row as the selection moves.
  useLayoutEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a.classList.contains('row')) focusSelectedRow();
  }, [loc.route, loading]);

  const listRef = useRef<HTMLElement>(null);
  const [listWidth, setListWidth] = useListWidth(loc.route.area);

  const topRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  useEdges(topRef, dockRef, overlay !== null || dropping);
  useDrop(canEdit, setDropping, (files) => (area.drop ? area.drop.run(files, propsRef.current) : intake(files, nav)));

  const search = useCallback((q: string): PaletteGroup[] => {
    const p = propsRef.current;
    const words = q.split(/\s+/).filter(Boolean);
    const hit = (x: PaletteItem) => words.every((w) => `${x.label} ${x.side ?? ''}`.toLowerCase().includes(w));
    const objects: PaletteGroup[] = Object.values(AREAS)
      .filter((a) => a.palette && (q || a.id === p.route.area))
      .map((a) => [a.label(), a.palette!(p).filter(hit).slice(0, q ? 6 : 3)]);
    const report = (report: 'income' | 'balance' | 'trial', label: string): PaletteItem =>
      ({ label, side: t('shell.report'), run: () => go({ route: { area: 'reports', report }, query: p.query.period ? { period: p.query.period } : {} }) });
    const add = areaOf(p.route).add;
    const actions: PaletteItem[] = [
      ...(add && p.canEdit ? [{ label: add.title(), side: 'N', run: () => add.run(p) }] : []),
      report('income', t('tab.incomeStatement')),
      report('balance', t('tab.balanceSheet')),
      report('trial', t('tab.trialBalance')),
      { label: t('area.codes'), side: t('shell.lookup'), run: () => goArea('codes') },
      { label: t('export.paletteAction'), side: '⇧E', run: () => openExport() },
      ...PRESETS.map((x) => ({ label: t('export.palettePreset', { name: t(`export.preset.${x.id}`) }), side: t('export.paletteBuiltin'), run: () => openExport(configOf(x.id, openNow(), p.period)) })),
      ...ownPresets().map((x) => ({ label: t('export.palettePreset', { name: x.name }), side: t('export.paletteOwn'), run: () => openExport(ownConfig(x)) })),
      { label: t('shell.themeToggle'), side: 'T', run: toggleTheme },
    ].filter(hit);
    const areas: PaletteItem[] = DOCK.flat().map((id) => ({ label: AREAS[id].label(), side: `G ${AREAS[id].dock!.key.toUpperCase()}`, run: () => goArea(id) })).filter(hit);
    return [...objects, [t('shell.actions'), actions], [t('shell.areas'), areas]].filter(([, xs]) => xs.length > 0) as PaletteGroup[];
  }, [go, goArea]);

  const quarters = useMemo(() => {
    const qs = new Set<string>();
    for (const tx of books.transactions) qs.add(`${tx.date.slice(0, 4)}-Q${Math.ceil(Number(tx.date.slice(5, 7)) / 3)}`);
    return [...qs].sort().reverse();
  }, [books.transactions]);

  const legendItems: LegendItem[] = area.legend?.() ?? [
    ...(area.Detail ? [[['↑', '↓'], t('keys.select'), t('keys.selectTip')] as LegendItem] : []),
    ...(area.add && canEdit ? [[['N'], t('keys.new'), area.add.title()] as LegendItem] : []),
    [['G'], t('keys.area'), t('keys.areaTip')],
    [['/'], t('keys.search'), t('keys.searchTip')],
    [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
    [['?'], t('keys.help'), t('keys.helpTip')],
  ];

  const List = area.List;
  const Detail = area.Detail;
  const mainStyle = (listWidth ? { '--lw': `${listWidth}px` } : {}) as CSSProperties;

  return (
    <ShellUiContext.Provider value={ui}>
      {readonly && (
        <div role="status" data-testid="audit-bar" className="auditbar">
          {ICONS.lock} {t('app.auditBar')}
          {snapshot && <span data-testid="audit-snapshot"> · {t('app.snapshot', { date: formatDate(snapshot.createdAt.slice(0, 10)), schema: snapshot.booksSchema, version: snapshot.appVersion })}</span>}
        </div>
      )}
      <a className="skip" href="#list">{t('shell.skip')}</a>
      {loading || error ? (
        <main className="full">
          <div className="detail-empty">{loading ? t('app.loading') : <div><p>{t('app.loadFailed')}</p><p>{t('app.loadFailedHint', { command: 'npm run extract' })}</p><p>{error}</p></div>}</div>
        </main>
      ) : (
        <FxProvider index={books}>
          {Detail ? (
            <main data-area={loc.route.area} style={mainStyle}>
              <section className="list" id="list" ref={listRef} aria-label={area.label()}><List {...props} /></section>
              <section className="detail" aria-live="polite"><Detail {...props} /></section>
              <Split list={listRef} width={listWidth} onWidth={setListWidth} />
            </main>
          ) : (
            <main className="full" id="list" data-area={loc.route.area}><List {...props} /></main>
          )}
        </FxProvider>
      )}

      <TopBar
        ref={topRef}
        company={workspace?.company.name}
        period={area.periodless ? undefined : periodName(period)}
        zoom={zoom}
        onSearch={() => setOverlay({ kind: 'palette' })}
        onPeriod={ui.openPeriod}
        onZoom={zoomStep}
        onTheme={cycleTheme}
        onExport={() => openExport()}
        language={language}
        onLanguage={(anchor) => setOverlay({ kind: 'language', anchor: anchor.getBoundingClientRect() })}
      />
      <Dock ref={dockRef} current={loc.route.area} books={books} keys={dockKeys} href={(id) => hrefOf({ route: AREA_HOME[id], query: {} })} onGo={goArea} />
      <div className="hint" aria-hidden="true" />
      {toastNode}
      {legend && (
        <div className="legend">
          {t('shell.edges')}<br />
          {legendItems.map(([keys, label, tip]) => (
            <span key={label} className="item"><span className="k" data-tip={tip}>{keys.map((k) => <span key={k} className="cap">{k}</span>)}</span>{label}</span>
          ))}
        </div>
      )}
      <div className={`drop${dropping ? ' show' : ''}`} aria-hidden="true">
        <div className="box"><div>
          {ICONS.upload}
          <h2>{t('drop.title')}</h2>
          <p>{area.drop?.text() ?? t('drop.text')}</p>
          <p style={{ marginTop: 4, fontSize: 12.5, color: 'var(--faint)' }}>{area.drop?.formats() ?? t('drop.formats')}</p>
        </div></div>
      </div>

      {overlay?.kind === 'palette' && <Palette search={search} onClose={() => { setOverlay(null); focusSelectedRow(); }} />}
      {overlay?.kind === 'language' && (
        <Menu
          anchor={overlay.anchor}
          items={LOCALES.map((l) => ({ label: l.name, side: l.code.toUpperCase(), current: l.code === language, run: () => onLanguage(l.code) }))}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay?.kind === 'export' && (
        <ExportDialog
          initial={overlay.config}
          books={books}
          company={workspace?.company.name}
          page={period}
          account={loc.route.area === 'reports' ? accountOfRoute(loc.route) : undefined}
          quarters={quarters}
          toast={toast}
          onClose={() => { setOverlay(null); focusSelectedRow(); }}
        />
      )}
      {overlay?.kind === 'period' && (
        <PeriodPicker
          anchor={overlay.anchor}
          period={period}
          quarters={quarters}
          years={[...new Set(quarters.map((q) => q.slice(0, 4)))]}
          closedThrough={books.config?.closedThrough}
          onClose={() => setOverlay(null)}
          onApply={(token) => { setOverlay(null); nav.setQuery({ period: parsePeriod(token, localToday()) ?? undefined }); }}
        />
      )}
    </ShellUiContext.Provider>
  );
}

/** The top bar shows near the top edge, the dock near the bottom edge; both stay while hovered or held. */
function useEdges(top: React.RefObject<HTMLElement>, dock: React.RefObject<HTMLElement>, hold: boolean) {
  const holdRef = useRef(hold);
  holdRef.current = hold;
  useEffect(() => {
    let hideTop: ReturnType<typeof setTimeout>, hideDock: ReturnType<typeof setTimeout>;
    const show = (el: HTMLElement | null, on: boolean, timer: 'top' | 'dock') => {
      if (!el) return;
      clearTimeout(timer === 'top' ? hideTop : hideDock);
      if (on) el.classList.add('show');
      else if (timer === 'top') hideTop = setTimeout(() => el.classList.remove('show'), 450);
      else hideDock = setTimeout(() => el.classList.remove('show'), 450);
    };
    const onMove = (e: MouseEvent) => {
      if (document.querySelector('.drop.show')) return;
      const d = dock.current, b = top.current;
      show(d, innerHeight - e.clientY < 80 || !!d?.matches(':hover'), 'dock');
      show(b, e.clientY < 10 || !!b?.matches(':hover') || !!document.querySelector('.menu'), 'top');
      if (d?.classList.contains('show')) for (const it of d.querySelectorAll<HTMLElement>('.it')) {
        const r = it.getBoundingClientRect();
        const dx = Math.abs(e.clientX - (r.left + r.width / 2));
        it.querySelector<HTMLElement>('.ic')!.style.transform = `scale(${1 + Math.max(0, 1 - dx / 110) * 0.22})`;
      }
    };
    const unmagnify = () => dock.current?.querySelectorAll<HTMLElement>('.ic').forEach((ic) => { ic.style.transform = ''; });
    document.addEventListener('mousemove', onMove);
    dock.current?.addEventListener('mouseleave', unmagnify);
    return () => { document.removeEventListener('mousemove', onMove); clearTimeout(hideTop); clearTimeout(hideDock); };
  }, []);
}

/** Files dragged over the page show the drop zone; dropped, they go to the inbox. */
function useDrop(enabled: boolean, setShown: (on: boolean) => void, onFiles: (files: File[]) => void) {
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const files = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent) => { if (!files(e)) return; e.preventDefault(); depth++; setShown(true); };
    const over = (e: DragEvent) => { if (files(e)) e.preventDefault(); };
    const leave = () => { if (--depth <= 0) { depth = 0; setShown(false); } };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setShown(false);
      latest.current([...(e.dataTransfer?.files ?? [])]);
    };
    addEventListener('dragenter', enter);
    addEventListener('dragover', over);
    addEventListener('dragleave', leave);
    addEventListener('drop', drop);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragover', over); removeEventListener('dragleave', leave); removeEventListener('drop', drop); };
  }, [enabled]);
}
