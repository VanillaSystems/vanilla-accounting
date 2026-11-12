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

/** The page's two columns at their narrowest (shell.css --list-min, --detail-min, issue #34): the list compact, the detail still readable. */
export const LIST_MIN = 280;
export const DETAIL_MIN = 420;

/**
 * What the page keeps beside the wide setup conversation before that narrows to its least: the list and the detail with
 * room to read (at 1440 pixels the page gets these 820, the setup 568). Only then does the page go down to its narrowest (#342).
 */
export const PAGE_BESIDE_SETUP = 820;

/**
 * The AI sidebar's width, wanted and at the least, in page pixels: 400 (34 % of a small window), the setup conversation
 * about twice that (a card with its evidence fits). `page`: what the sidebar leaves the page while it is wider than its least.
 */
export interface SidebarWidths { want: number; least: number; page?: number }
export const sidebarWidths = (windowWidth: number, setup: boolean): SidebarWidths =>
  setup ? { want: Math.min(760, windowWidth * 0.52), least: 520, page: PAGE_BESIDE_SETUP } : { want: Math.min(400, windowWidth * 0.34), least: 320 };

/**
 * Where the open AI sidebar goes, given the `room` the dock leaves (page pixels): beside the page, narrowed down to
 * its least while the page keeps its list and its detail at their narrowest; with less room it lies over the page's
 * right edge at its least, and the page keeps the window (⌘J or its arrow closes it). A sidebar that names a `page`
 * width yields to it first: it is wider than its least only with what the page does not need.
 */
export function sidebarFit(room: number, { want, least, page = LIST_MIN + DETAIL_MIN }: SidebarWidths): { width: number; over: boolean } {
  const atLeast = Math.min(least, want);
  const beside = Math.min(want, Math.max(room - page, Math.min(atLeast, room - LIST_MIN - DETAIL_MIN)));
  return beside >= atLeast ? { width: beside, over: false } : { width: atLeast, over: true };
}

export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6] as const;
