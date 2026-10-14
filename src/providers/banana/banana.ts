/**
 * The journal as Banana Accounting's import file (TSV, the Banana NameXml columns): one row per
 * entry dated in the range, in CHF with the foreign amount and rate beside it. `npm run export`
 * and the export dialog write the same file.
 */
import type { Index, JournalEntry } from '../../types/index.js';
import { chfAmount } from '../../accounting/ledger.js';

const BANANA_COLUMNS = [
  'Date', 'Description', 'AccountDebit', 'AccountCredit', 'Amount', 'AmountCurrency',
  'ExchangeCurrency', 'ExchangeRate', 'ExchangeMultiplier', 'VatCode', 'ExternalReference',
] as const;

const cell = (value: unknown) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/** The entries of the range in Banana's order (date, then transaction ref), each with its description or its payment's. */
export function bananaEntries(books: Pick<Index, 'journalEntries' | 'transactions'>, from: string, to: string): Array<{ entry: JournalEntry; description: string }> {
  const txByRef = new Map(books.transactions.map((tx) => [tx.ref, tx]));
  return (books.journalEntries ?? [])
    .filter((e) => e.date >= from && e.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.transactionRef.localeCompare(b.transactionRef))
    .map((entry) => ({ entry, description: entry.description ?? txByRef.get(entry.transactionRef)?.description ?? '' }));
}

export function bananaTsv(books: Pick<Index, 'journalEntries' | 'transactions'>, from: string, to: string): string {
  const rows = bananaEntries(books, from, to).map(({ entry: e, description }) => {
    const foreign = !!e.exchangeCurrency && e.exchangeCurrency !== 'CHF';
    return [
      e.date, description, e.accountDebit, e.accountCredit, chfAmount(e).toFixed(2),
      foreign ? e.amount.toFixed(2) : '', foreign ? e.exchangeCurrency : '', foreign ? e.exchangeRate ?? 1 : '', foreign ? -1 : '',
      e.vatCode ?? '', e.transactionRef,
    ].map(cell).join('\t');
  });
  return [BANANA_COLUMNS.join('\t'), ...rows].join('\n') + '\n';
}
