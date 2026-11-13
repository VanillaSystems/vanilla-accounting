/**
 * A bank payment booked by hand, without the AI (MISSION.md: an accountant without a subscription
 * books what the classifier would): the form's first lines, decided by rules only, and whether
 * the lines add up to the payment. The write is src/server/edits.ts bookPayment.
 */
import type { BankTransaction, Index, JournalEntry, Receipt } from '../types/index.js';
import { partsOf, partText } from './batch-parts.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import { paymentSides, type PaymentSide } from './payment-entries.js';
import { codeOnAccount, formTakes, lookupVatCode, vatCodeOf } from './vat-codes.js';
import { agreedBasis, chart, filing, invoicing, vat, vatSetup, withoutInputTax } from '../engines/index.js';
import { methodOf } from '../workspace/vat-setup.js';
import { saleProofOf } from './sale-document.js';
import { fromRappen, toRappen } from './rappen.js';
import { hasEvent, isManualRef } from '../books/refs.js';
import type { Tags } from '../books/tags.js';
import type { Invoice } from '../invoices/model.js';
import { namedInvoice, namesNumber, openAmount, revenueSplit } from '../invoices/rules.js';
import { saleProposal, saleVatCode } from './sales-without-vat.js';
import type { SaleChoice } from '../questions/model.js';
import { isPurchaseDocument } from './evidence-check.js';
import { documentDates, openItemAccounts, sideOf, taxPointOf } from './tax-point.js';
import { dayLock } from '../books/lock-line.js';
import { issuedByFirm, ownNumbers } from '../intake/own-invoice.js';
import { paymentText, paysIn } from '../intake/pairing.js';
import { squash, tokensIn } from './document-numbers.js';
import { gapOf } from '../intake/near-pairs.js';
import { refundedPurchase } from '../booking/refund-code.js';

/** One line of the booking, in the payment's currency. */
export interface BookingLine { accountDebit: string; accountCredit: string; amount: number; vatCode?: string; description: string; tags?: Tags }

/**
 * Where a proposed account or VAT code of a line comes from, said beside it in a few words (#344):
 * a company rule, the business's last booking, the business's own account (its file), the linked
 * receipt, the issued invoice the payment names, the firm's default account for sales, the owner's
 * account, the app's proposal for a sale without an invoice (saleProposal), a supplier's refund.
 */
export interface DraftSource {
  account?: { from: 'rule'; rule: string } | { from: 'precedent'; date: string; yours?: true; name?: string } | { from: 'refund'; date: string } | { from: 'sales' | 'owner' | 'business' | 'bankFee' | 'wage' | 'ownerOutlays' } | { from: 'invoice' | 'receivable'; number: string } | { from: 'clearing'; provider: string };
  /** `abroad`: the firm's own invoice says its service is supplied abroad (invoicing placeAbroad). `noReceipt`: the last booking's code claimed input tax, which a payment without a receipt does not (#397). */
  vat?: { from: 'rule' | 'precedent' | 'receipt' | 'invoice' | 'netRate' | 'refund' | 'abroad' | 'noReceipt' } | { from: 'sale'; choice: SaleChoice }
    /** A supplier's refund without a credit note: the code of the purchase it refunds, with the minus (#357, refundedPurchase). `refund` above: no purchase was found unambiguously. */
    | { from: 'purchase'; date: string; code: string };
}

/**
 * What a line's `vat` is as a person would type it: a code, or a receipt's rate («8.1») that the
 * form turns into the code of whatever account stands in the field (vatCodeOf). A receipt gives the
 * rate, never a code, so the code follows the account she chooses (#344). `source`: what of it is a
 * proposal, and from where; `tags`: the dimensions a rule puts on its lines.
 */
export interface DraftLine { accountDebit: string; accountCredit: string; amount: number; vat: string; description: string; source?: DraftSource; tags?: Tags }

/**
 * What a payment is, as the server knows it from the firm's files (src/saving/hand-rule.ts
 * handStart): money between the firm's own accounts, money from the owner (her name in the
 * payment, receipt-wait.ts paysOwner), money from an authority (a business of that role), or a
 * provider's payout (PayoutNature). None of them is a sale.
 */
export type PaymentNature =
  | { kind: 'ownTransfer' }
  | { kind: 'owner'; account: string }
  | { kind: 'authority'; name: string }
  | PayoutNature
  /** The bank's own fee row (src/booking/bank-fee.ts): its account, or the one the firm's chart lacks. */
  | { kind: 'bankFee'; account: string } | { kind: 'bankFee'; missing: { account: string; name: string } }
  /** A wage on a firm that pays wages (src/booking/receipt-wait.ts `wage`): the firm's wage account (setup.yaml `wages`), booked without a VAT code (guide cls-salary). */
  | { kind: 'wage'; account: string }
  /** A wage on a firm whose books carry wages with their deductions (on `deductions`): no account is proposed. */
  | { kind: 'wage'; deductions: string }
  /** Money out to the owner that pays back her outlays, which her account holds not paid back (`open`, src/booking/owner-outlays.ts, #402): her account, without a code. */
  | { kind: 'ownerOutlays'; account: string; open: number; judged?: true }
  /** Money out to the owner in a foreign currency: her outlays are kept in the books' currency, so nothing is proposed and the form says why (#402). */
  | { kind: 'ownerForeign'; currency: string }
  /** Money out to the owner in the books' currency that her outlays booked do not cover (#428): the form says what ends its wait. */
  | { kind: 'ownerWaits'; account: string; open: number; owner: string }
  /** Social insurance contributions (#470), a proposal: `takes` (of `open`, what the deductions account holds on the day) on it, the rest on the employer's contribution account `account`, without a code. */
  | ContributionsNature;

export interface ContributionsNature { kind: 'contributions'; account: string; deductions: string; open: number; takes: number }

/**
 * A payment provider's payout (#404, src/booking/providers.ts): a settlement of what the provider
 * holds, never a sale. `ready`: code books it bank / its clearing account `account` without VAT;
 * `clearing`, `since`: the company's file lacks it, the provider's report asks; `gap`: before the
 * cut-over day beside sales a report booked, hers to decide; `before`: before the cut-over day, booked
 * as the payouts before it were (the business's last booking proposed, never the default sale).
 * `sales`: the provider's file names a sales report (its order export); without one, its payout report
 * books its sales.
 */
export interface PayoutNature { kind: 'payout'; provider: string; why: 'ready' | 'clearing' | 'since' | 'gap' | 'before'; account?: string; since?: string; sales?: boolean }

