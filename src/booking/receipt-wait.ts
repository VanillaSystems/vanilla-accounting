/**
 * Whether a payment waits for its receipt before it is booked (issue #29, owner 21.10.: «wait»).
 * A payment that needs a receipt is not booked while none is linked: no provisional booking, so
 * nothing is booked twice. It is booked once a receipt is linked; when its return comes near and
 * still none came, the person is asked (src/accounting/receipt-due.ts). A payment that needs no
 * receipt is booked at once.
 *
 * What needs no receipt is decided here in code, for any bank and any business: money coming in,
 * a fee the bank debits as a movement of its own, a transfer between the firm's own accounts, a
 * payment a person marked as needing none, a firm that claims no input tax, and a business whose
 * file says so as `apply: { receipt: none }` on a rule of evidence.guide.yaml#rules (in the app's
 * file a fact for every company, such as an authority whose notice is filed apart; in the
 * company's file its own choice, such as its bank or its rent). A payment booked onto a settlement
 * account (the owner's, a money account, a debt) pays what was booked elsewhere and never waits
 * (settlementAccount): by a rule, decided here; by the model, decided on its answer (onlySettles).
 * Any other company rule that books waits for the receipt like the model: the receipt decides its
 * rate (ruleVatCode). A rule that asks first is the person's
 * wish to be asked: its question comes at once, and her answer books it.
 */
import { identify, signalsOfTransaction } from '../knowledge/counterparties.js';
import type { Knowledge } from '../knowledge/layers.js';
import { chart, withoutInputTax } from '../engines/index.js';
import type { Books } from '../books/store.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { mappedReceipts, ruleOfPayment, type ClassifyContext } from './classify.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { isSeparateFee } from './separate-fee.js';
import { businessVat } from './purchase-vat.js';
import { linkedOf, type Linked } from '../accounting/receipt-due.js';

export const RECEIPT_STEP = 'evidence.guide.yaml#rules';

/** Why a payment is booked without waiting for a receipt. */
export type NoWait =
  /** A receipt is linked, and its VAT is read. */
  | 'receipt'
  /** Its receipt could not be read, and the company's rule says at which rate such a receipt of the business counts (`apply: { unreadReceipt }`). */
  | 'companyRate'
  /** A person marked it: no receipt will come (BankTransaction.noReceiptNeeded); booked without input tax. */
  | 'marked'
  /** Nothing moved. */
  | 'zero'
  /** Money in claims no input tax; a customer payment without an invoice has its own question. */
  | 'incoming'
  /** The bank's own fee row of another payment: the statement is the evidence. */
  | 'separateFee'
  /** Money to one of the firm's own accounts. */
  | 'ownTransfer'
  /** It is booked onto a settlement account (settlementAccount): the owner's, a money account, a debt such as an employee's or a card's. */
  | 'settlement'
  /** A company rule says to ask about it first (a wish such as «frag mich bei Barbezügen»): its question comes at once. */
  | 'ruleAsks'
  /** Its business's file says its payments need no receipt. */
  | 'business'
  /** The firm claims no input tax (not registered, or the net tax rate method): a receipt changes no code. */
  | 'noInputTax';

export type ReceiptWait = { wait: false; why: NoWait } | { wait: true; unread?: true };

/** What the decision reads of one payment beside the payment itself. */
export interface WaitFacts {
  /** What its linked receipts say (src/accounting/receipt-due.ts linkedOf). */
  linked: Linked;
  /** The business it routes to. */
  business?: string;
  /** The account a company rule books it on. */
  ruleAccount?: string;
  /** A company rule says to ask the person about it first. */
  ruleAsks?: boolean;
}

/** What the decision reads of the firm. */
export interface WaitContext {
  /** The businesses whose payments need no receipt (receiptFree). */
  free: ReadonlySet<string>;
  /** The businesses whose unread receipt the company counts at a rate (purchase-vat.ts, `apply: { unreadReceipt }`). */
  assumesUnread: ReadonlySet<string>;
  /** The IBANs of the firm's own bank accounts, as ibanOf writes them. */
  ownIbans: ReadonlySet<string>;
  /** Whether a booking onto this account settles money owed or moves money (settlementAccount). */
  settles: (account: string) => boolean;
  /** The firm claims input tax (the effective method). */
  inputTax: boolean;
}

