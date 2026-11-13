/**
 * The one classifier: bank transactions → journal entries, for `npm run classify` and the
 * UI's re-classify route alike. See processes/booking.guide.yaml#classify.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBatchClassifyPrompt, parseBatchClassifyResult, type ClassifyEntry, type ClassifyPromptContext } from '../llm/prompts.js';
import { resolveStep, type AskOptions } from '../llm/ask.js';
import { NoClaudeError } from '../llm/providers/claude-cli.js';
import { AiRefused } from '../llm/provider.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { ownerAccount } from '../accounting/bank-accounts.js';
import { bankAccountFor } from '../workspace/money-accounts.js';
import { paymentSides } from '../accounting/payment-entries.js';
import { atTaxPoint, openItemAccounts } from '../accounting/tax-point.js';
import { isVatAmountCode } from '../accounting/validate.js';
import { periodLock, type Books, type PeriodLock } from '../books/store.js';
import type { BankTransaction, BookedBy, JournalEntry, Receipt } from '../types/index.js';
import { isPurchaseDocument } from '../accounting/evidence-check.js';
import { vatNotRead } from '../accounting/receipt-due.js';
import type { ClassifyRefusal } from '../types/api-error.js';
import { loadCases, OWN_HISTORY_THRESHOLD, selectCases, type BookingCase } from '../knowledge/cases.js';
import { APP_ROOT, type LedgerBankAccount, type Workspace } from '../workspace/workspace.js';
import { sharedReceipts, inputTaxOverReceipts } from './shared-receipts.js';
import { chargesOf, legKey } from '../intake/charges.js';
import { agreedBasis, baseCurrency, chart, documents, filing, setup, vat, withoutInputTax } from '../engines/index.js';
import { paymentProposals, type PaymentProposal } from '../invoices/payments.js';
import { loadInvoices } from '../invoices/store.js';
import type { InvoiceBook } from '../invoices/model.js';
import { correctsFor, privateUseCode } from '../accounting/correction.js';
import { EFFECTIVE_QUARTERLY, type VatSetup } from '../workspace/vat-setup.js';
import { foreignTaxIn, saleCodeOf, saleCodeReason } from '../accounting/sales-without-vat.js';
import { codeOfFacts, formTakes, lookupVatCode } from '../accounting/vat-codes.js';
import { zeroCodeOff } from './rule-vat.js';
import { receiptWordings, repaymentsOf } from './receipt-wait.js';
import { employs } from '../workspace/setup.js';
import { bookVatCorrections, type CorrectionsDone } from './vat-corrections.js';
import { creditNoteCodeOf } from '../accounting/credit-note-code.js';
import { acquisitionCodeOf, acquisitionReason, readSupplier, type AcquisitionDocument } from '../accounting/acquisition-tax.js';
import { codeSignFor } from '../accounting/code-sign.js';
import { refundCodeOf, refundLookup, refundedPurchase, SUMS_OF, type RefundCode } from './refund-code.js';
import { homeOf, loadKnowledge } from '../knowledge/layers.js';
import { identify, merchantOf, signalsOfTransaction, type Counterparty } from '../knowledge/counterparties.js';
import { payerNames } from '../knowledge/payer.js';
import { businessGuidance, companyGuidance } from '../knowledge/guidance.js';
import { partPayment, partReceipts, partsOf, partText } from '../accounting/batch-parts.js';
import { cardLinesOf, cardPart, cardParts, lineReceiptsOf } from '../books/card-lines.js';
import { wordsIn } from '../export/texts.js';
import { ruleFor, ruleWords, stampRule, type PaymentFacts, type PlacedRule, type RuleBooking, type RuleNames } from './rules.js';
import { chartNames, companyRules, factsOf, placedRules } from './rule-book.js';
import { businessVat, capAtBills, withPurchaseVat, type BusinessVat } from './purchase-vat.js';
import { separateFeeOf, withoutSeparateFee } from './separate-fee.js';
import { bankChargesOf, isOwnBankFee, type BankCharges } from './bank-fee.js';
import { bankCodedFee } from '../books/bank-import.js';
import { sidesOf, withDerivedCodes } from './line-vat.js';
import { withReceiptTax } from './receipt-tax.js';
import { clearingAccounts, payoutWaitOf, providerOfPayment, type PayoutWait, type Provider } from './providers.js';
import { overWithheld, paysContributions, wageAccounts, withheldFor, withinWithheld } from './withheld.js';
import { splitByReceipts } from './receipt-lines.js';
import { CUSTOMS_BY, customsSplit, importVatDeductions, ratesImportVat, type Assessment, type CustomsHold, type CustomsTexts } from './customs-invoice.js';
import { nextManualRef } from '../books/next-ref.js';
import { salesDefaults } from '../workspace/sells.js';
import { loadChart, type ChartAccount } from '../workspace/chart.js';

export const BATCH_SIZE = 10;
export const CONCURRENCY = 3;
const CALL_TIMEOUT_MS = 360_000;

export interface EntryContext {
  fx: FxResolver;
  /** The receipts mapped to the transaction, which the model saw: stamped on the entries. */
  receipts: string[];
  bankAccount: string;
  lock: PeriodLock;
  /** The reason in words, stamped on the entries. */
  reason?: string;
  /** Who decided the entries, and wrote the reason: the model or a rule. */
  by: BookedBy;
  /** The accounts that hold money (cash, banks): an entry between two of them is a transfer and carries no VAT code. */
  money?: ReadonlySet<string>;
  /** The filed period the entries correct (src/accounting/correction.ts correctsFor): a private outlay for a receipt of a filed quarter (r8k-10). */
  corrects?: string;
  /** The model's lines: their Bezugsteuer is decided in code from the payment's receipts (src/accounting/acquisition-tax.ts). Absent: a rule's lines, whose code is the rule's. */
  acquisition?: { documents: readonly AcquisitionDocument[]; setup: VatSetup };
}

/**
 * The accounts that hold the company's money or what it owes through them: every money account of
 * the manifest (#88: the owner's, an employee's and a card's too), and every account the chart puts
 * on the line of a bank or the cash box (cash, the transfer account). Money moved between two of
 * them is no purchase and no sale: code decides that it carries no VAT code (r4w-9: a cash
 * withdrawal `1000 / 1020`; a bank payment that pays the owner back).
 */
export function moneyAccounts(bankAccounts: readonly LedgerBankAccount[], accounts: readonly ChartAccount[]): Set<string> {
  const held = bankAccounts.filter((a) => a.role === 'bank' || a.role === 'cash').map((a) => a.account);
  const lines = new Set(accounts.filter((a) => held.includes(a.number)).map((a) => a.line));
  return new Set([...bankAccounts.map((a) => a.account), ...accounts.filter((a) => lines.has(a.line)).map((a) => a.number)]);
}

/**
 * The journal entries for one transaction from the model's answer. The side the model left empty
 * is the transaction's bank account (a Skonto line the bank received back is the bank's debit on a
 * payment out), except on a VAT-amount code (M81-2), whose code is its other leg; whether the bank
 * really was the missing side, paymentRefusal decides. Every entry carries the payment's date; a
 * foreign one the ESTV daily sell rate of that day (ADR 0001).
 */
export function entriesFor(tx: BankTransaction, llmEntries: ClassifyEntry[], { fx, receipts, bankAccount, lock, reason, by, money, corrects, acquisition }: EntryContext): JournalEntry[] {
  lock.assertOpen(tx.date, `${tx.ref} wird nicht neu gebucht.`);
  const fxStamp = tx.currency === baseCurrency()
    ? {}
    : { exchangeCurrency: tx.currency, exchangeRate: fx.daily(tx.currency, tx.date) ?? fx.flat(tx.currency) ?? 1 };
  const entry = (e: Omit<JournalEntry, 'id' | 'transactionRef' | 'origin'>, decided?: { reason: string; by: BookedBy }): JournalEntry =>
    ({ id: randomBytes(8).toString('hex'), transactionRef: tx.ref, ...e, ...fxStamp, origin: 'classify', receipts: [...receipts].sort(), ...(corrects && { corrects }), ...(decided ?? { ...(reason && { reason }), by }) });

  const customs = documents().customs;
  return llmEntries.map((e) => {
    const { accountDebit, accountCredit } = sidesOf(e, tx.direction, bankAccount, isVatAmountCode(e.vatCode));
    const transfer = !!money?.has(accountDebit) && money.has(accountCredit);
    const acquired = acquisition && !transfer ? acquisitionCodeOf({ ...e, accountDebit, accountCredit }, acquisition.documents, acquisition.setup) : undefined;
    const vatCode = transfer ? undefined : acquired ? acquired.code : signed(permittedCode(e.vatCode), accountDebit, accountCredit, e.amount, bankAccount);
    // A rate on the import VAT itself is left off: its input tax comes only with the customs assessment, as the one-legged deduction.
    const importVat = !!customs && ratesImportVat({ accountDebit, vatCode }, customs);
    return entry({
      ...(acquisition && readSupplier(e)),
      date: tx.date,
      accountDebit,
      accountCredit,
      amount: e.amount,
      vatCode: importVat ? undefined : vatCode,
      description: e.description || tx.description,
    }, importVat ? { reason: wordsIn('de').t('rules.say.importVatRate', { account: accountDebit, code: vatCode! }), by: CUSTOMS_BY }
      : acquired && { reason: acquisitionReason(acquired), by: { kind: 'code', check: 'acquisitionTax' } });
  });
}

const day = (iso: string) => iso.split('-').reverse().join('.');

/**
 * Why the classifier's entries for `tx` must not be booked: an entry without an account (other than
 * a VAT-amount code's one leg), an entry on an account `chart` does not have (the bank account aside,
 * which the ledger names), an entry with a VAT code the engine does not know (a code the firm's form
 * does not take was already left off by permittedCode, so on the effective method only), or entries that do not move the bank account by what the bank paid, the
 * rules the AI sidebar's changes keep too (src/server/edits.ts applyAnswer). The payment then stays
 * unbooked for the person, with this reason. An empty `chart` checks no account.
 */
