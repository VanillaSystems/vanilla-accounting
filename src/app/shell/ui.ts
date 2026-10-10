import { createContext, useContext } from 'react';
import type { Theme } from './prefs.js';

/** What the shell offers the pages inside it: its overlays and the viewer's preferences. */
export interface ShellUi {
  openPeriod(anchor: HTMLElement): void;
  /** The current area's add action (the add button and N). */
  add(): void;
  theme: Theme;
  setTheme(theme: Theme): void;
  /** The page is dark now (the preference, or the OS under System). */
  dark: boolean;
  zoom: number;
  language: string;
}

export const ShellUiContext = createContext<ShellUi | null>(null);

export function useShellUi(): ShellUi {
  const ui = useContext(ShellUiContext);
  if (!ui) throw new Error('useShellUi outside the shell');
  return ui;
}
