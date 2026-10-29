/**
 * Kontoauszüge as the list and detail show them, derived from the books and never stored: each
 * bank account's monthly statements in a period, a month that ended without one (missing on an
 * account that has had statements, else a month whose balance comes from the movements alone: #88),
 * the payments of a statement (a Wise fee folded into its payment), and the balance checks. Pure, so
 * the list, the keys, the dock badge and the tests read the same statements.
 */
import type { BankStatement, BankTransaction, Index, JournalEntry } from '../../../types/index.js';
import type { StatementDetails } from '../../../types/drop.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { addDays, type IsoDate } from '../../../accounting/periods.js';
import { bookBalanceNative, nativeOpening } from '../../../accounting/reconcile-bank.js';
import { fromRappen, toRappen } from '../../../accounting/rappen.js';
import { bookedStates } from '../../../accounting/payment-entries.js';
import { splitTitle } from '../receipts/model.js';
import { baseCurrency, documents } from '../../../engines/index.js';
import { accountOfStatement, statementFacts } from '../../../books/statement-facts.js';
import { bookedInFiled } from '../../../books/twins.js';
import { lockedThrough } from '../../../books/lock-line.js';

export type Account = Pick<LedgerBankAccount, 'bank' | 'currency' | 'account' | 'label' | 'role' | 'statements' | 'iban'>;

/** A bank statement filed among the receipts (#151), placed at its account by its facts. */
export interface StatementReceipt { id: string; filename: string; from: IsoDate; to: IsoDate }

export interface Statement {
  /**
   * The statement's id in a link (docs/urls.md): `<account>-<yyyy-mm>` for a calendar month (a
   * statement of the whole month, or the month missing one), `<account>-<yyyy-mm-dd>` of its first
   * day for a statement of some days (several in one month), `_<last day>` added when two start the same day.
   */
  key: string;
  account: Account;
  from: IsoDate;
  to: IsoDate;
  /** The PDF or the bank's XML statement (isCamt); absent when the month ended without a statement, or has not ended yet. */
  file?: BankStatement;
  /** The month has not ended: its payments are there, its statement is still to come. */
  running?: boolean;
  /**
   * An ended month without a statement on an account that has had at least one imported: its
   * statement is missing. An account that never had one shows the month as without a statement,
   * no problem (#88): the account's own history decides, no setting.
   */
  missing?: true;
  /** Statements among the receipts of this account whose days overlap this one's. */
  receipts?: StatementReceipt[];
  /**
   * `file` is a bank export over several months, and this is its part of one month (#273): its
   * payments and balances are that month's, and the export is listed whole under Datei.
   */
  part?: true;
  /** A PDF whose whole month a bank export over several months covers too: that export. */
  export?: BankStatement;
}

/**
 * One statement file of an account's bank as it was read in (Kontoauszüge › Dateien, #208): the
 * file whole, not split into months, with the movements it holds and the balances it states.
 * `key`: `<account>/<file name>`, its id in a link (docs/urls.md).
 */
export interface StatementFile {
  key: string;
  account: Account;
  file: BankStatement;
  /** The movements the file holds (`refs`), oldest first; a file of books from before refs: the payments of its days. */
  payments: BankTransaction[];
  /** The bank's balances the day before its first day and on its last day, as the books keep them. */
  opening?: { date: IsoDate; amount: number };
  closing?: { date: IsoDate; amount: number };
}

/** The key of a statement file in a link. */
export const fileKeyOf = (account: string, filename: string) => `${account}/${filename}`;

/** What a statement file says about itself as the books know it (src/app/shell/FileDetails.tsx); the file's own words (bank, owner) come from the API. */
export function fileFacts(f: StatementFile): StatementDetails {
  const days = f.payments.map((t) => t.date).filter(Boolean).sort();
  return {
    currency: f.file.currency ?? f.account.currency,
    ...(f.account.iban ? { iban: f.account.iban } : {}),
    period: { from: f.file.fromDate, to: f.file.toDate },
    ...(days.length ? { booked: { first: days[0], last: days.at(-1)! } } : {}),
    movements: f.payments.length,
    ...(f.opening ? { opening: f.opening } : {}),
    ...(f.closing ? { closing: f.closing } : {}),
    preview: [],
    more: 0,
  };
}

