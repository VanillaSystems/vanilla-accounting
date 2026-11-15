/**
 * The amber bar of a read-only snapshot (audit mode, docs/audit-export.md). Its height, which grows when
 * its text wraps on a narrow window or at a high zoom, is --audit-h on <html>: the top bar, the corner,
 * the dock and the page start below it (shell.css), so nothing floats over its text (#515).
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { t } from '../i18n/index.js';
import { formatDate } from '../lib/utils.js';
import { ICONS } from '../areas/icons.js';
import type { AuditSnapshot } from '../../audit/sources.js';

/** Keeps --audit-h at the bar's height while it is shown: the read-only bar's, or Durchsicht's (src/app/handover/Durchsicht.tsx). */
export function useTopBarHeight(bar: RefObject<HTMLDivElement>): void {
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    // The border box in the page's own px, as the CSS that reads the variable: the box on screen undone by the zoom on <html>
    // (prefs.ts useZoom). Rounded up, since a zoom makes it fractional: a part of a pixel would lie under what follows.
    // Measured at once (a layout effect needs no frame), again on every resize (a zoom step sends one), when the fonts are in,
    // and whenever the observer sees the bar change size (its text wrapping anew).
    const measure = () => {
      const zoom = Number(root.style.zoom) || 1;
      root.style.setProperty('--audit-h', `${Math.ceil(el.getBoundingClientRect().height / zoom - 0.01)}px`);
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    addEventListener('resize', measure);
    let live = true;
    void document.fonts?.ready.then(() => { if (live) measure(); });
    return () => { live = false; seen.disconnect(); removeEventListener('resize', measure); root.style.removeProperty('--audit-h'); };
  }, [bar]);
}

export function AuditBar({ snapshot, version }: { snapshot?: AuditSnapshot; version?: { n: number; at: string; checksum: string } }) {
  const bar = useRef<HTMLDivElement>(null);
  useTopBarHeight(bar);
  const v = snapshot?.version ?? version;
  return (
    <div ref={bar} role="status" data-testid="audit-bar" className="auditbar">
      {ICONS.lock} {t('app.auditBar')}
      {v && <span data-testid="audit-version"> · {t('version.short', { n: v.n })}</span>}
      {snapshot && <span data-testid="audit-snapshot"> · {t('app.snapshot', { date: formatDate(snapshot.createdAt.slice(0, 10)), schema: snapshot.booksSchema, version: snapshot.appVersion })}</span>}
    </div>
  );
}
