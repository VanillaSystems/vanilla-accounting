/**
 * «2270 ausgleichen» (#476): a contribution payment booked without the employees' share while the wages' deductions
 * account still holds it (the `withheld` item of «Noch offen», src/booking/withheld.ts) offers its fix as a proposal
 * in words, booked by her click as by hand: what the account holds, at most the payment's lines on a shared
 * contribution account, moved from them onto it. On the open list's item and on the payment itself.
 */
import { t } from '../../i18n/index.js';
import { fmt } from '../../lib/utils.js';
import { baseCurrency, filing } from '../../../engines/index.js';
import { clearingProposal, unclearedContributions, type Uncleared } from '../../../booking/withheld.js';
import { filingKeyOf, parsePeriod } from '../../../accounting/periods.js';
import { providerIssuesNow } from '../../lib/order-pages.js';
import { clearWithheld } from '../journal/actions.js';
import type { Nav } from '../index.js';
import type { BankTransaction, Index } from '../../../types/index.js';

export function WithheldFix({ books, u, nav }: { books: Index; u: Uncleared; nav: Pick<Nav, 'toast' | 'refresh'> }) {
  const p = clearingProposal((books.journalEntries ?? []).filter((e) => e.transactionRef === u.tx.ref), u.open);
  if (!p) return null;
  return (
    <>
      {' '}<span className="m" data-testid="withheld-proposal">{t('issues.withheldProposal', { amount: `${baseCurrency()} ${fmt(p.amount)}`, from: p.from.join(', '), account: p.account })}</span>
      {' '}<button type="button" className="btn ghost" data-testid="withheld-clear" onClick={() => void clearWithheld(nav, u.tx.ref)}>{t('issues.withheldClear', { account: p.account })}</button>
    </>
  );
}

/** The payment's own line of the item, with its fix, while the item stands for the period that holds it. */
export function WithheldOnPayment({ books, tx, nav }: { books: Index; tx: BankTransaction; nav: Pick<Nav, 'toast' | 'refresh'> }) {
  const period = parsePeriod(filingKeyOf(tx.date, filing().length), tx.date);
  if (!period) return null;
  const u = unclearedContributions(books as Parameters<typeof unclearedContributions>[0], period.from, period.to, new Set(providerIssuesNow().withheldPayees ?? []), providerIssuesNow().withheldShares).find((x) => x.tx.ref === tx.ref);
  if (!u) return null;
  return (
    <span data-testid="withheld-payment">
      {' · '}<span className="wn">{t('issues.withheldHere', { account: u.account, open: `${baseCurrency()} ${fmt(u.open)}` })}</span>
      <WithheldFix books={books} u={u} nav={nav} />
    </span>
  );
}
