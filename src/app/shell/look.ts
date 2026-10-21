/** What the top bar's theme and zoom controls decide, apart from the page (so tests can run it). */

export type Theme = 'system' | 'light' | 'dark';

/**
 * The ◐ button's next theme. The first click leaves «System» for the appearance the OS does not
 * have, so it always shows a change; the second goes to the OS's own, the third back to System.
 */
export function nextTheme(theme: Theme, osDark: boolean): Theme {
  const opposite: Theme = osDark ? 'light' : 'dark';
  if (theme === 'system') return opposite;
  return theme === opposite ? (osDark ? 'dark' : 'light') : 'system';
}

/** Below this many page pixels the top bar drops its extras and the shortcut legend hides. */
export const TIGHT_BELOW = 1040;
/** The narrow dock's width (shell.css --abw), which TIGHT_BELOW counts in. */
const NARROW_DOCK = 52;
/** `besides`: what the dock and the AI sidebar take of the window, in page pixels; a wide dock or an open sidebar leaves the top bar less room. */
export const tight = (windowWidth: number, zoom: number, besides = NARROW_DOCK): boolean => windowWidth / zoom - besides < TIGHT_BELOW - NARROW_DOCK;

/** Below this many page pixels the page is as narrow as a phone: one column, the dock along the bottom (shell.css `html.phone`, r8c-8). */
export const PHONE_BELOW = 600;
export const phone = (windowWidth: number, zoom: number): boolean => windowWidth / zoom < PHONE_BELOW;

export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6] as const;