/** What code knows beside the books when the form opens. */
export interface DraftKnowledge {
  /** The firm's default accounts (the setup's): `sales` is proposed for a sale. */
  defaults?: { sales?: string; purchase?: string };
  /** The company rule that decides the payment, with the lines it would book; `ask`: its question, when the rule asks first. */
  rule?: { id: string; lines: ReadonlyArray<{ account: string; vat?: string; amount: number; against?: string }>; ask?: string; tags?: Tags };
  /** What the payment is, beside a sale or a purchase (PaymentNature). */
  nature?: PaymentNature;
  /** The one account the business's file allows (Counterparty.accounts). */
  account?: string;
  /** The account an issued invoice's revenue goes on (invoicing.revenueAccount). */
  invoiceRevenue?: string;
  /** The chart's account numbers: the open-item account (Debitoren) is the first candidate it has. */
  chart?: readonly string[];
  /** The firm's own UID: a linked document with another is a business's, not the firm's own invoice. */
  ownUid?: string;
  /** The firm's name: without a UID it tells the firm's own invoice (src/intake/own-invoice.ts issuedByFirm). */
  firmName?: string;
  /** A receipt she said is not the invoice this payment pays: the form proposes without it. */
  notOwnInvoice?: string;
  /** Whether a receipt's words name an account of the chart by a hint, as a whole word: the account list then stands in their order, and the form says so (#397). */
  ranks?(words: readonly string[]): boolean;
  /** A receipt that may be this payment's but is not linked (src/intake/near-pairs.ts, #397): its name, the rate it shows, what differs. */
  near?: { name: string; rate?: number; why: string };
  /** The payments out whose text is a wage (HandStart.wages): an earlier payment is a precedent only when it is of this payment's kind (#402). */
  wages?: readonly string[];
}

/**
 * A fact the form says under the lines, in plain words: the payment is taken for a sale, it moves
 * money between own accounts, comes from an authority, a supplier's document is linked, a payout
 * waits, the account is hers to choose, the sale's VAT is not read off its document, a rule asks
 * first, or (agreed basis) the receipt is dated in another period than the payment.
 */
export type DraftNote =
  | { kind: 'sale' }
  | { kind: 'refund' }
  | { kind: 'owner' }
  | { kind: 'ownerOutlays'; open: number; judged?: true }
  | { kind: 'ownerForeign'; currency: string }
  | { kind: 'ownerWaits'; account: string; open: number; owner: string }
  | ContributionsNature
  | { kind: 'invoicePaid'; number: string; surplus: number }
  | { kind: 'prepayment'; number: string }
  | { kind: 'unloaded' }
  | { kind: 'ownTransfer' }
  | { kind: 'authority'; name: string }
  | { kind: 'supplierDocument' }
  | PayoutNature
  | { kind: 'bankChargesMissing'; account: string; name: string }
  | { kind: 'chooseAccount' }
  /**
   * No sale code proposed, and the form asks the sale question: the document's VAT is not read or
   * shows neither a Swiss rate nor a place of supply abroad, it shows a foreign VAT, its groups do
   * not add up to the payment, the payment names an invoice of hers the form cannot take, or (no
   * document) the money came from abroad.
   */
  | { kind: 'saleVat'; why: 'notRead' | 'noVat' | 'payerAbroad' | 'foreignVat' | 'mixed' | 'namedInvoice' }
  /** A mixed invoice's part without Swiss VAT that it does not prove abroad: that line has no code. */
  | { kind: 'saleZeroPart' }
  /** More than what is open of her invoice: the rest is a line without an account. */
  | { kind: 'ownInvoiceSurplus'; number: string; surplus: number }
  /** Wages here are booked with their deductions (the deductions account carries them): the form proposes no account. */
  | { kind: 'wageDeductions'; account: string }
  | { kind: 'ask'; question: string }
  /** On the agreed basis a line with a VAT code is booked on its receipt's day over the open item `account`, which the payment settles (atTaxPoint, #360). */
  | { kind: 'taxPoint'; date: string; account: string }
  /** On the agreed basis the receipt is of a filed period: the line stays on the payment's day, declared in that period's correction. */
  | { kind: 'taxPointCorrects'; date: string; corrects: string }
  /** A receipt may be this payment's (DraftKnowledge.near): linked, its rate would apply (#397). */
  | { kind: 'nearReceipt'; name: string; rate?: number; why: string; vat: boolean }
  /** No account proposed, and the account list stands in the order of what the linked receipt names (#397). */
  | { kind: 'rankedByReceipt' }
  /** Money out with no proposal at all: why, in one line (#397). */
  | { kind: 'noProposal'; name: string; linked: boolean }
  /**
   * The linked receipt was paid less a cash discount: what is booked is what was paid (guide
   * spl-skonto, #397). `vat`: its input tax counts on the paid amount; `none`: the firm claims none;
   * `rates`: the receipt states several rates, which the paid amount does not split by itself.
   */
  | { kind: 'discount'; percent: number; amount: number; vat: 'paid' | 'none' | 'rates' };

export interface BookingDraft {
  ref: string;
  /** The payment's: under cash basis every line carries it. */
  date: string;
  currency: string;
  /** The ledger account of the bank the payment moved, and the side it stands on (money out: Haben). */
  bank?: { account: string; side: 'accountDebit' | 'accountCredit' };
  /** The receipts linked now: the entries record them, so a later run keeps the booking. */
  receipts: string[];
  lines: DraftLine[];
  /** The earlier booking of the same vendor the account was taken from. */
  precedent?: Pick<JournalEntry, 'id' | 'transactionRef' | 'date'>;
  /** The payment names an invoice that was cancelled: no revenue, no precedent; the form says so (r8c-5). */
  cancelledInvoice?: { id: string; number: string };
  /**
   * The payment names an issued invoice: its payment is confirmed on the invoice, which links it.
   * `settles`: the books carry the invoice's event (agreed basis), so its revenue is booked and the
   * payment only settles the receivable; else the invoice's own lines and codes are the proposal.
   */
  invoice?: { id: string; number: string; settles: boolean };
  /**
   * The firm's own invoices among the receipts whose numbers the payment names (#382, ownInvoicesOf).
   * `from`: the proposal is read off them ('invoice') or comes from elsewhere (a rule, the owner:
   * 'other'). `links`: what booking links. `earlier`: the day of the payment the invoice is linked
   * to already (an instalment).
   */
  ownInvoice?: { id: string; number: string; file: string; links: string[]; from: 'invoice' | 'other'; earlier?: string };
  /** What the linked purchase document's lines say, for the account list to rank by (the standard chart's hints). */
  words?: string[];
  notes: DraftNote[];
}

type Books = Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts' | 'config'>;

const vatRates = (r: Receipt) => (r.hasSwissVat ? (r.vatSummary ?? []).filter((g) => g.ratePercent > 0) : []);
const gross = (g: NonNullable<Receipt['vatSummary']>[number]) => g.gross ?? (g.net !== undefined ? g.net + g.vat : undefined);
const norm = (s: string | undefined) => s?.toLowerCase().replace(/[^a-z0-9äöü]/g, '') || undefined;
/** A document a sale's VAT may be read off: an invoice or a sales record, never a delivery note, a statement or noise. */
const isSaleDocument = (r: Pick<Receipt, 'kind'>) => r.kind === undefined || r.kind === 'invoice' || r.kind === 'sales-record';

/** The VAT numbers and the vendors of a payment's receipts, each normalized: what names its other party for certain. */
export function receiptKeys(books: Pick<Books, 'mappings' | 'receipts'>, tx: Pick<BankTransaction, 'ref'>): { uids: Set<string>; vendors: Set<string> } {
  const ids = new Set(books.mappings.filter((m) => m.transactionRef === tx.ref).map((m) => m.receiptId));
  const receipts = books.receipts.filter((r) => ids.has(r.id));
  const set = (keys: Array<string | undefined>) => new Set(keys.filter((k): k is string => !!k));
  return { uids: set(receipts.map((r) => norm(r.vatId))), vendors: set(receipts.map((r) => norm(r.title?.vendor))) };
}

