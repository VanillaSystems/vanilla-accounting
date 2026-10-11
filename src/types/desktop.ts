/**
 * What the desktop app (src/desktop) adds to the UI: the bridge its preload exposes as
 * `window.vanilla`, and the answers of its routes under /api/desktop. In the browser
 * (`npm start`, the audit export) neither exists.
 */

/** A menu item the page carries out itself: the zoom is the page's own (src/app/shell/prefs.ts). */
export type MenuCommand = 'zoomIn' | 'zoomOut' | 'zoomReset';

export interface DesktopBridge {
  /** The folder the person picks in the system's dialog; null when cancelled. */
  chooseFolder(title: string): Promise<string | null>;
  /** Calls `listener` for each menu command; returns the unsubscribe. */
  onMenu(listener: (command: MenuCommand) => void): () => void;
  /** The UI's language, so the native menu speaks it too. */
  setLanguage(code: string): void;
}

/**
 * `window.vanillaSmoke`, only when the app was started with --vanilla-smoke (tools/desktop/smoke.mjs):
 * the native menu for a script, since the fused release build takes no --inspect.
 */
export interface SmokeBridge {
  /** The labels of the File menu and of its recent list. */
  menu(): Promise<{ file: string[]; recent: string[] }>;
  /** Clicks the menu item with this id; false when there is none. */
  click(id: string): Promise<boolean>;
  quit(): void;
}

/** Books the app knows: their folder and, when it still holds a workspace, the company's name. */
export interface KnownBooks { root: string; name?: string; demo: boolean }

/** GET /api/desktop */
export interface DesktopInfo {
  open: KnownBooks | null;
  /** Most recent first, the open books included. */
  recent: KnownBooks[];
  /** Where new books go unless the person picks another folder. */
  booksHome: string;
}
