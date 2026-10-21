import { useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import type { Index } from '../../types/index.js';
import { AREAS, DOCK, type Nav } from '../areas/index.js';
import { ICONS } from '../areas/icons.js';
import type { AreaId, Location } from './route.js';
import { hrefOf } from './history.js';
import { language, t } from '../i18n/index.js';
import { periodName } from '../lib/period-label.js';
import { errorText } from '../lib/api.js';
import { automationCommand, useAutomation } from '../automation/store.js';
import { commandRefusalText } from '../automation/refusal.js';
import { askedRuns, homeFigures } from '../automation/home.js';
import { dockWidget, RUN_NOW, type DockWidget, type WidgetFigure } from '../automation/widget.js';
import { useQuestions } from '../questions/store.js';
import { forMe } from '../../questions/model.js';
import { whenText } from '../areas/automation/Home.js';
import { booksOpenPeriod, localToday, type Period } from '../../accounting/periods.js';
import { chargesVat, filing } from '../../engines/index.js';
import { stepOf, textIn, type AutomationView } from '../../workflows/model.js';

const AUTOMATION: AreaId = 'automation';

const HOME: Location = { route: { area: 'automation', view: 'home' }, query: {} };
const TASKS: Location = { route: { area: 'automation', view: 'tasks' }, query: {} };
const runAt = (run: string): Location => ({ route: { area: 'automation', view: 'run', run }, query: {} });

const figure = (f: WidgetFigure) => (f.key === 'withoutYou' ? `${f.pct} %` : String(f.n));
const figureLabel = (f: WidgetFigure) => (f.key === 'withoutYou' ? t('dock.fig.withoutYou') : t(`dock.fig.${f.key}`, { n: f.n }));
const cardLabel = (f: WidgetFigure) => (f.key === 'withoutYou' ? t('dock.fig.withoutYou') : t(`dock.card.${f.key}`, { n: f.n }));

interface Words {
  /** The state word after the title in the wide bar. */
  word: string;
  /** What is happening now, in the summary card. */
  now: string;
  workflow(id: string): string;
}

function wordsOf(w: DockWidget, view: AutomationView | undefined, now: Date): Words {
  const workflow = (id: string) => { const d = view?.workflows.find((x) => x.id === id); return d ? textIn(d.label, language()) : id; };
  const step = w.run?.at ? view?.workflows.find((x) => x.id === w.run!.workflow) : undefined;
  const stepLabel = step && w.run?.at ? stepOf(step, w.run.at)?.label : undefined;
  // Before the automation is loaded nothing is known about runs or schedules: the card says nothing about them.
  const nowLine = !w.loaded ? ''
    : w.run ? t('dock.now.running', { what: [workflow(w.run.workflow), stepLabel ? textIn(stepLabel, language()) : ''].filter(Boolean).join(' · ') })
    : w.paused ? t('dock.now.paused')
    : w.next ? t('dock.now.next', { when: whenText(w.next.at, now), workflow: workflow(w.next.workflow) })
    : t('dock.now.none');
  const word = w.run ? t('dock.word.running')
    : w.waiting ? t('dock.word.waiting', { n: w.waiting })
    : w.paused ? t('dock.word.paused')
    : w.next ? whenText(w.next.at, now)
    : '';
  return { word, now: nowLine, workflow };
}

/**
 * The areas as an activity bar down the left edge, as VS Code has it: an icon each, the area's
 * name and its G + letter in a tooltip on hover (narrow) or the name beside the icon (wide); the
 * current area marked by a bar at the edge. Holding G shows every key at once. An area that needs
 * the person carries a quiet dot, its count in the tooltip. Automatisierung is the widget at the
 * foot: the open period's figures, what waits for the person, and a summary card on click.
 */
export function Dock({ current, books, keys, wide, onToggle, nav, canEdit, href, onGo }: {
  current: AreaId; books: Index; keys: boolean; wide: boolean; onToggle(): void; nav: Nav; canEdit: boolean;
  href(area: AreaId): string; onGo(area: AreaId): void;
}) {
  const { view } = useAutomation();
  const q = useQuestions();
  const marked = AREAS[current].dockAs ?? current;
  const today = localToday();
  const period = booksOpenPeriod(books, today, filing().length);
  const figures = useMemo(
    () => homeFigures(books, { key: period.token, from: period.from, to: period.to }, { today, vatRegistered: chargesVat(), dueDays: filing().dueDays }, view ? askedRuns(view) : undefined),
    [books, view, period.token, today],
  );
  const now = new Date();
  const w = dockWidget(figures, view, forMe(q.questions, q.me).length, now);
  const words = wordsOf(w, view, now);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);

  const click = (id: AreaId) => (e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onGo(id); };
  const goTo = (loc: Location) => (e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); setOpen(false); nav.go(loc); };
  const [starting, setStarting] = useState(false);
  const runNow = async () => {
    setOpen(false);
    opener.current?.focus();
    setStarting(true);
    const workflow = words.workflow(RUN_NOW);
    try {
      const r = await automationCommand({ kind: 'start', workflow: RUN_NOW, item: { kind: 'company', id: 'company' } });
      if (!r.ok) nav.toast(r.refusal === 'not-approved' ? t('marks.waitsSwitchOn', { workflow }) : t('marks.refused', { workflow, why: commandRefusalText(r) }));
      else nav.toast(t('dock.started', { workflow }));
    } catch (e) { nav.toast(errorText(e)); } finally { setStarting(false); }
  };
  const runnable = w.canRun && canEdit;
  const busyRunNow = starting || w.run?.workflow === RUN_NOW;

  const tipLines = [w.stack.map((f) => `${figure(f)} ${figureLabel(f)}`).join(' · '), words.now];
  const stack = w.stack.map((f) => (
    <span key={f.key} className={`n ${f.key}`}><b>{figure(f)}</b><span>{figureLabel(f)}</span></span>
  ));
  const action = w.state === 'waiting' ? { label: t('dock.answer', { n: w.waiting }), go: TASKS }
    : w.run ? { label: t('dock.showRun'), go: runAt(w.run.id) }
    : runnable ? { label: t('dock.runNow'), run: true }
    : { label: t('dock.openAutomation'), go: HOME };

  return (
    <nav className={`activity${keys ? ' keys' : ''}`} aria-label={t('shell.areas')}>
      {DOCK.map((group, gi) => [
        gi > 0 && <span key={`div${gi}`} className="div" />,
        ...group.map((id) => {
          const area = AREAS[id];
          const dock = area.dock!;
          if (id === AUTOMATION) {
            // A phone has no room for the widget: Automatisierung stays an item of the bottom bar, with what waits.
            return (
              <a key={id} className={`it bolt${id === marked ? ' on' : ''}`} href={href(id)} aria-current={id === marked ? 'page' : undefined}
                aria-label={w.waiting ? `${area.label()}, ${t('dock.ask', { n: w.waiting })}` : area.label()} onClick={click(id)}>
                <span className="ic">{dock.icon}{w.waiting ? <span className="cnt">{w.waiting}</span> : null}</span>
              </a>
            );
          }
          const count = dock.badge?.(books) || 0;
          const pending = count ? t('dock.pending', { n: count }) : '';
          return (
            <a key={id} className={`it${id === marked ? ' on' : ''}`} href={href(id)} aria-current={id === marked ? 'page' : undefined}
              aria-label={pending ? `${area.label()}, ${pending}` : area.label()} data-k={dock.key} onClick={click(id)}>
              <span className="ic">{dock.icon}{count ? <span className="mark" /> : null}</span>
              <span className="nm">{area.label()}</span>
              <span className="tip" role="tooltip"><span className="tx"><b>{area.label()}</b>{dock.tip()}{pending ? <span className="op">{pending}</span> : null}</span><span className="kk"><span>G</span><span>{dock.key.toUpperCase()}</span></span></span>
            </a>
          );
        }),
      ])}
      <div className={`autow ${w.state}${w.waiting ? ' asks' : ''}${AUTOMATION === marked ? ' on' : ''}`} data-testid="dock-widget">
        <button ref={opener} type="button" className="wopen" aria-expanded={open} aria-haspopup="dialog" data-k={AREAS[AUTOMATION].dock!.key}
          aria-label={`${AREAS[AUTOMATION].label()}: ${tipLines.join('. ')}`} onClick={() => setOpen(!open)}>
          {wide ? (
            <>
              <span className="wtitle"><span className="trig">{ICONS.automation}</span>{AREAS[AUTOMATION].label()}{words.word ? <em>{words.word}</em> : null}</span>
              <span className="figrow">{stack}</span>
            </>
          ) : (
            <>
              {stack}
              <span className="trig">{ICONS.automation}</span>
            </>
          )}
          <span className="tip" role="tooltip"><span className="tx"><b>{AREAS[AUTOMATION].label()}</b>{tipLines.map((l) => <span key={l}>{l}</span>)}</span><span className="kk"><span>G</span><span>{AREAS[AUTOMATION].dock!.key.toUpperCase()}</span></span></span>
        </button>
        {wide ? (
          'run' in action
            ? <button type="button" className="wbtn" disabled={busyRunNow} onClick={() => void runNow()}>{PLAY}{action.label}</button>
            : <a className={`wbtn${w.state === 'waiting' ? ' ask' : ''}`} href={hrefOf(action.go)} onClick={goTo(action.go)}>{action.label}</a>
        ) : null}
      </div>
      <button type="button" className="navtoggle" aria-expanded={wide} aria-label={t(wide ? 'dock.collapse' : 'dock.expand')} onClick={onToggle}>
        {wide ? ICONS.left : ICONS.right}
        <span className="tip" role="tooltip"><span className="tx"><b>{t(wide ? 'dock.collapse' : 'dock.expand')}</b></span><span className="kk"><span>⌘</span><span>B</span></span></span>
      </button>
      {open ? (
        <SummaryCard opener={opener} w={w} words={words} period={period} onClose={() => setOpen(false)}
          runnable={runnable} explain={w.loaded && canEdit && !w.canRun} busy={busyRunNow} onRun={() => void runNow()} goTo={goTo} />
      ) : null}
    </nav>
  );
}

