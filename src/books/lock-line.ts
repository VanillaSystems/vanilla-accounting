import type { AccountingConfig } from '../types/index.js';

/**
 * The last day the books are locked through: the filed line (closedThrough), or the end of a return
 * approved and waiting to be filed when it lies after it (r7h-24). Pure, so the server's periodLock
 * (src/books/store.ts) and the app read the same line.
 */
export function lockedThrough(config: Pick<AccountingConfig, 'closedThrough' | 'approvedReturn'> | undefined): string | undefined {
  const closed = config?.closedThrough;
  const approved = config?.approvedReturn;
  return approved && (!closed || approved.through > closed) ? approved.through : closed;
}
