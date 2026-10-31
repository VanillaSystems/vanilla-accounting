/**
 * The dock narrow (icons) or wide (icon and name per row): a per-viewer preference in this
 * browser, narrow by default. The class on <html> sets --abw (shell.css), which main, the top
 * bar's centre and the AI sidebar follow; index.html sets it before the first paint.
 */
import { store, stored } from './storage.js';

export const NAV_WIDE_KEY = 'nav.wide';
export const NAV_WIDE_CLASS = 'navwide';

export const navWideStored = (): boolean => stored(NAV_WIDE_KEY) === '1';

export function keepNavWide(wide: boolean): void {
  store(NAV_WIDE_KEY, wide ? '1' : null);
}
