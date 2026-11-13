/**
 * What the firm still owes the owner for the business costs she paid privately (#402), read off the
 * books, and which payments to her pay that back.
 *
 * An outlay is a credit on her account against an expense or an asset that she paid: its entry
 * belongs to a payment on her own money account («Privat bezahlt» books one), or it records the
 * receipt it books. Not an outlay: a wage or an employer's contribution booked expense / her
 * account (setup.yaml `wages`), a dividend or a loan (a debt or equity, no expense), and rent or
 * interest credited to her without a receipt. Her opening balance is not counted: it does not say
 * how much of it is outlays. Outlays of an earlier year still open count: the books are read across
 * the year boundary, from their first entry.
 *
 * A repayment is a debit on her account against a money account in a payment to her by name, or in
 * a payment booked onto money accounts only; a payment she split (her account plus a fee line)
 * counts by her account's line.
 *
 * Which payments repay (ownerRepayments): money out to her by name (the payee, never the text:
 * PR #389), no wage by the evidence rule's wording, in the books' currency, that no company rule
 * decides, each in date order covered by what is still open after the earlier ones. One that a
 * person or the app booked otherwise than onto her account is no repayment. The booking of such a
 * payment stays the model's or the person's: code books it nowhere by itself (#359).
 */
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { chfAmount } from '../accounting/ledger.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { baseCurrency, chart, setup } from '../engines/index.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';

type Books = { journalEntries: readonly JournalEntry[]; transactions: readonly BankTransaction[] };

/** What the reading needs of the firm. */
export interface OwnerFacts {
  /** Her account. */
  owner: string;
  /** The money accounts (the banks, the cash box, hers). */
  money: ReadonlySet<string>;
  /** Her name (company.owner). */
  ownerName?: string;
  /** The firm's money accounts: which payment was made on hers. */
  bankAccounts: readonly LedgerBankAccount[];
}

/** Every word of the owner's name stands in the payment's counterparty or text («Anna Muster» in «Sent money to Anna Maria Muster»). */
export function paysOwner(tx: Pick<BankTransaction, 'counterparty' | 'description'>, owner: string | undefined): boolean {
  const words = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 1);
  const name = words(owner ?? '');
  const said = new Set(words(`${tx.counterparty ?? ''} ${tx.description}`));
  return name.length > 0 && name.every((w) => said.has(w));
}

/** Her name as the payee: the counterparty only. */
const toOwner = (tx: Pick<BankTransaction, 'counterparty'>, name: string | undefined) => paysOwner({ counterparty: tx.counterparty, description: '' }, name);

/**
 * Money out to her by name (the payee) in the books' currency: what a repayment of her outlays is
 * (ownerRepayments' candidates; a wage aside, which never waits). One that waits for its receipt
 * waits in truth for the outlays it pays back to be booked over her account (#428): her receipts
 * paid privately, booked as her outlays, end the wait.
 */
export const repaysOwnerShape = (tx: Pick<BankTransaction, 'counterparty' | 'direction' | 'currency'>, ownerName: string | undefined): boolean =>
  tx.direction === 'DBIT' && tx.currency === baseCurrency() && toOwner(tx, ownerName);

/** The wage accounts of the jurisdiction: a wage booked expense / her account is no outlay. */
const wageAccounts = (): Set<string> => { const w = setup().wages; return new Set([...(w ? [w.account] : []), ...(w?.contributions ?? [])]); };

/** How many readings of the books were made: a test bounds the work of a pass over many payments by it (#402 review). */
let readings = 0;
export const readingsMade = (): number => readings;

