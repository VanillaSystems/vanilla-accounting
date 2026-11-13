/**
 * Whether a payment waits for its receipt before it is booked (issue #29, owner 21.10.: «wait»).
 * A payment that needs a receipt is not booked while none is linked: no provisional booking, so
 * nothing is booked twice. It is booked once a receipt is linked; when its return comes near and
 * still none came, the person is asked (src/accounting/receipt-due.ts). A payment that needs no
 * receipt is booked at once.
 *
 * What needs no receipt is decided here in code, for any bank and any business: a payment
 * provider's payout (a settlement of its clearing account, never matched to a receipt, #203), money coming in,
 * a fee row of the bank (another payment's fee debited as a movement of its own, or the account's fee), a transfer between the firm's own accounts, a
 * payment a person marked as needing none, a firm that claims no input tax, and a business whose
 * file says so as `apply: { receipt: none }` on a rule of evidence.guide.yaml#rules (in the app's
 * file a fact for every company, such as an authority whose notice is filed apart; in the
 * company's file its own choice, such as its bank or its rent), and wording a guide's rule there
 * names as `apply: { receipt: none, text }` (in the app's guide the cash withdrawal, which only
 * moves money onto the cash box; issue #99). A wage on a firm that pays wages (`firm: employer` on such
 * a rule, issue #340) is freed from the wait only: its evidence is the payroll's payslip, but a
 * receipt that matches it is still paired and books it again, so a purchase worded like a wage loses
 * nothing. A payment booked onto a settlement
 * account (the owner's, a money account, a debt) pays what was booked elsewhere and never waits
 * (settlementAccount): by a rule, decided here; by the model, decided on its answer (answerSettles),
 * where the owner's account settles only a payment to the owner (issue #201). A payment to the owner by
 * name, no wage, that her outlays not paid back yet cover (src/booking/owner-outlays.ts) pays those
 * back: its receipts are the outlays' own, booked over her account, so it waits for none (#402).
 * Any other company rule that books waits for the receipt like the model: the receipt decides its
 * rate (ruleVatCode). A rule that asks first is the person's
 * wish to be asked: its question comes at once, and her answer books it.
 */
import { basename } from 'node:path';
import { identify, signalsOfTransaction } from '../knowledge/counterparties.js';
import type { Knowledge } from '../knowledge/layers.js';
import { baseCurrency, chart, withoutInputTax } from '../engines/index.js';
import { outlaysOpen } from './owner-outlays.js';
import type { Books } from '../books/store.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { mappedReceipts, ruleOfPayment, type ClassifyContext } from './classify.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { isBankFee } from './separate-fee.js';
import { businessVat } from './purchase-vat.js';
import { linkedOf, type Linked } from '../accounting/receipt-due.js';
import { bankAccountFor } from '../workspace/money-accounts.js';
import { providerOfPayment } from './providers.js';
import { employs } from '../workspace/setup.js';
import type { Workspace } from '../workspace/workspace.js';

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
  /** A payment provider's payout (src/booking/providers.ts): a settlement of its clearing account; its order documents prove the sales, not the payout (#203). */
  | 'provider'
  /** Money in claims no input tax; a customer payment without an invoice has its own question. */
  | 'incoming'
  /** A fee row of the bank, of another payment or of the account itself (isBankFee): the statement is the evidence. */
  | 'bankFee'
  /** Money to one of the firm's own accounts. */
  | 'ownTransfer'
  /** It is booked onto a settlement account (settlementAccount): the owner's, a money account, a debt such as an employee's or a card's. */
  | 'settlement'
  /** A company rule says to ask about it first (a wish such as «frag mich bei Barbezügen»): its question comes at once. */
  | 'ruleAsks'
  /** It pays the owner back her outlays, which her account holds not paid back yet (repaysOwner, #402): their receipts are booked with them. */
  | 'repaysOwner'
  /** Its business's file says its payments need no receipt. */
  | 'business'
  /** Its wording is one a guide's rule says needs no receipt (a cash withdrawal: money onto the cash box). */
  | 'wording'
  /** Its text is a wage's, on a firm that pays wages: booked without waiting, and still a candidate for a receipt (never in NONE_OF_ITS_OWN). */
  | 'wage'
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
  /** It is a payment provider's payout (providerOfPayment). */
  payout?: boolean;
  /** It pays the owner back her outlays (repaysOwner). */
  repaysOwner?: boolean;
}

