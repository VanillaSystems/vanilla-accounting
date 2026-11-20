/**
 * A demo says that it is one (issue #343). While a demo is open (GET /api/workspace `demo`: told by
 * where the books lie, src/workspace/demo-copy.ts, never by the company's name) a quiet line along
 * the bottom names the made-up firm, says that nothing here is real, and in the Mac app leads back:
 * «Zu deiner Buchhaltung» when this Mac knows books of hers, else «Zur Startseite», which is where
 * the link goes either way. On its first opening in the Mac app, where a person comes to it from
 * the start screen, a card says what the demo shows and where to look. Card and line close with their
 * own button, and go by themselves at her first step to another area (a tester found the card «doesn't
 * go away»), remembered in this browser; the «Demo» chip in the top bar stays. Under `npm start` the
 * demo was started by its name: the line only. The line takes no click but its buttons', so nothing
 * under the page's bottom edge is out of reach.
 *
 * The public demo on the website (build:audit --demo, DEMO) says it in a bar along the top in the
 * product colour instead, in the place of the audit bar, with «App herunterladen»; its card opens on
 * the first visit too, and says that the page only shows: changing, reading receipts in and the AI
 * are the app's.
 */
import { useEffect, useRef, useState } from 'react';
import { AREAS } from '../areas/index.js';
import { START_PATH, desktop } from '../desktop/bridge.js';
import { t } from '../i18n/index.js';
import { api, DEMO } from '../lib/api.js';
import { useTopBarHeight } from './AuditBar.js';
import type { AreaId } from './route.js';
import { store, stored } from './storage.js';


/**
 * The public demo's «App herunterladen»: a page that offers the download, given to the build (build:audit --demo --download <url>),
 * since the app names no website of its own. Without one the bar has no link.
 */
const DOWNLOAD_URL: string = import.meta.env.VITE_DEMO_DOWNLOAD ?? '';

const SEEN = 'demoIntroSeen';
type LookKey = 'demo.intro.automation' | 'demo.intro.receipts' | 'demo.intro.journal' | 'demo.intro.vat';
/** Where the card points: what the app did with the receipts, a receipt with its payment, the quarter's return. */
const LOOK: ReadonlyArray<[AreaId, LookKey]> = [
  ['automation', 'demo.intro.automation'], ['receipts', 'demo.intro.receipts'], ['vat', 'demo.intro.vat'],
];
/** The public demo has no runs to show (Automatisierung needs the app): the bookings the app made instead. */
const LOOK_WEB: ReadonlyArray<[AreaId, LookKey]> = [
  ['receipts', 'demo.intro.receipts'], ['journal', 'demo.intro.journal'], ['vat', 'demo.intro.vat'],
];

/** «Ausblenden» on the line along the bottom, or her first step to another area: the line stays away in this browser. */
const BAR_HIDDEN = 'demoBarHidden';

/**
 * `area`: the area shown now. Her first step to another area is her starting to work: the card and the line
 * go by themselves then, kept so in this browser, and the top bar's «Demo» chip (DemoChip) keeps saying
 * it is a demo, with the way back. Both also close with their own button; neither covers the page after that.
 */
export function Demo({ name, href, onGo, area }: { name: string; href(id: AreaId): string; onGo(id: AreaId): void; area: AreaId }) {
  const [intro, setIntro] = useState(() => (!!desktop || DEMO) && stored(SEEN) === null);
  const [bar, setBar] = useState(() => DEMO || stored(BAR_HIDDEN) === null);
  const close = () => { store(SEEN, '1'); setIntro(false); };
  const hideBar = () => { store(BAR_HIDDEN, '1'); setBar(false); };
  const own = useOwnBooks();
  const first = useRef(area);
  useEffect(() => {
    if (area === first.current) return;
    if (intro) close();
    if (bar && !DEMO) hideBar();
  }, [area]);
  return (
    <>
      {DEMO ? <WebDemoBar name={name} /> : bar ? (
        <div className="demobar" role="status" data-testid="demo-bar">
          <span>{t('demo.bar', { name })}</span>
          {desktop ? <a href={START_PATH} data-act="demo-leave" data-own={own}>{t(own ? 'demo.toOwn' : 'aiSetup.toStart')}</a> : null}
          <button type="button" className="linkbtn" data-act="demo-bar-hide" aria-label={t('demo.hide')} onClick={hideBar}>{t('demo.hide')}</button>
        </div>
      ) : null}
      {intro ? (
        <aside className="demointro" data-testid="demo-intro" aria-label={t('demo.intro.title')}>
          <button type="button" className="demox" data-act="demo-intro-x" aria-label={t('common.close')} onClick={close}>×</button>
          <b>{t('demo.intro.title')}</b>
          <p>{t(DEMO ? 'demo.web.what' : 'demo.intro.what', { name })}</p>
          <p>{t('demo.intro.did')}</p>
          <p>{t('demo.intro.look')}</p>
          <ul>
            {(DEMO ? LOOK_WEB : LOOK).map(([id, key]) => (
              <li key={id}><a href={href(id)} onClick={(e) => { e.preventDefault(); onGo(id); }}>{t('demo.intro.item', { area: AREAS[id].label(), what: t(key) })}</a></li>
            ))}
          </ul>
          <button type="button" className="btn" data-act="demo-intro-close" onClick={close}>{t('demo.intro.close')}</button>
        </aside>
      ) : null}
    </>
  );
}

/** Whether this Mac knows books other than a demo: the link back is named by what it finds there. */
function useOwnBooks(): boolean {
  const [own, setOwn] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void api.desktop.info().then((i) => { if (live) setOwn(i.recent.some((b) => !b.demo && (!!b.name || !!b.setup))); }, () => undefined);
    return () => { live = false; };
  }, []);
  return own;
}

/**
 * The top bar's quiet, lasting sign of a demo (the app and npm start; the public demo has its bar): «Demo»,
 * what that means on hover, and in the Mac app a click back to the start page or her own books.
 */
export function DemoChip({ name }: { name: string }) {
  const own = useOwnBooks();
  const tip = t('demo.bar', { name });
  return desktop
    ? <a className="chip demochip" href={START_PATH} data-tip={`${tip} ${t(own ? 'demo.toOwn' : 'aiSetup.toStart')}`} data-testid="demo-chip">{t('demo.chip')}</a>
    : <span className="chip demochip" tabIndex={0} data-tip={tip} data-testid="demo-chip">{t('demo.chip')}</span>;
}

/**
 * The public demo's bar: in the audit bar's place along the top (its height is --audit-h, so the page starts below it, #515),
 * in the product colour, since nothing is wrong: a made-up firm, only to look at, and where to get the app.
 */
function WebDemoBar({ name }: { name: string }) {
  const bar = useRef<HTMLDivElement>(null);
  useTopBarHeight(bar);
  return (
    <div ref={bar} role="status" data-testid="demo-bar" className="auditbar webdemo">
      <span>{t('demo.web.bar', { name })}</span>
      {DOWNLOAD_URL ? <a href={DOWNLOAD_URL} data-act="demo-download">{t('demo.web.download')}</a> : null}
    </div>
  );
}