/** What names the other party of a payment: the VAT numbers and vendors of its receipts, the bank's counterparty. */
function vendorKeys(books: Books, tx: BankTransaction): Set<string> {
  const { uids, vendors } = receiptKeys(books, tx);
  return new Set([...uids, ...vendors, norm(tx.counterparty)].filter((k): k is string => !!k));
}

/** A booking the model decided (#382): a person's or a rule's booking of the same business comes before it, and only those are said to be hers. */
const byModel = (e: JournalEntry): boolean => e.by?.kind === 'model' || (!e.by && (e.origin === undefined || e.origin === 'classify') && !e.rule);
/** A booking a person or a rule decided: «deine letzte Buchung» (never one code booked by itself, a sales report's or an invoice's event). */
const decided = (e: JournalEntry): boolean => e.origin === 'manual' || !!e.rule || e.by?.kind === 'person' || e.by?.kind === 'rule' || e.by?.kind === 'assistant';

/**
 * The newest booking of the same vendor's other payments whose bank stands on `side` and whose other
 * account is not a bank (`only`: of that class), with that entry. Its account on the side opposite
 * the bank is the precedent.
 */
function newestOf(books: Books, tx: BankTransaction, side: 'accountDebit' | 'accountCredit', bankAccounts: Set<string>, only?: string, wages?: ReadonlySet<string>) {
  const mine = vendorKeys(books, tx);
  if (!mine.size) return undefined;
  const other = side === 'accountDebit' ? 'accountCredit' : 'accountDebit';
  const byRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const same = new Map<string, boolean>();
  // Of one kind (#402): a wage's precedent is a wage, any other payment's is no wage, so a salary's account never comes onto an outlay paid back to the same person.
  const wage = !!wages?.has(tx.ref);
  const isSame = (ref: string) => {
    if (!same.has(ref)) { const t = byRef.get(ref); same.set(ref, !!t && !!wages?.has(ref) === wage && [...vendorKeys(books, t)].some((k) => mine.has(k))); }
    return same.get(ref)!;
  };
  // The newest payment's legs: an expense or revenue leg before an asset one (a ladder beside the paint, r6h-27), the larger first.
  const onResult = (e: JournalEntry) => { const t = chart().typeOf(e[other]!); return t === 'expense' || t === 'revenue' ? 1 : 0; };
  const hit = (books.journalEntries ?? [])
    .filter((e) => e.transactionRef !== tx.ref && e.origin !== 'year-close' && bankAccounts.has(e[side]) && e[other] && !bankAccounts.has(e[other]) && (!only || chart().typeOf(e[other]!) === only) && isSame(e.transactionRef))
    .sort((a, b) => Number(byModel(a)) - Number(byModel(b)) || b.date.localeCompare(a.date) || onResult(b) - onResult(a) || Number(b.amount) - Number(a.amount))[0];
  const name = hit && (byRef.get(hit.transactionRef)?.counterparty?.trim() || undefined);
  return hit && { account: hit[other], vatCode: hit.vatCode, entry: { id: hit.id, transactionRef: hit.transactionRef, date: hit.date }, ...(decided(hit) && { yours: true as const }), ...(name && { name }) };
}

/**
 * The purchase a payment in from a business the firm buys from would refund: its newest one on an
 * expense, when the payment is no more than the firm paid that business and its text names none of
 * the firm's own invoices. Else undefined: a business that is also a customer pays for a sale.
 */
function refundOf(books: Books, tx: BankTransaction, bankAccounts: Set<string>, amount: number, invoices: readonly Invoice[] | undefined) {
  const bought = newestOf(books, tx, 'accountCredit', bankAccounts, 'expense');
  if (!bought) return undefined;
  const mine = vendorKeys(books, tx);
  const byRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const spent = (books.journalEntries ?? []).filter((e) => e.transactionRef !== tx.ref && bankAccounts.has(e.accountCredit) && chart().typeOf(e.accountDebit) === 'expense'
    && [...vendorKeys(books, byRef.get(e.transactionRef) ?? ({ ref: e.transactionRef } as BankTransaction))].some((k) => mine.has(k)))
    .reduce((s, e) => s + toRappen(Number(e.amount)), 0);
  const text = [tx.description, tx.reference ?? ''].join(' ');
  const ours = (invoices ?? []).some((i) => i.status === 'issued' && namesNumber(text, i.number));
  return toRappen(amount) <= spent && !ours ? bought : undefined;
}

/**
 * The draft without any proposal, for a form whose knowledge from the server did not come (a
 * failed or slow request): the bank side and the amounts only, and a note that says so. A client
 * guess would book an owner's deposit or a transfer as revenue.
 */
export function withoutProposal(d: BookingDraft): BookingDraft {
  const lines = d.lines.map((l) => ({
    accountDebit: d.bank?.side === 'accountDebit' ? d.bank.account : '', accountCredit: d.bank?.side === 'accountCredit' ? d.bank.account : '',
    amount: l.amount, vat: '', description: l.description,
  }));
  const { precedent: _p, invoice: _i, ...rest } = d;
  return { ...rest, lines, notes: [{ kind: 'unloaded' }] };
}

/**
 * The code the app books for a payment without a receipt, from the vendor's last booking (r4c-5):
 * its code, but the zero code where that claimed input tax (no receipt, no input tax); nothing
 * where the firm's form takes no such code.
 */
function withoutReceipt(code: string | undefined): string {
  if (!code || !lookupVatCode(code)) return '';
  const zero = inputTaxWithoutReceipt(code) ?? code;
  return formTakes(zero) ? zero : '';
}

/** A purchase code with the minus: a supplier's refund booked so. */
const REFUND_CODE = /^-[MI]\d+$/;

/** A code the firm's form takes, else nothing: a proposal never offers a code the booking would refuse. */
const taken = (code: string | null | undefined): string => (code && formTakes(code) ? code : '');

/** A sale's code, or for a mixed document a line per VAT group, with where it comes from. */
interface SaleVat { vat: string; source?: DraftSource['vat']; note?: DraftNote; parts?: Array<{ amount: number; vat: string; source?: DraftSource['vat'] }> }

/**
 * The VAT of a sale of `amount`, proposed only for what its documents PROVE (#382, saleProofOf): none
 * for a firm not registered; on the net tax rate method the firm's approved rate's code, or the
 * abroad code where the document proves the supply abroad; without a document the app's proposal for
 * a domestic sale (saleProposal), while money from abroad (a foreign IBAN, a foreign currency)
 * proposes no code and the form asks; with documents that show Swiss rates their rate (a mixed one:
 * a line per group, the zero group at the abroad code where the document proves it, else without a
 * code); with documents that prove the supply abroad the abroad code; in every other case (not read,
 * no VAT and no place abroad, a foreign VAT, a VAT wording included) no code, and the form asks the
 * sale question.
 */