/** What the decision reads of the firm. */
export interface WaitContext {
  /** The businesses whose payments need no receipt (receiptFree). */
  free: ReadonlySet<string>;
  /** The wordings of payments that need no receipt (receiptWordings), matched against the text and the counterparty. */
  wordings: readonly Wording[];
  /** The wordings of a wage, matched against the payment's text only; absent or empty on a firm that pays no wages. */
  wages?: readonly Wording[];
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
  if (facts.payout) return book('provider');
  if (tx.direction === 'CRDT') return book('incoming');
  if (isBankFee(tx)) return book('bankFee');
  if (tx.counterpartyIban && ctx.ownIbans.has(ibanOf(tx.counterpartyIban))) return book('ownTransfer');
  if (facts.ruleAccount && ctx.settles(facts.ruleAccount)) return book('settlement');
  if (facts.ruleAsks) return book('ruleAsks');
  if (facts.repaysOwner) return book('repaysOwner');
  if (facts.business && ctx.free.has(facts.business)) return book('business');
  if (ctx.wordings.some((w) => w.test(`${tx.description} ${tx.counterparty ?? ''}`))) return book('wording');
  // The text only: a counterparty may be called like a wage word (a surname, a place, a firm).
  if (ctx.wages?.some((w) => w.test(tx.description))) return book('wage');
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

/**
 * Whether the model's answer for a payment that needs a receipt only settles, so it is booked
 * without one (issue #90). The owner's account settles only a payment to the owner (her outlays or
 * her loan paid back): the model putting a supplier's payment there books it as private, which
 * hides the missing receipt and loses its input tax. That is a person's decision or a rule's,
 * never the stand-in for a receipt the run did not link (issue #201): the payment waits.
 */
export function answerSettles(tx: BankTransaction, entries: readonly Pick<JournalEntry, 'accountDebit' | 'accountCredit'>[], context: Pick<ClassifyContext, 'bankAccounts' | 'moneyAccounts' | 'ownerAccount' | 'ownerName'>): boolean {
  const settles = settlementAccount(context);
  const toOwner = paysOwner(tx, context.ownerName);
  return onlySettles(entries, bankAccountFor(tx, context.bankAccounts), (a) => (a === context.ownerAccount ? toOwner : settles(a)));
}

/**
 * Whether money out to the owner pays her outlays back (#402): her name as the payee (the
 * counterparty, never the text: PR #389), not a wage by the evidence rule's wording, in the books'
 * currency, and no more than the outlays her account holds not paid back up to its day.
 */
export function repaysOwner(books: Pick<Books, 'journalEntries' | 'transactions'>, tx: BankTransaction, context: Pick<ClassifyContext, 'ownerAccount' | 'ownerName' | 'moneyAccounts'>, wages: readonly Wording[]): boolean {
  if (tx.direction !== 'DBIT' || !context.ownerAccount || tx.currency !== baseCurrency()) return false;
  if (!paysOwner({ counterparty: tx.counterparty, description: '' }, context.ownerName) || wages.some((w) => w.test(tx.description))) return false;
  const open = outlaysOpen(books, context.ownerAccount, context.moneyAccounts ?? new Set(), tx.date, tx.ref);
  return open > 0 && Math.round(Math.abs(tx.amount) * 100) <= Math.round(open * 100);
}

/** Every word of the owner's name stands in the payment's counterparty or text («Anna Muster» in «Sent money to Anna Maria Muster»). */
export function paysOwner(tx: Pick<BankTransaction, 'counterparty' | 'description'>, owner: string | undefined): boolean {
  const words = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 1);
  const name = words(owner ?? '');
  const said = new Set(words(`${tx.counterparty ?? ''} ${tx.description}`));
  return name.length > 0 && name.every((w) => said.has(w));
}

