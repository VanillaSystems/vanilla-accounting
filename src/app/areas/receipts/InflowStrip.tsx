/**
 * How receipts come into Belege (docs/0.4.0/mockups/receipt-inflow): with no receipt yet, the three
 * ways as cards and the empty table beside them; once receipts are there, three slim rows above the
 * list: drop, the phone, and the automatic collection with its last run. State as fact, never a
 * reminder; processing runs by itself (src/server/background.ts), so no button starts it here.
 */
import { cloneElement, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { api, errorText } from '../../lib/api.js';
import { language, t } from '../../i18n/index.js';
import { desktop } from '../../desktop/bridge.js';
import { hrefOf } from '../../shell/history.js';
import { store, stored } from '../../shell/storage.js';
import { automationCommand, useAutomation } from '../../automation/store.js';
import { commandRefusalText } from '../../automation/refusal.js';
import { askFrom } from '../../assistant/cue.js';
import { BotIcon } from '../automation/Graph.js';
import { ICONS } from '../icons.js';
import { Go } from '../vat/links.js';
import { statementAdd } from '../bank/actions.js';
import type { Location } from '../../shell/route.js';
import type { AreaProps } from '../index.js';
import type { SourcesView } from '../../../platform/sources/model.js';
import { COLLECTION, collectRunOf, coverageOf, phoneWayOf, sourceChips, type CollectRun, type PhoneWay, type SourceChip } from './inflow.js';
import { loadPhone, openInflow, switchPhone, useInflow } from './inflow-state.js';
import { pollInbox, useUi } from './state.js';
import { useIntakeRunning } from '../../automation/intake.js';
import { intakeAdd } from './intake.js';

const svg = (d: ReactNode) => <svg className="i" viewBox="0 0 24 24" aria-hidden="true">{d}</svg>;
export const W = {
  down: svg(<path d="M12 4v12M6 10l6 6 6-6M4 20h16" />),
  phone: svg(<><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>),
  /** The automation area's own lightning (the dock's), in the strip's size. */
  automation: cloneElement(ICONS.automation, { className: 'i' }),
  bank: svg(<path d="M3 10h18M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18M12 3l9 5H3z" />),
  mail: svg(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>),
  fwd: svg(<><path d="M15 5l6 6-6 6" /><path d="M21 11H9a6 6 0 0 0-6 6v2" /></>),
  folder: svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  laptop: svg(<><rect x="4" y="5" width="16" height="11" rx="1" /><path d="M2 19h20" /></>),
  globe: svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>),
  link: svg(<><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>),
  key: svg(<><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3" /></>),
  shop: svg(<><path d="M4 7h16l-1 13H5z" /><path d="M9 7a3 3 0 0 1 6 0" /></>),
  print: svg(<path d="M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z" />),
  archive: svg(<><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11h14V8M10 12h4" /></>),
  check: svg(<path d="M5 12l5 5 9-10" />),
  chev: <svg className="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>,
};

/** The pictures of the three ways, drawn in the tokens' strokes (the mockup's). */
const ILL = {
  drop: (
    <svg className="ill" viewBox="0 0 120 84" aria-hidden="true">
      <rect x="18" y="58" width="84" height="18" rx="5" className="ill-tray" />
      <path d="M30 58v8h60v-8" className="ill-line" />
      <g className="ill-float"><rect x="44" y="6" width="32" height="40" rx="3" className="ill-paper" /><path d="M50 16h20M50 22h20M50 28h12" className="ill-line" /><text x="60" y="41" className="ill-tag">PDF</text></g>
      <path d="M60 47v8m-4-4 4 4 4-4" className="ill-accent" />
    </svg>
  ),
  phone: (
    <svg className="ill" viewBox="0 0 120 84" aria-hidden="true">
      <rect x="8" y="8" width="34" height="66" rx="6" className="ill-paper" />
      <rect x="15" y="18" width="20" height="30" rx="2" className="ill-tray" /><path d="M19 24h12M19 29h12M19 34h8" className="ill-line" />
      <circle cx="25" cy="62" r="5" className="ill-accentfill" />
      <path d="M52 40c6-6 14-6 20 0M56 45c4-3 8-3 12 0" className="ill-accent ill-pulse" />
      <rect x="80" y="22" width="34" height="24" rx="3" className="ill-paper" /><path d="M76 50h42" className="ill-line" />
      <path d="M90 30h14M90 35h10" className="ill-line" />
    </svg>
  ),
  auto: (
    <svg className="ill" viewBox="0 0 120 84" aria-hidden="true">
      <rect x="6" y="10" width="30" height="20" rx="3" className="ill-paper" /><path d="m6 12 15 10 15-10" className="ill-line" />
      <path d="M6 44h10l3 4h17v16H6z" className="ill-paper" />
      <rect x="84" y="24" width="30" height="38" rx="4" className="ill-tray" /><path d="M91 34h16M91 40h16M91 46h10" className="ill-line" />
      <path d="M40 20c18 0 22 14 40 16M40 54c18 0 22-10 40-12" className="ill-accent ill-dash" />
      <path d="M58 6l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" className="ill-ai" />
    </svg>
  ),
};

/** The setup request the AI gets from «Mit KI einrichten», in the person's language. */
export const askSetup = (e: MouseEvent<HTMLElement>) => void askFrom(e.currentTarget, t('inflow.aiAsk'), 'collection-setup');

/** No receipt in the books yet: the three ways in, and why a bank statement helps. */
export function FirstRun(props: AreaProps) {
  return (
    <div className="firstrun" data-testid="inflow-firstrun">
      <h2>{t('inflow.title')}</h2>
      <p>{t('inflow.lead')}</p>
      <div className="ways3">
        <div className="way3 dropway">
          {ILL.drop}
          <div><b>{t('inflow.drop')}</b><span>{t('inflow.dropText')}</span><button type="button" className="aiact" onClick={() => intakeAdd.run(props)}>{t('inflow.pick')}</button></div>
        </div>
        <div className="way3">
          {ILL.phone}
          <div><b>{t('inflow.phone')}</b><span>{t('inflow.phoneText')}</span><button type="button" className="aiact" onClick={() => openInflow({ kind: 'pair', step: 'install' })}>{W.phone}{t('inflow.pair')}</button></div>
        </div>
        <div className="way3 rec">
          {ILL.auto}
          <div>
            <b>{t('area.automation')}</b><span>{t('inflow.autoText')}</span>
            <span className="btns">
              <button type="button" className="aiact primary" data-testid="inflow-ai" onClick={askSetup}><BotIcon />{t('inflow.withAi')}</button>
              <button type="button" className="linkbtn" onClick={() => openInflow({ kind: 'add' })}>{t('inflow.byHand')}</button>
            </span>
          </div>
        </div>
      </div>
      <div className="banknote">{W.bank}<span>{t('inflow.bankNote')} <button type="button" className="linkbtn" onClick={() => statementAdd.run(props)}>{t('inflow.bankImport')}</button></span></div>
    </div>
  );
}

/** The detail column while there is no receipt: an empty table, and where receipts will show. */
export function EmptyTable() {
  const ghost = (w1: number, w2: number) => <div className="gr" key={`${w1}-${w2}`}><i style={{ width: 56 }} /><i style={{ width: `${w1}%` }} /><i className="r" style={{ width: w2 }} /></div>;
  return (
    <div className="detail-empty">
      <div className="emptyph" data-testid="inflow-empty">
        <div className="ghost">{[[46, 52], [62, 44], [38, 60], [54, 48], [42, 56], [58, 40]].map(([a, b]) => ghost(a, b))}</div>
        <div className="msgph">
          <svg className="ill tray" viewBox="0 0 64 56" aria-hidden="true"><rect x="18" y="4" width="28" height="30" rx="2" className="ill-paper dashed" /><path d="M24 13h16M24 19h16M24 25h9" className="ill-line" /><path d="M6 34h14l4 7h16l4-7h14v14a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z" className="ill-tray" /></svg>
          <b>{t('inflow.emptyTitle')}</b>
          <span>{t('inflow.emptyText')}</span>
        </div>
      </div>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A run's time: «heute 14:02», else «16.10. 14:02». */
export function whenText(iso: string): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? t('inflow.today', { time }) : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${time}`;
}

function runLine(run: CollectRun): string {
  switch (run.kind) {
    case 'never': return t('inflow.run.never');
    case 'running': return t('inflow.run.running');
    case 'done': return run.failed ? t('inflow.run.failed', { failed: run.failed, of: run.of }) : t('inflow.run.ok', { when: whenText(run.at) });
  }
}

const PHONE_LINE: Record<PhoneWay, 'inflow.phone.never' | 'inflow.phone.on' | 'inflow.phone.off' | 'inflow.phone.browser' | undefined> = {
  loading: undefined, browser: 'inflow.phone.browser', never: 'inflow.phone.never', off: 'inflow.phone.off', on: 'inflow.phone.on',
};

/** A source's chip: its name, how often it fetches, when it last did, and what it needs from a person. */
const chipText = (c: SourceChip) => [
  c.label,
  ...c.every.map((e) => t(`sources.every.${e}` as 'sources.every.daily')),
  ...(c.last ? [t('inflow.src.last', { when: whenText(c.last) })] : []),
  ...(c.warn ? [t(`inflow.src.${c.warn}` as 'inflow.src.login')] : []),
].join(' · ');

const OPEN_KEY = 'receipts.inflowOpen';
const runAt = (run: string): Location => ({ route: { area: 'automation', view: 'run', run }, query: {} });

/** The three rows above the list of receipts, and what opens under «Automatisch». */
export function Strip(props: AreaProps) {
  const { nav, books, period } = props;
  const { view } = useAutomation();
  const { phone } = useInflow();
  const { inbox } = useUi();
  const [open, setOpen] = useState(stored(OPEN_KEY) === '1');
  const [sources, setSources] = useState<SourcesView>();
  const run = useMemo(() => collectRunOf(view?.runs ?? []), [view]);
  const restKey = run.kind === 'done' ? run.run : run.kind;
  const intake = useIntakeRunning();
  useEffect(() => { void loadPhone(); }, []);
  // Files that arrive while the page is open (the phone, a mailbox) start the inbox's run: read the inbox again then.
  useEffect(() => { if (intake) void pollInbox(nav.refresh); }, [intake]);
  useEffect(() => { api.sources().then(setSources, () => setSources(undefined)); }, [restKey]);

  const way = phoneWayOf(phone, !!desktop);
  const chips = sources ? sourceChips(sources, view?.runs ?? [], language()) : [];
  // No source at all: the row offers the setup, nothing else; no run and no coverage to state.
  const none = sources?.rows.length === 0;
  const cover = coverageOf(books, period);
  const reading = inbox.filter((f) => !f.failed).length;
  const waiting = view?.tasks.length ?? 0;
  const toggle = () => { setOpen(!open); store(OPEN_KEY, open ? null : '1'); };

  async function fetchNow() {
    const workflow = t('inflow.fetch');
    try {
      const r = await automationCommand({ kind: 'start', workflow: COLLECTION, item: { kind: 'company', id: 'company' } });
      if (!r.ok) nav.toast(r.refusal === 'not-approved' ? t('marks.waitsSwitchOn', { workflow }) : t('marks.refused', { workflow, why: commandRefusalText(r) }));
    } catch (e) { nav.toast(errorText(e)); }
  }
  async function phoneOn() {
    try { await switchPhone(true); nav.toast(t('inflow.phoneSwitchedOn')); } catch (e) { nav.toast(errorText(e)); }
  }
  // Buchungen with the chip «Beleg: fehlt» (#211): the payments of the period still waiting for theirs.
  const missingAt: Location = { route: { area: 'journal' }, query: { period: props.query.period, chips: [{ field: 'receipt', value: 'missing' }] } };
  function missing(e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    nav.go(missingAt);
  }

  const line = PHONE_LINE[way];
  const phoneText = (
    <>
      {W.phone}
      <span className="stx"><b>{way === 'never' ? t('inflow.pair') : t('inflow.phoneRow')}</b>{line ? <small><i className="pd" />{t(line)}</small> : null}</span>
      <span className="go">{t(way === 'off' ? 'inflow.go.switchOn' : way === 'on' ? 'inflow.go.open' : way === 'browser' ? 'inflow.go.how' : 'inflow.go.pair')}</span>
    </>
  );
  const dots = chips.map((c) => <span key={c.id} className={`sd${c.warn ? ' warn' : ''}`} data-tip={c.label} />);
  return (
    <section className={`ways3s${open ? ' open' : ''}`} aria-label={t('inflow.title')} data-testid="inflow-strip">
      <div className="segs">
        <button type="button" className="seg dz" data-tip={t('inflow.dropRow')} onClick={() => intakeAdd.run(props)}>
          {W.down}<span className="stx"><b>{t('inflow.drop')}</b><small>{t('inflow.dropRow')}</small></span>
        </button>
        {way === 'on'
          ? <Go to={{ route: { area: 'company', section: 'phone' }, query: {} }} nav={nav} className="seg phone on">{phoneText}</Go>
          : <button type="button" className={`seg phone ${way}`} data-testid="inflow-phone" onClick={() => (way === 'off' ? void phoneOn() : openInflow({ kind: 'pair', step: 'install' }))}>{phoneText}</button>}
        <div className={`seg auto ${none ? 'none' : run.kind === 'done' ? (run.failed ? 'fail' : 'ok') : run.kind}`}>
          <button type="button" className="segmain" aria-expanded={open} data-testid="inflow-auto" onClick={toggle}>
            {W.automation}
            <span className="stx"><b>{t('area.automation')}{dots.length ? <span className="sdots">{dots}</span> : null}</b><small className="rl">{none ? t('inflow.noSourceYet') : <>{run.kind === 'running' ? <span className="spin small" /> : null}{runLine(run)}</>}</small></span>
            {W.chev}
          </button>
          {none
            ? <button type="button" className="aiact fetchbtn" data-testid="inflow-setup" onClick={askSetup}><BotIcon />{t('inflow.setUp')}</button>
            : <button type="button" className="aiact fetchbtn" data-testid="inflow-fetch" disabled={run.kind === 'running'} data-tip={t('inflow.fetchTip')} onClick={() => void fetchNow()}>{t('inflow.fetch')}</button>}
        </div>
      </div>
      {reading ? <div className="sline"><span className="spin small" />{t('inflow.reading', { n: reading })}</div>
        : waiting ? <div className="sline"><Go to={{ route: { area: 'automation', view: 'tasks' }, query: {} }} nav={nav} className="linkbtn waiting">{t('inflow.waiting', { n: waiting })}</Go></div>
          : null}
      {open ? (
        <div className="more" data-testid="inflow-more">
          {chips.length ? (
            <div className="chans">
              {chips.map((c) => (
                <Go key={c.id} to={c.run && c.warn !== 'login' && c.warn !== 'pending' ? runAt(c.run) : { route: { area: 'company', section: 'sources' }, query: {} }} nav={nav} className={`chan${c.warn ? ' warn' : ''}`}>
                  {W.mail}<i className="cdot" /><span className="ct">{chipText(c)}</span>
                </Go>
              ))}
            </div>
          ) : <p className="nosrc">{t('inflow.noSources')}</p>}
          {cover.total && !none ? (
            <div className="cover">
              <span>{t('inflow.coverage', { covered: cover.covered, total: cover.total })}</span>
              <span className="bar"><i style={{ width: `${Math.round((100 * cover.covered) / cover.total)}%` }} /></span>
              {cover.total > cover.covered ? <a className="linkbtn" href={hrefOf(missingAt)} onClick={missing}>{t('inflow.missing', { n: cover.total - cover.covered })}</a> : null}
            </div>
          ) : null}
          <div className="links">
            {run.kind !== 'never' && !none ? <Go to={runAt(run.run)} nav={nav} className="linkbtn">{t('inflow.lastRun', { when: run.kind === 'done' ? whenText(run.at) : t('inflow.run.running') })}</Go> : null}
            <button type="button" className="linkbtn" data-testid="inflow-add" onClick={() => openInflow({ kind: 'add' })}>{W.plus}{t('inflow.addWay')}</button>
            <button type="button" className="linkbtn" onClick={() => openInflow({ kind: 'all' })}>{t('inflow.allWays')}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
