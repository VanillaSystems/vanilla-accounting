/**
 * The app's frame: list and detail with the divider, the top bar and the dock at the edges, the
 * ⌘K palette, the toast, the key legend and the drop zone; the URL in step with all of it.
 * Areas own only their list, detail and keys (docs/redesign/architecture.md §3).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { localToday, booksOpenPeriod, dataPeriod, filingKeyOf, parsePeriod, type Period } from '../../accounting/periods.js';
import { AREAS, DOCK, areaOf, type Area, type AreaProps, type LegendItem, type Nav, type PaletteItem } from '../areas/index.js';
import { useIndex } from '../hooks/use-index.js';
import type { Index } from '../../types/index.js';
import { useApiStatus } from '../hooks/use-api-status.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { FxProvider } from '../hooks/use-fx.js';
import { LOCALES, t, tWith } from '../i18n/index.js';
import { periodName } from '../lib/period-label.js';
import { formatDate } from '../lib/utils.js';
import { ICONS } from '../areas/icons.js';
import { Dock } from './Dock.js';
import { hrefOf, useLocationState } from './history.js';
import { DropDialog, closeDrop, dropFiles, dropOpen } from './DropDialog.js';
import { INTAKE, watchRuns, watchSteps } from '../automation/intake.js';
import { STATIC_EXPORT } from '../lib/api.js';
import { noTitleBar } from '../desktop/bridge.js';
import { Demo } from './Demo.js';
import { ExportDialog } from '../areas/export/ExportDialog.js';
import { configOf, ownConfig, presetFor, type DialogConfig } from '../areas/export/config.js';
import { ownPresets } from '../areas/export/state.js';
import { PRESETS } from '../../export/model.js';
import { accountOfRoute } from '../areas/reports/view.js';
import { focusSelectedRow, useShellKeys } from './keyboard.js';
import { Menu } from './Menu.js';
import { Palette, type PaletteGroup } from './Palette.js';
import { PeriodPicker } from './PeriodPicker.js';
import { nextTheme, useNavWide, usePersistedFlag, useTheme, useZoom, type Theme } from './prefs.js';
import { AREA_HOME, type AreaId, type Query, type Route } from './route.js';
import { useInvoicesLoaded } from '../areas/invoices/data.js';
import { Split, useListWidth } from './Split.js';
import { useToast } from './Toast.js';
import { VatCards } from '../areas/codes/vat-card.js';
import { TopBar } from './TopBar.js';
import { Corner } from './Corner.js';
import { Sidebar } from './Sidebar.js';
import { pageContext, selectionContext } from '../assistant/context.js';
import { attachDropped, keepPage, onBooksChanged, syncSidebarWidth, toggleAssistant, useAssistant } from '../assistant/store.js';
import { CHAT_TAKES, PAGE_TAKES, droppedFiles, leftOut } from '../lib/folder-drop.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { ShellUiContext, type ShellUi } from './ui.js';
import { filing } from '../../engines/index.js';
import { clearSelection, selectAll, selectionNow, useSelection } from '../selection/store.js';
import { actionsNow, openActions } from '../selection/ActionsMenu.js';

type Overlay =
  | { kind: 'palette' }
  | { kind: 'period'; anchor: DOMRect }
  | { kind: 'language'; anchor: DOMRect }
  | { kind: 'export'; config: DialogConfig };

interface ShellProps { language: string; onLanguage(code: string): void }

/** Waits for the books and their jurisdiction (/modules.json): no area computes before both are there. */
export function Shell(props: ShellProps) {
  const { data, loading, error, refresh } = useIndex();
  if (loading || error) {
    return (
      <main className="full">
        <div className="detail-empty">{loading ? t('app.loading') : <div><p>{t('app.loadFailed')}</p><p>{t('app.loadFailedHint')}</p><p>{error}</p></div>}</div>
      </main>
    );
  }
  return <Workbench {...props} books={data} refresh={refresh} />;
}