export interface Check {
  /** The bank's balance the day before the statement starts (the previous statement's end, or the year's opening). */
  open: number | null;
  /** The bank's balance on its last day. */
  close: number | null;
  inc: number;
  out: number;
  /** Payments booked by the bank in it, fees included. */
  n: number;
  /** open + inc − out − close: not 0 when a payment is missing or counted twice. Null without both balances. */
  diff: number | null;
  ok: boolean;
  /** The ledger's balance of the account on the last day, in its currency (src/accounting/reconcile-bank.ts). */
  book: number;
  /** book − close: not 0 when a payment is not booked, or booked wrong. */
  bookDiff: number | null;
  /**
   * The bank's balance moved between the statement before this one and this one's opening with no
   * statement in between (r10h-7): a statement is missing for [from, to], or a file is wrong.
   * `diff` is open − bank (this statement's opening less the earlier statement's closing).
   */
  gap?: { from: IsoDate; to: IsoDate; bank: number; open: number; diff: number };
}

/** A payment's amount with its direction: money out is negative. */
export const signed = (t: BankTransaction) => (t.direction === 'DBIT' ? -1 : 1) * Math.abs(t.amount);

const round = (n: number) => fromRappen(toRappen(n));
const monthEnd = (d: IsoDate) => addDays(`${monthAdd(d.slice(0, 7), 1)}-01`, -1);
function monthAdd(ym: string, n: number): string {
  const m = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
}

/** The bank's XML statement: its payments and balances as data, no page to show. */
export const isCamt = (f: Pick<BankStatement, 'filename'>) => /\.xml$/i.test(f.filename);

export const statementKey = (account: string, from: IsoDate) => `${account}-${from.slice(0, 7)}`;

/** A statement key's account and month: "1021-2026-09" → 1021, 2026-09; "1021-2026-10-15" also names its day. */
export function parseStatementKey(key: string): { account: string; month: string; day?: string } | undefined {
  const m = /^(.+?)-(\d{4}-\d{2})(?:-(\d{2})(?:_\d{4}-\d{2}-\d{2})?)?$/.exec(key);
  return m ? { account: m[1], month: m[2], ...(m[3] ? { day: m[3] } : {}) } : undefined;
}

/** Whether statements, one or several end to end, cover every day of [first, last]. */
function coversMonth(list: readonly Statement[], first: IsoDate, last: IsoDate): boolean {
  let next = first;
  for (const s of [...list].sort((x, y) => x.from.localeCompare(y.from))) {
    if (s.from > next) break;
    if (s.to >= next) next = addDays(s.to, 1);
    if (next > last) return true;
  }
  return false;
}

/** A bank export over several months as its part of each month it reaches, from the day the books start (#273). */
function partsOf(s: Statement, booksFrom: IsoDate | undefined): Statement[] {
  const from = booksFrom && booksFrom > s.from ? booksFrom : s.from;
  const out: Statement[] = [];
  for (let m = from.slice(0, 7); m <= s.to.slice(0, 7); m = monthAdd(m, 1)) {
    const first = `${m}-01`, last = monthEnd(first);
    out.push({ ...s, from: first > from ? first : from, to: last < s.to ? last : s.to, part: true });
  }
  return out;
}

/** The key of a statement file of `account` covering [from, to]: its month when it covers the whole month, else its first day. */
export const fileKey = (account: string, from: IsoDate, to: IsoDate) =>
  (from.slice(8) === '01' && to >= monthEnd(from) ? statementKey(account, from) : `${account}-${from}`);

/** Each file statement of one account gets a key no other statement has (several statements in one month, treuhaender r4t-1). */
function keyed(account: string, list: Statement[]): Statement[] {
  const base = (s: Statement) => fileKey(account, s.from, s.to);
  return list.map((s) => {
    const same = list.filter((x) => base(x) === base(s));
    return { ...s, key: same.length > 1 && same[0] !== s ? `${account}-${s.from}_${s.to}` : base(s) };
  });
}

/** A Wise fee is folded into its payment when that payment is there ("FEE-CARD-1" belongs to "CARD-1"). */
const baseRef = (fee: BankTransaction) => fee.ref.replace(/^FEE-/, '');

