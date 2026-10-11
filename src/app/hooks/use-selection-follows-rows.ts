import { useEffect, useRef } from 'react';

/**
 * When the rows change under the selection (a filter, a search, a collapsed group) and no longer
 * hold it, the first row is selected, as the mockup does. A link to a row the list does not show
 * keeps its object: the rows did not change after it.
 */
export function useSelectionFollowsRows(selected: string | undefined, ids: string[], select: (id: string) => void, hold = false) {
  const key = ids.join('\n');
  const last = useRef(key);
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    if (!hold && selected && ids[0] && !ids.includes(selected)) select(ids[0]);
  }, [key]);
}
