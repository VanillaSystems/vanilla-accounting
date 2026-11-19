/**
 * What the wages withheld and the firm still owes on their behalf (#426): the credit on the
 * deductions account (setup.yaml `wages.deductions`) at the end of a payment's day. Books that carry
 * wages gross credit it with each payslip's deductions; the payment of the contributions clears it.
 * A contribution bill states its totals by contribution, not by party, so only the books say how much
 * of a payment is the employees' share: the model is told this figure for a payment that pays
 * contributions (`paysContributions`) and the guide says how to use it (booking.guide.yaml
 * cls-social-insurance), also when it holds nothing (wages booked net: the whole contribution is the
 * employer's, #470). Code books an answer that takes more off the account than it holds with only
 * what it holds there, the rest on the employer's contribution account (`withinWithheld`), and names a booked contribution payment that leaves the
 * account untouched while it held a credit (`unclearedContributions`, a task on Aufgaben).
 * Pure and browser-safe.
 */
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../types/index.js';
import { computeAccountBalance } from '../accounting/ledger.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { baseCurrency, chart, setup } from '../engines/index.js';
import { readPayslip } from './payslip.js';

type Books = { journalEntries: readonly JournalEntry[]; config?: { openingBalances?: Record<string, Record<string, number>> } };

/**
 * The credit `account` holds at the end of the payment's day: the year's opening (in the account's
 * natural direction, as the year close writes it) and the year's entries up to then, without the
 * payment's own entries (a payment booked again is told what was open before it); undefined for
 * money in, without the account, or when it holds no credit (wages booked net never touch it).
 */
export function withheldFor(books: Books, tx: Pick<BankTransaction, 'ref' | 'date' | 'direction'>, account: string | undefined): number | undefined {
  if (!account || tx.direction !== 'DBIT') return undefined;
  const year = tx.date.slice(0, 4);
  const others = books.journalEntries.filter((e) => e.transactionRef !== tx.ref);
  const debitNormal = (a: string) => chart().isDebitNormal(a);
  const { balance } = computeAccountBalance(others, account, `${year}-01-01`, tx.date, books.config?.openingBalances?.[year]?.[account] ?? 0, debitNormal);
  const credit = debitNormal(account) ? -balance : balance;
  return credit > 0 ? credit : undefined;
}

/** The deductions account and the employer's contribution accounts of the jurisdiction (setup.yaml `wages`); undefined without a deductions account. */
export function wageAccounts(): { deductions: string; contributions: ReadonlySet<string>; shared: ReadonlySet<string>; payees: readonly string[] } | undefined {
  const w = setup().wages;
  return w?.deductions ? { deductions: w.deductions, contributions: new Set(w.contributions ?? []), shared: new Set(w.shared ?? []), payees: w.payees ?? [] } : undefined;
}

const fold = (s: string | undefined) => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/**
 * The businesses that collect deductions the payslips withheld, each with its kinds (docs/specs/payroll.md §10.2 A5):
 * the jurisdiction's payees (setup.yaml `wages.payees`, each collecting the kind of its id), and every business file
 * that says `collects: [...]` (a pension fund's, the canton's for the withholding tax), whose word wins.
 */
export type Collectors = ReadonlyMap<string, readonly string[]>;
export function collectorsOf(counterparties: ReadonlyArray<{ id: string; collects?: readonly string[] }>): Collectors {
  const w = setup().wages;
  const out = new Map<string, readonly string[]>();
  for (const id of w?.payees ?? []) if (w?.withholds?.[id]) out.set(id, [id]);
  for (const c of counterparties) if (c.collects?.length) out.set(c.id, c.collects);
  return out;
}

/** The kinds a business collects: its own word (`collectors`), else the kind its id names (setup.yaml `wages.withholds`), else none. */
export function kindsOf(business: string | undefined, collectors?: Collectors): readonly string[] {
  if (!business) return [];
  return collectors?.get(business) ?? (setup().wages?.withholds?.[business] ? [business] : []);
}

/** The account a kind's deductions are owed on: setup.yaml `wages.withholdsTo`, else `deductions`; a combined kind only when its parts share one. */
export function accountOfKind(kind: string): string | undefined {
  const w = setup().wages;
  const accounts = new Set(kind.split('+').map((k) => w?.withholdsTo?.[k] ?? w?.deductions));
  return accounts.size === 1 ? [...accounts][0] : undefined;
}