function saleVat(tx: BankTransaction, docs: readonly Receipt[], amount: number): SaleVat {
  const setup = vatSetup();
  if (!setup.registered) return { vat: '' };
  if (!docs.length) {
    const sale = saleProposal(tx);
    if (sale.choice !== 'saleDomestic') return { vat: '', note: { kind: 'saleVat', why: 'payerAbroad' } };
    const code = taken(saleVatCode(sale.choice));
    return code ? { vat: code, source: { from: 'sale', choice: sale.choice } } : { vat: '' };
  }
  const abroadCode = taken(vat().codes.deductedIn(invoicing().exemptions.abroad));
  const abroad = (): SaleVat => (abroadCode ? { vat: abroadCode, source: { from: 'abroad' } } : { vat: '' });
  const proofs = docs.map(saleProofOf);
  // On the net tax rate method the same rule: the firm's rate for what the documents prove domestic (a Swiss rate), the abroad code for what they prove abroad, else asked.
  if (methodOf(setup) === 'net-rate' && proofs.every((p) => p.kind === 'rates' || p.kind === 'abroad')) {
    if (proofs.every((p) => p.kind === 'abroad')) return abroad();
    const code = taken(saleVatCode('saleDomestic'));
    if (proofs.every((p) => p.kind === 'rates')) return code ? { vat: code, source: { from: 'netRate' } } : { vat: '' };
    return { vat: '', note: { kind: 'saleVat', why: 'mixed' } };
  }
  if (methodOf(setup) !== 'net-rate' && proofs.every((p) => p.kind === 'rates')) {
    const groups = proofs.flatMap((p) => (p.kind === 'rates' ? p.groups : []));
    if (groups.length === 1) return { vat: String(groups[0].rate), source: { from: 'receipt' } };
    // A line per group when the groups add up to the sale; a zero group the document does not prove abroad stays without a code, and the form says so.
    if (proofs.length === 1 && groups.every((g) => g.gross !== undefined) && toRappen(groups.reduce((a, g) => a + g.gross!, 0)) === toRappen(amount)) {
      const lines = groups.map((g) => (g.rate > 0 ? { amount: g.gross!, vat: String(g.rate), source: { from: 'receipt' as const } } : g.abroad && abroadCode ? { amount: g.gross!, vat: abroadCode, source: { from: 'abroad' as const } } : { amount: g.gross!, vat: '' }));
      return { vat: '', parts: lines, ...(lines.some((l) => !l.vat) && { note: { kind: 'saleZeroPart' } }) };
    }
    return { vat: '', note: { kind: 'saleVat', why: 'mixed' } };
  }
  if (proofs.every((p) => p.kind === 'abroad')) return abroad();
  if (proofs.some((p) => p.kind === 'foreignVat')) return { vat: '', note: { kind: 'saleVat', why: 'foreignVat' } };
  return { vat: '', note: { kind: 'saleVat', why: proofs.some((p) => p.kind === 'unclear' && p.why === 'noVat') ? 'noVat' : 'notRead' } };
}

/** What the payment in says of the firm's own invoices among the receipts (#382, ownInvoicesOf). */
interface OwnNamed {
  /** The invoices the proposal is read off. */
  use: Receipt[];
  /** Of those, the ones booking links (linked to no payment yet). */
  link: Receipt[];
  /** The numbers as the payment writes them. */
  numbers: string[];
  /** One invoice, linked to an earlier payment already (an instalment): what that payment paid of it, and its day. */
  earlier?: { paid: number; date: string };
  /** The text names an invoice of the firm's own the form cannot take (set aside, several not adding up): no default sale code. */
  named: boolean;
}

/**
 * The firm's own invoices (issuedByFirm, by its UID or its name; not a credit note) whose numbers the
 * payment's text names as whole tokens (ownNumbers). One linked to no payment is taken and linked by
 * the booking; one linked to an earlier payment is an instalment, read but not linked again; several
 * are taken together only when each is free and read and their amounts add up to the payment.
 */
function ownInvoicesOf(books: Books, tx: BankTransaction, known: DraftKnowledge, paid: number): OwnNamed | undefined {
  const firm = { ...(known.ownUid && { uid: known.ownUid }), ...(known.firmName && { name: known.firmName }) };
  if (!firm.uid && !firm.name) return undefined;
  const words = tokensIn(paymentText(tx));
  const here = new Set(books.mappings.filter((m) => m.transactionRef === tx.ref).map((m) => m.receiptId));
  const all = books.receipts.filter((r) => !here.has(r.id) && !r.filedPayment && (!r.kind || r.kind === 'invoice') && !paysIn(r) && issuedByFirm(r, firm)
    && ownNumbers(r).some((n) => words.has(n)));
  if (!all.length) return undefined;
  const found = all.filter((r) => r.id !== known.notOwnInvoice);
  const numbers = found.flatMap((r) => ownNumbers(r).filter((n) => words.has(n)).slice(0, 1)).map((n) => asWritten(tx, n));
  const linkedTo = (r: Receipt) => books.mappings.filter((m) => m.receiptId === r.id && m.transactionRef !== tx.ref).map((m) => books.transactions.find((t) => t.ref === m.transactionRef)).filter((t): t is BankTransaction => !!t);
  if (found.length === 1) {
    const [r] = found;
    const before = linkedTo(r);
    if (!before.length) return { use: [r], link: [r], numbers, named: true };
    const same = before.every((t) => t.currency === tx.currency);
    return { use: [r], link: [], numbers, named: true, ...(same && { earlier: { paid: before.reduce((a, t) => a + Math.abs(t.amount), 0), date: before.map((t) => t.date).sort().at(-1)! } }) };
  }
  const sum = found.reduce((a, r) => a + (r.amount ?? Number.NaN), 0);
  if (found.length > 1 && found.every((r) => !linkedTo(r).length && (r.currency ?? tx.currency) === tx.currency) && toRappen(sum) === toRappen(paid)) return { use: found, link: found, numbers, named: true };
  return { use: [], link: [], numbers, named: true };
}

