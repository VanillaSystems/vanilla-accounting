import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { t } from '../i18n/index.js';
import { store, stored } from './storage.js';
import type { AreaId } from './route.js';

const MIN = 340;
const zoom = () => Number(document.documentElement.style.zoom) || 1;
const clamp = (w: number) => Math.min(Math.max(MIN, innerWidth / zoom() - 560), Math.max(MIN, w));

/**
 * The list column's width: drag the divider, ←/→ while it has focus, double-click resets.
 * Each area keeps its own width, per viewer in this browser. Returns the width for main's --lw.
 */
export function useListWidth(area: AreaId): [number | null, (w: number | null, save?: boolean) => void] {
  const key = `lw.${area}`;
  const [width, setWidth] = useState<number | null>(() => Number(stored(key)) || null);
  useEffect(() => setWidth(Number(stored(key)) || null), [key]);
  const set = (w: number | null, save = false) => {
    const next = w === null ? null : clamp(w);
    setWidth(next);
    if (save) store(key, next === null ? null : String(Math.round(next)));
  };
  return [width === null ? null : clamp(width), set];
}

export function Split({ list, width, onWidth }: { list: RefObject<HTMLElement>; width: number | null; onWidth(w: number | null, save?: boolean): void }) {
  const [left, setLeft] = useState(0);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const place = () => setLeft(list.current?.offsetWidth ?? 0);
    place();
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  });

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => onWidth(ev.clientX / zoom());
    const up = () => {
      el.removeEventListener('pointermove', move);
      setDragging(false);
      document.body.classList.remove('resizing');
      onWidth(list.current?.offsetWidth ?? null, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
  }

  return (
    <div
      className={`split${dragging ? ' drag' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('shell.split')}
      aria-valuenow={Math.round(width ?? left)}
      title={t('shell.split')}
      tabIndex={0}
      style={{ left }}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onWidth(null, true)}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowLeft' ? -24 : e.key === 'ArrowRight' ? 24 : 0;
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        onWidth((list.current?.offsetWidth ?? 0) + d, true);
      }}
    />
  );
}
