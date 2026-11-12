import { useEffect, useRef } from 'react';

/** The rows and the selection as one render saw them. */
export interface Shown { selected: string | undefined; ids: readonly string[] }

/**
 * The row to select when the rows changed from `was` to `now`, or none. Only rows that change
 * under a selection that stayed (a filter, a search, a collapsed group) move it to the first row.
 * A selection that changed with the rows is a link (a dropped statement opened in its period):
 * it keeps its object while the books that hold it are still loading.
 */
export function followedSelection(was: Shown, now: Shown, hold = false): string | undefined {
  if (hold || was.selected !== now.selected || was.ids.join('\n') === now.ids.join('\n')) return undefined;
  return now.selected && now.ids[0] && !now.ids.includes(now.selected) ? now.ids[0] : undefined;
}

/**
 * When the rows change under the selection and no longer hold it, the first row is selected, as
 * the mockup does (followedSelection). A link to a row the list does not show keeps its object.
 */
export function useSelectionFollowsRows(selected: string | undefined, ids: string[], select: (id: string) => void, hold = false) {
  const key = ids.join('\n');
  const last = useRef<Shown>({ selected, ids });
  useEffect(() => {
    const was = last.current;
    last.current = { selected, ids };
    const next = followedSelection(was, { selected, ids }, hold);
    if (next) select(next);
  }, [key, selected]);
}
