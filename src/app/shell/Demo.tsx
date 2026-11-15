/**
 * A demo says that it is one (issue #343). While a demo is open (GET /api/workspace `demo`: told by
 * where the books lie, src/workspace/demo-copy.ts, never by the company's name) a quiet line along
 * the bottom names the made-up firm, says that nothing here is real, and in the Mac app leads back:
 * «Zu deiner Buchhaltung» when this Mac knows books of hers, else «Zur Startseite», which is where
 * the link goes either way. On its first opening in the Mac app, where a person comes to it from
 * the start screen, a card says what the demo shows and where to look; «Verstanden» is remembered
 * in this browser, the line stays. Under `npm start` the demo was started by its name: the line only.
 * The line takes no click but its link's, so nothing under the page's bottom edge is out of reach.
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

export function Demo({ name, href, onGo }: { name: string; href(id: AreaId): string; onGo(id: AreaId): void }) {
  const [intro, setIntro] = useState(() => (!!desktop || DEMO) && stored(SEEN) === null);
  const close = () => { store(SEEN, '1'); setIntro(false); };
  /** Whether this Mac knows books other than a demo: the link back is named by what it finds there. */
  const [own, setOwn] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void api.desktop.info().then((i) => { if (live) setOwn(i.recent.some((b) => !b.demo && (!!b.name || !!b.setup))); }, () => undefined);
    return () => { live = false; };
  }, []);
  return (
    <>
      {DEMO ? <WebDemoBar name={name} /> : (
        <div className="demobar" role="status" data-testid="demo-bar">
          <span>{t('demo.bar', { name })}</span>
          {desktop ? <a href={START_PATH} data-act="demo-leave" data-own={own}>{t(own ? 'demo.toOwn' : 'aiSetup.toStart')}</a> : null}
        </div>
      )}
      {intro ? (
        <aside className="demointro" data-testid="demo-intro" aria-label={t('demo.intro.title')}>
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