/** A number as the payment writes it («2026-031»), found by its squashed form («2026031»). */
function asWritten(tx: BankTransaction, number: string): string {
  const words = [tx.description, tx.reference ?? '', tx.remarks ?? ''].join(' ').split(/[\s,;:()[\]«»"']+/).map((w) => w.replace(/^[-/#]+|[-/#.]+$/g, ''));
  return words.find((w) => squash(w) === number) ?? number;
}

/** The words a purchase document's lines say (its line items, else its text), for the account list to rank by: the first 300 distinct words, enough to rank by; nothing is cut from what is booked. */
function wordsOf(docs: readonly Receipt[]): string[] | undefined {
  const text = docs.flatMap((d) => (d.lineItems?.length ? d.lineItems.map((l) => l.description) : [d.extractedText ?? ''])).join(' ');
  const words = [...new Set(text.split(/[^\p{L}]+/u).filter((w) => w.length >= 4))].slice(0, 300);
  return words.length ? words : undefined;
}

/**
 * The booking a person starts from, by rules only (#344): the bank on its side, the amount of the
 * payment, and the other side proposed from what code knows, each proposal naming its source
 * (DraftLine.source) and nothing booked before her click. In this order:
 * - a provider's payout: bank / its clearing account without a code when code books it so, else no
 *   proposal; never a sale, and the form says what a payout is and what it waits for;
 * - a payment naming an issued invoice: with its event booked (agreed basis) bank / the receivable
 *   without a code (its revenue is booked), else the invoice's own accounts and codes; the form
 *   names the invoice and the way to confirm the payment on it;
 * - the company rule that decides the payment (also one that asks first, with its question);
 * - the bank's own fee row, and a wage on a firm that pays wages: their account, without a code;
 * - the account of the business's last booking (money in with a document: the VAT off the document);
 * - money from the owner: her account without a code; between own accounts, from an authority, or
 *   with a business's document linked: no account and no code, and the form says what it is;
 * - money back from a business the firm buys from: the account of its last purchase, with the rate
 *   of a linked document that shows it (the code inverts on that account), else the zero code inverted;
 * - other money in: the firm's default revenue account with the sale's VAT (saleVat), and the form
 *   says it took the payment for a sale; a payment that names the number of the firm's own invoice
 *   among the receipts (ownInvoiceOf, #382) takes that invoice as its document, which booking links;
 * - money out: the business's own account (its file), else none, with the receipt's rate filled.
 * A rate comes from a purchase document alone (isPurchaseDocument): no input tax without a receipt
 * that shows it. On the agreed basis the form says where a line with a VAT code goes when its
 * document is of another day (taxPointOf): booking dates it so (src/server/edits.ts bookPayment).
 * Undefined when no payment has the ref.
 */
export function bookingDraft(books: Books, ref: string, accounts: readonly LedgerBankAccount[], invoices?: readonly Invoice[], known: DraftKnowledge = {}): BookingDraft | undefined {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx) return undefined;
  const named = invoices && tx.direction === 'CRDT' ? namedInvoice(tx, invoices) : undefined;
  const cancelled = named?.cancelled ? { id: named.id, number: named.number } : undefined;
  const issued = named && !cancelled ? named : undefined;
  // What is still open on the bank side: the whole payment, or the rest after lines booked already (one line of a split undone, r9k-2).
  const [side] = paymentSides(books, ref, accounts);
  const open = side ? fromRappen(toRappen(side.paid) - toRappen(side.booked)) : undefined;
  const bank = side && { account: side.account, side: (open ?? side.paid) < 0 ? 'accountCredit' as const : 'accountDebit' as const };
  const paid = open !== undefined ? Math.abs(open) : tx.amount;
  const receiptIds = [...new Set(books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId))].sort();
  const receipts = books.receipts.filter((r) => receiptIds.includes(r.id));
  const moneyIn = bank?.side === 'accountDebit';
  // The firm's own invoices the payment names by their numbers (#382): the sale's VAT is read off them, and booking links those not linked yet.
  const own = moneyIn && !named ? ownInvoicesOf(books, tx, known, paid) : undefined;
  // The documents a rate may be read off: on money out a purchase document only (never a delivery note or the firm's own credit note, #81).
  // A bill of one line of a card's settlement (#409) is no document of the whole payment: its rate is that line's alone.
  const lined = new Set(books.mappings.filter((m) => m.transactionRef === ref && m.line !== undefined).map((m) => m.receiptId));
  const docs = [...receipts.filter((r) => !lined.has(r.id) && (moneyIn ? isSaleDocument(r) : isPurchaseDocument(r))), ...(own?.use ?? [])];
  const bankAccounts = new Set(accounts.map((a) => a.account));
  const text = receipts.find((r) => r.description)?.description ?? tx.description;
  const notes: DraftNote[] = [];
  // Whether the proposal is read off her invoices: the banner says what is true (#382).
  const ownAt: { from: 'invoice' | 'other' } = { from: 'other' };
  const ownInvoice = () => (own?.use.length
    ? { id: own.use[0].id, number: own.numbers.join(', '), file: own.use.map((r) => r.filename).join(', '), links: own.link.map((r) => r.id), from: ownAt.from, ...(own.earlier && { earlier: own.earlier.date }) }
    : undefined);
  // On the agreed basis a line with a VAT code is dated by its documents (atTaxPoint): the form says where booking puts the first
  // proposed line whose code is known, by that code (a sale or a purchase, a minus code by the latest document); nothing while none is.
  const pointNote = (lines: readonly DraftLine[]): DraftNote | undefined => {
    if (!agreedBasis()) return undefined;
    const coded = lines.map((l) => vatCodeOf(l.vat, l.accountDebit, l.accountCredit)?.code).find((c) => sideOf(c));
    if (!coded) return undefined;
    const side = sideOf(coded)!;
    const point = taxPointOf(side, coded.startsWith(vat().codes.negativePrefix), tx.date, documentDates([...receipts, ...(own?.link ?? [])]), dayLock(books), filing().length);
    if (point?.corrects) return { kind: 'taxPointCorrects', date: point.date, corrects: point.corrects };
    const items = openItemAccounts(known.chart ?? []);
    return point && { kind: 'taxPoint', date: point.date, account: side === 'sale' ? items.receivable : items.payable };
  };
  const result = (lines: DraftLine[], extra: Partial<BookingDraft> = {}): BookingDraft => {
    const mine = ownInvoice();
    const point = pointNote(lines);
    return { ref, date: tx.date, currency: tx.currency, ...(bank && { bank }), receipts: receiptIds, lines, ...(cancelled && { cancelledInvoice: cancelled }), ...(mine && { ownInvoice: mine }), ...extra, notes: point ? [...notes, point] : notes };
  };
  const place = (account: string, amount: number, vat: string, source?: DraftSource, description = text): DraftLine => ({
    accountDebit: bank?.side === 'accountDebit' ? bank.account : account,
    accountCredit: bank?.side === 'accountCredit' ? bank.account : account,
    amount, vat, description, ...(source && (source.account || source.vat) ? { source } : {}),
  });

  const nature = known.nature;
  // A provider's payout is no sale (#404): from its clearing account when code books it so, else nothing proposed;
  // before the cut-over day as the payouts before it were (the business's last booking), never the default sale.
  const payoutBefore = nature?.kind === 'payout' && nature.why === 'before';
  if (payoutBefore) notes.push(nature);
  if (nature?.kind === 'payout' && !payoutBefore) {
    notes.push(nature);
    const from = nature.why === 'ready' && nature.account ? nature.account : '';
    return result([place(from, paid, '', from ? { account: { from: 'clearing', provider: nature.provider } } : undefined)]);
  }

  // An issued invoice the payment names: its revenue is the invoice's, booked with it or now.
  if (issued && bank) {
    const invoice = { id: issued.id, number: issued.number };
    const event = hasEvent({ journalEntries: books.journalEntries ?? [] }, issued);
    // A payment before the invoice's date on the agreed basis is a prepayment, taxed on its own day: confirmed on the invoice, which books it so (prepaidEvent).
    if (event && agreedBasis() && tx.date < issued.date) {
      notes.push({ kind: 'prepayment', number: issued.number });
      return result([place('', paid, '')], { invoice: { ...invoice, settles: false } });
    }
    // Only what is still open is the invoice's: the rest (a double payment, say) is the customer's, and the form says so.
    const open = issued.currency === tx.currency ? openAmount(issued, invoices ?? []) : paid;
    const due = Math.min(paid, open);
    const surplus = fromRappen(toRappen(paid) - toRappen(due));
    if (surplus > 0) notes.push({ kind: 'invoicePaid', number: issued.number, surplus });
    const rest = surplus > 0 ? [place('', surplus, '')] : [];
    if (event) {
      const receivable = openItemAccounts(known.chart ?? []).receivable;
      return result([...(due > 0 ? [place(receivable, due, '', { account: { from: 'receivable', number: issued.number } })] : []), ...rest], { invoice: { ...invoice, settles: true } });
    }
    const revenue = known.invoiceRevenue ?? known.defaults?.sales ?? '';
    let split: ReturnType<typeof revenueSplit> = [];
    try { split = revenue && due > 0 ? revenueSplit(issued, due, revenue) : []; } catch { split = []; }
    const lines = split.map((l) => { const code = taken(l.vatCode); return place(l.account, l.amount, code, { account: { from: 'invoice', number: issued.number }, ...(code && { vat: { from: 'invoice' as const } }) }); });
    return result(lines.length || rest.length ? [...lines, ...rest] : [place('', paid, '')], { invoice: { ...invoice, settles: false } });
  }

  const proposes = !cancelled && !!bank;

  // A company rule decides the payment (it waits for its receipt, or asks first): its lines as it would book them, when they add up to what is open.
  const rule = known.rule;
  if (proposes && rule && toRappen(rule.lines.filter((l) => !l.against).reduce((s, l) => s + l.amount, 0)) === toRappen(paid)) {
    if (rule.ask) notes.push({ kind: 'ask', question: rule.ask });
    return result(rule.lines.map((l): DraftLine => {
      const from = { from: 'rule' as const, rule: rule.id };
      const own = (mine: string) => (l.against ? mine : bank!.account);
      const [accountDebit, accountCredit] = moneyIn ? [own(l.against ?? ''), l.account] : [l.account, own(l.against ?? '')];
      return { accountDebit, accountCredit, amount: l.amount, vat: l.vat ?? '', description: text, source: { account: from, ...(l.vat && { vat: { from: 'rule' as const } }) }, ...(rule.tags && { tags: rule.tags }) };
    }));
  }

  // The bank's own fee row: the account code books it on, without a VAT code (#359); or no account, and the form says which one the chart lacks.
  if (proposes && nature?.kind === 'bankFee') {
    if ('missing' in nature) { notes.push({ kind: 'bankChargesMissing', ...nature.missing }); return result([place('', paid, '')]); }
    return result([place(nature.account, paid, '', { account: { from: 'bankFee' } })]);
  }

  // Her outlays paid back: her account, before any precedent of the payee (#402): the books say what it pays.
  if (proposes && !moneyIn && nature?.kind === 'ownerForeign') { notes.push(nature); return result([place('', paid, '')]); }
  if (proposes && !moneyIn && nature?.kind === 'ownerOutlays') {
    notes.push({ kind: 'ownerOutlays', open: nature.open, ...(nature.judged && { judged: true as const }) });
    return result([place(nature.account, paid, '', { account: { from: 'ownerOutlays' } })]);
  }
  // A payment to the owner her outlays do not cover yet: the form says what it waits for and proposes as for any payment (#428).
  if (proposes && !moneyIn && nature?.kind === 'ownerWaits') notes.push(nature);
  // Contributions (#470): proposed by the books, before any precedent (an earlier booking may have put it all on the deductions account); its account is the payee's own earlier one.
  if (proposes && !moneyIn && nature?.kind === 'contributions') {
    notes.push(nature);
    const held = Math.min(toRappen(Math.max(nature.takes, 0)), toRappen(paid));
    const rest = toRappen(paid) - held;
    return result([...(held ? [place(nature.deductions, fromRappen(held), '')] : []), ...(rest ? [place(nature.account, fromRappen(rest), '')] : [])]);
  }
  // Money for a cancelled invoice is the customer's, not a sale (`proposes`): the earlier sale's account and code would mislead.
  const precedent = proposes ? newestOf(books, tx, bank!.side, bankAccounts, undefined, known.wages ? new Set(known.wages) : undefined) : undefined;
  const extra = precedent ? { precedent: precedent.entry } : {};
  // A wage on a firm that pays wages, without a booking of hers to follow: the net paid on the wage account, without a VAT code (guide
  // cls-salary); where the books carry wages with their deductions, no account, and the form says how wages are booked here.
  if (!precedent && proposes && !moneyIn && nature?.kind === 'wage') {
    if ('deductions' in nature) { notes.push({ kind: 'wageDeductions', account: nature.deductions }); return result([place('', paid, '')]); }
    return result([place(nature.account, paid, '', { account: { from: 'wage' } })]);
  }
  // A firm without input tax has no code for a receipt's rate (r8f-50): no rate is filled that nothing resolves.
  const claims = !withoutInputTax();
  const rates = new Set(docs.flatMap(vatRates).map((g) => g.ratePercent));
  const rate = claims && rates.size === 1 ? String([...rates][0]) : '';
  // The other side and its VAT for a line without a rate of its own.
  let other: { account: string; vat: string; source?: DraftSource } = { account: '', vat: rate, ...(rate && { source: { vat: { from: 'receipt' } } }) };
  const fromReceipt = (vat: string): DraftSource['vat'] | undefined => (vat && vat === rate ? { from: 'receipt' } : undefined);
  // The sale's VAT: off its documents, or asked where the payment names an invoice of hers the form cannot take (#382).
  const ofSale = (): SaleVat => {
    if (own?.named && !own.use.length && !docs.length) return vatSetup().registered ? { vat: '', note: { kind: 'saleVat', why: 'namedInvoice' } } : { vat: '' };
    if (own?.use.length) ownAt.from = 'invoice';
    // Several invoices of hers: a line each says its own VAT and asks only for a line without a code (perInvoice).
    if (own && own.use.length > 1) return { vat: '' };
    return saleVat(tx, docs, Math.min(paid, ownOpen ?? paid));
  };
  // What is open of her one invoice whose amount is read: its amount less what an earlier payment paid of it.
  const ownOpen = own?.use.length === 1 && own.use[0].amount !== undefined && (own.use[0].currency ?? tx.currency) === tx.currency
    ? fromRappen(toRappen(Math.abs(own.use[0].amount)) - toRappen(own.earlier?.paid ?? 0)) : undefined;
  let saleParts: SaleVat['parts'];
  if (precedent && moneyIn && (docs.length || own?.named) && chart().typeOf(precedent.account!) === 'revenue') {
    // A sale with its document: the account as last time, the VAT off the document, never the last sale's code (#382).
    const sale = ofSale();
    saleParts = sale.parts;
    if (sale.note) notes.push(sale.note);
    other = { account: precedent.account!, vat: sale.vat, source: { account: { from: 'precedent', date: precedent.entry.date, ...(precedent.yours && { yours: true as const }), ...(precedent.name && { name: precedent.name }) }, ...(sale.source && { vat: sale.source }) } };
  } else if (precedent && !(moneyIn && proposes && REFUND_CODE.test(precedent.vatCode ?? ''))) {
    // A refund before is no «wie beim letzten Mal» for the next one: the purchase it refunds decides its code (#357, below).
    const vat = rate || (receipts.length ? '' : withoutReceipt(precedent.vatCode));
    // The last booking claimed input tax and this payment has no receipt: its zero code is no «wie beim letzten Mal» (#397).
    const zeroed = !rate && !receipts.length && !!vat && vat !== precedent.vatCode;
    other = { account: precedent.account!, vat, source: { account: { from: 'precedent', date: precedent.entry.date, ...(precedent.yours && { yours: true as const }), ...(precedent.name && { name: precedent.name }) }, ...(vat && { vat: fromReceipt(vat) ?? { from: zeroed ? 'noReceipt' as const : 'precedent' as const } }) } };
  } else if (proposes && nature?.kind === 'owner') {
    notes.push({ kind: 'owner' });
    other = { account: nature.account, vat: '', source: { account: { from: 'owner' } } };
  } else if (proposes && (nature?.kind === 'ownTransfer' || nature?.kind === 'authority')) {
    notes.push(nature);
    other = { account: '', vat: '' };
  } else if (proposes && moneyIn && !payoutBefore) {
    // Money back from a business the firm buys from: a refund on the account of its last purchase, the code inverted on it.
    // Plausible only when it is no more than the firm paid that business, and the text names no invoice of the firm's own.
    const bought = own?.named ? undefined : refundOf(books, tx, bankAccounts, paid, invoices);
    // A linked document with a VAT number someone else issued: by the UID when the settings have one, else by the firm's name (issuedByFirm).
    const foreign = known.ownUid ? docs.some((d) => d.vatId && norm(d.vatId) !== norm(known.ownUid))
      : !!known.firmName && docs.some((d) => d.vatId && issuedByFirm(d, { name: known.firmName }) === false);
    if (bought) {
      const refundRate = new Set(claims ? receipts.filter(isPurchaseDocument).flatMap(vatRates).map((g) => g.ratePercent) : []);
      // The purchase it refunds, found unambiguously: its account and its code with the minus (#357, I81 back is -I81, I0 back is -I0).
      const refunded = refundRate.size ? undefined : refundedPurchase(tx, paid, { transactions: books.transactions, journalEntries: books.journalEntries ?? [], receipts: books.receipts, mappings: books.mappings });
      const code = refunded ? taken(refunded.code) : '';
      // Not found: the purchase's zero code (its own when it was booked without input tax), with the minus; the form says so.
      const booked = bought.vatCode && !bought.vatCode.startsWith('-') ? lookupVatCode(bought.vatCode) : null;
      const zero = inputTaxWithoutReceipt(bought.vatCode) ?? (booked?.entry.kind === 'inputNoVat' ? bought.vatCode : undefined);
      // A rate stays a rate: on the expense's credit side the form makes it the refund's code (-M81).
      const vat = refundRate.size === 1 ? String([...refundRate][0]) : code || (zero ? taken(`-${zero}`) : '');
      const vatFrom: DraftSource['vat'] = refundRate.size === 1 ? { from: 'receipt' } : code ? { from: 'purchase', date: refunded!.original.date, code: refunded!.originalCode } : { from: 'refund' };
      notes.push({ kind: 'refund' });
      other = { account: code ? refunded!.account : bought.account!, vat, source: { account: { from: 'refund', date: code ? refunded!.original.date : bought.entry.date }, ...(vat && { vat: vatFrom }) } };
    } else if (foreign) {
      notes.push({ kind: 'supplierDocument' });
      other = { account: '', vat: '' };
    } else if (known.defaults?.sales && chart().typeOf(known.defaults.sales) === 'revenue') {
      const sale = ofSale();
      saleParts = sale.parts;
      // Her own invoice says it is a sale: no assumption to name.
      if (!own?.named) notes.push({ kind: 'sale' });
      if (sale.note) notes.push(sale.note);
      other = { account: known.defaults.sales, vat: sale.vat, source: { account: { from: 'sales' }, ...(sale.source && { vat: sale.source }) } };
    }
  } else if (proposes && known.account && chart().typeOf(known.account)) {
    other = { account: known.account, vat: rate, source: { account: { from: 'business' }, ...(rate && { vat: { from: 'receipt' } }) } };
  }
  // No account is guessed from a receipt's words (#356, #389): they only rank the list (DraftKnowledge words below).
  const aside = notes.some((n) => n.kind === 'ownTransfer' || n.kind === 'authority' || n.kind === 'owner');
  if (!moneyIn && rate && !other.account) notes.push({ kind: 'chooseAccount' });
  // No proposal at all on money out: say why in one line (#397).
  if (proposes && !moneyIn && !aside && !other.account && !other.vat && !notes.length) notes.push({ kind: 'noProposal', name: tx.counterparty?.trim() || tx.description, linked: receipts.length > 0 });
  // Paid less a cash discount the payment states or the receipt offers: booked is what was paid, its VAT on that (guide spl-skonto).
  const gap = !moneyIn && docs.length === 1 ? gapOf(docs[0], tx) : undefined;
  if (gap?.kind === 'discount') notes.push({ kind: 'discount', percent: gap.percent, amount: gap.discount, vat: !claims ? 'none' : rates.size > 1 ? 'rates' : 'paid' });
  // A receipt that may be this payment's, not linked: linking it would bring its rate (#397).
  if (!moneyIn && !receipts.length && known.near && proposes) notes.push({ kind: 'nearReceipt', name: known.near.name, why: known.near.why, vat: claims, ...(claims && known.near.rate !== undefined && { rate: known.near.rate }) });
  const words = !moneyIn && !other.account ? wordsOf(docs) : undefined;
  if (words && known.ranks?.(words)) notes.push({ kind: 'rankedByReceipt' });

  // A receipt that states several rates adding up to the payment: a line per rate, each with its rate.
  const groups = docs.length === 1 && docs[0].currency === tx.currency && claims && other.vat === rate ? vatRates(docs[0]) : [];
  const split = groups.length > 1 && groups.every((g) => gross(g) !== undefined) && toRappen(groups.reduce((s, g) => s + gross(g)!, 0)) === toRappen(paid);
  const sourced = (vat: string): DraftSource | undefined => {
    const s = { ...(other.source?.account && { account: other.source.account }), ...(vat && other.source?.vat && { vat: other.source.vat }) };
    return s.account || s.vat ? s : undefined;
  };
  // A collective payment (Sammelauftrag): one line per part, named by its payee and reference, when the parts add up to it (r9k-6).
  const parts = partsOf(tx, paid);
  const sold = !!other.account && chart().typeOf(other.account) === 'revenue';
  // Several invoices of hers: a line each, with the VAT each proves (#382).
  const perInvoice = sold && own && own.use.length > 1 && ownAt.from === 'invoice' ? own.use.map((r) => {
    const v = saleVat(tx, [r], Math.abs(r.amount!));
    if (v.note && !notes.some((n) => n.kind === v.note!.kind)) notes.push(v.note);
    const code = v.parts ? '' : v.vat;
    return place(other.account, Math.abs(r.amount!), code, { ...(other.source?.account && { account: other.source.account }), ...(code && v.source && { vat: v.source }) }, `${text} · ${r.filename}`);
  }) : undefined;
  // More than is open of her one invoice: revenue up to that, the rest a line without an account, as for an app invoice (#356).
  const surplus = sold && ownOpen !== undefined && ownOpen >= 0 && toRappen(paid) > toRappen(ownOpen) ? fromRappen(toRappen(paid) - toRappen(ownOpen)) : 0;
  if (surplus) notes.push({ kind: 'ownInvoiceSurplus', number: own!.numbers[0], surplus });
  const due = surplus ? fromRappen(toRappen(paid) - toRappen(surplus)) : paid;
  const fromParts = sold && saleParts?.length ? saleParts.map((x) => place(other.account, x.amount, x.vat, { ...(other.source?.account && { account: other.source.account }), ...(x.vat && x.source && { vat: x.source }) })) : undefined;
  const ownLines = perInvoice ?? fromParts ?? (surplus ? [...(due > 0 ? [place(other.account, due, other.vat, sourced(other.vat))] : []), place('', surplus, '')] : undefined);
  const lines = ownLines ?? (split ? groups.map((g) => place(other.account, gross(g)!, String(g.ratePercent), { ...(other.source?.account && { account: other.source.account }), vat: { from: 'receipt' } }))
    : parts ? parts.map((p) => place(other.account, Math.abs(p.amount), other.vat, sourced(other.vat), partText(p)))
      : [place(other.account, paid, other.vat, sourced(other.vat))]);
  return result(lines, { ...extra, ...(words && { words }) });
}