/**
 * Whether a payment has an amount and is not booked: no entry, or entries that do not add up to
 * what the bank paid (src/accounting/payment-entries.ts bookedState, r9k-2); a Wise fee folded into
 * a booked payment counts as booked with it, and a bank movement booked in a filed quarter as a read
 * one (bookedInFiled, #254) is booked. `accounts`: the manifest's bank accounts, which say
 * where a payment's bank side is booked.
 */
export function isUnbooked(books: Pick<Index, 'transactions' | 'journalEntries'>, accounts: readonly LedgerBankAccount[]): (t: BankTransaction) => boolean {
  const state = bookedStates(books, accounts);
  const booked = (ref: string) => state(ref) === 'booked';
  const refs = new Set(books.transactions.map((t) => t.ref));
  return (t) => t.amount !== 0 && !booked(t.ref) && !bookedInFiled(t) && !(t.type === 'wise-fee' && refs.has(baseRef(t)) && booked(baseRef(t)));
}

/** The payments of the open period nobody has booked yet, oldest first: Aufgaben lists them (corner-9). */
export function unbookedPayments(books: Pick<Index, 'transactions' | 'journalEntries' | 'config'>, accounts: readonly LedgerBankAccount[]): BankTransaction[] {
  const closed = lockedThrough(books.config);
  const unbooked = isUnbooked(books, accounts);
  return books.transactions.filter((t) => (!closed || t.date > closed) && unbooked(t)).sort((x, y) => x.date.localeCompare(y.date) || x.ref.localeCompare(y.ref));
}

export interface Bank {
  /** The accounts at a bank, and every account that takes statements, in the manifest's order. */
  accounts: Account[];
  closedThrough?: string;
  /** Statements and missing months of every account overlapping [from, to], newest last day first. */
  statements(from: IsoDate, to: IsoDate): Statement[];
  /** The XML statement files read in whose days overlap [from, to], each whole (#208), by account in the manifest's order, newest first. */
  files(from: IsoDate, to: IsoDate): StatementFile[];
  /** A statement file by its key (`<account>/<file name>`). */
  fileByKey(key: string): StatementFile | undefined;
  /** Any statement by key, missing ones of the account's months included. */
  byKey(key: string): Statement | undefined;
  /** The statement a payment is on; none for a private one. */
  statementOf(t: BankTransaction): Statement | undefined;
  /** Its payments, newest first; a Wise fee folded into its payment is left out. */
  payments(s: Statement): BankTransaction[];
  /** The fee folded into a payment. */
  feeOf(ref: string): BankTransaction | undefined;
  check(s: Statement): Check;
  receiptsOf(ref: string): string[];
  /** A receipt's vendor (its description up to the first comma or dash) and date. */
  receiptOf(id: string): { name: string; date?: string } | undefined;
  entriesOf(ref: string): JournalEntry[];
  txByRef: Map<string, BankTransaction>;
  /** A payment still waiting for its receipt: not a fee, not 0, not marked as needing none, nothing linked. */
  needsReceipt(t: BankTransaction): boolean;
  /** A payment with an amount and no entry: the books do not know where its money went. */
  unbooked(t: BankTransaction): boolean;
  /**
   * Entries in [from, to] that move a bank account without any payment of the statements behind
   * them (a storno of a filed payment, a bank entry typed by hand): the bank's balance in the books
   * moves while no statement line does (corner-29). The year-end revaluation moves no money.
   */
  strays(from: IsoDate, to: IsoDate): JournalEntry[];
}

