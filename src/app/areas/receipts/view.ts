/** What the list, the detail and the keys of Belege share: the ledger of the loaded books, and the list as last shown. */
import { roleOf } from '../../../workspace/money-accounts.js';
import { workspaceNow } from '../../hooks/use-workspace.js';
import type { BankTransaction, Index } from '../../../types/index.js';
import { localToday, booksOpenPeriod, parsePeriod, periodContaining, type Period } from '../../../accounting/periods.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { Location, Route } from '../../shell/route.js';
import { ledgerOf, type AmountFit, type Candidate, type Ledger, type ReceiptView } from './model.js';
import { baseCurrency, filing } from '../../../engines/index.js';

let memo: { books: Index; ledger: Ledger } | undefined;

/** The ledger of these books, computed once per load. */
export function ledgerFor(books: Index): Ledger {
  if (memo?.books !== books) memo = { books, ledger: ledgerOf(books, booksOpenPeriod(books, localToday(), filing().length).from) };
  return memo.ledger;
}

/** The list as last shown, in ↑↓ order, with the suggestion of each row that has one: the keys act on it. */
export const listed: { ids: string[]; suggestions: Map<string, Candidate> } = { ids: [], suggestions: new Map() };

/** A payment's amount with its direction: money out is negative. */
export const signed = (tx: BankTransaction) => (tx.direction === 'DBIT' ? -1 : 1) * Math.abs(tx.amount);

/** The account a payment moved on: its label, its currency when not CHF; one on the owner's account is "Privat". */
export const bankOf = (tx: BankTransaction) =>
  roleOf(tx, workspaceNow()?.bankAccounts ?? []) === 'owner' ? t('receipts.private') : tx.currency !== baseCurrency() ? `${tx.bank} ${tx.currency}` : tx.bank;

export const amountOf = (tx: BankTransaction) => `${tx.currency !== baseCurrency() ? `${tx.currency} ` : ''}${fmt(signed(tx))}`;

/** A payment in one line, for toasts: "29.09.2026 Raiffeisen −15.00". */
export const txLine = (tx: BankTransaction) => `${formatDate(tx.date)} ${bankOf(tx)} ${amountOf(tx)}`;

/** A place for an object dated `date`: in the current period when it holds the date (urls.md rule 1). */
export const at = (route: Route, date: string | undefined, current?: Period): Location =>
  ({ route, query: { period: parsePeriod(periodContaining(date, current, filing().length), localToday()) ?? undefined } });

/** How far a payment is from the receipt's date: "gleicher Tag", "2 Tage vorher". */
export const dayText = (days: number) =>
  days === 0 ? t('receipts.sameDay') : t(days < 0 ? 'receipts.daysBefore' : 'receipts.daysAfter', { n: Math.abs(days) });

/** A payment's amount against the receipt's in words: «Betrag weicht um CHF 28.75 ab», «2 % weniger · Skonto?»; nothing when it is the same. */
export const fitText = (fit: AmountFit | undefined) =>
  fit?.kind === 'off' ? t('receipts.whyOff', { amount: `${fit.currency} ${fmt(Math.abs(fit.diff))}` })
    : fit?.kind === 'skonto' ? t('receipts.whySkonto', { percent: fit.percent })
      : '';

/**
 * Why a file is no receipt, and who said so (#186): the model's own reason, a person's mark, or
 * what the app's rules read («laut Text kein Beleg»).
 */
export function noneText(v: ReceiptView): string {
  if (v.noneBy === 'model') return v.r.kindWhy ? t('receipts.noneBy.modelWhy', { why: v.r.kindWhy }) : t('receipts.noneBy.model');
  if (v.noneBy === 'person' && v.r.kind === 'noise') return t('receipts.noneBy.person');
  const why = v.noneWhy ? t(`receipts.why.${v.noneWhy}`) : '';
  return v.noneBy === 'person' ? `${why} · ${t('receipts.noneBy.personShort')}` : why;
}
