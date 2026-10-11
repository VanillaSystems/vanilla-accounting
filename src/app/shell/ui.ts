import { createContext, useContext } from 'react';
import type { Theme } from './prefs.js';
import type { Palette } from '../brand/palette.js';
import type { DialogConfig } from '../areas/export/state.js';
import type { Area } from '../areas/index.js';
import type { Route } from './route.js';

/**
 * What the shell offers the pages inside it: the area open now, its overlays and the viewer's
 * preferences. Shell components an area renders read the area here, not from the registry: an
 * area importing the registry back would be an import cycle, and Vite's HMR fails on it.
 */
export interface ShellUi {
  area: Area;
  route: Route;
  openPeriod(anchor: HTMLElement): void;
  /** The current area's add action (the add button and N). */
  add(): void;
  /** The export dialog; without a config, preset for the page (⇧E). */
  openExport(config?: DialogConfig): void;
  theme: Theme;
  setTheme(theme: Theme): void;
  /** The page is dark now (the preference, or the OS under System). */
  dark: boolean;
  /** The colour test while the brand red is being judged (prefs.ts). */
  palette: Palette;
  setPalette(palette: Palette): void;
  zoom: number;
  language: string;
}

export const ShellUiContext = createContext<ShellUi | null>(null);

export function useShellUi(): ShellUi {
  const ui = useContext(ShellUiContext);
  if (!ui) throw new Error('useShellUi outside the shell');
  return ui;
}
