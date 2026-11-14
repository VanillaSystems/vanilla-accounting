/**
 * The keyboard model of the mockup. Typing in a field never triggers it. The shell's own keys:
 * ⌘K palette, G + letter area, N add, T light/dark, ⇧E export, / search, ? key help, ⌘Z undo,
 * ⌘B the dock narrow or wide, ⌘A every row shown, Esc no rows picked or back to the list, A the Aktionen; ↑/↓ and J/K belong to the area (moveKey), ⌘+/⌘−/⌘0 to the zoom (prefs.ts).
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
  /** «Teilen…» (⇧S); false where the books are not shared from (a Durchsicht copy, read-only). */
  shareOpen(): boolean;
  /** ⌘J: the AI sidebar, also while typing. */
  assistant(): void;
  /** ⌘B: the dock narrow or wide. */
  toggleNav(): void;
  /** ⌘A: every row the list shows (#216); false where the list picks none. */
  selectAll(): boolean;
  /** Esc with rows picked: none picked; false when none was. */
  unselect(): boolean;
  /** A: the Aktionen of what is open or picked (#216); false where there are none. */
  actions(): boolean;
}

const plain = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey;

/** What answers Enter and Space itself: a button or link (the KI sidebar's «+», r7h-25), a tab, a details summary. A list row (`role=option`) does not: its Enter is the area's (r8c-7). */
const OWN_ENTER = 'button, a[href], [role="button"], [role="tab"], summary';
export const takesOwnEnter = (target: { closest(selectors: string): unknown } | null | undefined): boolean => !!target?.closest?.(OWN_ENTER);

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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); k.assistant(); return; }
      if (k.overlayOpen()) {
        if (e.key === 'Escape') { e.preventDefault(); k.closeOverlay(); }
        return;
      }
      if (typing) {
        if (e.key === 'Escape') { target!.blur(); focusSelectedRow(); }
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && takesOwnEnter(target)) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && k.undo()) { e.preventDefault(); return; }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); k.toggleNav(); return; }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') { if (k.selectAll()) e.preventDefault(); return; }
      if (e.key === 'Escape' && k.unselect()) { e.preventDefault(); return; }
      if (plain(e) && !e.shiftKey && (e.key === 'a' || e.key === 'A') && k.actions()) { e.preventDefault(); return; }
      if (gPending && plain(e) && /^[a-z]$/.test(e.key)) { endG(); if (k.area(e.key)) e.preventDefault(); return; }
      if (plain(e) && e.shiftKey && e.key === 'E') { e.preventDefault(); k.exportOpen(); return; }
      if (plain(e) && e.shiftKey && e.key === 'S' && k.shareOpen()) { e.preventDefault(); return; }
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
