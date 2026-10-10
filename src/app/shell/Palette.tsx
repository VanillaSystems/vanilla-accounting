import { useMemo, useState } from 'react';
import type { PaletteItem } from '../areas/index.js';
import { t } from '../i18n/index.js';

export type PaletteGroup = [name: string, items: PaletteItem[]];

/** ⌘K: one field finds objects, actions and areas; ↑/↓ choose, Enter runs, Esc closes. */
export function Palette({ search, onClose }: { search(query: string): PaletteGroup[]; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const groups = useMemo(() => search(query.toLowerCase().trim()), [search, query]);
  const items = groups.flatMap(([, xs]) => xs);
  const at = Math.min(idx, items.length - 1);

  function run(item: PaletteItem | undefined) {
    if (!item) return;
    onClose();
    item.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((at + 1) % items.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((at - 1 + items.length) % items.length); }
    if (e.key === 'Enter') { e.preventDefault(); run(items[at]); }
  }

  let k = 0;
  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 40%, transparent)' }} onClick={onClose} />
      <div className="palette" role="dialog" aria-label={t('shell.palette')}>
        <input
          autoFocus
          value={query}
          placeholder={t('shell.palettePlaceholder')}
          aria-label={t('shell.search')}
          onChange={(e) => { setQuery(e.target.value); setIdx(0); }}
          onKeyDown={onKeyDown}
        />
        <div className="res" role="listbox">
          {items.length === 0 && <div className="gh">{t('shell.paletteNone')}</div>}
          {groups.map(([name, xs]) => (
            <div key={name}>
              <div className="gh">{name}</div>
              {xs.map((x) => {
                const i = k++;
                return (
                  <div key={i} className={`o${i === at ? ' on' : ''}`} role="option" aria-selected={i === at} onMouseMove={() => i !== at && setIdx(i)} onClick={() => run(x)}>
                    <span>{x.label}</span><span className="r">{x.side}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
