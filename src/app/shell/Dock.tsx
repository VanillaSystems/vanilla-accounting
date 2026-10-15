import type { Index } from '../../types/index.js';
import { AREAS, DOCK } from '../areas/index.js';
import type { AreaId } from './route.js';
import { t } from '../i18n/index.js';
import { useAutomation } from '../automation/store.js';

/**
 * The areas as an activity bar down the left edge, as VS Code has it: an icon each, a badge, the
 * area's name and its G + letter in a tooltip on hover; the current area marked by a bar at the
 * edge. Holding G shows every tooltip at once.
 */
export function Dock({ current, books, keys, href, onGo }: { current: AreaId; books: Index; keys: boolean; href(area: AreaId): string; onGo(area: AreaId): void }) {
  useAutomation();
  const marked = AREAS[current].dockAs ?? current;
  return (
    <nav className={`activity${keys ? ' keys' : ''}`} aria-label={t('shell.areas')}>
      {DOCK.map((group, gi) => [
        gi > 0 && <span key={`div${gi}`} className="div" />,
        ...group.map((id) => {
          const area = AREAS[id];
          const dock = area.dock!;
          const badge = dock.badge?.(books) || '';
          return (
            <a key={id} className={`it${id === marked ? ' on' : ''}`} href={href(id)} aria-current={id === marked ? 'page' : undefined}
              aria-label={area.label()} data-k={dock.key} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onGo(id); }}>
              <span className="ic">{dock.icon}<span className="badge">{badge}</span></span>
              <span className="tip" role="tooltip"><span className="tx"><b>{area.label()}</b>{dock.tip()}</span><span className="kk"><span>G</span><span>{dock.key.toUpperCase()}</span></span></span>
            </a>
          );
        }),
      ])}
    </nav>
  );
}
