/**
 * «Neue Buchhaltung erstellen»: the system's save panel that names the folder of new books
 * (DesktopBridge.chooseNewFolder). What the page sends is checked here; main.ts opens the panel.
 */
import { basename, join } from 'node:path';

export interface NewFolderPanel {
  title: string;
  /** macOS shows no title on a save panel: the same words stand in it as its message. */
  message: string;
  defaultPath: string;
  buttonLabel?: string;
  properties: ['createDirectory'];
  /** No Finder tags on a folder of books. */
  showsTagField: false;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The panel for `choice` (from the page, so anything): the name prefilled in `home`, never a path of the page's. */
export function newFolderPanel(choice: unknown, home: string): NewFolderPanel {
  const c = (choice !== null && typeof choice === 'object' ? choice : {}) as { title?: unknown; name?: unknown; button?: unknown };
  const title = text(c.title);
  const name = basename(text(c.name));
  const button = text(c.button);
  return {
    title,
    message: title,
    defaultPath: name && name !== '.' && name !== '..' ? join(home, name) : home,
    ...(button ? { buttonLabel: button } : {}),
    properties: ['createDirectory'],
    showsTagField: false,
  };
}

/** The folder the person named; null when they cancelled. */
export const chosenFolder = (r: { canceled: boolean; filePath?: string }): string | null => (r.canceled || !r.filePath ? null : r.filePath);
