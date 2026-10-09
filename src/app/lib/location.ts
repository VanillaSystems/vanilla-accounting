import { STATIC_EXPORT } from './api.js';
import { LOCALES, language } from '../i18n/index.js';
import { periodContaining, type Period } from '../../accounting/periods.js';

/**
 * The view's path and query (/<lang>/<period>/<tab>?q=…). With the API they are the URL's own path
 * and query. The static audit export keeps them after '#': a plain file server has no route for
 * /de/2026-Q3/vat-report, and the export must work under any base path.
 */
export function viewPath(): string {
  return STATIC_EXPORT ? hashPart().split('?')[0] || '/' : window.location.pathname;
}

export function viewParams(): URLSearchParams {
  return new URLSearchParams(STATIC_EXPORT ? hashPart().split('?')[1] ?? '' : window.location.search);
}

/** Replaces the current history entry; no-op when nothing changed. */
export function setView(path: string, params: URLSearchParams): void {
  const view = withQuery(path, params);
  if (STATIC_EXPORT) {
    if (hashPart() !== view) history.replaceState(null, '', `#${view}`);
  } else if (`${window.location.pathname}${window.location.search}` !== view) {
    history.replaceState(null, '', view);
  }
}

/** The path's parts: the language when it names one, then the period and tab segments. */
export function splitViewPath(path: string): { lang?: string; rest: string[] } {
  const parts = path.split('/').filter(Boolean);
  return LOCALES.some((l) => l.code === parts[0]) ? { lang: parts[0], rest: parts.slice(1) } : { rest: parts };
}

/** /<lang>/<period>/<tab>; the period 'all' is left out. */
export function buildViewPath(lang: string, period: string, tab: string): string {
  return period === 'all' ? `/${lang}/${tab}` : `/${lang}/${period}/${tab}`;
}

/** A link to another view in the current language, as an href that works in the export too. */
export function viewHref(tab: string, params: Record<string, string>, period = 'all'): string {
  const view = withQuery(buildViewPath(language(), period, tab), new URLSearchParams(params));
  return STATIC_EXPORT ? `#${view}` : view;
}

/**
 * Links to one item's detail view. The link keeps the current period when it holds the item's
 * date, else opens the date's quarter; an item without a date opens in 'all'.
 */
export const receiptHref = (id: string, date?: string, current?: Period) =>
  viewHref('receipts', { receipt: id }, periodContaining(date, current));

export const txHref = (ref: string, date?: string, current?: Period) =>
  viewHref('transactions', { tx: ref }, periodContaining(date, current));

export const entryHref = (id: string, date?: string, current?: Period) =>
  viewHref('journal-entries', { je: id }, periodContaining(date, current));

/** An account's Kontoauszug in the period `token` names. */
export const accountHref = (account: string, token: string) => viewHref('account-ledger', { account }, token);

/** The language the URL named when the page loaded: it wins over a stored or configured one. */
export const URL_LANGUAGE_AT_LOAD: string | undefined = splitViewPath(viewPath()).lang;

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function hashPart(): string {
  return window.location.hash.slice(1);
}
