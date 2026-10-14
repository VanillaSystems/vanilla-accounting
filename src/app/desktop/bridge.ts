import type { DesktopBridge } from '../../types/desktop.js';

declare global {
  interface Window { vanilla?: DesktopBridge }
}

/** The desktop app's bridge (src/desktop/preload.ts); undefined in a browser. */
export const desktop: DesktopBridge | undefined = typeof window === 'undefined' ? undefined : window.vanilla;

/** The Mac app has no title bar: the page reaches the window's top edge (src/desktop/main.ts). */
export const noTitleBar = !!desktop && /Mac/.test(navigator.userAgent);

/** The start screen shows at /start, and whenever the desktop app has no books open. */
export const START_PATH = '/start';
