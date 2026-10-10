import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { setView, viewParams } from '../lib/location.js';

/** One selection an old tab keeps itself (account=, statement=, ziffer=): read once, written back on change. */
export function useUrlParam(name: string): [string | null, Dispatch<SetStateAction<string | null>>] {
  const [value, setValue] = useState(() => viewParams().get(name));
  useEffect(() => {
    const params = viewParams();
    if (value) params.set(name, value);
    else params.delete(name);
    setView(params);
  }, [name, value]);
  return [value, setValue];
}
