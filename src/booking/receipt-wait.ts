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
 * company's file its own choice, such as its bank or its rent). A company rule that books waits
 * for the receipt like the model: the receipt decides its rate (ruleVatCode), unless it books onto
 * one of the firm's money accounts, which is a transfer. A rule that asks first is the person's
 * wish to be asked: its question comes at once, and her answer books it.
 */
import { identify, signalsOfTransaction } from '../knowledge/counterparties.js';
import type { Knowledge } from '../knowledge/layers.js';
import { withoutInputTax } from '../engines/index.js';
import type { Books } from '../books/store.js';
import type { BankTransaction } from '../types/index.js';
import { mappedReceipts, ruleOfPayment, type ClassifyContext } from './classify.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { isSeparateFee } from './separate-fee.js';

export const RECEIPT_STEP = 'evidence.guide.yaml#rules';

/** Why a payment is booked without waiting for a receipt. */
export type NoWait =
  /** A receipt is linked. */
  | 'receipt'
  /** A person marked it: no receipt will come (BankTransaction.noReceiptNeeded); booked without input tax. */
  | 'marked'
  /** Nothing moved. */
  | 'zero'
  /** Money in claims no input tax; a customer payment without an invoice has its own question. */
  | 'incoming'
  /** The bank's own fee row of another payment: the statement is the evidence. */
  | 'separateFee'
  /** Money to one of the firm's own accounts, or a rule books it onto a money account. */
  | 'ownTransfer'
  /** A company rule says to ask about it first (a wish such as «frag mich bei Barbezügen»): its question comes at once. */
  | 'ruleAsks'
  /** Its business's file says its payments need no receipt. */
  | 'business'
  /** The firm claims no input tax (not registered, or the net tax rate method): a receipt changes no code. */
  | 'noInputTax';

export type ReceiptWait = { wait: false; why: NoWait } | { wait: true };

/** What the decision reads of one payment beside the payment itself. */
export interface WaitFacts {
  linked: boolean;
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
  /** The IBANs of the firm's own bank accounts, as ibanOf writes them. */
  ownIbans: ReadonlySet<string>;
  /** The accounts that hold money (src/booking/classify.ts moneyAccounts). */
  money: ReadonlySet<string>;
  /** The firm claims input tax (the effective method). */
  inputTax: boolean;
}

export function receiptWait(tx: BankTransaction, facts: WaitFacts, ctx: WaitContext): ReceiptWait {
  const book = (why: NoWait): ReceiptWait => ({ wait: false, why });
  if (facts.linked) return book('receipt');
  if (tx.noReceiptNeeded) return book('marked');
  if (tx.amount === 0) return book('zero');
  if (tx.direction === 'CRDT') return book('incoming');
  if (isSeparateFee(tx)) return book('separateFee');
  if ((tx.counterpartyIban && ctx.ownIbans.has(ibanOf(tx.counterpartyIban))) || (facts.ruleAccount && ctx.money.has(facts.ruleAccount))) return book('ownTransfer');
  if (facts.ruleAsks) return book('ruleAsks');
  if (facts.business && ctx.free.has(facts.business)) return book('business');
  if (!ctx.inputTax) return book('noInputTax');
  return { wait: true };
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
export function receiptWaitOf(books: Books, tx: BankTransaction, context: ClassifyContext, free: ReadonlySet<string>, fx: FxResolver): ReceiptWait {
  const linked = mappedReceipts(books, tx);
  const routing = identify(signalsOfTransaction(tx, linked), context.counterparties ?? []);
  const then = ruleOfPayment(books, tx, context, fx)?.rule.then;
  const ruleAccount = then?.kind === 'book' ? then.booking.account : then?.booking?.account;
  return receiptWait(tx, { linked: linked.length > 0, ...(routing.kind === 'known' && { business: routing.counterparty }), ...(ruleAccount && { ruleAccount }), ...(then?.kind === 'ask' && { ruleAsks: true }) }, {
    free,
    ownIbans: new Set(context.bankAccounts.flatMap((a) => (a.iban ? [ibanOf(a.iban)] : []))),
    money: context.moneyAccounts ?? new Set(),
    inputTax: withoutInputTax() === undefined,
  });
}
