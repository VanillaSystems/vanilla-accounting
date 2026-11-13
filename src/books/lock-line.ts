import type { AccountingConfig } from '../types/index.js';
import type { PeriodLock } from './store.js';

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

/**
 * The books' first day: 1 January of the first year with opening balances, else of the year of the
 * earliest payment; undefined for books with neither. The year before is the opening balances'
 * (#39): no entry is dated in it and no year folder is made for it.
 */
export function booksOpen(books: { config?: Pick<AccountingConfig, 'openingBalances'>; transactions?: readonly { date: string }[] }): string | undefined {
  const year = Object.keys(books.config?.openingBalances ?? {}).sort()[0]
    ?? (books.transactions ?? []).reduce<string | undefined>((m, t) => (!m || t.date < m ? t.date : m), undefined)?.slice(0, 4);
  return year && `${year}-01-01`;
}

/** What a tax point asks of the lock (src/accounting/tax-point.ts taxPointOf), pure for the app: as the server's periodLock answers it. */
export function dayLock(books: { config?: Pick<AccountingConfig, 'closedThrough' | 'approvedReturn' | 'openingBalances'>; transactions?: readonly { date: string }[] }): Pick<PeriodLock, 'isClosed' | 'beforeBooks'> {
  const through = lockedThrough(books.config);
  const opens = booksOpen(books);
  return { isClosed: (date) => !!through && !!date && date <= through, beforeBooks: (date) => !!opens && !!date && date < opens };
}
