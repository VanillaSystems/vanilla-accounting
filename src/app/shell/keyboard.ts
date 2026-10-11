/**
 * The keyboard model of the mockup. Typing in a field never triggers it. The shell's own keys:
 * ⌘K palette, G + letter area, N add, T light/dark, ⇧E export, / search, ? key help, ⌘Z undo,
 * Esc back to the list; ↑/↓ and J/K belong to the area (moveKey), ⌘+/⌘−/⌘0 to the zoom (prefs.ts).
 */
import { useEffect, useRef } from 'react';

/** ↓ or J: the next row; ↑ or K: the previous one. */
export function moveKey(e: KeyboardEvent): -1 | 1 | 0 {
  if (e.metaKey || e.ctrlKey || e.altKey) return 0;
  if (e.key === 'ArrowDown' || e.key === 'j') return 1;
  if (e.key === 'ArrowUp' || e.key === 'k') return -1;
  return 0;
}

export interface ShellKeys {
  /** An overlay (palette, menu, period picker) is open: it owns the keys but Esc. */
  overlayOpen(): boolean;
  closeOverlay(): void;
  palette(): void;
  undo(): boolean;
  /** The dock's letters; G shows them, the letter goes there. */
  area(letter: string): boolean;
  showDockKeys(on: boolean): void;
  add(): boolean;
  /** The area's own keys; true when handled. */
  areaKeys(e: KeyboardEvent): boolean;
  toggleTheme(): void;
  toggleLegend(): void;
  /** ⇧E: the export dialog, preset for the page. */
  exportOpen(): void;
}

const plain = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey;

export function useShellKeys(keys: ShellKeys) {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    let gPending: ReturnType<typeof setTimeout> | undefined;
    const endG = () => { clearTimeout(gPending); gPending = undefined; ref.current.showDockKeys(false); };

    function onKey(e: KeyboardEvent) {
      const k = ref.current;
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest?.('input, textarea, select, [contenteditable]');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); k.palette(); return; }
      if (k.overlayOpen()) {
        if (e.key === 'Escape') { e.preventDefault(); k.closeOverlay(); }
        return;
      }
      if (typing) {
        if (e.key === 'Escape') { target!.blur(); focusSelectedRow(); }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && k.undo()) { e.preventDefault(); return; }
      if (gPending && plain(e) && /^[a-z]$/.test(e.key)) { endG(); if (k.area(e.key)) e.preventDefault(); return; }
      if (plain(e) && e.shiftKey && e.key === 'E') { e.preventDefault(); k.exportOpen(); return; }
      if (k.areaKeys(e)) { e.preventDefault(); return; }
      if (!plain(e)) return;
      switch (e.key) {
        case 'n': case 'N': if (k.add()) e.preventDefault(); break;
        case 'g': case 'G': gPending = setTimeout(endG, 2200); k.showDockKeys(true); break;
        case 't': case 'T': k.toggleTheme(); break;
        case '?': k.toggleLegend(); break;
        case '/': {
          const field = document.querySelector<HTMLInputElement>('main input[type="search"], main .search input, main input[placeholder]');
          if (field) { e.preventDefault(); field.focus(); }
          break;
        }
        case 'Escape': if (document.querySelector('.detail')?.contains(document.activeElement)) focusSelectedRow(); break;
      }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); clearTimeout(gPending); };
  }, []);
}

/** The keyboard's place in a list: the selected row, in view. */
export function focusSelectedRow() {
  const row = document.querySelector<HTMLElement>('.list .row.sel');
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: 'nearest' });
}
