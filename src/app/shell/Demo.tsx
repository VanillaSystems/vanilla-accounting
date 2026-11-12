/**
 * A demo says that it is one (issue #343). While a demo is open (GET /api/workspace `demo`: told by
 * where the books lie, src/workspace/demo-copy.ts, never by the company's name) a quiet line along
 * the bottom names the made-up firm, says that nothing here is real, and in the Mac app leads back
 * to the person's own books. On its first opening in the Mac app, where a person comes to it from
 * the start screen, a card says what the demo shows and where to look; «Verstanden» is remembered
 * in this browser, the line stays. Under `npm start` the demo was started by its name: the line only.
 * The line takes no click but its link's, so nothing under the page's bottom edge is out of reach.
 */
import { useState } from 'react';
import { AREAS } from '../areas/index.js';
import { START_PATH, desktop } from '../desktop/bridge.js';
import { t } from '../i18n/index.js';
import type { AreaId } from './route.js';
import { store, stored } from './storage.js';

const SEEN = 'demoIntroSeen';
/** Where the card points: what the app did with the receipts, a receipt with its payment, the quarter's return. */
const LOOK: ReadonlyArray<[AreaId, 'demo.intro.automation' | 'demo.intro.receipts' | 'demo.intro.vat']> = [
  ['automation', 'demo.intro.automation'], ['receipts', 'demo.intro.receipts'], ['vat', 'demo.intro.vat'],
];

export function Demo({ name, href, onGo }: { name: string; href(id: AreaId): string; onGo(id: AreaId): void }) {
  const [intro, setIntro] = useState(() => !!desktop && stored(SEEN) === null);
  const close = () => { store(SEEN, '1'); setIntro(false); };
  return (
    <>
      <div className="demobar" role="status" data-testid="demo-bar">
        <span>{t('demo.bar', { name })}</span>
        {desktop ? <a href={START_PATH} data-act="demo-leave">{t('demo.toOwn')}</a> : null}
      </div>
      {intro ? (
        <aside className="demointro" data-testid="demo-intro" aria-label={t('demo.intro.title')}>
          <b>{t('demo.intro.title')}</b>
          <p>{t('demo.intro.what', { name })}</p>
          <p>{t('demo.intro.did')}</p>
          <p>{t('demo.intro.look')}</p>
          <ul>
            {LOOK.map(([id, key]) => (
              <li key={id}><a href={href(id)} onClick={(e) => { e.preventDefault(); onGo(id); }}>{AREAS[id].label()}</a>: {t(key)}</li>
            ))}
          </ul>
          <button type="button" className="btn" data-act="demo-intro-close" onClick={close}>{t('demo.intro.close')}</button>
        </aside>
      ) : null}
    </>
  );
}