const PLAY = <svg className="play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>;

function SummaryCard({ opener, w, words, period, onClose, runnable, explain, busy, onRun, goTo }: {
  opener: RefObject<HTMLButtonElement>; w: DockWidget; words: Words; period: Period;
  onClose(): void; runnable: boolean; explain: boolean; busy: boolean; onRun(): void; goTo(loc: Location): (e: MouseEvent) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.querySelector<HTMLElement>('a[href], button:not(:disabled)')?.focus();
    const onKey = (e: KeyboardEvent) => {
      // The palette or a dialog opened over the card takes its own Escape first.
      if (e.key !== 'Escape' || document.querySelector('.palette, .scrim')) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      opener.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!card.current?.contains(at) && !opener.current?.contains(at)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true); };
  }, []);
  return (
    <div ref={card} className={`autocard ${w.state}`} role="dialog" aria-label={t('area.automation')} data-testid="dock-card">
      <header>{ICONS.automation}<b>{t('area.automation')}</b><span>{periodName(period)}</span></header>
      {words.now ? <div className="now"><span className="ndot" />{words.now}</div> : null}
      <div className="figs">
        {w.card.map((f) => <div key={f.key}><b>{figure(f)}</b><span>{cardLabel(f)}</span></div>)}
      </div>
      {w.waiting ? <a className="ask" href={hrefOf(TASKS)} onClick={goTo(TASKS)}>{t('dock.ask', { n: w.waiting })}{ICONS.right}</a> : null}
      <footer>
        {runnable
          ? <button type="button" className="btn primary" disabled={busy} onClick={onRun}>{PLAY}{t('dock.runNow')}</button>
          : null}
        <a className="btn ghost" href={hrefOf(HOME)} onClick={goTo(HOME)}>{t('dock.openAutomation')}</a>
      </footer>
      {runnable ? <p className="m">{t('dock.runNowTip', { workflow: words.workflow(RUN_NOW) })}</p> : explain ? <p className="m">{t('dock.noRunNow')}</p> : null}
    </div>
  );
}