export function paymentRefusal(tx: BankTransaction, entries: readonly JournalEntry[], bankAccount: string, chart: ReadonlySet<string> = new Set()): { reason: string; refusal: ClassifyRefusal } | undefined {
  const legless = entries.find((e) => !e.accountDebit !== !e.accountCredit ? !isVatAmountCode(e.vatCode) : !e.accountDebit);
  if (legless) {
    const description = legless.description ?? '';
    return {
      reason: `Claudes Antwort hat eine Buchung ohne Konto («${description}»): nichts gebucht, die Zahlung bleibt, wie sie war.`,
      refusal: { code: 'classifyAccount', params: { description } },
    };
  }
  const outside = (a: string) => !!a && a !== bankAccount && !chart.has(a);
  const stray = chart.size ? entries.find((e) => outside(e.accountDebit) || outside(e.accountCredit)) : undefined;
  if (stray) {
    const account = outside(stray.accountDebit) ? stray.accountDebit : stray.accountCredit;
    const description = stray.description ?? '';
    return {
      reason: `Claudes Antwort bucht auf Konto ${account} («${description}»), das der Kontenplan nicht hat: nichts gebucht, die Zahlung bleibt, wie sie war.`,
      refusal: { code: 'classifyUnknownAccount', params: { account, description } },
    };
  }
  const unknownCode = entries.find((e): e is JournalEntry & { vatCode: string } => !!e.vatCode && !vat().codes.parse(e.vatCode));
  if (unknownCode) {
    const { vatCode: code, description = '' } = unknownCode;
    return {
      reason: `Claudes Antwort bucht mit dem Steuercode ${code} («${description}»), den die App nicht kennt: nichts gebucht, die Zahlung bleibt, wie sie war.`,
      refusal: { code: 'classifyUnknownVatCode', params: { code, description } },
    };
  }
  const account = { bank: tx.bank, currency: tx.currency, account: bankAccount, label: bankAccount, role: 'bank' as const };
  const [side] = paymentSides({ transactions: [tx], journalEntries: [...entries] }, tx.ref, [account]);
  if (side.booked === side.paid) return undefined;
  const sign = side.paid < 0 ? -1 : 1;
  const params = { date: side.date, currency: side.currency, paid: Math.abs(side.paid), booked: sign * side.booked };
  return {
    reason: `Claudes Buchungen der Zahlung vom ${day(side.date)} über ${side.currency} ${params.paid.toFixed(2)} ergäben zusammen ${side.currency} ${params.booked.toFixed(2)}: nichts gebucht, die Zahlung bleibt, wie sie war.`,
    refusal: { code: 'classifyBalance', params },
  };
}

export interface ClassifyContext extends ClassifyPromptContext {
  bankAccounts: readonly LedgerBankAccount[];
  /** The casebook (examples/cases/): examples for a company with little history of its own. */
  casebook?: readonly BookingCase[];
  /** The company's executable booking rules (src/booking/rules.ts): code decides what they cover, never the model. */
  rules?: readonly PlacedRule[];
  /** The businesses a payment can route to, for a rule of one business. */
  counterparties?: readonly Counterparty[];
  /** The owner's name (company.owner): a payment to her is one the owner's account may settle (answerSettles). */
  ownerName?: string;
  /** The firm's VAT setup (src/workspace/vat-setup.ts): which codes its bookings may carry; absent: the effective method. */
  vat?: VatSetup;
  /** The accounts that hold money (moneyAccounts): a transfer between two carries no VAT code. */
  moneyAccounts?: ReadonlySet<string>;
  /** What the app's business files state about input tax (src/booking/purchase-vat.ts): code decides it on the model's lines. */
  purchaseVat?: BusinessVat;
  /** The issued invoices, on the agreed basis: a customer payment that could pay an open one is not booked as revenue (openInvoiceOf). */
  invoices?: InvoiceBook;
  /** The firm's UID: a customs assessment proves import VAT for the firm it names as importer (src/booking/customs-invoice.ts). */
  companyUid?: string;
  /** The account the bank's own fee rows go on, or the one the chart lacks (src/booking/bank-fee.ts); absent: code books no fee row. */
  bankCharges?: BankCharges;
  /** Whether a fee row is one the bank itself coded as its charge (src/books/bank-import.ts bankCodedFee); absent: none is. */
  bankCoded?: (tx: BankTransaction) => boolean;
  /** The firm's wage account (setup.yaml `wages`) when its chart has it as an expense account: the hand form proposes it for a wage (#382). */
  wageAccount?: string;
  /** The account a wage's deductions are booked on (setup.yaml `wages.deductions`): books that carry entries on it book wages with their deductions. */
  wageDeductions?: string;
  /** The wordings of a wage on a firm that pays wages (evidence.guide.yaml, receipt-wait.ts receiptWordings): a payment to the owner so worded repays no outlays (#402). */
  wageWordings?: ReadonlyArray<{ test(s: string): boolean }>;
}

/** At most this many casebook examples in one call: the best of each transaction first. */
const CASES_PER_BATCH = 8;

/**
 * Rows of the company's own booking history: its journal and the prior year's sample entries.
 * Below OWN_HISTORY_THRESHOLD the classify prompt also gets casebook examples.
 */
export function ownHistoryRows(books: Books, context: ClassifyPromptContext): number {
  const sampleRows = Math.max(0, context.historicEntries.split('\n').filter((l) => l.trim()).length - 1);
  return books.journalEntries.length + sampleRows;
}

/** The casebook examples for one batch: each transaction's best case, then its second best, … without repeats. */
function casesForBatch(books: Books, batch: BankTransaction[], casebook: readonly BookingCase[]): BookingCase[] {
  const perTx = batch.map((tx) => selectCases(tx, mappedReceipts(books, tx), casebook));
  const out: BookingCase[] = [];
  for (let i = 0; out.length < CASES_PER_BATCH && perTx.some((l) => l[i]); i++) {
    for (const list of perTx) if (list[i] && !out.includes(list[i]) && out.length < CASES_PER_BATCH) out.push(list[i]);
  }
  return out;
}

/**
 * The newest Banana export in history/: `<name>.Konten.txt` (chart of accounts) beside
 * `<name>.Buchungen-sample.tsv` (example entries). Returns `<name>`, or undefined for a company
 * without a prior year in Banana.
 */
function priorYearExport(historyDir: string): string | undefined {
  const charts = existsSync(historyDir) ? readdirSync(historyDir).filter((f) => f.endsWith('.Konten.txt')).sort() : [];
  return charts.at(-1)?.slice(0, -'.Konten.txt'.length);
}

/** accounts.json (npm run init writes it) in the Konten.txt layout, for a company without a prior-year export. */
function chartFromAccounts(ws: Pick<Workspace, 'paths'>): string {
  if (!existsSync(ws.paths.accounts)) {
    throw new Error(`classify needs a chart of accounts: ${ws.paths.accounts} (npm run init writes it), or a prior-year Banana export in ${ws.paths.history} (<name>.Konten.txt and <name>.Buchungen-sample.tsv)`);
  }
  const accounts = JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as { number: string; name: string }[];
  return ['Konto\tBeschreibung', ...accounts.map((a) => `${a.number}\t${a.name}`)].join('\n');
}

/**
 * The chart the classifier and the rules book on, as `number<TAB>name` lines: the firm's own
 * accounts.json, which Firma › Kontenplan edits (an account added there is a rule's to name, r9k-5),
 * else the prior-year export of books that have no chart of their own yet.
 */
export function chartOf(ws: Pick<Workspace, 'paths'>): string {
  if (existsSync(ws.paths.accounts)) return chartFromAccounts(ws);
  const prior = priorYearExport(ws.paths.history);
  return prior ? readFileSync(join(ws.paths.history, `${prior}.Konten.txt`), 'utf8') : chartFromAccounts(ws);
}

/**
 * What code needs to book the bank's own fee rows (#359): the bank-charges account by the firm's own
 * chart and its types (accounts.json; a prior-year export's numbers by their class), and which fee
 * rows the bank coded as its charges, read from its statement files.
 */
function bankFeeContext(ws: Workspace, chartOfAccounts: string): Pick<ClassifyContext, 'bankCharges' | 'bankCoded' | 'wageAccount' | 'wageDeductions'> {
  const accounts = existsSync(ws.paths.accounts)
    ? JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as Array<{ number: string; type?: string }>
    : [...chartNames(chartOfAccounts).keys()].map((number) => ({ number, type: chart().typeOf(number) }));
  const charges = bankChargesOf(accounts);
  // The wage account by the same chart: the hand form's proposal for a wage (#382).
  const wage = setup().wages?.account;
  const wageAccount = wage && accounts.some((a) => a.number === wage && (a.type ?? chart().typeOf(a.number)) === 'expense') ? wage : undefined;
  const wageDeductions = setup().wages?.deductions;
  return { ...(charges && { bankCharges: charges }), bankCoded: bankCodedFee(ws), ...(wageAccount && { wageAccount }), ...(wageDeductions && { wageDeductions }) };
}

/**
 * The company (manifest), its chart and example entries (the prior-year export in history/, else
 * accounts.json and no examples of its own: the casebook stands in), and the app's VAT codes.
 */