function Workbench({ language, onLanguage, books, refresh }: ShellProps & { books: Index; refresh(): void }) {
  const { online, readonly, snapshot } = useApiStatus();
  const canEdit = online && !readonly;
  const workspace = useWorkspace();
  const [loc, go] = useLocationState();
  const [theme, setTheme, dark] = useTheme();
  const [zoom, zoomStep] = useZoom();
  const { toast, note, dismiss: dismissToast, undo, node: toastNode } = useToast(() => go({ route: { area: 'company', section: 'ai' }, query: {} }));
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [dockKeys, setDockKeys] = useState(false);
  const [legend, setLegend] = usePersistedFlag('legend', true);
  const [navWide, toggleNav] = useNavWide();
  const [dropping, setDropping] = useState<DropTarget | null>(null);
  const aiOpen = useAssistant().open;

  const area = areaOf(loc.route);
  // Without a period in the link, a page shows where the newest data is (F10), its own rows outside the books included.
  // An area may name another home (the return: the oldest period not filed that holds something, #341).
  useInvoicesLoaded();
  const latestOf = (route: Route) => areaOf(route).home?.(books, localToday()) ?? dataPeriod(books, localToday(), filing().length, areaOf(route).newest?.());
  const latest = latestOf(loc.route);
  const latestNow = useRef(latestOf);
  latestNow.current = latestOf;
  const period = loc.query.period ?? latest;

  const current = useRef(loc);
  current.current = loc;
  const nav: Nav = useMemo(() => ({
    // urls.md: the period of the newest data is left out of a link.
    go: (loc) => go(loc.query.period?.token === latestNow.current(loc.route).token ? { ...loc, query: { ...loc.query, period: undefined } } : loc),
    select: (route) => go({ route, query: current.current.query }),
    setQuery: (patch) => {
      const query: Query = { ...current.current.query, ...patch };
      if (query.period?.token === latest.token) delete query.period;
      for (const k of Object.keys(query) as Array<keyof Query>) if (query[k] === undefined) delete query[k];
      // Two patches in one event (a chip added and the search cleared) both hold: the next one builds on this one.
      current.current = { ...current.current, query };
      go({ route: current.current.route, query });
    },
    toast,
    dismissToast,
    refresh,
  }), [go, toast, dismissToast, refresh, latest.token]);

  /** Where dropped files landed: the area's list in that period, its first row selected (the one shown before may not be in it). */
  const showLanded = (next: Period) => {
    if (!area.periodless) nav.go({ route: AREA_HOME[area.id], query: { ...current.current.query, period: next } });
  };

  const props: AreaProps = { route: loc.route, query: loc.query, period, books, nav, canEdit };
  const propsRef = useRef(props);
  propsRef.current = props;

  // On a phone one column shows at a time (shell.css `html.phone`): a tap on a row opens the detail, «←» or the dock the list (r8c-8).
  const [phoneColumn, setPhoneColumn] = useState<'list' | 'detail'>('list');
  const goArea = useCallback((id: AreaId) => {
    const { route, query } = current.current;
    setPhoneColumn('list');
    if (route.area === id) return;
    go({ route: AREA_HOME[id], query: query.period ? { period: query.period } : {} });
  }, [go]);

  const cycleTheme = () => {
    const next = nextTheme(theme, matchMedia('(prefers-color-scheme: dark)').matches);
    setTheme(next);
    const name = t(next === 'light' ? 'app.themeLight' : next === 'dark' ? 'app.themeDark' : 'app.themeSystem');
    const before = theme;
    toast(t('shell.themeSet', { theme: next === 'system' ? t('shell.themeFollows', { theme: name }) : name }), () => setTheme(before));
  };
  const toggleTheme = () => setTheme(dark ? 'light' : 'dark');
  const runAdd = () => { if (area.add && canEdit) area.add.run(propsRef.current); };

  // The palette's search keeps the first render's closure: the open quarter is read from the props of now.
  const openNow = () => booksOpenPeriod(propsRef.current.books, localToday(), filing().length);
  const openExport = (config?: DialogConfig) => {
    const { route, period } = propsRef.current;
    setOverlay({ kind: 'export', config: config ?? presetFor(route, period, openNow()) });
  };

  const ui: ShellUi = {
    area: area as Area,
    route: loc.route,
    openPeriod: (anchor) => setOverlay({ kind: 'period', anchor: anchor.getBoundingClientRect() }),
    add: runAdd,
    openExport,
    theme, setTheme, dark, zoom, language,
  };

  // The runs write the books on the server; they are loaded again when a run comes to rest.
  const reload = useRef(refresh);
  reload.current = refresh;
  useEffect(() => onBooksChanged(() => reload.current()), []);
  const noteRef = useRef(note);
  noteRef.current = note;
  useEffect(() => (STATIC_EXPORT ? undefined : watchRuns((run) => {
    reload.current();
    if (run.workflow !== INTAKE) return;
    if (run.status === 'done') noteRef.current(t('intake.finished'));
    else toast(t('intake.note.error', { detail: run.error ?? run.status }));
  })), [toast]);
  useEffect(() => (STATIC_EXPORT ? undefined : watchSteps(() => reload.current())), []);

  useShellKeys({
    overlayOpen: () => overlay !== null || dropOpen(),
    closeOverlay: () => { if (dropOpen()) closeDrop(); setOverlay(null); focusSelectedRow(); },
    palette: () => setOverlay({ kind: 'palette' }),
    // ⌘Z with nothing left to take back says so instead of doing nothing (r8k-7).
    undo: () => { if (!undo()) toast(t('shell.nothingToUndo')); return true; },
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
    assistant: toggleAssistant,
    toggleNav,
    selectAll: () => !!area.selects && selectAll(area.selects, toast),
    unselect: () => { if (!selectionNow()) return false; clearSelection(); focusSelectedRow(); return true; },
    actions: () => !overlay && openActions(),
  });
  useLayoutEffect(syncSidebarWidth, []);
  // A selection belongs to its list: another area starts with none (#216).
  useEffect(clearSelection, [loc.route.area]);
  // The chat carries the picked rows as its chip; a new selection is a new reference, shown again after the chip was taken off.
  const picked = useSelection();
  const pickedKey = picked?.ids.join(',');
  useEffect(() => { if (pickedKey) keepPage(); }, [pickedKey]);

  // urls.md rule 6: the tab names the object.
  useEffect(() => {
    document.title = [area.title(loc.route, books), area.label()].filter(Boolean).join(' · ');
  }, [area, loc.route, books, language]);

  // The keyboard stays on the selected row as the selection moves.
  useLayoutEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a.classList.contains('row')) focusSelectedRow();
  }, [loc.route]);

  const listRef = useRef<HTMLElement>(null);
  const [listWidth, setListWidth] = useListWidth(loc.route.area);

  // The drop dialog takes every drop, a folder's files with its subfolders' (#188); the Bank area keeps its own, where the open account places a statement.
  useDrop(canEdit, setDropping, (files, target, entries) => {
    if (target === 'chat') return void droppedFiles(entries, files, CHAT_TAKES).then(attachDropped);
    void droppedFiles(entries, files, PAGE_TAKES).then((d) => {
      const note = leftOut(d, PAGE_TAKES).map((x) => tWith(x.key, x.vars)).join(' ');
      if (!area.drop || dropOpen()) return void dropFiles(d.files, note);
      if (note) toast(note);
      area.drop.run(d.files, propsRef.current);
    });
  });

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
      ...(add && p.canEdit ? [{ label: add.title(p.route), side: 'N', run: () => add.run(p) }] : []),
      report('income', t('tab.incomeStatement')),
      report('balance', t('tab.balanceSheet')),
      report('trial', t('tab.trialBalance')),
      { label: t('area.codes'), side: t('shell.lookup'), run: () => goArea('codes') },
      { label: t('export.paletteAction'), side: '⇧E', run: () => openExport() },
      ...PRESETS.map((x) => ({ label: t('export.palettePreset', { name: t(`export.preset.${x.id}`) }), side: t('export.paletteBuiltin'), run: () => openExport(configOf(x.id, openNow(), p.period)) })),
      ...ownPresets().map((x) => ({ label: t('export.palettePreset', { name: x.name }), side: t('export.paletteOwn'), run: () => openExport(ownConfig(x)) })),
      { label: t('shell.themeToggle'), side: 'T', run: toggleTheme },
      { label: t('dock.navToggle'), side: '⌘B', run: toggleNav },
    ].filter(hit);
    const areas: PaletteItem[] = DOCK.flat().map((id) => ({ label: AREAS[id].label(), side: `G ${AREAS[id].dock!.key.toUpperCase()}`, run: () => goArea(id) })).filter(hit);
    // The Aktionen of what is open or picked (#216), first: the A key's menu, by name.
    const here: PaletteItem[] = actionsNow().map((a) => ({ label: a.label, side: a.key, run: a.run })).filter(hit);
    return [[t('actions.palette'), here], ...objects, [t('shell.actions'), actions], [t('shell.areas'), areas]].filter(([, xs]) => xs.length > 0) as PaletteGroup[];
  }, [go, goArea]);

  // The filing periods that hold payments: quarters, or half years on a half-yearly setup (r6f-29).
  const quarters = useMemo(() => {
    const qs = new Set<string>();
    for (const tx of books.transactions) qs.add(filingKeyOf(tx.date, filing().length));
    return [...qs].sort().reverse();
  }, [books.transactions]);

  const legendItems: LegendItem[] = area.legend?.() ?? [
    ...(area.Detail ? [[['↑', '↓'], t('keys.select'), t('keys.selectTip')] as LegendItem] : []),
    ...(area.add && canEdit ? [[['N'], t('keys.new'), area.add.title(loc.route)] as LegendItem] : []),
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
      <FxProvider index={books}>
        {Detail && !area.fullPage?.(loc.route) ? (
          <main data-area={loc.route.area} data-phone={phoneColumn} style={mainStyle}>
            <section className="list" id="list" ref={listRef} aria-label={area.label()} onClickCapture={(e) => { if ((e.target as HTMLElement).closest?.('.row')) setPhoneColumn('detail'); }}><List {...props} /></section>
            <section className="detail" aria-live="polite">
              <button type="button" className="phoneback" onClick={() => setPhoneColumn('list')}>← {area.label()}</button>
              <Detail {...props} />
            </section>
            <Split list={listRef} width={listWidth} onWidth={setListWidth} />
          </main>
        ) : (
          <main className="full" id="list" data-area={loc.route.area}><List {...props} /></main>
        )}
        <VatCards {...props} />
      </FxProvider>

      <TopBar
        hold={overlay !== null && overlay.kind !== 'palette'}
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
      <Sidebar page={picked ? selectionContext(picked) : pageContext(loc.route, books)} books={books} onGo={(route) => nav.go({ route, query: {} })} />
      <DropDialog books={books} refresh={refresh} period={period} onGo={(loc) => nav.go(loc)} onLanded={showLanded} />
      <Corner onAssistant={toggleAssistant} onGo={(route) => nav.go({ route, query: {} })} />
      <Dock current={loc.route.area} books={books} keys={dockKeys} wide={navWide} onToggle={toggleNav} nav={nav} canEdit={canEdit} href={(id) => hrefOf({ route: AREA_HOME[id], query: {} })} onGo={goArea} />
      {workspace?.demo ? <Demo name={workspace.company.name} href={(id) => hrefOf({ route: AREA_HOME[id], query: {} })} onGo={goArea} /> : null}
      {toastNode}
      {legend && (
        <div className="legend">
          {t('shell.edges')}<br />
          {legendItems.map(([keys, label, tip]) => (
            <span key={label} className="item"><span className="k" data-tip={tip}>{keys.map((k) => <span key={k} className="cap">{k}</span>)}</span>{label}</span>
          ))}
        </div>
      )}
      <div className={`drop${dropping ? ' show' : ''}${dropping === 'page' ? ' on' : ''}`} aria-hidden="true" data-testid="drop-page">
        <div className="box"><div>
          {ICONS.upload}
          <h2>{area.drop ? t('drop.title') : t('drop.page')}</h2>
          <p>{area.drop?.text() ?? t('drop.text')}</p>
          <p style={{ marginTop: 4, fontSize: 12.5, color: 'var(--faint)' }}>{area.drop?.formats() ?? t('drop.formats')}</p>
        </div></div>
      </div>
      <div className={`dropchat${dropping ? ' show' : ''}${dropping === 'chat' ? ' on' : ''}${aiOpen ? '' : ' edge'}`} aria-hidden="true" data-testid="drop-chat">
        <div className="box"><div>
          <BotIcon />
          <h2>{t(aiOpen ? 'drop.chat' : 'drop.ai')}</h2>
          {aiOpen ? <p>{t('drop.chatText')}</p> : null}
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
          account={loc.route.area === 'reports' && loc.route.report !== 'custom' ? accountOfRoute(loc.route) : undefined}
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
          onApply={(token) => {
            setOverlay(null);
            const next = parsePeriod(token, localToday()) ?? undefined;
            if (area.periodRows) nav.go({ route: AREA_HOME[area.id], query: { ...loc.query, period: next } });
            else nav.setQuery({ period: next });
          }}
        />
      )}
    </ShellUiContext.Provider>
  );
}

