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

/**
 * Which days the books take: locked through `lockedThrough`, opened on `opens` (booksOpen, read on
 * first use). Pure, so the app (the hand form's tax point) and the server's periodLock
 * (src/books/store.ts), which is built on it, answer alike.
 */
export function dayLock(books: { config?: Pick<AccountingConfig, 'closedThrough' | 'approvedReturn' | 'openingBalances'>; transactions?: readonly { date: string }[] }): Pick<PeriodLock, 'lockedThrough' | 'isClosed' | 'beforeBooks' | 'opens'> {
  const through = lockedThrough(books.config);
  let first: { day: string | undefined } | undefined;
  const opens = () => (first ??= { day: booksOpen(books) }).day;
  return {
    lockedThrough: through,
    isClosed: (date) => !!through && !!date && date <= through,
    get opens() { return opens(); },
    beforeBooks: (date) => { const day = opens(); return !!day && !!date && date < day; },
  };
}