export function loadClassifyContext(ws: Workspace): ClassifyContext {
  const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
  const prior = priorYearExport(ws.paths.history);
  const chartOfAccounts = chartOf(ws);
  const knowledge = loadKnowledge(APP_ROOT, ws.paths.root);
  const { counterparties } = knowledge;
  const facts = factsOf(chartNames(chartOfAccounts), new Set(counterparties.map((c) => c.id)), ws.dimensions);
  return {
    companyName: ws.company.name,
    bankAccounts: ws.bankAccounts,
    chartOfAccounts,
    historicEntries: prior ? read(ws.paths.history, `${prior}.Buchungen-sample.tsv`) : '',
    casebook: loadCases(),
    rules: placedRules(companyRules(ws, facts)),
    counterparties,
    purchaseVat: businessVat(knowledge),
    guidance: companyGuidance(knowledge),
    ownerAccount: ownerAccount(ws).split(' ')[0],
    ownerName: ws.company.owner,
    vat: ws.company.vat,
    ...(ws.profile?.sells.length ? { sells: salesDefaults(ws.profile.sells, setup().sells) } : {}),
    moneyAccounts: moneyAccounts(ws.bankAccounts, loadChart().accounts),
    ...(agreedBasis() ? { invoices: loadInvoices(ws) } : {}),
    companyUid: ws.company.uid,
    ...bankFeeContext(ws, chartOfAccounts),
    wageWordings: employs(ws.profile) ? receiptWordings(knowledge, 'employer') : [],
  };
}

/**
 * On the agreed basis an issued invoice's event carries its revenue on the receivable
 * (src/invoices/events.ts): a customer payment that could pay an open invoice (paymentProposals:
 * its open amount, or a part with its number or from the customer) is never booked as revenue
 * again, by a rule or the model. It waits unbooked with the invoice it could pay; the person
 * confirms it on the invoice, which settles the receivable, or books it by hand. Every incoming
 * payment of each call is matched against the open invoices once; the best match per payment.
 */
function openInvoicesPaid(books: Books, context: ClassifyContext): Map<string, PaymentProposal> {
  const out = new Map<string, PaymentProposal>();
  if (!agreedBasis() || !context.invoices) return out;
  for (const p of paymentProposals(books, context.invoices)) if (p.direction === 'CRDT' && !out.has(p.transactionRef)) out.set(p.transactionRef, p);
  return out;
}

