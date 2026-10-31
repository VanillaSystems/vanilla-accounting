/**
 * What a drafted rule would do, before the person keeps it (wishes3-2, wishes3-4): the payments of
 * the open year it holds for, each with the booking it would make and how it is booked today, and
 * the other rules that hold for the same payments. Code, never the model: the card shows this so
 * a rule drafted too wide is seen on the payments it would book.
 */
import { bankAccountFor } from '../workspace/money-accounts.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import type { Books } from '../books/store.js';
import type { BankTransaction } from '../types/index.js';
import { mappedReceipts, paymentFacts, ruleBookingLines, type ClassifyContext, type RuleLine } from './classify.js';
import type { RuleRow } from './rule-book.js';
import { holds, loneWords, ruleFor, type PlacedRule, type RuleBooking } from './rules.js';
import { nationalCodes, overrideOf, supplierFacts, type NationalOverride, type SideLine } from './national-vat.js';

/** How many matching payments the card names one by one; the rest it counts. */
export const PREVIEW_EXAMPLES = 5;

export interface PreviewPayment {
  ref: string;
  date: string;
  amount: number;
  currency: string;
  direction: BankTransaction['direction'];
  /** The bank's text and, when it names one, the counterparty. */
  text: string;
  /** What the rule would do with it: book these lines, or ask (with the lines it would propose). */
  would: { kind: 'book'; lines: RuleLine[] } | { kind: 'ask'; question: string; lines: RuleLine[] };
  /** Its bookings today, the side opposite the bank (empty: not booked). */
  now: RuleLine[];
  /** Its bookings before the AI sidebar changed them, when it did: what the person or the app had decided. */
  beforeAi?: RuleLine[];
  /** Another rule that decides this payment before the drafted one: its id. */
  decidedBy?: string;
}

export interface RuleOverlap {
  /** The other rule, as Firma › Regeln lists it. */
  row: RuleRow;
  /** Payments of the year both hold for. */
  shared: number;
  /** Of those, the payments the other rule decides (it ranks first). */
  theirs: number;
}

/**
 * The payments a rule holds for that are booked on other accounts than its own, as decided before
 * the AI sidebar changed them: on two or more of them, or on the owner's private account, the rule
 * would book over decisions (a cash withdrawal, a private purchase, a restaurant), so keeping it
 * asks for «Trotzdem behalten» (x02).
 */
export interface RuleSpread {
  /** The other accounts, as booked today, in the order first met. */
  accounts: string[];
  /** One of them is the owner's private account. */
  private: boolean;
  /** Such payments the newest examples leave out, at most PREVIEW_EXAMPLES. */
  payments: PreviewPayment[];
}

/**
 * Payments of the year a booking rule books against a national VAT rule the code would otherwise
 * apply (issue #75): Bezugsteuer, the receipt rules, the app's business files. Keeping the rule
 * asks for «Trotzdem behalten».
 */
export interface RuleOverride {
  kind: NationalOverride;
  /** Payments the rule books so, of those it decides. */
  count: number;
  /** The newest of them, at most PREVIEW_EXAMPLES, each with the lines the national rules give. */
  payments: Array<PreviewPayment & { national: RuleLine[] }>;
}

export interface RulePreview {
  /** The drafted rule: `${step}#${id}`. */
  key: string;
  /** The year whose payments it was tried on. */
  year: string;
  /** Payments of that year it holds for. */
  matches: number;
  /** The newest of them, at most PREVIEW_EXAMPLES. */
  examples: PreviewPayment[];
  overlaps: RuleOverlap[];
  /** The single words it rests on (loneWords): keeping asks for confirmation. */
  loneWords: string[];
  /** The payments it holds for are booked today on several other accounts or privately: keeping asks for confirmation. */
  spread?: RuleSpread;
  /** The national VAT rules it books against, each with its payments: keeping asks for confirmation. */
  overrides?: RuleOverride[];
  /**
   * A booking rule's payments booked today (as decided before the AI sidebar moved them) otherwise
   * than it would book them: account, code or amount. Payments the rule itself booked do not count.
   * A rule from the notes is offered only when there are none (src/knowledge/note-rules.ts).
   */
  otherwise?: number;
  /** A booking rule's payments booked today (as decided before the AI sidebar moved them) exactly as it would book them. */
  same?: number;
  /** The newest payments counted in `otherwise` that `examples` and `spread` leave out, at most PREVIEW_EXAMPLES: the card names them. */
  differ?: PreviewPayment[];
}

const lineKey = (l: RuleLine) => `${l.account}|${l.vat ?? ''}|${Math.abs(l.amount).toFixed(2)}`;
/** Whether two bookings of a payment are the same lines, in any order. */
export const sameLines = (a: readonly RuleLine[], b: readonly RuleLine[]): boolean => JSON.stringify(a.map(lineKey).sort()) === JSON.stringify(b.map(lineKey).sort());

