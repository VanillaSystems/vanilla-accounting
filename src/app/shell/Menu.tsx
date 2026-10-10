import { useLayoutEffect, useRef, type ReactNode } from 'react';

export interface MenuItem { label: ReactNode; side?: ReactNode; current?: boolean; run(): void }

/** A short list under its anchor (the language menu): ↑/↓ move, Enter picks, Esc or a click outside closes. */
export function Menu({ anchor, items, onClose }: { anchor: DOMRect; items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const m = ref.current!;
    // The anchor's rect is in zoomed pixels, the menu's position in page pixels.
    const z = Number(document.documentElement.style.zoom) || 1;
    m.style.left = `${Math.max(16, Math.min(anchor.left / z, innerWidth / z - m.offsetWidth - 16))}px`;
    m.style.top = `${anchor.bottom / z + 6}px`;
    (m.querySelector<HTMLElement>('.cur') ?? m.querySelector<HTMLElement>('button'))?.focus();
  }, [anchor]);

  function onKeyDown(e: React.KeyboardEvent) {
    const buttons = [...ref.current!.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    buttons[(i + d + buttons.length) % buttons.length].focus();
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="menu" role="menu" ref={ref} onKeyDown={onKeyDown}>
        {items.map((it, i) => (
          <button key={i} type="button" role="menuitem" className={it.current ? 'cur' : ''} onClick={() => { onClose(); it.run(); }}>
            {it.label}<span className="s">{it.side}</span>
          </button>
        ))}
      </div>
    </>
  );
}
