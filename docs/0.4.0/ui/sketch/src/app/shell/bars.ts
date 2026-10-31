/**
 * The two folding bars (views.md "Both bars"): top bar and dock, each its own pin. Replaces
 * Shell.tsx's useEdges (direct DOM class toggling, the unused `hold`, `.hint`) in the same unit.
 *
 * Preference = per viewer, kept in localStorage (prefs.ts store()), read by the bar and by
 * Firma › Darstellung through the same hook, so the pin and the setting cannot disagree.
 * Whether a bar is open NOW is derived from the preference and the pointer/focus, never stored.
 */
export type BarId = 'top' | 'dock';

export type BarPref =
  /** New user: open until used three times. */
  | { mode: 'new'; uses: number }
  /** Folded once, with the tip still to show. */
  | { mode: 'auto'; tip: boolean }
  | { mode: 'pinned' };

export type BarEvent =
  | { kind: 'used' }            // a click on an item of the bar (an area in the dock, a chip in the top bar)
  | { kind: 'pin'; on: boolean }
  | { kind: 'tip'; answer: 'always' | 'ok' };

export const USES_BEFORE_FOLD = 3;

/** new(2) + used → auto(tip: true); auto + pin on → pinned; pinned + pin off → auto(tip: false); tip 'always' → pinned. */
export function barReducer(p: BarPref, e: BarEvent): BarPref {
  throw new Error('not implemented');
}

export interface BarPresence { hover: boolean; focus: boolean; held: boolean /* a menu or the drop zone */ }

/** Full bar or pill. A pinned or new bar is always open; an auto bar opens on hover, focus or hold, and folds 450 ms after. */
export function barOpen(p: BarPref, now: BarPresence): boolean {
  throw new Error('not implemented');
}

/** The hook both bars and Firma › Darstellung use. */
export function useBar(id: BarId): { pref: BarPref; open: boolean; dispatch(e: BarEvent): void; bind: { onPointerEnter(): void; onPointerLeave(): void; onFocus(): void; onBlur(): void } } {
  throw new Error('not implemented');
}

/*
 * Layout: the page is `main` + its fixed bars; the AI sidebar is a sibling card. The shell sets
 * --aiw (0 or the sidebar width + gap) on <body>; every fixed, centred element (top bar, dock,
 * pills, toast, IntakeLine, legend, drop dialog) centres on `calc((100vw - var(--aiw)) / 2)`
 * instead of 50%. Split.clamp, Menu and PeriodPicker read the page width from one helper
 * pageWidth() = innerWidth / zoom - aiw instead of innerWidth / zoom.
 * The Mac drag strip: the corner (AI toggle, status) and the top pill get -webkit-app-region: no-drag.
 */