export function bankOf(books: Index, accounts: readonly Account[], today: IsoDate): Bank {
  const banked = accounts.filter((a) => a.statements || a.role === 'bank');
  const accountOf = (bank: string, currency: string) => banked.find((a) => a.bank === bank && a.currency === currency);
  const txByRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const byAccount = new Map<string, BankTransaction[]>(banked.map((a) => [a.account, []]));
  for (const t of books.transactions) {
    const a = accountOf(t.bank, t.currency);
    if (a) byAccount.get(a.account)!.push(t);
  }
  const fees = new Map<string, BankTransaction>();
  for (const t of books.transactions) if (t.type === 'wise-fee' && txByRef.has(baseRef(t))) fees.set(baseRef(t), t);
  const folded = (t: BankTransaction) => t.type === 'wise-fee' && txByRef.has(baseRef(t));

  const receiptById = new Map(books.receipts.map((r) => [r.id, r]));
  const receipts = new Map<string, string[]>();
  for (const m of books.mappings) (receipts.get(m.transactionRef) ?? receipts.set(m.transactionRef, []).get(m.transactionRef)!).push(m.receiptId);
  const entries = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) (entries.get(e.transactionRef) ?? entries.set(e.transactionRef, []).get(e.transactionRef)!).push(e);

  const filedAsReceipt = new Map<string, StatementReceipt[]>(banked.map((a) => [a.account, []]));
  for (const r of books.receipts) {
    if (r.kind !== 'statement') continue;
    const facts = statementFacts(r, documents());
    const a = facts?.to ? accountOfStatement(facts, r, banked) : undefined;
    if (!a) continue;
    filedAsReceipt.get(a.account)!.push({ id: r.id, filename: r.filename, from: facts!.from ?? `${facts!.to!.slice(0, 7)}-01`, to: facts!.to! });
  }
  const withReceipts = (s: Statement): Statement => {
    const overlap = filedAsReceipt.get(s.account.account)!.filter((x) => x.from <= s.to && x.to >= s.from);
    return overlap.length ? { ...s, receipts: overlap } : s;
  };

  const refSets = new Map<BankStatement, Set<string>>();
  const refsOf = (f: BankStatement) => refSets.get(f) ?? refSets.set(f, new Set(f.refs)).get(f)!;
  /** Whether a statement holds a payment: one its file holds (`refs`; a part, of its days), else one of its days (a PDF, books from before refs). */
  const holds = (s: Statement, t: BankTransaction): boolean => {
    const within = t.date >= s.from && t.date <= s.to;
    if (!s.file?.refs) return within;
    const refs = refsOf(s.file);
    // A movement made by hand a row of this statement confirmed stands for that row (#88).
    return (refs.has(t.ref) || (t.statement !== undefined && refs.has(t.statement))) && (!s.part || within);
  };
  const held = (s: Statement): BankTransaction[] => byAccount.get(s.account.account)!.filter((t) => holds(s, t));

  // A bank export states its days from the account's opening on (a camt.053 «since 2017»): the books start no earlier than their first year or payment.
  const opens = Object.keys(books.config?.openingBalances ?? {}).sort()[0];
  const firstYear = opens ?? books.transactions.map((t) => t.date).filter(Boolean).sort()[0]?.slice(0, 4);
  const booksFrom = firstYear ? `${firstYear}-01-01` : undefined;
  const files = new Map<string, Statement[]>(banked.map((a) => [a.account, []]));
  const received = new Set<string>();
  for (const f of books.bankStatements) {
    const a = accountOf(f.bank, f.currency ?? baseCurrency());
    if (!a) continue;
    received.add(a.account);
    files.get(a.account)!.push({ key: statementKey(a.account, f.fromDate), account: a, from: f.fromDate, to: f.toDate, file: f });
  }
  for (const [account, list] of files) {
    const pdfs = list.filter((s) => !isCamt(s.file!));
    const covered = (m: string) => pdfs.some((p) => p.from <= `${m}-01` && p.to >= monthEnd(`${m}-01`));
    const camts = list.filter((s) => isCamt(s.file!));
    // An XML statement of days within one month is that statement; beside a PDF of its whole month it adds nothing to see.
    const short = camts.filter((s) => s.from.slice(0, 7) === s.to.slice(0, 7) && !covered(s.from.slice(0, 7)));
    // A bank export over several months is no statement of its own (#273): each month it covers whole is its part, unless a PDF shows that month.
    const parts = camts.filter((s) => s.from.slice(0, 7) !== s.to.slice(0, 7)).flatMap((s) => partsOf(s, booksFrom));
    const whole = (p: Statement) => p.from.slice(8) === '01' && p.to === monthEnd(p.from);
    // Of two exports covering a month, the one of fewer days is the month's (a quarter's export before a year's).
    const span = (p: Statement) => Date.parse(p.file!.toDate) - Date.parse(p.file!.fromDate > (booksFrom ?? '') ? p.file!.fromDate : booksFrom!);
    const monthly = new Map<string, Statement>();
    for (const p of parts.filter(whole).sort((x, y) => span(x) - span(y))) if (!monthly.has(p.from.slice(0, 7))) monthly.set(p.from.slice(0, 7), p);
    const shown = [
      ...[...monthly.values()].filter((p) => !covered(p.from.slice(0, 7))),
      // A part of a month the export reaches only into is shown when it holds a payment the month's whole part does not.
      ...parts.filter((p) => !whole(p) && !monthly.has(p.from.slice(0, 7)) && !covered(p.from.slice(0, 7)) && held(p).length > 0),
    ];
    const marked = pdfs.map((p) => {
      const ex = whole(p) ? monthly.get(p.from.slice(0, 7))?.file : undefined;
      return ex ? { ...p, export: ex } : p;
    });
    files.set(account, keyed(account, [...marked, ...short, ...shown]).map(withReceipts));
  }

  // An account's months start with its first statement or payment, or the year its books open.
  const startOf = new Map(banked.map((a) => {
    const firsts = [...files.get(a.account)!.map((s) => s.from), ...byAccount.get(a.account)!.map((t) => t.date), ...filedAsReceipt.get(a.account)!.map((x) => x.from)].sort();
    const first = opens && firsts[0] && `${opens}-01-01` < firsts[0] ? `${opens}-01-01` : firsts[0];
    return [a.account, first] as const;
  }));

  function forAccount(a: Account, from: IsoDate, to: IsoDate): Statement[] {
    const have = files.get(a.account)!.filter((s) => s.to >= from && s.from <= to);
    const start = startOf.get(a.account);
    const missing: Statement[] = [];
    if (start) {
      for (let m = (from > start ? from : start).slice(0, 7); `${m}-01` <= to && `${m}-01` <= today; m = monthAdd(m, 1)) {
        const first = `${m}-01`, last = monthEnd(first);
        if (coversMonth(files.get(a.account)!, first, last)) continue;
        const running = last >= today;
        if (running && !byAccount.get(a.account)!.some((t) => t.date >= first)) continue;
        missing.push(withReceipts({ key: statementKey(a.account, first), account: a, from: first, to: last, ...(running ? { running } : received.has(a.account) && { missing: true as const }) }));
      }
    }
    return [...have, ...missing];
  }

  const balanceOn = (account: string, date: IsoDate) => books.statementBalances?.find((b) => b.account === account && b.date === date)?.amount ?? null;
  /** The balances the statement's own file states, oldest first: its opening and its closing (r10c-2). */
  const ownBalances = (s: Statement) => (books.statementBalances ?? []).filter((b) => b.account === s.account.account && b.sourceFile === s.file?.filename).sort((a, b) => a.date.localeCompare(b.date));
  /** A file's balances as the books keep them: its own, else the bank's of the same day from another file (a PDF's balance of a day wins over the XML's). */
  function fileBalances(f: BankStatement, account: string) {
    const kept = (books.statementBalances ?? []).filter((x) => x.account === account);
    const own = kept.filter((x) => x.sourceFile === f.filename).sort((x, y) => x.date.localeCompare(y.date));
    return {
      opening: own.find((x) => x.date < f.toDate) ?? kept.find((x) => x.date === addDays(f.fromDate, -1)),
      closing: own.find((x) => x.date === f.toDate) ?? kept.find((x) => x.date === f.toDate),
    };
  }
  /**
   * A bank export's part of a month (#273): opening on the export's opening and its payments before
   * the month, closing on the bank's balance of the month's last day, else on its payments.
   */
  function partBalances(s: Statement, own: readonly { date: string; amount: number }[], inc: number, out: number): { open: number | null; close: number | null } {
    const { account } = s.account;
    const stated = own.find((b) => b.date === s.to)?.amount ?? balanceOn(account, s.to);
    const start = fileBalances(s.file!, account).opening;
    if (!start) return { open: balanceOn(account, addDays(s.from, -1)), close: stated };
    const before = held({ ...s, from: s.file!.fromDate, part: undefined }).filter((t) => t.date < s.from).reduce((a, t) => a + signed(t), 0);
    const open = round(start.amount + before);
    return { open, close: stated ?? round(open + inc - out) };
  }
  /** The account's statement before `s`: the latest one that ends by the day `s` starts. */
  const before = (s: Statement) => files.get(s.account.account)!.filter((x) => x !== s && x.to <= s.from && x.from < s.from).sort((x, y) => y.to.localeCompare(x.to) || y.from.localeCompare(x.from))[0];

  const checks = new Map<string, Check>();
  function check(s: Statement): Check {
    const hit = checks.get(s.key);
    if (hit) return hit;
    const { account, currency } = s.account;
    const year = s.from.slice(0, 4);
    const own = ownBalances(s);
    const ownOpen = s.part ? undefined : own.find((b) => b.date < s.to && b.date !== s.to && own.length > 1)?.amount;
    const xs = held(s);
    const inc = round(xs.filter((t) => signed(t) > 0).reduce((a, t) => a + signed(t), 0));
    const out = round(xs.filter((t) => signed(t) < 0).reduce((a, t) => a - signed(t), 0));
    const part = s.part ? partBalances(s, own, inc, out) : undefined;
    const open = part ? part.open : ownOpen ?? balanceOn(account, addDays(s.from, -1))
      ?? (s.from.slice(5) === '01-01' && books.config?.openingBalances?.[year] ? nativeOpening(books, account, currency, year) : null);
    const close = part ? part.close : own.find((b) => b.date === s.to)?.amount ?? balanceOn(account, s.to);
    const diff = open == null || close == null ? null : round(open + inc - out - close);
    const book = bookBalanceNative(books.journalEntries ?? [], account, currency, s.to.slice(0, 4), s.to, nativeOpening(books, account, currency, s.to.slice(0, 4)));
    const c: Check = { open, close, inc, out, n: xs.length, diff, ok: diff === 0, book, bookDiff: close == null ? null : round(book - close) };
    // The statement before this one closed on another balance than this one opens on: the bank moved money no statement shows (r10h-7).
    const prev = ownOpen !== undefined ? before(s) : undefined;
    const prevClose = prev ? check(prev).close : null;
    if (prev && prevClose != null && toRappen(prevClose) !== toRappen(ownOpen!)) {
      const from = addDays(prev.to, 1), to = addDays(s.from, -1);
      c.gap = { ...(from <= to ? { from, to } : { from: prev.to, to: s.from }), bank: prevClose, open: ownOpen!, diff: round(ownOpen! - prevClose) };
    }
    checks.set(s.key, c);
    return c;
  }

  /** Each XML statement file whole, with the movements it holds and the balances it states (#208). */
  const wholeFiles: StatementFile[] = books.bankStatements.filter(isCamt).flatMap((f): StatementFile[] => {
    const a = accountOf(f.bank, f.currency ?? baseCurrency());
    if (!a) return [];
    const whole: Statement = { key: '', account: a, from: f.fromDate, to: f.toDate, file: f };
    const { opening, closing } = fileBalances(f, a.account);
    return [{
      key: fileKeyOf(a.account, f.filename), account: a, file: f,
      payments: held(whole).sort((x, y) => x.date.localeCompare(y.date) || x.ref.localeCompare(y.ref)),
      ...(opening ? { opening: { date: opening.date, amount: opening.amount } } : {}),
      ...(closing ? { closing: { date: closing.date, amount: closing.amount } } : {}),
    }];
  });

  // Newest last day first; of two ending the same day, the one that started later (it holds the later balance, r10c-2).
  const desc = (x: Statement, y: Statement) => y.to.localeCompare(x.to) || y.from.localeCompare(x.from) || banked.indexOf(x.account) - banked.indexOf(y.account);

  return {
    accounts: banked,
    closedThrough: lockedThrough(books.config),
    statements: (from, to) => banked.flatMap((a) => forAccount(a, from, to)).sort(desc),
    files: (from, to) => wholeFiles.filter((f) => f.file.toDate >= from && f.file.fromDate <= to)
      .sort((x, y) => banked.indexOf(x.account) - banked.indexOf(y.account) || y.file.toDate.localeCompare(x.file.toDate) || y.file.fromDate.localeCompare(x.file.fromDate)),
    fileByKey: (key) => wholeFiles.find((f) => f.key === key),
    byKey(key) {
      const k = parseStatementKey(key);
      const a = k && banked.find((x) => x.account === k.account);
      if (!a || !k) return undefined;
      const own = files.get(a.account)!;
      const first = `${k.month}-01`;
      return own.find((s) => s.key === key) ?? forAccount(a, first, monthEnd(first)).find((s) => s.key === key)
        // A link from before statements of some days had keys of their own: the month's first statement.
        ?? (k.day ? undefined : own.filter((s) => s.from.startsWith(k.month)).sort((x, y) => x.from.localeCompare(y.from))[0]);
    },
    statementOf(t) {
      const a = accountOf(t.bank, t.currency);
      if (!a) return undefined;
      // The file that holds the payment; else the narrowest statement that holds the day: a statement of some days before the month's.
      const days = (s: Statement) => Date.parse(s.to) - Date.parse(s.from);
      const own = files.get(a.account)!;
      return own.find((s) => !!s.file?.refs && holds(s, t))
        ?? own.filter((s) => !s.file?.refs && t.date >= s.from && t.date <= s.to).sort((x, y) => days(x) - days(y) || y.from.localeCompare(x.from))[0]
        ?? forAccount(a, t.date, t.date)[0];
    },
    payments: (s) => held(s)
      .filter((t) => !folded(t))
      .sort((x, y) => y.date.localeCompare(x.date) || y.ref.localeCompare(x.ref)),
    feeOf: (ref) => fees.get(ref),
    check,
    receiptsOf: (ref) => receipts.get(ref) ?? [],
    receiptOf(id) {
      const r = receiptById.get(id);
      return r && { name: splitTitle(r.description || r.filename.replace(/\.pdf$/i, ''))[0], date: r.date };
    },
    entriesOf: (ref) => entries.get(ref) ?? [],
    txByRef,
    needsReceipt: (t) => t.type !== 'wise-fee' && t.amount !== 0 && !t.noReceiptNeeded && !(receipts.get(t.ref) ?? []).length,
    unbooked: isUnbooked(books, accounts),
    strays: (from, to) => (books.journalEntries ?? []).filter((e) => e.date >= from && e.date <= to && e.origin !== 'year-close'
      && e.accountDebit !== e.accountCredit && !txByRef.has(e.transactionRef)
      && banked.some((a) => a.account === e.accountDebit || a.account === e.accountCredit)),
  };
}