/**
 * The code in the VAT field while she has not touched it, for the accounts in the fields now (#344):
 * a receipt's rate stays a rate, whose code the account gives (vatCodeOf); a sale's code goes when
 * neither account is a revenue account any more; a purchase code takes the family of the account
 * (codeOnAccount), and goes where the account takes none. The proposal's accounts keep its code.
 */
export function followedVat(init: Pick<DraftLine, 'accountDebit' | 'accountCredit' | 'vat'>, accountDebit: string, accountCredit: string): string {
  const code = init.vat;
  if (!code || !lookupVatCode(code) || (accountDebit === init.accountDebit && accountCredit === init.accountCredit)) return code;
  if (sideOf(code) === 'sale' && !/^-?[MI]\d/.test(code)) return [accountDebit, accountCredit].some((a) => a && chart().typeOf(a) === 'revenue') ? code : '';
  if (/^-?[MI]\d/.test(code)) return codeOnAccount(code, accountDebit, accountCredit) ?? '';
  return code;
}

/**
 * The draft the hand form opens with, once the invoices are known: while they load (`'loading'`)
 * there is no form yet, or a payment of a cancelled invoice would open with the earlier sale's
 * account and code and keep them when the invoices arrive (r9c-4). Without invoicing: undefined.
 */
export function formDraft(books: Books, ref: string, accounts: readonly LedgerBankAccount[], invoices: readonly Invoice[] | 'loading' | undefined, known?: DraftKnowledge): BookingDraft | undefined {
  return invoices === 'loading' ? undefined : bookingDraft(books, ref, accounts, invoices, known);
}

