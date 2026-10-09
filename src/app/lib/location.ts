import { STATIC_EXPORT } from './api.js';

/**
 * The view's path and query (/<period>/<tab>?q=…). With the API they are the URL's own path and
 * query. The static audit export keeps them after '#': a plain file server has no route for
 * /2026-Q3/vat-report, and the export must work under any base path.
 */
export function viewPath(): string {
  return STATIC_EXPORT ? hashPart().split('?')[0] || '/' : window.location.pathname;
}

export function viewParams(): URLSearchParams {
  return new URLSearchParams(STATIC_EXPORT ? hashPart().split('?')[1] ?? '' : window.location.search);
}

/** Replaces the current history entry; no-op when nothing changed. */
export function setView(path: string, params: URLSearchParams): void {
  const qs = params.toString();
  const view = qs ? `${path}?${qs}` : path;
  if (STATIC_EXPORT) {
    if (hashPart() !== view) history.replaceState(null, '', `#${view}`);
  } else if (`${window.location.pathname}${window.location.search}` !== view) {
    history.replaceState(null, '', view);
  }
}

const hashPart = () => window.location.hash.slice(1);
