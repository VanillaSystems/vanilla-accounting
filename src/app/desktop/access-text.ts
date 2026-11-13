/**
 * What the person reads when the app may not read a folder (issue #373), in the page and in the
 * main process's dialogs alike: macOS refused it (allowed again in System Settings), or the
 * folder's own rights do (changed in the Finder). `say` is t() or textsIn(language).
 */
import type { NoAccess } from '../../types/desktop.js';

export type AccessKey = 'desktop.access.refused' | 'desktop.access.refusedOther' | 'desktop.access.rights' | `desktop.access.folder.${Exclude<NoAccess['folder'], 'other'>}`;
type Say = (key: AccessKey, vars: Record<string, string>) => string;

export function accessText(say: Say, no: NoAccess, root: string): string {
  if (no.why === 'rights') return say('desktop.access.rights', { name: root.split('/').filter(Boolean).pop() ?? root });
  return no.folder === 'other' ? say('desktop.access.refusedOther', {}) : say('desktop.access.refused', { folder: say(`desktop.access.folder.${no.folder}`, {}) });
}