/** The one account of several kinds, or undefined when they are owed on two. */
export function accountOfKinds(kinds: readonly string[]): string | undefined {
  const accounts = new Set(kinds.map(accountOfKind));
  return accounts.size === 1 ? [...accounts][0] : undefined;
}

/**
 * Whether a payment out pays social insurance contributions, by what the books know of its payee:
 * the business it routes to is one the jurisdiction names as collecting them (setup.yaml
 * `wages.payees`, the business files' ids), or an earlier payment to the same business (or the same
 * counterparty name) is booked on the deductions account or an employer's contribution account. A
 * wage itself is none.
 */
export function paysContributions(books: Pick<Books, 'journalEntries'> & { transactions: readonly BankTransaction[] }, tx: BankTransaction, businessOf: (t: BankTransaction) => string | undefined, collectors?: Collectors): boolean {
  const w = wageAccounts();
  if (!w || tx.direction !== 'DBIT') return false;
  const business = businessOf(tx);
  if (business && (w.payees.includes(business) || !!collectors?.has(business))) return true;
  const payee = fold(tx.counterparty);
  const same = (t: BankTransaction) => t.ref !== tx.ref && t.date <= tx.date && ((!!business && businessOf(t) === business) || (!!payee && fold(t.counterparty) === payee));
  const refs = new Set(books.transactions.filter(same).map((t) => t.ref));
  if (!refs.size) return false;
  const onThem = books.journalEntries.filter((e) => refs.has(e.transactionRef));
  // An earlier wage to the same person is no contribution: its lines are on the wage account, not on these.
  return onThem.some((e) => w.contributions.has(e.accountDebit) || w.contributions.has(e.accountCredit) || e.accountDebit === w.deductions);
}

/**
 * The employer's contribution account the payee's newest earlier payment was booked on (#470 review):
 * a pension fund's payment goes where its earlier ones went (5720), never to the setup's first (5700).
 */
export function payeeContributionAccount(books: Pick<Books, 'journalEntries'> & { transactions: readonly BankTransaction[] }, tx: BankTransaction, businessOf: (t: BankTransaction) => string | undefined): string | undefined {
  const w = wageAccounts();
  if (!w) return undefined;
  const business = businessOf(tx);
  const payee = fold(tx.counterparty);
  const same = (t: BankTransaction) => t.ref !== tx.ref && t.date <= tx.date && ((!!business && businessOf(t) === business) || (!!payee && fold(t.counterparty) === payee));
  const earlier = books.transactions.filter(same).sort((a, b) => b.date.localeCompare(a.date));
  for (const t of earlier) {
    const line = books.journalEntries.find((e) => e.transactionRef === t.ref && w.contributions.has(e.accountDebit));
    if (line) return line.accountDebit;
  }
  return undefined;
}

/**
 * Whether the books carry a wage in the payment's year up to its day (#470 review): a line on the
 * setup's wage account. Only then does an empty deductions account mean wages booked net, whose
 * contributions are the employer's; a firm without wages paying its owner's own AHV pays a private cost.
 */
export function wagesBooked(books: Pick<Books, 'journalEntries'>, tx: Pick<BankTransaction, 'date'>): boolean {
  const account = setup().wages?.account;
  const year = tx.date.slice(0, 4);
  return !!account && books.journalEntries.some((e) => e.accountDebit === account && e.date.startsWith(year) && e.date <= tx.date);
}

/** What an answer takes off the deductions account (its debits there less its credits), in the books' currency. */
export function takenOff(entries: readonly Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'amount' | 'exchangeRate' | 'exchangeCurrency'>[], account: string): number {
  let r = 0;
  for (const e of entries) {
    const chf = e.exchangeCurrency && e.exchangeRate ? e.amount * e.exchangeRate : e.amount;
    if (e.accountDebit === account) r += toRappen(chf);
    if (e.accountCredit === account) r -= toRappen(chf);
  }
  return fromRappen(r);
}

/** An answer that takes more off the deductions account than it held on the payment's day (`open`, absent: nothing): what it takes and what was there. */
export function overWithheld(entries: readonly JournalEntry[], account: string, open: number | undefined): { taken: number; open: number } | undefined {
  const taken = takenOff(entries, account);
  return taken > (open ?? 0) + 0.004 ? { taken, open: open ?? 0 } : undefined;
}

