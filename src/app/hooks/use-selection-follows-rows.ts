import { useEffect, useRef } from 'react';
import type { Index } from '../../types/index.js';
import { loadedFromOutside } from './use-index.js';

/**
 * When the rows change under the selection (a filter, a search, a collapsed group) and no longer
 * hold it, the first row is selected, as the mockup does. A link to a row the list does not show
 * keeps its object: the rows did not change after it. So does a selection the books lost to a
 * change from outside the app: the detail says it is gone (urls.md rule 5).
 */
export function useSelectionFollowsRows(selected: string | undefined, ids: string[], select: (id: string) => void, books: Index, hold = false) {
  const key = ids.join('\n');
  const last = useRef(key);
  const lastBooks = useRef(books);
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    const outside = books !== lastBooks.current && loadedFromOutside(books);
    if (!hold && !outside && selected && ids[0] && !ids.includes(selected)) select(ids[0]);
  }, [key]);
  useEffect(() => { lastBooks.current = books; });
}
