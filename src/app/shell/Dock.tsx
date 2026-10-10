import { forwardRef } from 'react';
import type { Index } from '../../types/index.js';
import { AREAS, DOCK } from '../areas/index.js';
import type { AreaId } from './route.js';
import { t } from '../i18n/index.js';

/** The areas at the bottom edge: an icon, its label, a badge, and a tooltip with its G + letter. */
export const Dock = forwardRef<HTMLElement, { current: AreaId; books: Index; keys: boolean; href(area: AreaId): string; onGo(area: AreaId): void }>(
  function Dock({ current, books, keys, href, onGo }, ref) {
    const marked = AREAS[current].dockAs ?? current;
    return (
      <nav className={`dock${keys ? ' keys show' : ''}`} ref={ref} aria-label={t('shell.areas')}>
        {DOCK.map((group, gi) => [
          gi > 0 && <span key={`div${gi}`} className="div" />,
          ...group.map((id) => {
            const area = AREAS[id];
            const dock = area.dock!;
            const badge = dock.badge?.(books) || '';
            return (
              <a key={id} className={`it${id === marked ? ' on' : ''}`} href={href(id)} aria-current={id === marked ? 'page' : undefined}
                data-k={dock.key} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onGo(id); }}>
                <span className="ic">{dock.icon}<span className="badge">{badge}</span></span>
                <span className="lb">{area.label()}</span>
                <span className="tip" role="tooltip"><span className="tx">{dock.tip()}</span><span className="kk"><span>G</span><span>{dock.key.toUpperCase()}</span></span></span>
              </a>
            );
          }),
        ])}
      </nav>
    );
  },
);
