import { useEffect, useRef } from 'react';

/**
 * What a list + detail view selects when it opens (`opening`) or its visible rows change: the
 * first row while nothing is selected or the rows no longer hold the selection (null for an
 * empty list, so the placeholder shows). A selection present when the view opens is a deep link
 * and is kept even if the list does not show it. `undefined` keeps the current selection.
 */
export function autoSelection(ids: readonly string[], selectedId: string | null, opening: boolean): string | null | undefined {
  if (selectedId !== null && (opening || ids.includes(selectedId))) return undefined;
  const first = ids[0] ?? null;
  return first === selectedId ? undefined : first;
}

/**
 * Applies `autoSelection` when the view opens and whenever `ids` (the visible rows in display
 * order) change, never on a bare selection change: a selection the user cleared stays cleared
 * until the rows change. `select` should only set state: each view writes its selection to the
 * URL with replaceState, so an auto-selection adds no history entry. While `enabled` is false
 * the view counts as closed.
 */
export function useAutoSelectFirst(
  ids: readonly string[],
  selectedId: string | null,
  select: (id: string | null) => void,
  enabled = true,
): void {
  const signature = ids.join('\n');
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      seen.current = null;
      return;
    }
    if (seen.current === signature) return;
    const opening = seen.current === null;
    seen.current = signature;
    const next = autoSelection(ids, selectedId, opening);
    if (next !== undefined) select(next);
  }, [enabled, signature]);
}