const ibanOf = (iban: string) => iban.replace(/\s+/g, '').toUpperCase();
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A rule's `apply:` on evidence.guide.yaml#rules, in either layer: `{ receipt: none }` in a
 * business file (the business is the condition), `{ receipt: none, text: "<pattern>" }` in a guide
 * (it holds for every payment, so it names the wording: a pattern over the payment's text and
 * counterparty, ignoring case; `not`: a second pattern whose match takes the wording back). `firm: employer`
 * beside them makes it a wage's wording: only on a firm that pays wages (employs), read off the
 * payment's text alone, and freeing the payment from the wait only, never from pairing.
 */
export function parseReceiptApply(raw: unknown, where: 'business' | 'guide' = 'business'): { ok: true; text?: string; not?: string; firm?: 'employer' } | { ok: false; problem: string } {
  if (!isMap(raw)) return { ok: false, problem: `apply must be a map: { receipt: none${where === 'guide' ? ', text: "<pattern>"' : ''} }` };
  const { receipt, text, not, firm, ...rest } = raw;
  const extra = Object.keys(rest)[0];
  if (extra) return { ok: false, problem: `apply.${extra} is unknown — apply on ${RECEIPT_STEP} takes receipt${where === 'guide' ? ', text, not and firm' : ''}` };
  if (receipt !== 'none') return { ok: false, problem: 'apply.receipt must be none: the payments need no receipt to be booked' };
  if (where === 'business') return text === undefined && firm === undefined && not === undefined ? { ok: true } : { ok: false, problem: `apply.${text !== undefined ? 'text' : firm !== undefined ? 'firm' : 'not'} is for a guide\'s rule; in a business file the business is the condition` };
  if (firm !== undefined && firm !== 'employer') return { ok: false, problem: 'apply.firm must be employer: the wording holds only on a firm that pays wages' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, problem: 'apply.text must name the wording of the payments that need no receipt, a pattern such as "Bancomat|Bargeldbezug"' };
  try { new RegExp(text, 'i'); } catch { return { ok: false, problem: `apply.text "${text}" is no valid pattern` }; }
  if (not !== undefined) {
    if (typeof not !== 'string' || !not.trim()) return { ok: false, problem: 'apply.not must be a pattern: the wording does not hold for a payment it matches' };
    try { new RegExp(not, 'i'); } catch { return { ok: false, problem: `apply.not "${not}" is no valid pattern` }; }
  }
  return { ok: true, text, ...(typeof not === 'string' && { not }), ...(firm === 'employer' && { firm }) };
}

type Rules = { rules?: Array<{ id?: string; status?: string; apply?: unknown }> } | undefined;

/** A wording a guide's rule names: `text` matches and `not`, when there, does not. */
export interface Wording { test(s: string): boolean }

/** What the knowledge says to the decision: whose payments and which wordings need no receipt, a wage's wordings on a firm that pays wages, and whose unread receipt the company counts at a rate. */
export interface ReceiptKnowledge { free: ReadonlySet<string>; wordings: readonly Wording[]; wages: readonly Wording[]; assumesUnread: ReadonlySet<string> }

export function receiptKnowledge(k: Pick<Knowledge, 'counterpartyFiles' | 'guides'>, firm: Pick<Workspace, 'profile'>): ReceiptKnowledge {
  const { facts } = businessVat(k);
  return { free: receiptFree(k), wordings: receiptWordings(k), wages: employs(firm.profile) ? receiptWordings(k, 'employer') : [], assumesUnread: new Set([...facts].filter(([, fs]) => fs.some((f) => f.fact.kind === 'unreadReceipt')).map(([id]) => id)) };
}