export function receiptWait(tx: BankTransaction, facts: WaitFacts, ctx: WaitContext): ReceiptWait {
  const book = (why: NoWait): ReceiptWait => ({ wait: false, why });
  if (facts.linked === 'read') return book('receipt');
  if (tx.noReceiptNeeded) return book('marked');
  if (tx.amount === 0) return book('zero');
  if (tx.direction === 'CRDT') return book('incoming');
  if (isSeparateFee(tx)) return book('separateFee');
  if (tx.counterpartyIban && ctx.ownIbans.has(ibanOf(tx.counterpartyIban))) return book('ownTransfer');
  if (facts.ruleAccount && ctx.settles(facts.ruleAccount)) return book('settlement');
  if (facts.ruleAsks) return book('ruleAsks');
  if (facts.business && ctx.free.has(facts.business)) return book('business');
  if (!ctx.inputTax) return book('noInputTax');
  if (facts.linked === 'unread') return facts.business && ctx.assumesUnread.has(facts.business) ? book('companyRate') : { wait: true, unread: true };
  return { wait: true };
}

/**
 * Whether a booking onto `account` settles: the owner's account (an outlay paid back, booking.guide.yaml
 * cls-owner-account), a money account (cash, a bank, a transfer), or any debt of the chart (an
 * employee's outlays, a card's bill, a loan). Such a payment pays what was booked or owed
 * elsewhere: it carries no VAT and has no receipt of its own (issue #90). Read off the chart and
 * the manifest, never a list of businesses.
 */
export function settlementAccount(context: Pick<ClassifyContext, 'moneyAccounts' | 'ownerAccount'>): (account: string) => boolean {
  return (account) => !!context.moneyAccounts?.has(account) || account === context.ownerAccount || chart().typeOf(account) === 'liability';
}

/** Whether the classifier's entries of a payment only settle (settlementAccount): each line's other side than the bank is such an account. */
export function onlySettles(entries: readonly Pick<JournalEntry, 'accountDebit' | 'accountCredit'>[], bankAccount: string, settles: (account: string) => boolean): boolean {
  return entries.length > 0 && entries.every((e) => [e.accountDebit, e.accountCredit].filter((a) => a && a !== bankAccount).every(settles));
}

const ibanOf = (iban: string) => iban.replace(/\s+/g, '').toUpperCase();
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A rule's `apply:` on evidence.guide.yaml#rules in a business file: `{ receipt: none }`, in either layer. */
export function parseReceiptApply(raw: unknown): { ok: true } | { ok: false; problem: string } {
  if (!isMap(raw)) return { ok: false, problem: 'apply must be a map: { receipt: none }' };
  const { receipt, ...rest } = raw;
  const extra = Object.keys(rest)[0];
  if (extra) return { ok: false, problem: `apply.${extra} is unknown — apply on ${RECEIPT_STEP} takes receipt` };
  return receipt === 'none' ? { ok: true } : { ok: false, problem: 'apply.receipt must be none: the business\'s payments need no receipt to be booked' };
}

type Rules = { rules?: Array<{ id?: string; status?: string; apply?: unknown }> } | undefined;

/** What the business files say to the decision: whose payments need no receipt, and whose unread receipt the company counts at a rate. */
export interface ReceiptKnowledge { free: ReadonlySet<string>; assumesUnread: ReadonlySet<string> }

export function receiptKnowledge(k: Pick<Knowledge, 'counterpartyFiles'>): ReceiptKnowledge {
  const { facts } = businessVat(k);
  return { free: receiptFree(k), assumesUnread: new Set([...facts].filter(([, fs]) => fs.some((f) => f.fact.kind === 'unreadReceipt')).map(([id]) => id)) };
}

/** The businesses whose file, in either layer, says their payments need no receipt; a rule whose question is open says nothing. */
export function receiptFree(k: Pick<Knowledge, 'counterpartyFiles'>): Set<string> {
  const free = new Set<string>();
  for (const f of k.counterpartyFiles) {
    const rules = (f.body.steps?.[RECEIPT_STEP] as Rules)?.rules ?? [];
    if (f.body.id && rules.some((r) => r.apply !== undefined && r.status !== 'open' && parseReceiptApply(r.apply).ok)) free.add(f.body.id);
  }
  return free;
}

/** Whether `tx` waits for its receipt, from the books and what the classifier knows of the firm. */
export function receiptWaitOf(books: Books, tx: BankTransaction, context: ClassifyContext, known: ReceiptKnowledge, fx: FxResolver): ReceiptWait {
  const linked = mappedReceipts(books, tx);
  const routing = identify(signalsOfTransaction(tx, linked), context.counterparties ?? []);
  const then = ruleOfPayment(books, tx, context, fx)?.rule.then;
  const ruleAccount = then?.kind === 'book' ? then.booking.account : then?.booking?.account;
  return receiptWait(tx, { linked: linkedOf(linked), ...(routing.kind === 'known' && { business: routing.counterparty }), ...(ruleAccount && { ruleAccount }), ...(then?.kind === 'ask' && { ruleAsks: true }) }, {
    ...known,
    ownIbans: new Set(context.bankAccounts.flatMap((a) => (a.iban ? [ibanOf(a.iban)] : []))),
    settles: settlementAccount(context),
    inputTax: withoutInputTax() === undefined,
  });
}