/**
 * An answer that takes more off the deductions account than it held (`open`), booked without the
 * over-claim (#470, the owner's decision on #368): what the account holds stays on it, the rest is
 * the employer's expense, on the contribution account the answer names (one the employees share in
 * first), else on the jurisdiction's first (`fallback`). The lines cut are those on the account, the
 * last first; a line cut to nothing books the employer's account instead. Undefined when there is no
 * contribution account to move it to, or a line on the account is in another currency than the
 * books': code then refuses the answer, as before.
 */
export function withinWithheld(entries: readonly JournalEntry[], account: string, open: number | undefined, contributions: { named: ReadonlySet<string>; shared: ReadonlySet<string>; fallback?: string }, newId: () => string): { entries: JournalEntry[]; moved: number; to: string } | undefined {
  const over = overWithheld(entries, account, open);
  if (!over) return { entries: [...entries], moved: 0, to: '' };
  const onIt = entries.filter((e) => e.accountDebit === account);
  if (onIt.some((e) => e.exchangeCurrency && e.exchangeCurrency !== baseCurrency())) return undefined;
  const debits = entries.map((e) => e.accountDebit).filter((a) => contributions.named.has(a));
  const to = debits.find((a) => contributions.shared.has(a)) ?? debits[0] ?? contributions.fallback;
  if (!to) return undefined;
  let excess = toRappen(over.taken) - toRappen(over.open);
  const moved = fromRappen(excess);
  const out = [...entries];
  for (let i = out.length - 1; i >= 0 && excess > 0; i--) {
    const e = out[i];
    if (e.accountDebit !== account) continue;
    const have = toRappen(e.amount);
    const cut = Math.min(have, excess);
    excess -= cut;
    if (cut === have) { out[i] = { ...e, accountDebit: to }; continue; }
    out[i] = { ...e, amount: fromRappen(have - cut) };
    out.splice(i + 1, 0, { ...e, id: newId(), accountDebit: to, amount: fromRappen(cut) });
  }
  return { entries: out, moved, to };
}

/**
 * What an answer takes off the deductions account, made exactly `share` (#476): over it, cut as `withinWithheld` cuts;
 * under it, the difference moved from the answer's lines on a contribution account the employees share in
 * (`shared`), the last first, onto the account. Undefined when the shared lines hold less than is missing, or one
 * of the lines is in another currency than the books': the answer then stays as it is.
 */
export function atWithheld(entries: readonly JournalEntry[], account: string, share: number, contributions: { named: ReadonlySet<string>; shared: ReadonlySet<string>; fallback?: string }, newId: () => string): { entries: JournalEntry[]; moved: number; to: string; onto?: true } | undefined {
  const taken = toRappen(takenOff(entries, account));
  const want = toRappen(share);
  if (taken >= want) return withinWithheld(entries, account, share, contributions, newId);
  let missing = want - taken;
  const from = entries.filter((e) => contributions.shared.has(e.accountDebit));
  if (from.some((e) => e.exchangeCurrency && e.exchangeCurrency !== baseCurrency())) return undefined;
  if (from.reduce((s, e) => s + toRappen(e.amount), 0) < missing) return undefined;
  const moved = fromRappen(missing);
  const out = [...entries];
  for (let i = out.length - 1; i >= 0 && missing > 0; i--) {
    const e = out[i];
    if (!from.includes(e)) continue;
    const have = toRappen(e.amount);
    const cut = Math.min(have, missing);
    missing -= cut;
    if (cut === have) { out[i] = { ...e, accountDebit: account }; continue; }
    out[i] = { ...e, amount: fromRappen(have - cut) };
    out.splice(i + 1, 0, { ...e, id: newId(), accountDebit: account, amount: fromRappen(cut) });
  }
  return { entries: out, moved, to: account, onto: true };
}

/**
 * A payment's lines with one line per kind (#489): what `atWithheld` split off one line and moved onto another is
 * summed into the first line of the same accounts, code, currency and rate, day, corrected period and tags, which
 * keeps its id; the descriptions of the lines summed into it are kept, each once; a line moved to nothing goes.
 */