/** A rule of the books with the draft applied, and the row it reads as. */
export interface PlacedRow { row: RuleRow; placed: PlacedRule }

export const ruleKey = (r: Pick<RuleRow, 'step' | 'id'>) => `${r.step}#${r.id}`;

/** The open year: the one after the filed quarters, else the year of the newest payment. */
export function openYear(books: Pick<Books, 'config' | 'transactions'>): string {
  const closed = books.config.closedThrough;
  if (closed) return String(new Date(Date.parse(`${closed}T00:00:00Z`) + 86_400_000).getUTCFullYear());
  return books.transactions.map((t) => t.date).sort().at(-1)?.slice(0, 4) ?? String(new Date().getFullYear());
}

/**
 * A payment's bookings today, the side opposite its bank account; with `decided`, each booking the
 * AI sidebar changed as it was before (JournalEntry.by `was`): a wish that rebooked the payments
 * first must not hide the decisions its rule would book over (x02).
 */
export function bookedNow(books: Books, tx: BankTransaction, bank: string, decided = false): RuleLine[] {
  return books.journalEntries.filter((e) => e.transactionRef === tx.ref).map((now) => {
    const e = decided && now.by?.kind === 'assistant' && now.by.was ? { ...now, ...now.by.was } : now;
    return {
      account: e.accountDebit === bank ? e.accountCredit : e.accountDebit,
      ...(e.vatCode ? { vat: e.vatCode } : {}),
      amount: e.amount,
    };
  });
}

/** What a rule's booking books for `tx`: its lines, the bank on the other side. */
function wouldEntries(books: Books, tx: BankTransaction, booking: RuleBooking, context: ClassifyContext): SideLine[] {
  const mapped = mappedReceipts(books, tx);
  const bank = bankAccountFor(tx, context.bankAccounts);
  return ruleBookingLines(tx, booking, mapped, context.ownerAccount).map((l) => ({
    accountDebit: tx.direction === 'DBIT' ? l.account : bank,
    accountCredit: tx.direction === 'DBIT' ? bank : l.account,
    amount: l.amount,
    ...(l.vat ? { vatCode: l.vat } : {}),
  }));
}

/** A line as the card names it: the side opposite the bank. */
const asRuleLine = (bank: string) => (e: SideLine): RuleLine => ({ account: e.accountDebit === bank ? e.accountCredit : e.accountDebit, ...(e.vatCode ? { vat: e.vatCode } : {}), amount: e.amount });

function wouldBook(books: Books, tx: BankTransaction, booking: RuleBooking, context: ClassifyContext): RuleLine[] {
  return wouldEntries(books, tx, booking, context).map(asRuleLine(bankAccountFor(tx, context.bankAccounts)));
}

/**
 * How the rule's booking of `tx` departs from the national VAT rules, each kind once, with the
 * lines they give; nothing where they agree.
 */
function departures(books: Books, tx: BankTransaction, booking: RuleBooking, context: ClassifyContext): { kinds: NationalOverride[]; national: RuleLine[] } {
  const lines = wouldEntries(books, tx, booking, context);
  const entries = books.journalEntries.filter((e) => e.transactionRef === tx.ref);
  const codes = nationalCodes(tx, lines, mappedReceipts(books, tx), supplierFacts(tx, entries), context);
  const kinds = [...new Set(lines.flatMap((l, i) => overrideOf(l.vatCode, codes[i]) ?? []))];
  const line = asRuleLine(bankAccountFor(tx, context.bankAccounts));
  return { kinds, national: lines.map((l, i) => line({ ...l, vatCode: codes[i] })) };
}

/**
 * The preview of each rule in `targets` against the books' payments of the open year, with
 * `rules` (every rule of the books, the draft applied) deciding who wins a payment.
 */