/** The wordings the guides' rules of evidence.guide.yaml#rules, in either layer, say need no receipt: those for every firm, or (`firm`) those of a wage; a rule whose question is open says nothing. */
export function receiptWordings(k: Pick<Knowledge, 'guides'>, firm?: 'employer'): Wording[] {
  const [file, section] = RECEIPT_STEP.split('#');
  return k.guides.filter((g) => basename(g.path) === file).flatMap((g) => (g.body.steps?.[section] as Rules)?.rules ?? []).flatMap((r) => {
    const parsed = r.apply !== undefined && r.status !== 'open' ? parseReceiptApply(r.apply, 'guide') : undefined;
    if (!parsed?.ok || !parsed.text || parsed.firm !== firm) return [];
    const [text, not] = [new RegExp(parsed.text, 'i'), parsed.not ? new RegExp(parsed.not, 'i') : undefined];
    return [{ test: (s: string) => text.test(s) && !not?.test(s) }];
  });
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
  const payout = !!providerOfPayment(tx, linked, context.counterparties ?? []);
  const repays = repaysOwner(books, tx, context, known.wages);
  return receiptWait(tx, { linked: linkedOf(linked, tx), ...(routing.kind === 'known' && { business: routing.counterparty }), ...(ruleAccount && { ruleAccount }), ...(then?.kind === 'ask' && { ruleAsks: true }), ...(payout && { payout }), ...(repays && { repaysOwner: true }) }, {
    ...known,
    ownIbans: new Set(context.bankAccounts.flatMap((a) => (a.iban ? [ibanOf(a.iban)] : []))),
    settles: settlementAccount(context),
    inputTax: withoutInputTax() === undefined,
  });
}

/** Why a payment has no receipt of its own: the matching chain never pairs one (#187), nor the model's match. Money in, a rule that asks first, a wage and a firm without input tax still take a receipt; a provider's payout never does (#203). */
const NONE_OF_ITS_OWN: ReadonlySet<NoWait> = new Set<NoWait>(['marked', 'zero', 'provider', 'bankFee', 'ownTransfer', 'settlement', 'business', 'wording', 'repaysOwner']);

/** A booking the app made on its own (the classifier, by a rule, a check of code or the model): never one a person made or decided. */
export const appBooked = (e: JournalEntry): boolean => e.origin === 'classify' && (!e.by || e.by.kind === 'rule' || e.by.kind === 'code' || e.by.kind === 'model');

/**
 * The payments that have no receipt of their own, by the same decision as the wait for one
 * (receiptWait), and a payment already booked onto the owner's account or another money account
 * only (an outlay paid back, a transfer, issue #90): what the matching chain never pairs. A booking
 * onto a debt is no sign: on the agreed basis an invoice's payment settles the payables. Nor is a
 * booking the app made without a receipt (the model's answer for a payment no receipt had reached
 * yet): a receipt that matches it later is the better evidence, and the classifier books the
 * payment again once it is linked (entriesWithoutTheirReceipts), so the order in which statements
 * and receipts arrive decides nothing.
 */
export function noReceiptOfItsOwn(books: Books, context: ClassifyContext, known: ReceiptKnowledge, fx: FxResolver): (tx: BankTransaction) => boolean {
  const settles = (account: string) => account === context.ownerAccount || !!context.moneyAccounts?.has(account);
  // The entries by payment, listed on the first question: the chain asks it of every payment, and books nothing meanwhile.
  let byRef: Map<string | undefined, JournalEntry[]> | undefined;
  const entriesOf = (ref: string) => {
    if (!byRef) {
      byRef = new Map();
      for (const e of books.journalEntries) { const list = byRef.get(e.transactionRef); if (list) list.push(e); else byRef.set(e.transactionRef, [e]); }
    }
    return byRef.get(ref) ?? [];
  };
  return (tx) => {
    const w = receiptWaitOf(books, tx, context, known, fx);
    if (!w.wait && NONE_OF_ITS_OWN.has(w.why)) return true;
    const entries = entriesOf(tx.ref);
    if (!entries.length || entries.every((e) => appBooked(e) && e.receipts?.length === 0)) return false;
    try { return onlySettles(entries, bankAccountFor(tx, context.bankAccounts), settles); } catch { return false; }
  };
}
