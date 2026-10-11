/**
 * The native menu, in the UI's language (the dictionaries of src/app/i18n). Keys the page answers
 * itself (zoom) show in the menu without being taken from the page: a menu click sends the command,
 * the key still reaches the page.
 */
import type { MenuItemConstructorOptions } from 'electron';
import { formatIn } from '../app/i18n/core.js';
import type { Key, Locale } from '../app/i18n/types.js';
import de from '../app/i18n/locales/de.js';
import en from '../app/i18n/locales/en.js';
import fr from '../app/i18n/locales/fr.js';
import it from '../app/i18n/locales/it.js';
import type { KnownBooks, MenuCommand } from '../types/desktop.js';

const LOCALES: Record<string, Locale> = { de, en, fr, it };

/** The language of `code` (de-CH, fr, …), German when the app has none for it. */
export const languageOf = (code: string | undefined): string => {
  const base = code?.toLowerCase().split(/[-_]/)[0] ?? '';
  return base in LOCALES ? base : 'de';
};

export const textsIn = (language: string) => (key: Key, values: Record<string, string> = {}): string =>
  formatIn({ code: language, messages: LOCALES[language].messages }, key, values);

export interface MenuActions {
  openBooks(): void;
  newBooks(): void;
  demo(): void;
  openRecent(root: string): void;
  command(command: MenuCommand): void;
  /** Absent: no page to point to yet, and no Help menu. */
  docs?: () => void;
}

export function menuTemplate(language: string, recent: readonly KnownBooks[], actions: MenuActions, dev: boolean): MenuItemConstructorOptions[] {
  const t = textsIn(language);
  const product = 'Vanilla Accounting';
  return [
    {
      label: product,
      submenu: [
        { id: 'about', label: t('desktop.menu.about', { app: product }), click: () => actions.command('about') },
        { type: 'separator' },
        { role: 'services', label: t('desktop.menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('desktop.menu.hide', { app: product }) },
        { role: 'hideOthers', label: t('desktop.menu.hideOthers') },
        { role: 'unhide', label: t('desktop.menu.showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('desktop.menu.quit', { app: product }) },
      ],
    },
    {
      label: t('desktop.menu.file'),
      submenu: [
        { id: 'open', label: t('desktop.menu.open'), accelerator: 'CmdOrCtrl+O', click: actions.openBooks },
        { id: 'new', label: t('desktop.menu.new'), click: actions.newBooks },
        { id: 'demo', label: t('desktop.menu.demo'), click: actions.demo },
        {
          id: 'recent',
          label: t('desktop.menu.recent'),
          enabled: recent.some((b) => b.name),
          submenu: recent.filter((b) => b.name).map((b) => ({ label: b.demo ? t('desktop.demoName') : b.name!, sublabel: b.root, click: () => actions.openRecent(b.root) })),
        },
        { type: 'separator' },
        { role: 'close', label: t('desktop.menu.close') },
      ],
    },
    {
      label: t('desktop.menu.edit'),
      submenu: [
        { role: 'undo', label: t('desktop.menu.undo') },
        { role: 'redo', label: t('desktop.menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('desktop.menu.cut') },
        { role: 'copy', label: t('desktop.menu.copy') },
        { role: 'paste', label: t('desktop.menu.paste') },
        { role: 'selectAll', label: t('desktop.menu.selectAll') },
      ],
    },
    {
      label: t('desktop.menu.view'),
      submenu: [
        { id: 'zoomIn', label: t('desktop.menu.zoomIn'), accelerator: 'CmdOrCtrl+Plus', registerAccelerator: false, click: () => actions.command('zoomIn') },
        { id: 'zoomOut', label: t('desktop.menu.zoomOut'), accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => actions.command('zoomOut') },
        { id: 'zoomReset', label: t('desktop.menu.zoomReset'), accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: () => actions.command('zoomReset') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('desktop.menu.fullScreen') },
        ...(dev ? [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: t('desktop.menu.window'),
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: t('desktop.menu.minimize') },
        { role: 'zoom', label: t('desktop.menu.windowZoom') },
        { type: 'separator' },
        { role: 'front', label: t('desktop.menu.front') },
      ],
    },
    ...(actions.docs ? [{ label: t('desktop.menu.help'), role: 'help' as const, submenu: [{ label: t('desktop.menu.docs'), click: actions.docs }] }] : []),
  ];
}
