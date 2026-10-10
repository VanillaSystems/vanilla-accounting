/**
 * The address bar in step with the app (docs/urls.md): changing area pushes a history entry,
 * anything else replaces it (rule 4); back and forward parse the URL again. The static audit
 * export keeps the path after '#', so it runs from any file server and under any base path.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { STATIC_EXPORT } from '../lib/api.js';
import { formatLocation, isRedirect, parseLocation, type Location } from './route.js';

/** A link to `loc` that works in the app and in the static export. */
export function hrefOf(loc: Location): string {
  return STATIC_EXPORT ? `#${formatLocation(loc)}` : formatLocation(loc);
}

function currentUrl(): string {
  return STATIC_EXPORT ? location.hash.slice(1) || '/' : location.pathname + location.search;
}

function write(loc: Location, mode: 'push' | 'replace') {
  if (formatLocation(loc) === currentUrl()) return;
  if (mode === 'push') history.pushState(null, '', hrefOf(loc));
  else history.replaceState(null, '', hrefOf(loc));
}

/** The URL's location; an old or other spelling is replaced by its canonical path first. */
function read(): Location {
  const url = currentUrl();
  const q = url.indexOf('?');
  const parsed = q < 0 ? parseLocation(url, '') : parseLocation(url.slice(0, q), url.slice(q));
  if (!isRedirect(parsed)) return parsed;
  write(parsed.redirect, 'replace');
  return parsed.redirect;
}

export function useLocationState(): [Location, (next: Location) => void] {
  const [loc, setLoc] = useState(read);
  const current = useRef(loc);
  current.current = loc;

  useEffect(() => {
    const reread = () => setLoc(read());
    addEventListener('popstate', reread);
    // A link pasted into the export's tab changes only the hash.
    if (STATIC_EXPORT) addEventListener('hashchange', reread);
    return () => { removeEventListener('popstate', reread); removeEventListener('hashchange', reread); };
  }, []);

  const go = useCallback((next: Location) => {
    write(next, next.route.area === current.current.route.area ? 'replace' : 'push');
    current.current = next;
    setLoc(next);
  }, []);

  return [loc, go];
}