/** The payment's bank sides with these lines added to the entries it has (a payment booked in part keeps them, r9k-2). */
const sidesWith = (books: Pick<Index, 'transactions' | 'journalEntries'>, ref: string, lines: readonly BookingLine[], accounts: readonly LedgerBankAccount[]) =>
  paymentSides({ transactions: books.transactions, journalEntries: [...(books.journalEntries ?? []).filter((e) => e.transactionRef === ref), ...lines.map((l, i) => ({ id: String(i), transactionRef: ref, date: '', ...l }))] }, ref, accounts);

/** The first bank side these lines would leave off what the bank paid, or undefined when every side adds up. */
export const offSide = (books: Pick<Index, 'transactions' | 'journalEntries'>, ref: string, lines: readonly BookingLine[], accounts: readonly LedgerBankAccount[]): PaymentSide | undefined =>
  sidesWith(books, ref, lines, accounts).find((s) => s.booked !== s.paid);

/** What is still to book on the payment's first bank side, in its currency and as the bank paid it (out: positive). */
export function restOf(books: Pick<Index, 'transactions' | 'journalEntries'>, ref: string, lines: readonly BookingLine[], accounts: readonly LedgerBankAccount[]): number {
  const [side] = sidesWith(books, ref, lines, accounts);
  return side ? fromRappen((side.paid < 0 ? -1 : 1) * (toRappen(side.paid) - toRappen(side.booked))) : 0;
}

