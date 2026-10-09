import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { cn } from '../lib/utils.js';

interface SplitPaneProps {
  left: ReactNode;
  /** Right pane content. When falsy, the left pane fills the whole width and no divider is shown. */
  right: ReactNode | null | false;
  /** Unique key for persisting the divider position in localStorage. */
  storageKey: string;
  /** Initial left-pane width as a percentage (used when nothing is stored yet). */
  defaultLeft?: number;
  minLeft?: number;
  maxLeft?: number;
  /** Extra classes for the left pane wrapper (e.g. `overflow-auto`). */
  leftClassName?: string;
  /** Ref forwarded to the left pane wrapper (e.g. for scroll-into-view). */
  leftRef?: Ref<HTMLDivElement>;
  className?: string;
}

/**
 * Two-column layout with a draggable divider. The left pane width is remembered
 * per `storageKey`. When `right` is falsy the left pane fills the container and
 * the divider disappears (matching the old `w-[XX%] : flex-1` behaviour).
 */
export function SplitPane({
  left,
  right,
  storageKey,
  defaultLeft = 55,
  minLeft = 25,
  maxLeft = 80,
  leftClassName,
  leftRef,
  className,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const key = `splitpane:${storageKey}`;
  const [leftPct, setLeftPct] = useState<number>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    const n = saved ? parseFloat(saved) : NaN;
    return Number.isFinite(n) ? Math.min(maxLeft, Math.max(minLeft, n)) : defaultLeft;
  });
  const [dragging, setDragging] = useState(false);

  const hasRight = Boolean(right);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const onDoubleClick = useCallback(() => setLeftPct(defaultLeft), [defaultLeft]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(maxLeft, Math.max(minLeft, pct)));
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, minLeft, maxLeft]);

  // Persist once a drag settles (not on every intermediate frame).
  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(key, String(leftPct));
    } catch {
      /* ignore quota / unavailable storage */
    }
  }, [dragging, leftPct, key]);

  return (
    <div ref={containerRef} className={cn('flex-1 flex overflow-hidden relative', className)}>
      <div
        ref={leftRef}
        className={cn('flex flex-col', leftClassName, hasRight && 'border-r border-border')}
        style={hasRight ? { width: `${leftPct}%`, flex: '0 0 auto' } : { flex: '1 1 0%' }}
      >
        {left}
      </div>

      {hasRight && (
        <>
          <div
            onMouseDown={onMouseDown}
            onDoubleClick={onDoubleClick}
            role="separator"
            aria-orientation="vertical"
            title="Ziehen zum Anpassen · Doppelklick zum Zurücksetzen"
            className={cn(
              'shrink-0 w-1.5 -mx-px z-10 cursor-col-resize bg-transparent hover:bg-primary/40 transition-colors',
              dragging && 'bg-primary/60',
            )}
          />
          <div className="flex-1 flex flex-col bg-background overflow-hidden min-w-0">{right}</div>
        </>
      )}

      {/* While dragging, this overlay keeps mouse events off iframes/PDF embeds. */}
      {dragging && <div className="absolute inset-0 z-50 cursor-col-resize" />}
    </div>
  );
}
