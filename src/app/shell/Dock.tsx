import type { Index } from '../../types/index.js';
import { AREAS, DOCK } from '../areas/index.js';
import type { AreaId } from './route.js';
import { t } from '../i18n/index.js';
import { useAutomation } from '../automation/store.js';
import { useQuestions } from '../questions/store.js';

/** The area that is the app's promise: a big round button at the top, wider than the dock. */
const HERO: AreaId = 'automation';

/**
 * The areas as an activity bar down the left edge, as VS Code has it: an icon each, a badge, the
 * area's name and its G + letter in a tooltip on hover; the current area marked by a bar at the
 * edge. Holding G shows every tooltip at once. Automatisierung stands above them as a round
 * button: its ring turns while a run is going, its count is what waits for the person.
 */
export function Dock({ current, books, keys, href, onGo }: { current: AreaId; books: Index; keys: boolean; href(area: AreaId): string; onGo(area: AreaId): void }) {
  const { view } = useAutomation();
  // The hero's badge counts the questions waiting for the viewer too: a new one shows at once.
  useQuestions();
  const marked = AREAS[current].dockAs ?? current;
  const hero = AREAS[HERO];
  const running = !!view?.runs.some((r) => r.status === 'running' || r.status === 'queued');
  const waiting = hero.dock?.badge?.(books) || 0;
  const click = (id: AreaId) => (e: React.MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onGo(id); };
  return (
    <nav className={`activity${keys ? ' keys' : ''}`} aria-label={t('shell.areas')}>
      <a className={`it go${HERO === marked ? ' on' : ''}${running ? ' running' : ''}`} href={href(HERO)} aria-current={HERO === marked ? 'page' : undefined}
        aria-label={hero.label()} data-k={hero.dock!.key} onClick={click(HERO)}>
        <svg className="ring" viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="34" /></svg>
        <span className="face">{hero.dock!.icon}</span>
        {waiting ? <span className="cnt">{waiting}</span> : null}
        <span className="tip" role="tooltip"><span className="tx"><b>{hero.label()}</b>{running ? t('dock.running') : hero.dock!.tip()}</span><span className="kk"><span>G</span><span>{hero.dock!.key.toUpperCase()}</span></span></span>
      </a>
      {DOCK.map((group, gi) => [
        gi > 0 && <span key={`div${gi}`} className="div" />,
        ...group.filter((id) => id !== HERO).map((id) => {
          const area = AREAS[id];
          const dock = area.dock!;
          const badge = dock.badge?.(books) || '';
          return (
            <a key={id} className={`it${id === marked ? ' on' : ''}`} href={href(id)} aria-current={id === marked ? 'page' : undefined}
              aria-label={area.label()} data-k={dock.key} onClick={click(id)}>
              <span className="ic">{dock.icon}<span className="badge">{badge}</span></span>
              <span className="tip" role="tooltip"><span className="tx"><b>{area.label()}</b>{dock.tip()}</span><span className="kk"><span>G</span><span>{dock.key.toUpperCase()}</span></span></span>
            </a>
          );
        }),
      ])}
    </nav>
  );
}