/** The money a rule names, in the books' currency, as the books write it. */
const money = (n: number) => `${baseCurrency()} ${n.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/**
 * A rule in plain German words, for the booking's reason (booking texts stay German, docs/i18n.md).
 * `payers` names a payer by the key `when.payer` holds (payerNames); a booking passes its own payment's.
 */
export function ruleLine(placed: PlacedRule, context: Pick<ClassifyContext, 'chartOfAccounts' | 'counterparties'> & { payers?: Readonly<Record<string, string>> }): string {
  const accounts = chartNames(context.chartOfAccounts);
  const names: RuleNames = {
    account: (n) => accounts.get(n),
    business: (id) => context.counterparties?.find((c) => c.id === id)?.name,
    payer: (key) => context.payers?.[key],
    money,
  };
  const de = wordsIn('de');
  return ruleWords(placed, names, (key, vars) => de.t(key, vars as Record<string, string>)).line;
}

/** What a rule sees of `tx`: its business by routing, its bank account, its amount in the books' currency at the payment day's rate. */
export function paymentFacts(books: Books, tx: BankTransaction, context: ClassifyContext, fx: FxResolver): PaymentFacts {
  const routing = identify(signalsOfTransaction(tx, mappedReceipts(books, tx)), context.counterparties ?? []);
  const rate = tx.currency === baseCurrency() ? 1 : fx.daily(tx.currency, tx.date) ?? fx.flat(tx.currency) ?? 1;
  return {
    tx, counterparty: routing.kind === 'known' ? routing.counterparty : undefined,
    bankAccount: bankAccountFor(tx, context.bankAccounts), amount: tx.amount * rate,
  };
}

/** The rule that decides `tx`, if one does. */
/**
 * Whether the classifier decides a payment before any company rule (classifyTransactions' order): a
 * provider's payout, one that waits for its report, or a payment that could pay an open invoice. A
 * rule's card counts no such payment among those its keep books (#383).
 */
export function decidedBeforeRules(books: Books, context: ClassifyContext): (tx: BankTransaction) => boolean {
  const invoicePaid = openInvoicesPaid(books, context);
  return (tx) => {
    const linked = mappedReceipts(books, tx);
    return !!payoutWaitOf(tx, linked, context.counterparties ?? [], books.journalEntries) || !!providerOfPayment(tx, linked, context.counterparties ?? []) || invoicePaid.has(tx.ref);
  };
}

export function ruleOfPayment(books: Books, tx: BankTransaction, context: ClassifyContext, fx: FxResolver): PlacedRule | undefined {
  if (!context.rules?.length) return undefined;
  return ruleFor(context.rules, paymentFacts(books, tx, context, fx));
}

/**
 * The VAT code a rule's booking takes on this payment. Only the receipt decides a rate (AGENTS.md
 * § VAT code rules): an input-tax code with a rate falls to its zero code when no linked purchase
 * document shows Swiss VAT (ruleBookingLines). Money coming back on a purchase, or going out on a sale, takes the code's minus.
 */
export function ruleVatCode(code: string | null, tx: Pick<BankTransaction, 'direction'>, swissVat: boolean): string | undefined {
  if (!code) return undefined;
  const found = lookupVatCode(code);
  if (!found || found.negative) return code;
  const { family, rate } = found.entry;
  const purchase = family === 'I' || family === 'M';
  const unsigned = purchase && rate && rate > 0 && !swissVat ? `${family}0` : code;
  const back = (purchase || family === 'B') ? tx.direction === 'CRDT' : family === 'V' ? tx.direction === 'DBIT' : false;
  return back ? `-${unsigned}` : unsigned;
}

/** The books a refund's purchase is looked up in (refundedPurchase). */
export type RefundBooks = Parameters<typeof refundedPurchase>[2];

/**
 * The purchase a rule's booking of money back refunds (#357): a refund without a document that
 * shows Swiss VAT, on a rule with a purchase code, takes the code of the purchase it refunds with
 * the minus (refundedPurchase), not the zero code; `notFound` when no purchase is found
 * unambiguously (`tooMany`: more purchases to try in sums than the limit), and the line keeps the
 * zero code with the minus. Undefined for any other payment.
 */
export function ruleRefund(tx: BankTransaction, booking: RuleBooking, documents: readonly Pick<Receipt, 'kind' | 'hasSwissVat'>[], owner: string | undefined, books: RefundBooks | undefined): RefundCode | 'notFound' | 'tooMany' | undefined {
  if (!books || tx.direction !== 'CRDT' || !booking.vat || booking.foreignTax || documents.some((r) => isPurchaseDocument(r) && r.hasSwissVat)) return undefined;
  const found = lookupVatCode(booking.vat);
  if (!found || found.negative || (found.entry.family !== 'I' && found.entry.family !== 'M')) return undefined;
  // With a private share outside own use the business's part is what came back on the rule's account.
  const share = booking.private && owner && !booking.ownUse ? (Math.round(tx.amount * 100) - Math.round((Math.round(tx.amount * 100) * booking.private) / 100)) / 100 : tx.amount;
  const refund = refundLookup(tx, share, books, booking.account);
  // A code the firm's form does not take is never booked (formTakes): the rule's own code stands then.
  return !refund ? 'notFound' : refund === 'tooMany' || formTakes(refund.code) ? refund : undefined;
}

/**
 * A rule's booking line as it lands: account, VAT code (none: no code) and amount, the bank on the
 * other side; `against`: the other side when it is no bank (an own-use correction, owner's account / the rule's account).
 */
export interface RuleLine { account: string; vat?: string; amount: number; against?: string }

/**
 * The code that takes back the input tax of `code` as own use (privateUseCode, K81-B for I81),
 * with the minus of a refund (-I81: -K81-B). Undefined when the line claims no input tax.
 */
export function ownUseCode(code: string | undefined): string | undefined {
  const negative = !!code?.startsWith(vat().codes.negativePrefix);
  const unsigned = negative ? code!.slice(vat().codes.negativePrefix.length) : code;
  const k = privateUseCode(unsigned);
  return k && (negative ? `${vat().codes.negativePrefix}${k}` : k);
}

/**
 * What a rule's booking books for `tx`: the whole amount on the rule's account with its VAT code
 * (ruleVatCode), or, with a private share, that share on the owner's account without VAT and the
 * rest on the rule's account, or, with a foreign VAT, that tax on its account without a code and the
 * net on the rule's. The lines add up to what the bank paid, to the Rappen. A share as own
 * use leaves the whole amount on the rule's account and adds the share's input-tax correction
 * between the owner's account and it, only when that line claims input tax (no receipt with Swiss
 * VAT: the zero code, nothing to correct). `documents` are the payment's linked receipts: only a
 * purchase document (evidence-check isPurchaseDocument) proves Swiss VAT, never a delivery note or
 * a supporting document (#81).
 */
export function ruleBookingLines(tx: BankTransaction, booking: RuleBooking, documents: readonly Pick<Receipt, 'kind' | 'hasSwissVat'>[], owner: string | undefined, books?: RefundBooks): RuleLine[] {
  const refund = ruleRefund(tx, booking, documents, owner, books);
  const vat = typeof refund === 'object' ? refund.code : ruleVatCode(booking.vat, tx, documents.some((r) => isPurchaseDocument(r) && r.hasSwissVat));
  const whole: RuleLine = { account: booking.account, ...(vat ? { vat } : {}), amount: tx.amount };
  if (booking.foreignTax) {
    const tax = foreignTaxIn(tx.amount, booking.foreignTax.rate);
    return [{ ...whole, amount: Math.round((tx.amount - tax) * 100) / 100 }, { account: booking.foreignTax.account, amount: tax }];
  }
  if (!booking.private || !owner) return [whole];
  const total = Math.round(tx.amount * 100);
  const own = Math.round((total * booking.private) / 100);
  if (booking.ownUse) {
    const correction = ownUseCode(vat);
    return correction ? [whole, { account: owner, against: booking.account, vat: correction, amount: own / 100 }] : [whole];
  }
  return [{ ...whole, amount: (total - own) / 100 }, { account: owner, amount: own / 100 }];
}

/**
 * The own-use corrections a person booked for `tx` by hand, as the owner books them: an entry on a
 * ref of no payment, dated the payment's day, from `account` to the owner's account with `code`
 * (a refund's the other way). The rule then books no second one, and its preview counts them.
 */
export function handOwnUse(books: Pick<Books, 'journalEntries' | 'transactions'>, tx: Pick<BankTransaction, 'date' | 'direction'>, line: Pick<RuleLine, 'account' | 'against' | 'vat'>): JournalEntry[] {
  const payments = new Set(books.transactions.map((t) => t.ref));
  const [debit, credit] = tx.direction === 'DBIT' ? [line.account, line.against] : [line.against, line.account];
  return books.journalEntries.filter((e) => e.date === tx.date && e.vatCode === line.vat && e.accountDebit === debit && e.accountCredit === credit && !payments.has(e.transactionRef));
}

const chf = (n: number) => n.toFixed(2);

/** A courier invoice's booking texts, in the books' language (German, docs/i18n.md). */
export function customsTexts(): CustomsTexts {
  const de = wordsIn('de');
  return {
    position: (p) => de.t(`rules.say.customsPosition.${p}` as const),
    deduction: (a: Assessment) => de.t('rules.say.customsDeduction', { file: a.file }),
    reason: (a: Assessment) => de.t('rules.say.customsProven', { amount: chf(a.amount), currency: baseCurrency(), file: a.file }),
    correction: (a: Assessment, entry: JournalEntry, period: string) => de.t('rules.say.customsCorrection', { id: entry.id, period, file: a.file }),
  };
}

/** Why a payment's customs invoices are not split in code, as its booking's reason says it. */
export function customsHoldWords(hold: CustomsHold): string {
  const de = wordsIn('de');
  switch (hold.why) {
    case 'line': return de.t('rules.say.customsHold.line', { file: hold.file, line: hold.line });
    case 'sum': return de.t('rules.say.customsHold.sum', { file: hold.file, lines: chf(hold.lines), total: chf(hold.total) });
    case 'paid': return de.t('rules.say.customsHold.paid', { invoices: chf(hold.invoices), paid: chf(hold.paid), currency: hold.currency });
    case 'currency': return de.t('rules.say.customsHold.currency', { invoices: chf(hold.invoices), currency: hold.currency, paid: chf(hold.paid), paidCurrency: hold.paidCurrency, slack: String(hold.slack) });
    case 'other': return de.t('rules.say.customsHold.other', { file: hold.file });
    case 'account': return de.t('rules.say.customsHold.account', { account: hold.account });
  }
}

/**
 * The payment `tx` booked by the positions of its linked customs invoices (src/booking/customs-invoice.ts),
 * by code: freight and fees with the carrier's Swiss VAT where the line shows it, duty and import VAT
 * without, and the deduction of each linked assessment that proves an import VAT line. Undefined when
 * no customs invoice is linked; a note for the model's reason when they do not book it.
 */
export function customsEntries(books: Books, tx: BankTransaction, context: ClassifyContext, fx: FxResolver): { entries: JournalEntry[] } | { note: string } | undefined {
  const mapped = mappedReceipts(books, tx);
  const words = documents().customs;
  if (!words || !mapped.length) return undefined;
  const base = baseCurrency();
  const inBase = (c: string) => (c === base ? 1 : fx.daily(c, tx.date) ?? fx.flat(c));
  const texts = customsTexts();
  const split = customsSplit(tx, mapped, {
    words, chart: new Set(chartNames(context.chartOfAccounts).keys()), uid: context.companyUid, inputTax: !withoutInputTax(),
    convert: (amount, from) => { const a = inBase(from); const b = inBase(tx.currency); return a && b ? (amount * a) / b : undefined; },
    texts, name: merchantOf(tx.description),
  });
  if (!split) return undefined;
  const de = wordsIn('de');
  if ('hold' in split) return { note: de.t('rules.say.customsHold', { why: customsHoldWords(split.hold) }) };
  const bankAccount = bankAccountFor(tx, context.bankAccounts);
  const lock = periodLock(books);
  const said = [split.direct ? de.t('rules.say.customsDirect') : de.t('rules.say.customsSplit')];
  if (split.importVat > 0 && !withoutInputTax()) {
    if (split.unproven > 0) said.push(de.t('rules.say.customsUnproven', { amount: chf(split.unproven), currency: split.currency }));
    for (const a of split.assessments) said.push(texts.reason(a));
  }
  const lines = withDerivedCodes(split.lines, tx.direction, bankAccount);
  const entries = entriesFor(tx, lines, { fx, receipts: mapped.map((r) => r.id), bankAccount, lock, money: context.moneyAccounts, by: CUSTOMS_BY, reason: said.join('; '), corrects: correctsFor(tx, mapped, lock.isClosed, filing().length) });
  // A deduction is the assessment's tax in the books' currency, whatever the payment was made in.
  const booked = entries.map((e, k) => {
    if (!split.deductions.has(split.lines[k])) return e;
    const { exchangeCurrency: _c, exchangeRate: _r, ...rest } = e;
    return rest;
  });
  // Each assessment deducted is used: the passes never book from it again, even once a person takes it off this payment.
  const deductions = booked.filter((_, k) => split.deductions.has(split.lines[k]));
  split.assessments.forEach((a, k) => { const r = mapped.find((x) => x.id === a.receipt); if (r && deductions[k]) r.importVatDeduction = deductions[k].id; });
  return { entries: booked };
}

/**
 * The deductions customs assessments bring to import VAT booked before them (importVatDeductions),
 * booked into `books`, and the assessments marked as used. Save the books when either is more than none.
 */
export function bookImportVatDeductions(books: Books, context: Pick<ClassifyContext, 'companyUid'>): { booked: number; marked: number } {
  const words = documents().customs;
  if (!words) return { booked: 0, marked: 0 };
  const lock = periodLock(books);
  const through = lock.lockedThrough;
  const firstOpenDay = through ? new Date(Date.parse(`${through}T00:00:00Z`) + 864e5).toISOString().slice(0, 10) : '';
  return importVatDeductions(books, {
    words, uid: context.companyUid, inputTax: !withoutInputTax(), isClosed: (d) => lock.isClosed(d), firstOpenDay,
    length: filing().length, newId: () => randomBytes(8).toString('hex'), manualRef: (date) => nextManualRef(books, date.slice(0, 4)), texts: customsTexts(),
  });
}

/**
 * The input tax of each payment provider's fee bill (a document that proves a VAT-only correction),
 * booked into `books` or linked to the correction that books it already (src/booking/vat-corrections.ts).
 * Save the books when it booked or linked one.
 */
export function bookBillCorrections(books: Books, context: Pick<ClassifyContext, 'counterparties' | 'chartOfAccounts'>, fx: FxResolver): CorrectionsDone {
  const lock = periodLock(books);
  const chart = new Set(chartNames(context.chartOfAccounts).keys());
  const de = wordsIn('de');
  const day = (iso: string) => iso.split('-').reverse().join('.');
  return bookVatCorrections(books, context.counterparties ?? [], {
    inputTax: !withoutInputTax(), isClosed: (d) => lock.isClosed(d), inChart: (a) => chart.has(a), base: baseCurrency(),
    rate: (currency, date) => fx.daily(currency, date),
    code: (rate, account, billVat) => (billVat && vat().codes.parse(billVat)?.rate === rate ? billVat : codeOfFacts({ charge: 'charged', rate, amountIs: 'tax' }, '', account)),
    newId: () => randomBytes(8).toString('hex'), manualRef: (date) => nextManualRef(books, date.slice(0, 4)),
    texts: {
      description: (business, date) => de.t('vatCorrection.text', { business, date: day(date) }),
      reason: (business, date, rate, currency, amount, code, account) => de.t('vatCorrection.reason', { business, date: day(date), rate, currency, amount: chf(amount), code, account }),
    },
  });
}

/** Why a provider's payout waits for the person (PayoutWait), in the books' language: what the run's note and the payment say. */
export function payoutWaitReason(w: PayoutWait): string {
  // A provider without a sales report books its sales from its payout reports: no order export to wait for.
  const own = w.provider.provider.reports.sales ? '' : 'NoSales';
  const key = w.why === 'clearing' ? `salesReport.noClearing${own}` : w.why === 'since' ? `salesReport.noSince${own}` : 'salesReport.gapPayout';
  return wordsIn('de').t(key as 'salesReport.gapPayout', { provider: w.provider.name, since: w.provider.provider.since ?? '', account: w.provider.provider.clearing ?? '' });
}

/**
 * A payment provider's payout, booked in code (#203): bank / its clearing account, without VAT, on
 * the payment's day. The sales and the fees are on the clearing account already, from the provider's
 * reports (src/booking/sales-report.ts). Refused, and so left for the person, when the clearing
 * account is not in the chart. Call it only for a provider whose company file names its clearing account.
 */
export function providerPayout(books: Books, tx: BankTransaction, provider: Provider, context: ClassifyContext, fx: FxResolver): JournalEntry[] | { reason: string; refusal: ClassifyRefusal } {
  const clearing = provider.provider.clearing!;
  const bankAccount = bankAccountFor(tx, context.bankAccounts);
  const lock = periodLock(books);
  const entries = entriesFor(tx, [{ accountDebit: bankAccount, accountCredit: clearing, amount: tx.amount, description: wordsIn('de').t('salesReport.payoutText', { provider: provider.name }) }], {
    fx, receipts: [], bankAccount, lock, money: context.moneyAccounts,
    by: { kind: 'code', check: 'payoutReport' }, reason: wordsIn('de').t('salesReport.payoutReason', { provider: provider.name, account: clearing }),
  });
  return paymentRefusal(tx, entries, bankAccount, new Set(chartNames(context.chartOfAccounts).keys())) ?? entries;
}

/**
 * The bank's own fee row, booked in code (#359, src/booking/bank-fee.ts): bank / the bank-charges
 * account, without a VAT code (a bank's services are exempt: no input tax, so a fee refund has no
 * code to take back either), on the payment's day. Undefined when the firm's chart lacks the
 * account as an expense account, or the jurisdiction names none: the row goes on as any payment
 * does, to the model, or without one to the person, whose form says which account is missing
 * (src/saving/hand-rule.ts). Call it only for a row no company rule decides and the bank coded as
 * its charge (isOwnBankFee). Stamped as the app's purchase-VAT check, as a customs invoice booked
 * by its positions is (a check of its own would change the books' format): the reason says what
 * code decided.
 */
export function bankFeeEntries(books: Books, tx: BankTransaction, context: ClassifyContext, fx: FxResolver): JournalEntry[] | { reason: string; refusal: ClassifyRefusal } | undefined {
  const names = chartNames(context.chartOfAccounts);
  const charges = context.bankCharges;
  if (!charges || 'missing' in charges) return undefined;
  const de = wordsIn('de');
  const bankAccount = bankAccountFor(tx, context.bankAccounts);
  const out = tx.direction === 'DBIT';
  const bank = tx.counterparty?.trim() || tx.bank;
  const text = tx.description.trim();
  const description = text && text !== bank ? de.t('bankFee.text', { bank, text }) : bank;
  const entries = entriesFor(tx, [{ accountDebit: out ? charges.account : '', accountCredit: out ? '' : charges.account, amount: tx.amount, vatCode: '', description }], {
    fx, receipts: [], bankAccount, lock: periodLock(books), money: context.moneyAccounts,
    by: { kind: 'code', check: 'purchaseVat' }, reason: de.t(out ? 'bankFee.reason' : 'bankFee.refundReason', { account: charges.account, name: names.get(charges.account) ?? '' }),
  });
  return paymentRefusal(tx, entries, bankAccount, new Set(names.keys())) ?? entries;
}

/** The entries a rule's booking makes for `tx` (ruleBookingLines), the bank on the other side, stamped with the rule. */
export function ruleEntries(books: Books, tx: BankTransaction, placed: PlacedRule, booking: RuleBooking, context: ClassifyContext, fx: FxResolver): JournalEntry[] {
  const mapped = mappedReceipts(books, tx);
  const bankAccount = bankAccountFor(tx, context.bankAccounts);
  const out = tx.direction === 'DBIT';
  // An own-use correction a person booked by hand already stands: the rule books the payment, never a second correction.
  const lines = ruleBookingLines(tx, booking, mapped, context.ownerAccount, books).filter((l) => !l.against || !handOwnUse(books, tx, l).length);
  const entries: ClassifyEntry[] = lines.map((l) => (l.against
    ? { accountDebit: out ? l.account : l.against, accountCredit: out ? l.against : l.account, amount: l.amount, vatCode: l.vat ?? '', description: wordsIn('de').t('rules.say.ownUseText', { percent: String(booking.private), text: merchantOf(tx.description) }) }
    : { accountDebit: out ? l.account : '', accountCredit: out ? '' : l.account, amount: l.amount, vatCode: l.vat ?? '', description: merchantOf(tx.description) }));
  const code = lines[0].vat;
  // The rule names a rate, the payment got the zero code: the reason says why, never the rule's rate alone.
  // A refund: the purchase it refunds names its code, or none was found and the zero code stands (#357).
  const refund = ruleRefund(tx, booking, mapped, context.ownerAccount, books);
  const de = wordsIn('de');
  const zero = typeof refund === 'object' ? `; ${refundReason(refund)}`
    : refund && code && formTakes(code) ? `; ${de.t(refund === 'tooMany' ? 'rules.say.refundTooMany' : 'rules.say.refundNotFound', { code, limit: String(SUMS_OF) })}`
      : booking.vat && code && code.replace(/^-/, '') !== booking.vat ? `; ${de.t('rules.say.zeroCode', { code })}` : '';
  const lock = periodLock(books);
  const booked = entriesFor(tx, entries, { fx, receipts: mapped.map((r) => r.id), bankAccount, lock, reason: `Regel: ${ruleLine(placed, { ...context, payers: payerNames([tx]) })}${zero}`, by: { kind: 'rule', rule: placed.rule.id }, money: context.moneyAccounts, corrects: correctsFor(tx, mapped, lock.isClosed, filing().length) })
    .map((e) => stampRule(e, placed.rule.id, booking));
  return receiptTaxOf(books, tx, booked, mapped);
}

const newEntryId = () => randomBytes(8).toString('hex');

/**
 * withReceiptTax for a booking of the whole bank payment only. A part of a collective payment, or
 * what is left of it, is booked against receipts that are the whole payment's (a receipt in the
 * books' currency pays no part of a foreign one, partReceipts): the invoices' tax is not the part's.
 */
function receiptTaxOf(books: Books, tx: BankTransaction, entries: JournalEntry[], mapped: Receipt[]): JournalEntry[] {
  const whole = books.transactions.find((t) => t.ref === tx.ref);
  return whole && whole.amount !== tx.amount ? entries : withReceiptTax(tx, entries, mapped, newEntryId, receiptTaxReason);
}

/** Why the input tax of a foreign payment is the invoice's own (src/booking/receipt-tax.ts). */
const receiptTaxReason = (tax: number, rate: number) =>
  `Der Beleg weist die Steuer in ${baseCurrency()} aus: ${tax.toFixed(2)} zu ${rate} % als Vorsteuer, wie auf dem Beleg, nicht aus der umgerechneten Zahlung gerechnet.`;

/** A part of a collective payment, or what is left of it, as the model is asked about it: the books with only its own receipts, and the key its answer comes under. */
interface PartView { books: Books; key: string; note?: string; cap?: true }

/**
 * A collective payment no rule decides as a whole, by its parts (r10h-14): each part is a payment of
 * its own (partPayment) with the receipts that pay it (partReceipts), decided as a single payment
 * is, by a rule that books or by its customs invoice. A part left open that a receipt pays goes to
 * the model alone with that receipt (`alone`); the open parts without one go together (`rest`: the
 * same ref, what is left of the amount). Undefined when code decides no part and no receipt pays
 * one: the payment is booked as a whole. `whole`: code decided every part. A rule that asks decides no part.
 */
function byParts(books: Books, tx: BankTransaction, context: ClassifyContext, fx: FxResolver): { entries: JournalEntry[]; whole: boolean; alone: Array<{ tx: BankTransaction; view: PartView }>; rest?: { tx: BankTransaction; view: PartView } } | undefined {
  // A card's settlement whose statement's lines have bills linked to them (#409) is split by those lines: each line's bill is evidence of that line alone.
  const card = cardLinesOf(books, tx);
  const byLine = card && lineReceiptsOf(books, tx.ref, card.lines.length);
  const lined = byLine?.some((rs) => rs.length) ? { parts: cardParts(card!.lines, tx.currency), held: byLine, statement: card!.statement.id } : undefined;
  const parts = lined?.parts ?? partsOf(tx);
  if (!parts) return undefined;
  const held = lined?.held ?? partReceipts(tx, mappedReceipts(books, tx));
  const paid = held?.some((rs) => rs.length);
  if (!context.rules?.length && !paid) return undefined;
  // Each part sees its own receipts only: another part's are no evidence of it. Receipts that pay no part stay the whole payment's;
  // a card statement is the receipt of its lines without a bill of their own, never of a line's bill.
  // A line's bill is its part's own receipt: in the part's view it is linked to the part as a whole.
  const only = (ids: ReadonlySet<string>): Books => (held ? { ...books, mappings: books.mappings.filter((m) => m.transactionRef !== tx.ref || ids.has(m.receiptId)).map(({ line: _, ...m }) => m) } : books);
  const rate = tx.currency === baseCurrency() ? 1 : fx.daily(tx.currency, tx.date) ?? fx.flat(tx.currency) ?? 1;
  const decided = parts.map((p, i) => {
    const part = lined ? cardPart(tx, p) : partPayment(tx, p);
    const view: PartView = { books: only(new Set((held?.[i] ?? []).map((r) => r.id))), key: `${tx.ref}#${i + 1}`, ...(lined && held?.[i]?.length ? { cap: true as const } : {}) };
    const routing = identify(signalsOfTransaction(part, held ? mappedReceipts(view.books, part) : []), context.counterparties ?? []);
    const placed = context.rules?.length ? ruleFor(context.rules, { tx: part, counterparty: routing.kind === 'known' ? routing.counterparty : undefined, bankAccount: bankAccountFor(tx, context.bankAccounts), amount: part.amount * rate }) : undefined;
    const then = placed?.rule.then;
    if (placed && then?.kind === 'book') return { part, view, entries: ruleEntries(view.books, part, placed, then.booking, context, fx) };
    const customs = held?.[i].length ? customsEntries(view.books, part, context, fx) : undefined;
    if (customs && 'entries' in customs) return { part, view, entries: customs.entries };
    return { part, view: customs ? { ...view, note: customs.note } : view, entries: undefined, paid: !!held?.[i].length };
  });
  const entries = decided.flatMap((d) => d.entries ?? []);
  if (!entries.length && !paid) return undefined;
  const open = decided.filter((d) => !d.entries);
  // A card statement's credit line (money back) is a payment the other way: it goes alone, with the statement, never summed into the charges.
  const credit = (i: number) => !!lined && parts[i].amount < 0;
  const statementView = (v: PartView): PartView => ({ ...v, books: only(new Set([lined!.statement])) });
  const alone = [
    ...open.filter((d) => d.paid).map(({ part, view }) => ({ tx: part, view })),
    ...decided.flatMap((d, i) => (!d.entries && !d.paid && credit(i) ? [{ tx: d.part, view: statementView(d.view) }] : [])),
  ];
  const loose = parts.filter((_, i) => !decided[i].entries && !decided[i].paid && !credit(i));
  const sign = tx.amount < 0 ? -1 : 1;
  const rest = loose.length ? { tx: { ...tx, amount: sign * loose.reduce((sum, p) => sum + Math.abs(p.amount), 0), description: loose.map(partText).join('; '), parts: loose.length > 1 ? loose : undefined }, view: { books: only(new Set(lined ? [lined.statement] : [])), key: tx.ref } } : undefined;
  return { entries, whole: !open.length, alone, rest };
}