/**
 * A statement with a problem: missing on an account that has had statements, its payments do not
 * add up to the bank's balance, or a statement is missing between two that do not chain. A month
 * of an account that never had a statement is none (#88): its balance comes from the movements.
 */
export const troubled = (b: Bank, s: Statement) => {
  if (!s.file) return s.missing === true;
  const c = b.check(s);
  return c.gap !== undefined || (c.diff != null && !c.ok);
};

/** What the dock's badge counts: statements with a problem from the open quarter until today. */
export const badgeCount = (b: Bank, openFrom: IsoDate, today: IsoDate) => b.statements(openFrom, today).filter((s) => troubled(b, s)).length;

/**
 * A bank's text as a name and a note: "Card transaction of 12.00 USD issued by Shop" is the
 * shop with the foreign amount, "Received money from X with reference Y" is X with Y.
 */
export function payText(t: BankTransaction): { name: string; note?: string } {
  const s = t.description;
  let m: RegExpExecArray | null;
  if ((m = /^Card transaction of (-?[\d.,]+) (\w{3}) issued by (.+?)(?:\s*\(fee?:?.*)?$/.exec(s))) {
    return { name: m[3], ...(m[2] !== t.currency ? { note: `${m[2]} ${Math.abs(Number(m[1].replace(/,/g, ''))).toFixed(2)}` } : {}) };
  }
  if ((m = /^Received money from (.+?) with reference (.+)$/.exec(s))) return { name: m[1], note: m[2] };
  if ((m = /^Sent money to (.+?)(?: with reference (.+))?$/.exec(s))) return { name: m[1], ...(m[2] ? { note: m[2] } : {}) };
  if ((m = /^(?:Zahlung|Gutschrift|Belastung)\s+(.+)$/.exec(s))) return { name: m[1].slice(0, 70) };
  return { name: s.slice(0, 70) };
}

/** The text a search looks in for a payment: the bank's text, reference, amount, date, and the linked receipts' words. */
export function payHaystack(t: BankTransaction, receiptWords: string): string {
  return [t.description, t.reference, Math.abs(t.amount).toFixed(2), t.date, t.date.split('-').reverse().join('.'), t.remarks, receiptWords].join(' ').toLowerCase();
}

export const matches = (haystack: string, q: string | undefined) => (q ?? '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => haystack.includes(w));
