/**
 * A change kept in a stored conversation is data of whichever version wrote it: describing it must
 * never take the page down (the sidebar has no error boundary, and books still in their setup open
 * that conversation at every start). What cannot be described gets `fallback`'s words.
 */
export function describedOr<T>(describe: () => T, fallback: () => T): T {
  try { return describe(); } catch { return fallback(); }
}