export function mergedLines(entries: readonly JournalEntry[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  const first = new Map<string, number>();
  const tagsOf = (e: JournalEntry) => JSON.stringify(Object.entries(e.tags ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  for (const e of entries) {
    const key = JSON.stringify([e.accountDebit, e.accountCredit, e.vatCode ?? '', e.exchangeCurrency ?? '', e.exchangeRate ?? '', e.date, e.corrects ?? '', tagsOf(e)]);
    const at = first.get(key);
    if (at === undefined) { first.set(key, out.length); out.push({ ...e }); continue; }
    const into = out[at];
    const said = [...new Set([into.description, e.description].flatMap((d) => (d ? d.split(' · ') : [])))].join(' · ');
    out[at] = { ...into, amount: fromRappen(toRappen(into.amount) + toRappen(e.amount)), ...(said && { description: said }) };
  }
  return out.filter((e) => toRappen(e.amount) !== 0);
}

/** An amount as payslips print it at a line's end: «-503.50», «503.50-», «1'234.00», the books' currency before it. */
const amountRe = () => new RegExp(`(?:^|\\s)(-|−)?\\s*(?:${baseCurrency()}\\s*)?(-|−)?\\s*(\\d{1,3}(?:['’ ]?\\d{3})*[.,]\\d{2})(-|−)?$`);
const amountOf = (line: string): number | undefined => {
  const m = amountRe().exec(line);
  if (!m) return undefined;
  const n = Number(m[3].replace(/['’ ]/g, '').replace(',', '.'));
  return m[1] || m[2] || m[4] ? -n : n;
};
const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A line that is a sentence, not a payslip's row: it ends as a sentence does, or runs on. */
export const prose = (label: string) => /[.!?:]$/.test(label) || label.split(/\s+/).length > 8;
/** A correction of an earlier month's deduction, printed positive on its own row. */
export const CORRECTION = /korrektur|rückerstattung|r[ée]troactif|correction|rettifica|conguaglio/i;

/** Whether a payslip row's label names one of `words` as a word of its own, not in a compound («AHV-Nr.»): a short capital word (an abbreviation) only in capitals. */
export function namesWord(words: readonly string[]): (label: string) => boolean {
  const res = words.map((w) => new RegExp(`(?<![\\p{L}\\d])${escape(w)}(?![\\p{L}\\d])(?!-\\p{L})`, /^[A-Z]{1,4}$/.test(w) ? 'u' : 'iu'));
  return (label) => res.some((r) => r.test(label));
}

/** A payslip's text as rows: each line's label and the amount at its end; `alone`, a line that is an amount only (pdftotext's column of figures). */
export interface PayslipRow { label: string; amount?: number; alone: boolean }
export function payslipRows(text: string): PayslipRow[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const amount = amountOf(line);
    const label = amount === undefined ? line : line.replace(amountRe(), '').trim();
    return { label, amount, alone: amount !== undefined && !/\p{L}/u.test(label) };
  });
}
/** A rate on a row's label: «5.3%», «1,10 %». */
const rateOf = (label: string) => { const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(label); return m ? Number(m[1].replace(',', '.')) : undefined; };

/** The deduction kind a row's label names (several funds' kinds as their combined kind, «accident+sickness»), none for a sentence. */
export function deductionKind(kinds: Readonly<Record<string, readonly string[]>>): (label: string) => string | undefined {
  const res = Object.entries(kinds).map(([kind, words]) => [kind, namesWord(words)] as const);
  return (label) => {
    if (prose(label)) return undefined;
    const hit = res.filter(([, names]) => names(label)).map(([k]) => k);
    return hit.length ? hit.sort().join('+') : undefined;
  };
}

/**
 * The deductions a payslip's text names, summed per kind of setup.yaml `wages.withholds` (#476), when that is sure.
 * A deduction is a row whose label names a kind and whose amount carries a minus («-503.50», «503.50-»): a kind's
 * word in a compound («AHV-Nr.», «AHV-pflichtiger Lohn», «AHV-Zweigstelle») names none, a row of the kind without a
 * minus is a basis or an employer's figure and no deduction, unless it says it corrects (then it is taken off), and a
 * sentence names none. A row naming kinds of several funds counts as their combined kind. The rows are read
 * - on a line of their own («AHV/IV/EO 5.3%  -503.50»), or
 * - as pdftotext lays out columns: each label followed by its amount, or all labels and then all amounts, which is
 *   taken only when the order is proven: each label with a rate shows rate × the first amount (the gross), and at
 *   most one label has none.
 * With `total` (what the wage booked on the deductions account), the deductions must add up to it. Undefined otherwise.
 */
export function payslipDeductions(text: string, total: number | undefined, kinds: Readonly<Record<string, readonly string[]>>): Map<string, number> | undefined {
  const kindOf = deductionKind(kinds);
  const rows = payslipRows(text).map((r) => ({ ...r, kind: kindOf(r.label) }));
  const pairs: Array<{ kind: string; amount: number }> = [];
  const inline = rows.filter((r) => r.kind && !r.alone && r.amount !== undefined);
  if (inline.some((r) => r.amount! < 0)) {
    for (const r of inline) {
      if (r.amount! < 0) pairs.push({ kind: r.kind!, amount: -r.amount! });
      else if (CORRECTION.test(r.label)) pairs.push({ kind: r.kind!, amount: -r.amount! });
    }
  } else {
    const labels = rows.map((r, i) => ({ ...r, i })).filter((r) => r.kind && r.amount === undefined);
    if (!labels.length) return undefined;
    // Each label followed by its own amount: the order is the text's.
    const next = labels.map((l) => rows[l.i + 1]);
    if (next.every((n) => n?.alone && n.amount! < 0)) labels.forEach((l, k) => pairs.push({ kind: l.kind!, amount: -next[k].amount! }));
    else {
      const amounts = rows.filter((r) => r.alone).map((r) => r.amount!);
      const minus = amounts.filter((a) => a < 0);
      const gross = amounts.find((a) => a > 0);
      if (minus.length !== labels.length || gross === undefined) return undefined;
      const rates = labels.map((l) => rateOf(l.label));
      if (rates.filter((r) => r === undefined).length > 1) return undefined;
      if (rates.some((r, k) => r !== undefined && Math.abs(toRappen((gross * r) / 100) - toRappen(-minus[k])) > 1)) return undefined;
      labels.forEach((l, k) => pairs.push({ kind: l.kind!, amount: -minus[k] }));
    }
  }
  if (!pairs.length) return undefined;
  if (total !== undefined && pairs.reduce((s, p) => s + toRappen(p.amount), 0) !== toRappen(total)) return undefined;
  const out = new Map<string, number>();
  for (const p of pairs) out.set(p.kind, fromRappen(toRappen(out.get(p.kind) ?? 0) + toRappen(p.amount)));
  return out;
}

type ShareBooks = Books & { transactions: readonly BankTransaction[]; receipts: readonly Pick<Receipt, 'id' | 'extractedText'>[]; mappings: readonly Pick<Mapping, 'transactionRef' | 'receiptId'>[] };

/**
 * The part of what the deductions account holds on a payment's day that belongs to the business it pays (#476, the
 * owner's decision on #368: what it holds for this fund is cleared there, never more): what the payslips behind the
 * account withheld for the kinds setup.yaml `wages.withholds` names under the business's id, less what earlier
 * payments to the business took off it, never more than the account holds. Only when code can tell: the business
 * collects such kinds, the account has no opening of the year (whose fund it held is not written down), every
 * payment that put something on it this year has its payslips linked (one or, for a payment of several wages,
 * several), whose deductions read per kind and add up to what it put there, and no row names this business's kind
 * together with another's. Undefined otherwise: the model is told the account's credit and the bill decides.
 */
export function fundShare(books: ShareBooks, tx: BankTransaction, business: string | undefined, businessOf: (t: BankTransaction) => string | undefined, collected: readonly string[] = kindsOf(business)): number | undefined {
  const open = withheldMonths(books, tx, business, businessOf, collected);
  if (!open) return undefined;
  const held = toRappen(withheldFor(books, tx, open.account) ?? 0);
  return fromRappen(Math.max(0, Math.min(open.months.reduce((s, m) => s + m.rappen, 0), held)));
}

/** A payslip's deductions per kind: as payslipDeductions reads them, else as readPayslip does (a program that prints them without a minus). */
const deductionsOf = (text: string, kinds: Readonly<Record<string, readonly string[]>>): Map<string, number> | undefined =>
  payslipDeductions(text, undefined, kinds) ?? readPayslip(text)?.deductions;

/**
 * What the payslips withheld for a business's kinds and earlier payments to it have not paid yet, month by month, the
 * oldest first (by the day the wage put it on the account); earlier payments pay the oldest months first. The same
 * gates as fundShare: the kinds on one account, no opening of the year on it, every wage that put something there with
 * its payslips read and adding up, no row mixing this business's kind with another's. Undefined otherwise.
 */
export function withheldMonths(books: ShareBooks, tx: BankTransaction, business: string | undefined, businessOf: (t: BankTransaction) => string | undefined, collected: readonly string[] = kindsOf(business)): { account: string; months: Array<{ month: string; rappen: number }> } | undefined {
  const w = setup().wages;
  const kinds = w?.withholds;
  const account = accountOfKinds(collected);
  if (!account || !kinds || !business || !collected.length || tx.direction !== 'DBIT') return undefined;
  const mine = new Set(collected);
  // What of a payslip's deductions goes onto this account: its kinds whose account it is.
  const onAccount = (m: Map<string, number>) => [...m].reduce((s, [k, v]) => s + (accountOfKind(k) === account ? toRappen(v) : 0), 0);
  const year = tx.date.slice(0, 4);
  if (books.config?.openingBalances?.[year]?.[account]) return undefined;
  const lines = books.journalEntries.filter((e) => e.transactionRef !== tx.ref && e.date.startsWith(year) && e.date <= tx.date);
  const put = new Map<string, { rappen: number; date: string }>();
  for (const e of lines) if (e.accountCredit === account) { const had = put.get(e.transactionRef); put.set(e.transactionRef, { rappen: (had?.rappen ?? 0) + toRappen(e.amount), date: had && had.date < e.date ? had.date : e.date }); }
  const byMonth = new Map<string, number>();
  for (const [ref, { rappen, date }] of put) {
    const ids = new Set([...books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId), ...lines.filter((e) => e.transactionRef === ref).flatMap((e) => e.receipts ?? [])]);
    const reads = books.receipts.filter((r) => ids.has(r.id)).flatMap((r) => deductionsOf(r.extractedText ?? '', kinds) ?? []);
    const sum = reads.reduce((s, m) => s + onAccount(m), 0);
    if (!reads.length || sum !== rappen) return undefined;
    for (const m of reads) for (const [kind, v] of m) {
      const parts = kind.split('+');
      const ours = parts.filter((k) => mine.has(k)).length;
      // A row that names this business's kind together with another's: whose part is whose, nothing says.
      if (ours && ours < parts.length) return undefined;
      if (ours) byMonth.set(date.slice(0, 7), (byMonth.get(date.slice(0, 7)) ?? 0) + toRappen(v));
    }
  }
  const theirs = new Set(books.transactions.filter((t) => t.ref !== tx.ref && t.date <= tx.date && businessOf(t) === business).map((t) => t.ref));
  let paid = lines.filter((e) => theirs.has(e.transactionRef)).reduce((s, e) => s + (e.accountDebit === account ? toRappen(e.amount) : 0) - (e.accountCredit === account ? toRappen(e.amount) : 0), 0);
  const months: Array<{ month: string; rappen: number }> = [];
  for (const [month, rappen] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    const taken = Math.min(Math.max(paid, 0), rappen);
    paid -= taken;
    if (rappen - taken > 0) months.push({ month, rappen: rappen - taken });
  }
  return { account, months };
}

/**
 * The share of each payment out to a business whose deduction kinds setup.yaml names (fundShare), by ref, where code
 * can tell it (#476): the task and «Arbeitnehmeranteil abziehen» then ask for that part, never for all the account holds.
 */
export function withheldSharesOf(books: ShareBooks, businessOf: (t: BankTransaction) => string | undefined, collectors?: Collectors): Record<string, number> {
  const w = setup().wages;
  if (!w?.withholds || !w.deductions) return {};
  const out: Record<string, number> = {};
  for (const t of books.transactions) {
    const b = t.direction === 'DBIT' ? businessOf(t) : undefined;
    const kinds = kindsOf(b, collectors);
    // The task and its click are the deductions account's: a kind owed elsewhere (the withholding tax) has none.
    if (!b || !kinds.length || accountOfKinds(kinds) !== w.deductions) continue;
    const share = fundShare(books, t, b, businessOf, kinds);
    if (share !== undefined) out[t.ref] = share;
  }
  return out;
}

/** The click that clears the deductions account, as a proposal: what moves (`amount`) from which contribution accounts (`from`) onto the deductions account, and the payment's lines after it, changed and added. */
export interface ClearingProposal { account: string; amount: number; from: string[]; changed: Array<{ before: JournalEntry; after: JournalEntry }>; added: JournalEntry[] }

/**
 * The person's one click on a contribution payment booked without the employees' share (#476, an `Uncleared`): what the
 * deductions account still holds (`open`), never more than the payment's lines on a contribution account the employees
 * share in, moved from those lines onto it, the last first. A proposal: she books it with the click, as by hand.
 * Undefined when the payment has no such line or the account holds nothing.
 */
export function clearingProposal(entries: readonly JournalEntry[], open: number): ClearingProposal | undefined {
  const w = wageAccounts();
  if (!w || open <= 0) return undefined;
  const shared = entries.filter((e) => w.shared.has(e.accountDebit));
  const amount = fromRappen(Math.min(toRappen(open), shared.reduce((s, e) => s + toRappen(e.amount), 0)));
  if (amount <= 0) return undefined;
  let n = 0;
  const done = atWithheld(entries, w.deductions, takenOff(entries, w.deductions) + amount, { named: w.contributions, shared: w.shared }, () => `new-${n++}`);
  if (!done) return undefined;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const changed = done.entries.flatMap((after) => { const before = byId.get(after.id); return before && (before.amount !== after.amount || before.accountDebit !== after.accountDebit) ? [{ before, after }] : []; });
  return { account: w.deductions, amount, from: [...new Set(changed.map((c) => c.before.accountDebit))], changed, added: done.entries.filter((e) => !byId.has(e.id)) };
}

/** A booked contribution payment that takes less off the deductions account than it should: `open`, what is still to move there (all the account holds at the period's end, or the payment's share where code knows it). */
export interface Uncleared { tx: BankTransaction; account: string; open: number }

/**
 * The payments dated `from`–`to` that can carry the employees' share, booked on a contribution
 * account the employees share in (setup.yaml `wages.shared`: not one the employer pays alone, as the
 * family allowances) with no line on the deductions account, while that account still holds a
 * credit at `to`: the employees' share the payslips withheld is still on it, and the staff expense
 * that much too high (#426). A payment can carry the share when its payee is one that collects it
 * (`payees`: the refs of payments to a business of `wages.payees`, which the server routes by the
 * business files, src/intake/pair-chain.ts providerIssuesIn) or an earlier payment to the same
 * counterparty took something off the deductions account. Cleared since, by hand on a ref of its
 * own, the account holds nothing at `to` and the task is gone.
 * Where the server knows a payment's share (`shares`, withheldSharesOf, #476), that decides: the payment is open only
 * while it takes less than its share off the account, for the difference (never more than the account holds at
 * `to`), whether or not it has a line there; a share of nothing is never open.
 */
export function unclearedContributions(books: Books & { transactions: readonly BankTransaction[] }, from: string, to: string, payees: ReadonlySet<string> = new Set(), shares: Readonly<Record<string, number>> = {}): Uncleared[] {
  const w = wageAccounts();
  if (!w) return [];
  const open = withheldFor(books, { ref: '', date: to, direction: 'DBIT' }, w.deductions);
  if (!open) return [];
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries) (byRef.get(e.transactionRef) ?? byRef.set(e.transactionRef, []).get(e.transactionRef)!).push(e);
  const cleared = new Set(books.transactions.filter((t) => byRef.get(t.ref)?.some((e) => e.accountDebit === w.deductions)).map((t) => t));
  const sharer = (tx: BankTransaction) => payees.has(tx.ref) || (!!tx.counterparty && [...cleared].some((t) => t.ref !== tx.ref && t.date <= tx.date && fold(t.counterparty) === fold(tx.counterparty)));
  return books.transactions.flatMap((tx): Uncleared[] => {
    const lines = tx.date >= from && tx.date <= to ? byRef.get(tx.ref) : undefined;
    if (!lines?.length || tx.direction !== 'DBIT' || !lines.some((e) => w.shared.has(e.accountDebit))) return [];
    const share = shares[tx.ref];
    if (share !== undefined) {
      const missing = Math.min(toRappen(share) - toRappen(takenOff(lines, w.deductions)), toRappen(open));
      return missing > 0 ? [{ tx, account: w.deductions, open: fromRappen(missing) }] : [];
    }
    if (lines.some((e) => e.accountDebit === w.deductions || e.accountCredit === w.deductions)) return [];
    return sharer(tx) ? [{ tx, account: w.deductions, open }] : [];
  });
}

/** The payments out to a business that collects contributions with the employees' share (setup.yaml `wages.payees`), by ref: what the app's task needs of the business files. */
export function withheldPayeesOf(transactions: readonly BankTransaction[], businessOf: (t: BankTransaction) => string | undefined, collectors?: Collectors): string[] {
  const w = wageAccounts();
  if (!w) return [];
  const collects = (b: string | undefined) => !!b && (w.payees.includes(b) || (!!collectors?.has(b) && accountOfKinds(collectors.get(b)!) === w.deductions));
  return transactions.filter((t) => t.direction === 'DBIT' && collects(businessOf(t))).map((t) => t.ref);
}

/** What code books of a payment to a collector without a model (contributionLines): its lines (`credit` empty is the bank), and why. */
export interface ContributionBooking {
  lines: Array<{ debit: string; credit: string; amount: number }>;
  account: string; share: number;
  /** Where the employer's part went: the payee's earlier contributions' account, else the kind's (setup.yaml `wages.employer`). */
  employer?: string;
  /** The collection commission the collector left the employer (setup.yaml `wages.commission`), and its account. */
  commission?: { amount: number; account: string };
}

/**
 * A payment to a business that collects deductions (§10.2 A4, A5), booked by code only where the payslips account for it
 * (review of A-2: never on what a later month withheld). The months the payslips withheld for its kinds that no payment
 * has cleared, oldest first (withheldMonths), are what it may clear, a whole number of them from the oldest:
 * - the withholding tax (a kind with a commission, setup.yaml `wages.commission`): the payment is those months' tax,
 *   or that less the collection commission (between `from` and `upTo` percent of it), which goes on the commission's
 *   account; a payment that fits no such run of months clears only what it pays;
 * - a fund's contributions: the payment is the employees' share of those months and the employer's beside it, so at
 *   least twice that share (the employer pays at least half by law) and at most three times it (with the family
 *   allowances and the administration cost); the rest goes on the payee's earlier contribution account, else the
 *   kind's (setup.yaml `wages.employer`). A payment that fits no run of months is the person's (or the model's).
 * Never at the year's start while the year before has books and no opening says what the account carried over.
 * Undefined when code cannot tell.
 */
export function contributionLines(books: ShareBooks, tx: BankTransaction, business: string | undefined, businessOf: (t: BankTransaction) => string | undefined, collectors?: Collectors): ContributionBooking | undefined {
  const w = setup().wages;
  const kinds = kindsOf(business, collectors);
  const account = accountOfKinds(kinds);
  if (!w || !business || !account || tx.direction !== 'DBIT') return undefined;
  const year = tx.date.slice(0, 4);
  const prev = String(Number(year) - 1);
  if (!books.config?.openingBalances?.[year] && books.journalEntries.some((e) => e.date.startsWith(prev))) return undefined;
  const open = withheldMonths(books, tx, business, businessOf, kinds);
  if (!open?.months.length) return undefined;
  const held = toRappen(withheldFor(books, tx, account) ?? 0);
  const paid = toRappen(Math.abs(tx.amount));
  const runs = open.months.map((_, k) => open.months.slice(0, k + 1).reduce((s, m) => s + m.rappen, 0)).filter((p) => p <= held);
  const commission = kinds.map((k) => w.commission?.[k]).find(Boolean);
  if (commission) {
    const fit = runs.find((p) => paid === p || (paid < p && (p - paid) * 100 >= p * (commission.from ?? 0) && (p - paid) * 100 <= p * commission.upTo));
    if (fit !== undefined && fit > paid) return { account, share: fromRappen(fit), commission: { amount: fromRappen(fit - paid), account: commission.account }, lines: [{ debit: account, credit: '', amount: fromRappen(paid) }, { debit: account, credit: commission.account, amount: fromRappen(fit - paid) }] };
    if (fit !== undefined || paid <= runs.at(-1)!) return { account, share: fromRappen(Math.min(paid, fit ?? paid)), lines: [{ debit: account, credit: '', amount: fromRappen(paid) }] };
    return undefined;
  }
  const fit = runs.find((p) => paid >= 2 * p - 1 && paid <= 3 * p);
  if (fit === undefined) return undefined;
  const employer = payeeContributionAccount(books, tx, businessOf) ?? kinds.map((k) => w.employer?.[k]).find(Boolean);
  if (!employer) return undefined;
  return { account, share: fromRappen(fit), employer, lines: [{ debit: account, credit: '', amount: fromRappen(fit) }, { debit: employer, credit: '', amount: fromRappen(paid - fit) }] };
}