type PromptInput = Parameters<typeof buildBatchClassifyPrompt>[0][number];

/**
 * What the prompt says about one transaction: the transaction and its receipts, with their VAT facts; `legs`: the movements of its
 * card charge (src/intake/charges.ts), whose other legs that hold its receipts it names. A leg that shares its ref goes by its legKey.
 * `counterparties`: the businesses it may route to, whose file's decisions for the booking steps it carries (src/knowledge/guidance.ts).
 */
export function classifyInput(books: Books, tx: BankTransaction, legs: readonly BankTransaction[] = [tx], counterparties: readonly Counterparty[] = []): PromptInput {
  const linked = mappedReceipts(books, tx);
  const routing = identify(signalsOfTransaction(tx, linked), counterparties);
  const cp = routing.kind === 'known' ? counterparties.find((c) => c.id === routing.counterparty) : undefined;
  const guidance = cp ? businessGuidance(cp) : [];
  const receipts = linked
    // A photo nothing could read counts by what a person entered on it (#438).
    .filter((r) => (r.extractedText && r.extractedText.length > 10) || r.vatBy === 'human')
    .map((r) => ({
      text: r.extractedText,
      amount: r.amount,
      currency: r.currency,
      description: r.description,
      filename: r.filename,
      hasSwissVat: r.hasSwissVat,
      vatId: r.vatId,
      vatSummary: r.vatSummary,
      lineItems: r.lineItems,
    }));
  const fee = separateFeeOf(tx, books.transactions);
  const shared = sharedReceipts(books, tx, legs);
  return {
    tx: { ref: legKey(tx, legs), date: tx.date, amount: tx.amount, currency: tx.currency, direction: tx.direction, description: tx.description, bank: tx.bank, ...(tx.counterparty ? { counterparty: tx.counterparty } : {}), ...(fee ? { separateFee: { ref: fee.ref, amount: fee.amount, currency: fee.currency } } : {}), ...(tx.businessPart ? { businessPart: { ...(tx.businessPart.what && { what: tx.businessPart.what }) } } : {}), ...(shared ? { sharedWith: shared.others.map((t) => ({ ref: t.ref, amount: t.amount, currency: t.currency })) } : {}), ...(cp && guidance.length ? { business: { name: cp.name, guidance } } : {}) },
    receipts,
  };
}