/** Where dragged files go: the page takes them as receipts, the AI sidebar (or, closed, the window's right edge) as a message's attachments. */
type DropTarget = 'page' | 'chat';
/** The width of the «An die KI» edge while the sidebar is closed; shell.css --ai-edge says the same. */
const AI_EDGE = 88;

/**
 * Files dragged over the window show the two drop zones, the one under the pointer lit; dropped, they go where it says.
 * `entries` are the drop's items as entries, read while the event lasts: a folder is one, to walk later.
 */
function useDrop(enabled: boolean, setShown: (on: DropTarget | null) => void, onFiles: (files: File[], target: DropTarget, entries: (FileSystemEntry | null)[]) => void) {
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const files = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const target = (e: DragEvent): DropTarget => e.clientX >= (document.querySelector('aside.aside')?.getBoundingClientRect().left ?? innerWidth - AI_EDGE) ? 'chat' : 'page';
    const enter = (e: DragEvent) => { if (!files(e)) return; e.preventDefault(); depth++; setShown(target(e)); };
    const over = (e: DragEvent) => { if (files(e)) { e.preventDefault(); setShown(target(e)); } };
    const leave = () => { if (--depth <= 0) { depth = 0; setShown(null); } };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setShown(null);
      const entries = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.() ?? null);
      latest.current([...(e.dataTransfer?.files ?? [])], target(e), entries);
    };
    addEventListener('dragenter', enter);
    addEventListener('dragover', over);
    addEventListener('dragleave', leave);
    addEventListener('drop', drop);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragover', over); removeEventListener('dragleave', leave); removeEventListener('drop', drop); };
  }, [enabled]);
}