export function previewRules(targets: readonly PlacedRow[], rules: readonly PlacedRow[], books: Books, context: ClassifyContext, fx: FxResolver): RulePreview[] {
  const year = openYear(books);
  const txs = books.transactions.filter((t) => t.date.startsWith(year)).sort((a, b) => b.date.localeCompare(a.date) || a.ref.localeCompare(b.ref));
  const on = rules.filter((r) => !r.placed.rule.off);
  const facts = new Map(txs.map((tx) => [tx.ref, paymentFacts(books, tx, context, fx)]));
  return targets.map((target) => {
    const key = ruleKey(target.row);
    const hits = txs.filter((tx) => holds(target.placed, facts.get(tx.ref)!));
    const overlaps = new Map<string, RuleOverlap>();
    const examples: PreviewPayment[] = [];
    const pool = rules.filter((r) => !r.placed.rule.off || ruleKey(r.row) === key);
    // The drafted rule counts as switched on: the preview says what it would do.
    const placed = pool.map((r) => ({ ...r.placed, rule: { ...r.placed.rule, off: false } }));
    const t = target.placed.rule.then;
    const payment = (tx: BankTransaction, p: ReturnType<typeof paymentFacts>): PreviewPayment => {
      const decider = ruleFor(placed, p);
      const deciderRow = decider && pool[placed.indexOf(decider)].row;
      const lines = t.booking ? wouldBook(books, tx, t.booking, context) : [];
      const bank = bankAccountFor(tx, context.bankAccounts);
      const now = bookedNow(books, tx, bank);
      const decided = bookedNow(books, tx, bank, true);
      return {
        ref: tx.ref, date: tx.date, amount: tx.amount, currency: tx.currency, direction: tx.direction,
        text: [tx.description, tx.counterparty && !tx.description.includes(tx.counterparty) ? tx.counterparty : ''].filter(Boolean).join(' · '),
        would: t.kind === 'ask' ? { kind: 'ask', question: t.question, lines } : { kind: 'book', lines },
        now,
        ...(JSON.stringify(decided) !== JSON.stringify(now) ? { beforeAi: decided } : {}),
        ...(deciderRow && ruleKey(deciderRow) !== key ? { decidedBy: deciderRow.id } : {}),
      };
    };
    // The accounts the rule books on: a booking on any other, as decided before the AI moved it, is a decision it would overrule.
    const own = new Set(t.kind === 'book' ? [t.booking.account, ...(t.booking.private && context.ownerAccount ? [context.ownerAccount] : [])] : []);
    const others: string[] = [];
    const elsewhere: BankTransaction[] = [];
    let otherwise = 0;
    let same = 0;
    const differs: BankTransaction[] = [];
    const against = new Map<NationalOverride, { count: number; payments: RuleOverride['payments'] }>();
    for (const tx of hits) {
      const p = facts.get(tx.ref)!;
      for (const other of on) {
        if (ruleKey(other.row) === key || !holds(other.placed, p)) continue;
        const o = overlaps.get(ruleKey(other.row)) ?? { row: other.row, shared: 0, theirs: 0 };
        o.shared++;
        const decider = ruleFor(placed, p);
        if (decider && ruleKey(pool[placed.indexOf(decider)].row) === ruleKey(other.row)) o.theirs++;
        overlaps.set(ruleKey(other.row), o);
      }
      // An ask rule asks first: it overrules nobody.
      if (t.kind === 'book') {
        const decided = bookedNow(books, tx, bankAccountFor(tx, context.bankAccounts), true);
        const off = decided.map((l) => l.account).filter((a) => a && !own.has(a));
        if (off.length) elsewhere.push(tx);
        for (const a of off) if (!others.includes(a)) others.push(a);
        const byItself = books.journalEntries.filter((e) => e.transactionRef === tx.ref).every((e) => e.rule === target.row.id && e.origin !== 'manual');
        const agrees = decided.length > 0 && sameLines(decided, wouldBook(books, tx, t.booking, context));
        if (agrees) same++;
        else if (decided.length && !byItself) { otherwise++; differs.push(tx); }
        // Only where it books: another rule deciding first books nothing by this one.
        const decider = ruleFor(placed, p);
        if (decider && ruleKey(pool[placed.indexOf(decider)].row) === key) {
          const { kinds, national } = departures(books, tx, t.booking, context);
          for (const kind of kinds) {
            const o = against.get(kind) ?? { count: 0, payments: [] };
            o.count++;
            if (o.payments.length < PREVIEW_EXAMPLES) o.payments.push({ ...payment(tx, p), national });
            against.set(kind, o);
          }
        }
      }
      if (examples.length < PREVIEW_EXAMPLES) examples.push(payment(tx, p));
    }
    const isPrivate = !!context.ownerAccount && others.includes(context.ownerAccount);
    const spread: RuleSpread | undefined = others.length >= 2 || isPrivate ? {
      accounts: others,
      private: isPrivate,
      payments: elsewhere.filter((tx) => !examples.some((x) => x.ref === tx.ref)).slice(0, PREVIEW_EXAMPLES).map((tx) => payment(tx, facts.get(tx.ref)!)),
    } : undefined;
    const listed = new Set([...examples, ...(spread?.payments ?? [])].map((x) => x.ref));
    const differ = differs.filter((tx) => !listed.has(tx.ref)).slice(0, PREVIEW_EXAMPLES).map((tx) => payment(tx, facts.get(tx.ref)!));
    return {
      key, year, matches: hits.length, examples, overlaps: [...overlaps.values()], loneWords: loneWords(target.placed),
      ...(spread ? { spread } : {}),
      ...(against.size ? { overrides: [...against].map(([kind, o]) => ({ kind, ...o })) } : {}),
      ...(t.kind === 'book' ? { otherwise, same, ...(differ.length ? { differ } : {}) } : {}),
    };
  });
}