/**
 * The receipts whose VAT must be read before the model books `tx` (#391): a payment out of a firm
 * that claims input tax, whose linked purchase documents are all not read yet (vatNotRead). Empty
 * otherwise: no receipt, one read, one that could not be read (its own wait, #57), money in.
 */
export function vatToRead(books: Books, tx: BankTransaction): Receipt[] {
  if (tx.direction !== 'DBIT' || withoutInputTax()) return [];
  const purchase = mappedReceipts(books, tx).filter(isPurchaseDocument);
  return purchase.length && purchase.every(vatNotRead) ? purchase : [];
}

/**
 * The receipts linked to a payment; a copy a person marked as such never claims its input tax a second time.
 * A bill of one line of a card's settlement (Mapping.line, #409) is none of the whole payment's: only its
 * line's part sees it (byParts), whether or not the line still has its statement.
 */
export function mappedReceipts(books: Books, tx: BankTransaction) {
  return books.mappings
    .filter((m) => m.transactionRef === tx.ref && m.line === undefined)
    .map((m) => books.receipts.find((r) => r.id === m.receiptId))
    .filter((r): r is NonNullable<typeof r> => !!r && r.kind !== 'duplicate');
}

/**
 * The model's sale lines with the code that code decides (src/accounting/sales-without-vat.ts
 * saleCodeOf): a customer payment without an invoice gets the app's proposal, never a zero code for
 * want of a paper; an invoice that places its service abroad the abroad code; books not registered
 * for VAT no code; a firm on the net tax rate method its approved rate's code. Such a line's reason
 * says why, in place of the model's.
 */
function withSaleCodes(tx: BankTransaction, entries: JournalEntry[], documents: ReturnType<typeof mappedReceipts>, setup: VatSetup): JournalEntry[] {
  return entries.map((e) => {
    const decided = saleCodeOf(e.vatCode, e.accountCredit, tx, documents, setup);
    if (!decided) return e;
    const { vatCode: _, ...rest } = e;
    return { ...rest, ...(decided.code ? { vatCode: decided.code } : {}), reason: saleCodeReason(decided, tx.currency), by: { kind: 'code', check: 'saleCode' } };
  });
}

/**
 * The model's lines of a supplier's credit note without its own document that names a booked
 * invoice, with that invoice's code and the minus (src/accounting/credit-note-code.ts); the reason
 * names the invoice, in place of the model's.
 */
function withCreditNoteCodes(books: Books, tx: BankTransaction, entries: JournalEntry[], documents: ReturnType<typeof mappedReceipts>): JournalEntry[] {
  return entries.map((e) => {
    const decided = creditNoteCodeOf(e, tx, documents, books);
    if (!decided) return e;
    return { ...e, vatCode: decided.code, reason: wordsIn('de').t('rules.say.creditNoteCode', { invoice: decided.invoice, invoiceCode: decided.invoiceCode, code: decided.code }), by: { kind: 'code', check: 'creditNote' } };
  });
}

/**
 * The model's lines of a refund of a booked purchase with that purchase's code and the minus
 * (src/booking/refund-code.ts, #288); the reason names the purchase, in place of the model's.
 */
function withRefundCodes(books: Books, tx: BankTransaction, entries: JournalEntry[], bank: string): JournalEntry[] {
  return entries.map((e) => {
    const decided = e.by?.kind === 'model' ? refundCodeOf(e, tx, bank, books) : undefined;
    if (!decided || decided.code === e.vatCode) return e;
    return { ...e, vatCode: decided.code, reason: refundReason(decided), by: { kind: 'code', check: 'creditNote' } };
  });
}

/** Why a refund takes the code of the purchase it refunds: that purchase, its entry and its code. */
const refundReason = (r: RefundCode): string => wordsIn('de').t('rules.say.refundCode', { date: day(r.original.date), entry: r.entry, originalCode: r.originalCode, code: r.code });

/**
 * A code the firm's form does not take is left off the entry: a firm not registered for VAT books
 * everything gross, one on the net tax rate method its purchases. On the effective method the
 * model's code stands as written; one the engine does not know is refused (paymentRefusal).
 */
const permittedCode = (code: string | undefined): string | undefined => (code && formTakes(code) ? code : undefined);

/**
 * The model's lines without the zero input code (I0, M0, either sign) where the other account takes
 * no VAT code at all (zeroCodeOff: a wage, a contribution, the bank charges, a debt, the owner's or a
 * money account): the guide books those without a code, as the hand form and the rules do (#402). The
 * zero code has no box, so no figure changes; a rate the receipt shows stays.
 */
function withoutZeroOnNoCode(entries: JournalEntry[], bankAccount: string, context: Pick<ClassifyContext, 'moneyAccounts' | 'ownerAccount'>): JournalEntry[] {
  const settles = (a: string) => a === context.ownerAccount || !!context.moneyAccounts?.has(a);
  return entries.map((e) => {
    if (!e.vatCode || lookupVatCode(e.vatCode)?.entry.kind !== 'inputNoVat') return e;
    const other = e.accountDebit === bankAccount ? e.accountCredit : e.accountDebit;
    if (!other || !zeroCodeOff(other, settles)) return e;
    const { vatCode: _, ...rest } = e;
    return rest;
  });
}
/** The model's code with the sign the accounts and the bank's side give it (r9h-11, #288): a credit note's M0 becomes -M0, money back on 1540 -I81, whatever the model wrote. */
const signed = (code: string | undefined, accountDebit: string, accountCredit: string, amount: number, bank: string): string | undefined => codeSignFor(code, accountDebit, accountCredit, amount, bank) ?? code;

export interface ClassifyDeps {
  /** Absent: no model; what no rule decides is left in `unasked`. */
  ask?: (prompt: string, opts: AskOptions) => Promise<string>;
  fx: FxResolver;
  context: ClassifyContext;
  log?: (line: string) => void;
  /** Runs after each wave of concurrent batches, e.g. to save the books so far. */
  afterWave?: () => void;
  /** A held payment whose rule proposes no booking gets the model's proposal; false: no model call for it (its task proposes later). */
  proposeAsked?: boolean;
}

/** A payment a rule says to ask the person about: not booked; `entries` is what the app would book (empty: no proposal). */
export interface Asked { ref: string; rule: string; question: string; entries: JournalEntry[] }

export interface ClassifyOutcome {
  classified: string[];
  /** `refusal`: the answer came, but would have booked the payment wrong (paymentRefusal). */
  failed: Array<{ ref: string; reason: string; refusal?: ClassifyRefusal }>;
  /** Payments a rule holds for the person, never booked here. */
  asked: Asked[];
  /** Payments no rule decided, left unbooked because there is no model. */
  unasked: string[];
  /** Payments out left unbooked until the VAT of their receipts is read (vatToRead, #391): the model is not asked to guess it. */
  vatNotRead: string[];
  /** Collective payments booked in part, one line per part a rule decided; the rest is the person's (r10h-14). Also in `classified`. */
  partly: string[];
}

/**
 * Books `txs`: first by the company's rules, in code (a rule that books books; a rule that asks
 * holds the payment in `asked`, never booked), then the rest by the model, ten transactions per
 * call, three calls at a time, appended to `books.journalEntries`. A transaction the model gives
 * no entries for is reported in `failed` and left unbooked.
 */
