/**
 * The amber bar of a read-only snapshot (audit mode, docs/audit-export.md). Its height, which grows when
 * its text wraps on a narrow window or at a high zoom, is --audit-h on <html>: the top bar, the corner,
 * the dock and the page start below it (shell.css), so nothing floats over its text (#515).
 */
import { useLayoutEffect, useRef } from 'react';
import { t } from '../i18n/index.js';
import { formatDate } from '../lib/utils.js';
import { ICONS } from '../areas/icons.js';
import type { AuditSnapshot } from '../../audit/sources.js';

export function AuditBar({ snapshot }: { snapshot?: AuditSnapshot }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    // The border box in the page's own px, as the CSS that reads the variable (the zoom on <html> scales both alike); rounded up,
    // since a zoom makes it fractional and offsetHeight rounds it down: a part of a pixel would lie under what follows.
    const set = (h: number) => root.style.setProperty('--audit-h', `${Math.ceil(h)}px`);
    set(el.offsetHeight);
    const seen = new ResizeObserver(([e]) => set(e.borderBoxSize[0]?.blockSize ?? el.offsetHeight));
    seen.observe(el);
    return () => { seen.disconnect(); root.style.removeProperty('--audit-h'); };
  }, []);
  return (
    <div ref={bar} role="status" data-testid="audit-bar" className="auditbar">
      {ICONS.lock} {t('app.auditBar')}
      {snapshot && <span data-testid="audit-snapshot"> · {t('app.snapshot', { date: formatDate(snapshot.createdAt.slice(0, 10)), schema: snapshot.booksSchema, version: snapshot.appVersion })}</span>}
    </div>
  );
}