/** One reading of the books: their entries by payment, which payments are on her account, and her outlays and repayments by day. */
function reading(books: Books, f: OwnerFacts) {
  readings++;
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries) if (e.transactionRef) { const l = byRef.get(e.transactionRef); if (l) l.push(e); else byRef.set(e.transactionRef, [e]); }
  const txOf = new Map(books.transactions.map((t) => [t.ref, t]));
  const ownBanks = new Set(f.bankAccounts.filter((a) => a.account === f.owner).map((a) => a.bank));
  const wages = wageAccounts();
  const moves = (a: string | undefined) => !!a && (a === f.owner || f.money.has(a));
  const outlay = (e: JournalEntry) => {
    if (e.accountCredit !== f.owner || moves(e.accountDebit) || wages.has(e.accountDebit)) return false;
    const type = chart().typeOf(e.accountDebit);
    if (type !== 'expense' && type !== 'asset') return false;
    const tx = e.transactionRef ? txOf.get(e.transactionRef) : undefined;
    return (!!tx && ownBanks.has(tx.bank)) || !!e.receipts?.length;
  };
  /** Her account's line of a repayment: what this entry pays back, else 0. */
  const repaid = (e: JournalEntry) => {
    if (e.accountDebit !== f.owner || !f.money.has(e.accountCredit) || e.accountCredit === f.owner) return 0;
    const tx = e.transactionRef ? txOf.get(e.transactionRef) : undefined;
    const all = e.transactionRef ? byRef.get(e.transactionRef) ?? [e] : [e];
    return (tx && toOwner(tx, f.ownerName)) || all.every((x) => moves(x.accountDebit) && moves(x.accountCredit)) ? toRappen(chfAmount(e)) : 0;
  };
  return { byRef, outlay, repaid, moves };
}

/** What her account holds of outlays not paid back at the end of `date` (`except`: payments whose repayment counts for nothing), in the books' currency. */
export function outlaysOpen(books: Books, f: OwnerFacts, date: string, except: ReadonlySet<string> = new Set()): number {
  const { outlay, repaid } = reading(books, f);
  let open = 0;
  for (const e of books.journalEntries) {
    if (e.date > date) continue;
    if (outlay(e)) open += toRappen(chfAmount(e));
    else if (!except.has(e.transactionRef)) open -= repaid(e);
  }
  return fromRappen(open);
}

/**
 * The payments that repay her outlays, each with what was open for it (after the earlier ones), in
 * the books' currency. `wage`: whether a payment's text is a wage's; `ruled`: whether a company rule
 * decides it (then its rule does, as before). One reading of the books and one sweep by date: every
 * payment to her by name booked onto her account uses up what is open, covered or not (a draw of
 * hers too), and one not booked uses it up when it is covered.
 */
export function ownerRepayments(books: Books, f: OwnerFacts, wage: (text: string) => boolean, ruled: (tx: BankTransaction) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  if (!f.ownerName) return out;
  const candidates = books.transactions
    .filter((t) => repaysOwnerShape(t, f.ownerName) && !wage(t.description))
    .sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  if (!candidates.length) return out;
  const { byRef, moves, repaid, outlay } = reading(books, f);
  // Booked otherwise than onto her account and money: no repayment; its line on her account, if any, counts as any repayment.
  const booked = (t: BankTransaction) => byRef.get(t.ref) ?? [];
  const mine = candidates.filter((t) => booked(t).every((e) => moves(e.accountDebit) && moves(e.accountCredit)) && !ruled(t));
  const refs = new Set(mine.map((t) => t.ref));
  // Her outlays (+) and the repayments of payments not among `mine` (−), by day.
  const events: Array<[string, number]> = [];
  for (const e of books.journalEntries) {
    if (outlay(e)) events.push([e.date, toRappen(chfAmount(e))]);
    else if (!refs.has(e.transactionRef)) { const r = repaid(e); if (r) events.push([e.date, -r]); }
  }
  events.sort((a, b) => a[0].localeCompare(b[0]));
  let at = 0;
  let sum = 0;
  let used = 0;
  for (const t of mine) {
    while (at < events.length && events[at][0] <= t.date) sum += events[at++][1];
    const open = sum - used;
    const entries = booked(t);
    const amount = entries.length ? entries.reduce((s, e) => s + repaid(e), 0) : toRappen(Math.abs(t.amount));
    const covered = open > 0 && amount <= open;
    if (covered) out.set(t.ref, fromRappen(open));
    if (covered || entries.length) used += amount;
  }
  return out;
}

/** The facts of the classify context, when it names her account. */
export function ownerFactsOf(c: { ownerAccount?: string; ownerName?: string; moneyAccounts?: ReadonlySet<string>; bankAccounts: readonly LedgerBankAccount[] }): OwnerFacts | undefined {
  return c.ownerAccount ? { owner: c.ownerAccount, money: c.moneyAccounts ?? new Set(), ...(c.ownerName && { ownerName: c.ownerName }), bankAccounts: c.bankAccounts } : undefined;
}