/** A person's booking made without a payment (Buchungen › N): its own ref and its entries. */
export interface Unattached { ref: string; entries: JournalEntry[]; days: number }

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * Bookings typed in Buchungen without their payment that may be this unbooked payment's: entries
 * under a ref of their own (no transaction, no receipt linked to it) that move the payment's bank
 * account by exactly what the bank paid, dated within `days` of it. Nearest first. Tying one to the
 * payment marks the payment booked, so a later run does not book it twice.
 */
export function unattachedFor(books: Pick<Index, 'transactions' | 'journalEntries' | 'mappings'>, ref: string, accounts: readonly LedgerBankAccount[], days = 10): Unattached[] {
  const tx = books.transactions.find((t) => t.ref === ref);
  const entries = books.journalEntries ?? [];
  if (!tx || entries.some((e) => e.transactionRef === ref)) return [];
  const own = new Set([...books.transactions.map((t) => t.ref), ...books.mappings.map((m) => m.transactionRef)]);
  const groups = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    if (!isManualRef(e.transactionRef) || own.has(e.transactionRef)) continue;
    groups.set(e.transactionRef, [...(groups.get(e.transactionRef) ?? []), e]);
  }
  return [...groups].flatMap(([own, es]): Unattached[] => {
    if (es.some((e) => e.corrects || e.origin === 'year-close' || (e.exchangeCurrency && e.exchangeCurrency !== tx.currency))) return [];
    const near = Math.max(...es.map((e) => dayDiff(e.date, tx.date)));
    const sides = paymentSides({ transactions: books.transactions, journalEntries: es.map((e) => ({ ...e, transactionRef: ref })) }, ref, accounts);
    if (near > days || !sides.length || sides.some((s) => s.booked !== s.paid)) return [];
    return [{ ref: own, entries: es, days: near }];
  }).sort((a, b) => a.days - b.days || a.ref.localeCompare(b.ref));
}

/**
 * Whether a code deducts input tax (I81, M81, M26-2, …): only a receipt that shows the Swiss VAT
 * allows that, so a payment without one is booked with the zero code of its family, which is returned.
 * Undefined for a firm without input tax: there the code itself is refused (formTakes).
 */
export function inputTaxWithoutReceipt(code: string | undefined): string | undefined {
  const found = code && !withoutInputTax() ? lookupVatCode(code) : null;
  if (!found || found.negative || (found.entry.kind !== 'material' && found.entry.kind !== 'investment')) return undefined;
  return `${found.entry.family}0`;
}