export async function classifyTransactions(books: Books, txs: BankTransaction[], deps: ClassifyDeps): Promise<ClassifyOutcome> {
  const { ask, fx, context, log = () => {}, afterWave, proposeAsked = true } = deps;
  const lock = periodLock(books);
  const casebook = context.casebook && ownHistoryRows(books, context) < OWN_HISTORY_THRESHOLD ? context.casebook : [];
  const chartAccounts = new Set(chartNames(context.chartOfAccounts).keys());
  const items = openItemAccounts([...chartAccounts]);
  const clearing = clearingAccounts(context.counterparties ?? []);
  /** The parts of collective payments the model is asked about each on its own (byParts): their books and keys. */
  const views = new Map<BankTransaction, PartView>();
  const booksOf = (tx: BankTransaction): Books => views.get(tx)?.books ?? books;
  // On the agreed basis a coded line takes its document's date and the open item; on the cash basis this changes nothing (src/accounting/tax-point.ts).
  const atPoint = (tx: BankTransaction, entries: JournalEntry[]): JournalEntry[] => atTaxPoint(tx, entries, {
    accounts: items, bankAccount: bankAccountFor(tx, context.bankAccounts), clearing, lock, rateOn: (c, d) => fx.daily(c, d),
    documents: mappedReceipts(booksOf(tx), tx), length: filing().length, newId: () => randomBytes(8).toString('hex'),
  });
  const outcome: ClassifyOutcome = { classified: [], failed: [], asked: [], unasked: [], vatNotRead: [], partly: [] };
  // The legs of a card charge split across balances share its receipts: each books its share, the input tax of all of them never more than the receipts show (#190).
  const charges = chargesOf(books.transactions, (amount, currency, date) => { if (currency === baseCurrency()) return amount; const rate = fx.daily(currency, date) ?? fx.flat(currency); return rate === undefined ? undefined : amount * rate; });
  const legsOf = (tx: BankTransaction) => charges.of(tx).legs;
  // The model answers by the key the prompt gives each transaction: the legs of a split under one ref apart (#287).
  const keyOf = (tx: BankTransaction) => views.get(tx)?.key ?? legKey(tx, legsOf(tx));
  const invoicePaid = openInvoicesPaid(books, context);
  const toModel: BankTransaction[] = [];
  /** Asked payments whose rule proposes nothing: the model proposes, the entries go to `asked`. */
  const proposing = new Map<string, ClassifyOutcome['asked'][number]>();
  /** Why a payment's customs invoices were not split in code: the model's reason says it. */
  const customsNotes = new Map<BankTransaction, string>();
  /**
   * A collective payment whose parts went to the model: its lines so far and how many parts are still unanswered.
   * It is booked once every part has its lines, in one go, or in no part: never short of what the bank paid.
   */
  const byPart = new Map<string, { entries: JournalEntry[]; open: number }>();
  for (const tx of txs) {
    // A payment provider's payout settles its clearing account, in code, whatever a rule or the model would say (#203).
    // Until the company's file names the clearing account and the cut-over day (the first sales report asks for both), the payout waits
    // for the person: neither a rule nor the model knows its sales, its exports or its fees, so none guesses them from the payout.
    // A payout before the cut-over day is no provider's payout here (providerOfPayment): it is booked like any other payment,
    // unless a sales report booked sales dated before it onto the clearing account already (PayoutWait 'gap'): then it waits too.
    const waits = payoutWaitOf(tx, mappedReceipts(books, tx), context.counterparties ?? [], books.journalEntries);
    if (waits) {
      log(`  ${tx.ref}  payout of ${waits.provider.name}: waits for the person (${waits.why})`);
      outcome.failed.push({ ref: tx.ref, reason: payoutWaitReason(waits) });
      continue;
    }
    const provider = providerOfPayment(tx, mappedReceipts(books, tx), context.counterparties ?? []);
    const booked = provider ? providerPayout(books, tx, provider, context, fx) : undefined;
    if (provider && booked) {
      if ('refusal' in booked) { log(`  ${tx.ref}  payout of ${provider.name}: refused: ${booked.reason}`); outcome.failed.push({ ref: tx.ref, ...booked }); continue; }
      books.journalEntries.push(...booked);
      log(`  ${tx.ref}  → payout of ${provider.name}, from its clearing account`);
      outcome.classified.push(tx.ref);
      continue;
    }
    const paid = invoicePaid.get(tx.ref);
    if (paid) {
      log(`  ${tx.ref}  could pay invoice ${paid.number}: waits for the person to confirm it there`);
      outcome.failed.push({
        ref: tx.ref,
        reason: `Die Zahlung könnte Rechnung ${paid.number} von ${paid.customerName} bezahlen, deren Umsatz mit der Rechnung auf Debitoren gebucht ist: nichts gebucht. Unter Rechnungen › ${paid.number} die Zahlung bestätigen, oder von Hand buchen.`,
        refusal: { code: 'classifyOpenInvoice', params: { number: paid.number, customer: paid.customerName } },
      });
      continue;
    }
    const placed = ruleOfPayment(books, tx, context, fx);
    const then = placed?.rule.then;
    // The bank's own fee row is booked in code when no company rule decides it, before the model is asked (#359).
    const fee = !placed && isOwnBankFee(tx, context.bankCoded) ? bankFeeEntries(books, tx, context, fx) : undefined;
    if (fee) {
      if ('refusal' in fee) { log(`  ${tx.ref}  bank's fee row: refused: ${fee.reason}`); outcome.failed.push({ ref: tx.ref, ...fee }); continue; }
      books.journalEntries.push(...fee);
      log(`  ${tx.ref}  → bank's fee row, on ${fee[0].accountDebit === bankAccountFor(tx, context.bankAccounts) ? fee[0].accountCredit : fee[0].accountDebit}`);
      outcome.classified.push(tx.ref);
      continue;
    }
    const split = placed ? undefined : byParts(books, tx, context, fx);
    // Without a model, a payment code books no part of is booked as a whole (no model: unasked).
    if (split && (split.entries.length || ask)) {
      // The parts code did not decide go to the model when there is one, each with its own receipts; the decided parts stay code's.
      const asked = ask ? [...split.alone, ...(split.rest ? [split.rest] : [])] : [];
      log(`  ${tx.ref}  → by part${split.whole ? '' : asked.length ? ', the rest to the model' : ', the rest waits for the person'}`);
      for (const { tx: part, view } of asked) {
        views.set(part, view);
        if (view.note) customsNotes.set(part, view.note);
        toModel.push(part);
      }
      if (asked.length) { byPart.set(tx.ref, { entries: atPoint(tx, split.entries), open: asked.length }); continue; }
      books.journalEntries.push(...atPoint(tx, split.entries));
      outcome.classified.push(tx.ref);
      if (!split.whole) outcome.partly.push(tx.ref);
      continue;
    }
    if (!placed) {
      // A courier's customs invoice is split by its positions in code; one that does not add up goes to the model, told why.
      const customs = customsEntries(books, tx, context, fx);
      if (customs && 'entries' in customs) {
        books.journalEntries.push(...atPoint(tx, customs.entries));
        log(`  ${tx.ref}  → customs invoice by its positions`);
        outcome.classified.push(tx.ref);
        continue;
      }
      if (customs) customsNotes.set(tx, customs.note);
    }
    if (!placed || !then) { toModel.push(tx); continue; }
    if (then.kind === 'book') {
      books.journalEntries.push(...atPoint(tx, ruleEntries(books, tx, placed, then.booking, context, fx)));
      log(`  ${tx.ref}  → rule ${placed.rule.id}`);
      outcome.classified.push(tx.ref);
      continue;
    }
    const asked = { ref: tx.ref, rule: placed.rule.id, question: then.question, entries: then.booking ? atPoint(tx, ruleEntries(books, tx, placed, then.booking, context, fx)) : [] };
    log(`  ${tx.ref}  waits for the person (rule ${placed.rule.id})`);
    outcome.asked.push(asked);
    if (!then.booking && proposeAsked) { proposing.set(tx.ref, asked); toModel.push(tx); }
  }
  afterWave?.();
  if (!ask) {
    outcome.unasked = toModel.filter((tx) => !proposing.has(tx.ref)).map((tx) => tx.ref);
    return outcome;
  }
  // The payments that repay the owner's outlays, each told what was open for it after the earlier ones (#402).
  const repayments = repaymentsOf(books, context, context.wageWordings ?? [], fx);
  // A payment out whose purchase receipts nobody has read yet waits for the VAT step, not for the model's guess at its input tax (#391);
  // a repayment of the owner's outlays books onto her account and claims none, a part of a collective payment keeps the backstop in withPurchaseVat.
  for (const tx of [...toModel]) {
    if (views.has(tx) || proposing.has(tx.ref) || repayments.has(tx.ref) || !vatToRead(books, tx).length) continue;
    toModel.splice(toModel.indexOf(tx), 1);
    log(`  ${tx.ref}  waits: the VAT of its receipt is not read yet`);
    outcome.vatNotRead.push(tx.ref);
  }
  // The payments of contributions (#426): to a business that collects them, or one booked on the wages' accounts before; never a wage
  // (its text or its payee's), nor a purchase whose receipt shows the jurisdiction's VAT. Each is told what the wages withheld.
  const businessOf = (t: BankTransaction): string | undefined => {
    const routing = identify(signalsOfTransaction(t, mappedReceipts(books, t)), context.counterparties ?? []);
    return routing.kind === 'known' ? routing.counterparty : undefined;
  };
  const isWage = (t: BankTransaction) => !!context.wageWordings?.some((w) => w.test(t.description) || (!!t.counterparty && w.test(t.counterparty)));
  const contributions = new Set(context.wageDeductions ? toModel.filter((t) => !repayments.has(t.ref) && !isWage(t) && !mappedReceipts(booksOf(t), t).some((r) => r.hasSwissVat) && paysContributions(books, t, businessOf)).map((t) => t.ref) : []);
  // Where code books what an answer takes off the deductions account over what it holds (#470): the employer's contribution accounts.
  const wages = wageAccounts();
  const employer = { named: wages?.contributions ?? new Set<string>(), shared: wages?.shared ?? new Set<string>(), fallback: [...(wages?.contributions ?? [])].find((a) => !chartAccounts.size || chartAccounts.has(a)) };
  const withheldOf = (own: Books, tx: BankTransaction): { account: string; open: number } | undefined => {
    if (!context.wageDeductions || !contributions.has(tx.ref)) return undefined;
    // Nothing held is said too (#470): the model is told that the whole contribution is the employer's, not left to read the bill's split.
    return { account: context.wageDeductions, open: withheldFor(own, tx, context.wageDeductions) ?? 0 };
  };
  // The contribution payments go last, in waves of their own: what the wages of this run withhold is booked before they are asked.
  const batches: BankTransaction[][] = [];
  const later: BankTransaction[][] = [];
  const first = toModel.filter((t) => !contributions.has(t.ref));
  const last = toModel.filter((t) => contributions.has(t.ref));
  for (let i = 0; i < first.length; i += BATCH_SIZE) batches.push(first.slice(i, i + BATCH_SIZE));
  for (let i = 0; i < last.length; i += BATCH_SIZE) later.push(last.slice(i, i + BATCH_SIZE));
  const firstCount = batches.length;
  batches.push(...later);

  const processBatch = async (batch: BankTransaction[], batchNum: number) => {
    // An asked payment the model could not propose for still waits for the person, without a proposal.
    const fail = (tx: BankTransaction, reason: string) => { if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, reason }); };
    try {
      const examples = casebook.length ? casesForBatch(books, batch, casebook) : [];
      const prompt = buildBatchClassifyPrompt(batch.map((tx) => {
        const input = classifyInput(booksOf(tx), tx, legsOf(tx), context.counterparties);
        // A payment that pays the owner back her outlays (#402): the model is told what her account holds, so it books there, never an expense again.
        const open = repayments.get(tx.ref);
        const owed = context.ownerAccount && open !== undefined ? { account: context.ownerAccount, open } : undefined;
        // Money out while the wages' deductions account holds a credit (#426): what the payslips withheld, so a contribution payment can clear the employees' share.
        const withheld = owed ? undefined : withheldOf(booksOf(tx), tx);
        return { ...input, tx: { ...input.tx, ref: keyOf(tx), ...(owed && { ownerOutlays: owed }), ...(withheld && { withheld }) } };
      }), context, examples);
      let model: string | undefined;
      const raw = await ask(prompt, { step: 'classify', timeoutMs: CALL_TIMEOUT_MS, answered: (by) => { model = by.model; } });
      model ??= (await resolveStep('classify')).model;
      const result = parseBatchClassifyResult(raw);
      if (!result) {
        log(`  [Batch ${batchNum}/${batches.length}]  could not parse response`);
        for (const tx of batch) fail(tx, 'could not parse response');
        return;
      }
      for (const tx of batch) {
        const answer = result[keyOf(tx)];
        const llmEntries = answer?.entries;
        if (!llmEntries?.length) {
          log(`  [Batch ${batchNum}]  ${tx.ref}  no entries in response`);
          fail(tx, 'no entries in response');
          continue;
        }
        const own = booksOf(tx);
        const mapped = mappedReceipts(own, tx);
        const bankAccount = bankAccountFor(tx, context.bankAccounts);
        const said = answer.reason;
        const reason = typeof said === 'string' && said.trim() ? said.trim().slice(0, 300) : undefined;
        const derived = withDerivedCodes(llmEntries, tx.direction, bankAccount);
        const separate = separateFeeOf(tx, books.transactions);
        const fee = separate && withoutSeparateFee(tx, separate, derived, { booked: books.journalEntries, answered: result[keyOf(separate)]?.entries });
        if (fee && 'refused' in fee) {
          log(`  [Batch ${batchNum}]  ${tx.ref}  refused: ${fee.refused.reason}`);
          if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, ...fee.refused });
          continue;
        }
        const lines = splitByReceipts(tx, fee?.lines ?? derived, mapped);
        const noted = [reason, fee?.note, customsNotes.get(tx)].filter(Boolean).join(' ') || undefined;
        const coded = withPurchaseVat(tx, withRefundCodes(own, tx, withCreditNoteCodes(own, tx, withSaleCodes(tx, entriesFor(tx, lines, { fx, receipts: mapped.map((r) => r.id), bankAccount, lock, reason: noted, by: { kind: 'model', model }, money: context.moneyAccounts, corrects: correctsFor(tx, mapped, lock.isClosed, filing().length), acquisition: { documents: mapped, setup: context.vat ?? EFFECTIVE_QUARTERLY } }), mapped, context.vat ?? EFFECTIVE_QUARTERLY), mapped), bankAccount), mapped, context.purchaseVat, context.counterparties);
        const taxed = withoutZeroOnNoCode(receiptTaxOf(own, tx, coded, mapped), bankAccount, context);
        // A card line's bill that shows less than the line (a tip): its rate on no more than the bill taxes at it (#409).
        const answered = views.get(tx)?.cap ? capAtBills(taxed, mapped, tx.currency, newEntryId) : taxed;
        const twice = inputTaxOverReceipts(own, tx, legsOf(tx), answered, (c, d) => fx.daily(c, d));
        if (twice) {
          const others = twice.others.map((t) => t.ref).join(', ');
          log(`  [Batch ${batchNum}]  ${tx.ref}  refused: input tax ${twice.booked} with ${others} above the receipt's VAT ${twice.shown}`);
          if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, reason: `Die Vorsteuer dieser Zahlung ergäbe mit ${others} zusammen ${baseCurrency()} ${twice.booked.toFixed(2)}, der Beleg weist nur ${baseCurrency()} ${twice.shown.toFixed(2)} MWST aus: nichts gebucht. Jede Zahlung trägt nur ihren Teil der MWST; von Hand buchen.`, refusal: { code: 'classifyInputTaxShared', params: { payments: others, currency: baseCurrency(), booked: twice.booked, shown: twice.shown } } });
          continue;
        }
        const refused = paymentRefusal(tx, answered, bankAccount, chartAccounts);
        if (refused) {
          log(`  [Batch ${batchNum}]  ${tx.ref}  refused: ${refused.reason}`);
          if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, ...refused });
          continue;
        }
        // A contribution payment takes no more off the deductions account than the wages withheld by its day, with what this run booked before it (#426):
        // what it holds stays there, the rest is the employer's expense, on the contribution account the answer names (#470, #368's decision).
        const deductions = context.wageDeductions;
        const heldOn = deductions && contributions.has(tx.ref) ? withheldFor(books, tx, deductions) : undefined;
        const capped = deductions && contributions.has(tx.ref) ? withinWithheld(answered, deductions, heldOn, employer, newEntryId) : { entries: answered, moved: 0, to: '' };
        if (!capped) {
          const cur = baseCurrency();
          const over = overWithheld(answered, deductions!, heldOn)!;
          log(`  [Batch ${batchNum}]  ${tx.ref}  refused: ${over.taken} off ${deductions}, which held ${over.open}`);
          if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, reason: `Die Buchung nähme ${cur} ${over.taken.toFixed(2)} vom Konto ${deductions} der Lohnabzüge, das an diesem Tag nur ${cur} ${over.open.toFixed(2)} hielt: nichts gebucht. Von Hand buchen.`, refusal: { code: 'classifyWithheldOver', params: { account: deductions!, currency: cur, taken: over.taken, open: over.open } } });
          continue;
        }
        // The booking's reason says what code moved, beside the model's.
        const movedSaid = capped.moved ? wordsIn('de').t('rules.say.withheldCapped', { account: deductions!, currency: baseCurrency(), open: (heldOn ?? 0).toFixed(2), moved: capped.moved.toFixed(2), to: capped.to }) : undefined;
        const entries = movedSaid ? capped.entries.map((e) => ({ ...e, reason: [e.reason, movedSaid].filter(Boolean).join(' ') })) : capped.entries;
        if (capped.moved) log(`  [Batch ${batchNum}]  ${tx.ref}  ${capped.moved} over what ${deductions} held booked on ${capped.to}`);
        const held = proposing.get(tx.ref);
        if (held) { held.entries = atPoint(tx, entries.map((e) => ({ ...e, rule: held.rule }))); continue; }
        log(`  [Batch ${batchNum}]  ${keyOf(tx)}  → ${lines.length} entries (${lines.map((e) => e.accountDebit || e.accountCredit).join(', ')})`);
        const whole = views.has(tx) ? byPart.get(tx.ref) : undefined;
        if (whole) {
          whole.entries.push(...atPoint(tx, entries));
          if (--whole.open) continue;
          byPart.delete(tx.ref);
          books.journalEntries.push(...whole.entries);
        } else books.journalEntries.push(...atPoint(tx, entries));
        if (!outcome.classified.includes(tx.ref)) outcome.classified.push(tx.ref);
      }
    } catch (e) {
      if (e instanceof NoClaudeError || (e instanceof AiRefused && e.refusal.reason !== 'limit')) throw e;
      log(`  [Batch ${batchNum}/${batches.length}]  error: ${e}`);
      for (const tx of batch) if (!outcome.classified.includes(tx.ref)) fail(tx, String(e));
    }
    log(`  [Batch ${batchNum}/${batches.length}]  done (${outcome.classified.length} classified, ${outcome.failed.length} failed)`);
  };

  for (let i = 0; i < firstCount; i += CONCURRENCY) {
    await Promise.all(batches.slice(i, Math.min(i + CONCURRENCY, firstCount)).map((b, j) => processBatch(b, i + j + 1)));
    afterWave?.();
  }
  for (let i = firstCount; i < batches.length; i += CONCURRENCY) {
    await Promise.all(batches.slice(i, i + CONCURRENCY).map((b, j) => processBatch(b, i + j + 1)));
    afterWave?.();
  }
  for (const ref of byPart.keys()) log(`  ${ref}  booked in no part: a part got no booking from the model, the payment waits whole`);
  return outcome;
}
