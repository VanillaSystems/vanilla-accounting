/**
 * The one classifier: bank transactions → journal entries, for `npm run classify` and the
 * UI's re-classify route alike. See processes/booking.guide.yaml#classify.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBatchClassifyPrompt, parseBatchClassifyResult, type ClassifyEntry, type ClassifyPromptContext, type PayoutKind } from '../llm/prompts.js';
import { NoClaudeError, type AskOptions } from '../llm/ask.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { bankAccountFor, ownerAccount } from '../accounting/bank-accounts.js';
import { SHOPIFY_ACCOUNT, paymentSides } from '../accounting/payment-entries.js';
import { isVatAmountCode } from '../accounting/validate.js';
import { periodLock, type Books, type PeriodLock } from '../books/store.js';
import type { BankTransaction, BookedBy, JournalEntry, Receipt } from '../types/index.js';
import { isPurchaseDocument } from '../accounting/evidence-check.js';
import type { ClassifyRefusal } from '../types/api-error.js';
import { loadCases, OWN_HISTORY_THRESHOLD, selectCases, type BookingCase } from '../knowledge/cases.js';
import { APP_ROOT, type LedgerBankAccount, type Workspace } from '../workspace/workspace.js';
import { baseCurrency, chart, filing, invoicing, setup, vat } from '../engines/index.js';
import { roundCHF, toRappen } from '../accounting/rappen.js';
import { correctsFor } from '../accounting/correction.js';
import { EFFECTIVE_QUARTERLY, type VatSetup } from '../workspace/vat-setup.js';
import { normalRate, saleCodeOf, saleCodeReason, saleVatCode } from '../accounting/sales-without-vat.js';
import { formTakes, lookupVatCode } from '../accounting/vat-codes.js';
import { creditNoteCodeOf } from '../accounting/credit-note-code.js';
import { acquisitionCodeOf, acquisitionReason, readSupplier, type AcquisitionDocument } from '../accounting/acquisition-tax.js';
import { codeSignFor } from '../accounting/code-sign.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { identify, merchantOf, signalsOfTransaction, type Counterparty } from '../knowledge/counterparties.js';
import { payerNames } from '../knowledge/payer.js';
import { partsOf, partText } from '../accounting/manual-booking.js';
import { wordsIn } from '../export/texts.js';
import { ruleFor, ruleWords, type PaymentFacts, type PlacedRule, type RuleBooking, type RuleNames } from './rules.js';
import { chartNames, companyRules, factsOf, placedRules } from './rule-book.js';
import { businessVat, withPurchaseVat, type BusinessVat } from './purchase-vat.js';
import { separateFeeOf, withoutSeparateFee } from './separate-fee.js';
import { sidesOf, withDerivedCodes } from './line-vat.js';
import { holdWords, payoutByOrders, type OrderHold } from './payout-orders.js';
import { splitByReceipts } from './receipt-lines.js';
import { payoutSales, salesDefaults } from '../workspace/sells.js';
import { loadChart, type ChartAccount } from '../workspace/chart.js';

export const BATCH_SIZE = 10;
export const CONCURRENCY = 3;
const CALL_TIMEOUT_MS = 360_000;
/** The model that books what no rule decides; its entries name it (JournalEntry.by). */
const CLASSIFY_MODEL = 'sonnet';

export interface EntryContext {
  fx: FxResolver;
  /** The earliest date of the receipts mapped to the transaction (a Shopify order date). */
  receiptDate: string | undefined;
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
 * The accounts that hold the company's money: its bank accounts and every account the chart puts
 * on the same line (cash, the transfer account). Money moved between two of them is no purchase
 * and no sale: code decides that it carries no VAT code (r4w-9: a cash withdrawal `1000 / 1020`).
 */
export function moneyAccounts(bankAccounts: readonly LedgerBankAccount[], accounts: readonly ChartAccount[]): Set<string> {
  const banks = bankAccounts.filter((a) => a.bank !== 'manual').map((a) => a.account);
  const lines = new Set(accounts.filter((a) => banks.includes(a.number)).map((a) => a.line));
  return new Set([...banks, ...accounts.filter((a) => lines.has(a.line)).map((a) => a.number)]);
}

/**
 * The journal entries for one transaction from the model's answer. The side the model left empty
 * is the transaction's bank account (a Skonto line the bank received back is the bank's debit on a
 * payment out), except on a VAT-amount code (M81-2), whose code is its other leg; whether the bank
 * really was the missing side, paymentRefusal decides. A foreign entry carries the ESTV daily sell
 * rate of the payment date (ADR 0001). Entries on 1093 take the order date, unless that lies
 * in a closed period or before the books begin (#39): then the payment date, because nothing new
 * is ever dated there.
 */
export function entriesFor(tx: BankTransaction, llmEntries: ClassifyEntry[], { fx, receiptDate, receipts, bankAccount, lock, reason, by, money, corrects, acquisition }: EntryContext): JournalEntry[] {
  lock.assertOpen(tx.date, `${tx.ref} wird nicht neu gebucht.`);
  const fxStamp = tx.currency === baseCurrency()
    ? {}
    : { exchangeCurrency: tx.currency, exchangeRate: fx.daily(tx.currency, tx.date) ?? fx.flat(tx.currency) ?? 1 };
  const orderDate = receiptDate && !lock.isClosed(receiptDate) && !lock.beforeBooks(receiptDate) ? receiptDate : tx.date;
  const entry = (e: Omit<JournalEntry, 'id' | 'transactionRef' | 'origin'>, decided?: { reason: string; by: BookedBy }): JournalEntry =>
    ({ id: randomBytes(8).toString('hex'), transactionRef: tx.ref, ...e, ...fxStamp, origin: 'classify', receipts: [...receipts].sort(), ...(corrects && { corrects }), ...(decided ?? { ...(reason && { reason }), by }) });

  const entries = llmEntries.map((e) => {
    const { accountDebit, accountCredit } = sidesOf(e, tx.direction, bankAccount, isVatAmountCode(e.vatCode));
    const onShopify = accountDebit === SHOPIFY_ACCOUNT || accountCredit === SHOPIFY_ACCOUNT;
    const transfer = !!money?.has(accountDebit) && money.has(accountCredit);
    const acquired = acquisition && !transfer ? acquisitionCodeOf({ ...e, accountDebit, accountCredit }, acquisition.documents, acquisition.setup) : undefined;
    return entry({
      ...(acquisition && readSupplier(e)),
      date: onShopify ? orderDate : tx.date,
      accountDebit,
      accountCredit,
      amount: e.amount,
      vatCode: transfer ? undefined : acquired ? acquired.code : signed(permittedCode(e.vatCode), accountDebit, accountCredit, e.amount),
      description: e.description || tx.description,
    }, acquired && { reason: acquisitionReason(acquired), by: { kind: 'code', check: 'acquisitionTax' } });
  });
  const onShopify = entries.some((e) => e.accountDebit === SHOPIFY_ACCOUNT || e.accountCredit === SHOPIFY_ACCOUNT);
  if (onShopify && tx.direction === 'CRDT') {
    entries.push(entry({
      date: tx.date,
      accountDebit: bankAccount,
      accountCredit: SHOPIFY_ACCOUNT,
      amount: tx.amount,
      description: 'Stripe, Auszahlung',
    }));
  }
  return entries;
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
  const account = { bank: tx.bank, currency: tx.currency, account: bankAccount, label: bankAccount };
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
  /** The owner's private account (its number): where a rule's private share goes. */
  ownerAccount?: string;
  /** The firm's VAT setup (src/workspace/vat-setup.ts): which codes its bookings may carry; absent: the effective method. */
  vat?: VatSetup;
  /** The accounts that hold money (moneyAccounts): a transfer between two carries no VAT code. */
  moneyAccounts?: ReadonlySet<string>;
  /** The firm's own payout split (payoutDefault) for a payout report no rule names the provider of. */
  payout?: RuleBooking;
  /** What the app's business files state about input tax (src/booking/purchase-vat.ts): code decides it on the model's lines. */
  purchaseVat?: BusinessVat;
}

/**
 * The payout booking of a firm that answered «Auszahlungen eines Zahlungsanbieters: ja» at setup
 * (modules/ch/setup.yaml answers.payouts), for a payout report no rule names the provider of
 * (r10f-29): the gross sales on the revenue account of what the firm sells at its sale code, the
 * fees on the account the answer added at its code where the form takes one, both from the chart.
 */
export function payoutDefault(ws: Pick<Workspace, 'profile'>, chart: readonly string[]): RuleBooking | undefined {
  if (ws.profile?.payouts !== 'yes') return undefined;
  const { fees } = setup().answers.payouts;
  const has = new Set(chart);
  const account = payoutSales(ws.profile.sells ?? []);
  if (!has.has(account) || !has.has(fees.account)) return undefined;
  return { account, vat: saleVatCode('saleDomestic'), fees: { account: fees.account, vat: formTakes(fees.vat) ? fees.vat : '' } };
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
 * The company (manifest), its chart and example entries (the prior-year export in history/, else
 * accounts.json and no examples of its own: the casebook stands in), and the app's VAT codes.
 */
export function loadClassifyContext(ws: Workspace): ClassifyContext {
  const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
  const prior = priorYearExport(ws.paths.history);
  const chartOfAccounts = chartOf(ws);
  const knowledge = loadKnowledge(APP_ROOT, ws.paths.root);
  const { counterparties } = knowledge;
  const facts = factsOf(chartNames(chartOfAccounts), new Set(counterparties.map((c) => c.id)));
  return {
    companyName: ws.company.name,
    bankAccounts: ws.bankAccounts,
    chartOfAccounts,
    historicEntries: prior ? read(ws.paths.history, `${prior}.Buchungen-sample.tsv`) : '',
    casebook: loadCases(),
    rules: placedRules(companyRules(ws, facts)),
    counterparties,
    purchaseVat: businessVat(knowledge),
    ownerAccount: ownerAccount(ws).split(' ')[0],
    vat: ws.company.vat,
    ...(ws.profile?.sells.length ? { sells: salesDefaults(ws.profile.sells) } : {}),
    moneyAccounts: moneyAccounts(ws.bankAccounts, loadChart().accounts),
    ...((p) => (p ? { payout: p } : {}))(payoutDefault(ws, [...chartNames(chartOfAccounts).keys()])),
  };
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

/** A rule's booking line as it lands: account, VAT code (none: no code) and amount, the bank on the other side. */
export interface RuleLine { account: string; vat?: string; amount: number }

/**
 * What a rule's booking books for `tx`: the whole amount on the rule's account with its VAT code
 * (ruleVatCode), or, with a private share, that share on the owner's account without VAT and the
 * rest on the rule's account. The lines add up to what the bank paid, to the Rappen. `documents`
 * are the payment's linked receipts: only a purchase document (evidence-check isPurchaseDocument)
 * proves Swiss VAT, never a delivery note or a supporting document (#81).
 */
export function ruleBookingLines(tx: BankTransaction, booking: RuleBooking, documents: readonly Pick<Receipt, 'kind' | 'hasSwissVat'>[], owner: string | undefined): RuleLine[] {
  const vat = ruleVatCode(booking.vat, tx, documents.some((r) => isPurchaseDocument(r) && r.hasSwissVat));
  const whole: RuleLine = { account: booking.account, ...(vat ? { vat } : {}), amount: tx.amount };
  if (!booking.private || !owner) return [whole];
  const total = Math.round(tx.amount * 100);
  const own = Math.round((total * booking.private) / 100);
  return [{ ...whole, amount: (total - own) / 100 }, { account: owner, amount: own / 100 }];
}

/** A line of a payout report as read: its sides (an empty one is the bank), its amount with the sign the reader wrote, its words, and its role when the reader named it. */
export interface PayoutRead { accountDebit: string; accountCredit: string; amount: number; description: string; kind?: PayoutKind }

/** The reader's own words for a provider's fee, in the report's languages: the fallback when a line names no role and sits on revenue. */
const FEE_WORDS = /geb[üu]hr|\bfee|frais|commission|provision|kommission|spesen|\bcosti\b/i;

/**
 * A payout rule (RuleBooking.fees) applied to the model's reading of the payout report, normalised
 * in code so that the same report gives the same booking whatever sides and sign the reading wrote
 * (r8h-20): each line's role is the one it names (`kind`), else its structure: a minus flips the
 * sides, money into the bank is a sale, money out of it a refund when it sits on revenue and does
 * not read as a fee, else the provider's fee. A sale lands on the rule's account with its code,
 * a refund there with the code's minus, a fee on fees.account with fees.vat; amounts are positive,
 * never negative revenue. The figures stay the reading's. Undefined: a line off the bank with no
 * role, which no payout has.
 */
export function payoutLines(entries: readonly PayoutRead[], bankAccount: string, booking: RuleBooking, fees: NonNullable<RuleBooking['fees']>, isRevenue: (account: string) => boolean): ClassifyEntry[] | undefined {
  const sale = ruleVatCode(booking.vat, { direction: 'CRDT' }, true) ?? '';
  const refund = ruleVatCode(booking.vat, { direction: 'DBIT' }, true) ?? '';
  const out: ClassifyEntry[] = [];
  for (const e of entries) {
    let debit = e.accountDebit || (e.accountCredit ? bankAccount : '');
    let credit = e.accountCredit || (e.accountDebit ? bankAccount : '');
    if (e.amount < 0) [debit, credit] = [credit, debit];
    const kind: PayoutKind | undefined = e.kind
      ?? (debit === bankAccount ? 'sale' : credit === bankAccount ? (isRevenue(debit) && !FEE_WORDS.test(e.description) ? 'refund' : 'fee') : undefined);
    if (!kind) return undefined;
    const amount = Math.abs(e.amount);
    out.push(kind === 'sale' ? { accountDebit: bankAccount, accountCredit: booking.account, amount, vatCode: sale, description: e.description }
      : kind === 'refund' ? { accountDebit: booking.account, accountCredit: bankAccount, amount, vatCode: refund, description: e.description }
        : { accountDebit: fees.account, accountCredit: bankAccount, amount, vatCode: fees.vat, description: e.description });
  }
  return out;
}

/**
 * A payout booked from its report's figures, in code (r10f-29): the report linked to `tx`
 * (Receipt.payout, read once at the match step) covers every payout it is linked to; when those
 * add up to what it paid out, each payout's sales are its own amount, and the last one (by date)
 * carries the report's refunds and fees on top, so the sales of all of them add up to the report's.
 * Undefined when no linked report has figures or the payouts do not add up: the model reads it.
 */
export function payoutFromReport(books: Books, tx: BankTransaction, booking: RuleBooking & { fees: NonNullable<RuleBooking['fees']> }, context: ClassifyContext, fx: FxResolver, by: BookedBy, reason: string): JournalEntry[] | undefined {
  const mapped = mappedReceipts(books, tx);
  const report = mapped.find((r) => r.payout);
  if (!report?.payout) return undefined;
  const facts = report.payout;
  const refs = new Set(books.mappings.filter((m) => m.receiptId === report.id).map((m) => m.transactionRef));
  const payouts = books.transactions.filter((t) => refs.has(t.ref) && t.direction === 'CRDT' && t.currency === tx.currency).sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  if (!payouts.length || toRappen(payouts.reduce((s, t) => s + Math.abs(t.amount), 0)) !== toRappen(facts.paidOut)) return undefined;
  const last = payouts[payouts.length - 1].ref === tx.ref;
  const name = merchantOf(tx.description);
  const read: PayoutRead[] = [
    { accountDebit: '', accountCredit: '', amount: last ? roundCHF(Math.abs(tx.amount) + facts.refunds + facts.fees) : Math.abs(tx.amount), description: name, kind: 'sale' },
    ...(last && facts.refunds > 0 ? [{ accountDebit: '', accountCredit: '', amount: facts.refunds, description: `${name}, Rückerstattungen`, kind: 'refund' as const }] : []),
    ...(last && facts.fees > 0 ? [{ accountDebit: '', accountCredit: '', amount: facts.fees, description: `${name}, Gebühren`, kind: 'fee' as const }] : []),
  ];
  const bankAccount = bankAccountFor(tx, context.bankAccounts);
  const lines = payoutLines(read, bankAccount, booking, booking.fees, (a) => chart().typeOf(a) === 'revenue')!;
  const money = (n: number) => n.toFixed(2);
  const said = wordsIn('de').t('rules.say.payoutReport', { file: report.filename, sales: money(facts.sales), refunds: money(facts.refunds), fees: money(facts.fees), paidOut: money(facts.paidOut), n: payouts.length });
  const lock = periodLock(books);
  const receiptDate = mapped.map((r) => r.date).filter((d): d is string => !!d).sort()[0];
  return entriesFor(tx, lines, { fx, receiptDate, receipts: mapped.map((r) => r.id), bankAccount, lock, money: context.moneyAccounts, by, reason: `${reason}${said}`, corrects: correctsFor(tx, mapped, lock.isClosed, filing().length) });
}

/**
 * A payout booked per order from the order documents linked to it (src/booking/payout-orders.ts):
 * the payout rule's (or the firm's) sales account at its code for a domestic delivery, the export
 * code for one abroad, the fees on its fee account. Undefined when no linked document names a
 * share of `tx`; an OrderHold when they do but the person must decide.
 */
export function payoutFromOrders(books: Books, tx: BankTransaction, booking: RuleBooking & { fees: NonNullable<RuleBooking['fees']> }, context: ClassifyContext, fx: FxResolver, by: BookedBy, reason: string): JournalEntry[] | OrderHold | undefined {
  const mapped = mappedReceipts(books, tx);
  const orders = mapped.flatMap((r) => (r.order ? [r.order] : []));
  if (tx.direction !== 'CRDT' || !orders.length) return undefined;
  const refund = (code: string) => ruleVatCode(code, { direction: 'DBIT' }, true)!;
  const domestic = booking.vat ? { sale: booking.vat, refund: refund(booking.vat), rate: normalRate() } : undefined;
  const abroad = saleVatCode('saleAbroad');
  const bankAccount = bankAccountFor(tx, context.bankAccounts);
  const split = payoutByOrders(tx, orders, { bank: bankAccount, sales: booking.account, fees: booking.fees },
    { territory: invoicing().territory, domestic, ...(domestic && abroad ? { abroad: { sale: abroad, refund: refund(abroad) } } : {}) }, merchantOf(tx.description));
  if (!split || 'hold' in split) return split?.hold;
  const de = wordsIn('de');
  const foreign = split.foreign.length ? `; ${de.t('rules.say.ordersForeignTax', { orders: split.foreign.map((f) => `#${f.order} ${f.country} ${f.rate} %`).join(', ') })}` : '';
  const said = `${de.t('rules.say.payoutOrders', { orders: split.orders, refunds: split.refunds.toFixed(2), fees: split.fees.toFixed(2) })}${foreign}`;
  const lock = periodLock(books);
  return entriesFor(tx, split.lines, { fx, receiptDate: undefined, receipts: mapped.map((r) => r.id), bankAccount, lock, money: context.moneyAccounts, by, reason: `${reason}${said}`, corrects: correctsFor(tx, mapped, lock.isClosed, filing().length) });
}

/** Why a payout's orders book nothing, as its question says it (booking texts stay German). */
function orderHoldWords(hold: OrderHold): string {
  const { key, vars } = holdWords(hold);
  return wordsIn('de').t(key, vars);
}

/** The entries a rule's booking makes for `tx` (ruleBookingLines), the bank on the other side, stamped with the rule. */
export function ruleEntries(books: Books, tx: BankTransaction, placed: PlacedRule, booking: RuleBooking, context: ClassifyContext, fx: FxResolver): JournalEntry[] {
  const mapped = mappedReceipts(books, tx);
  const bankAccount = bankAccountFor(tx, context.bankAccounts);
  const out = tx.direction === 'DBIT';
  const lines = ruleBookingLines(tx, booking, mapped, context.ownerAccount);
  const entries: ClassifyEntry[] = lines.map((l) => ({
    accountDebit: out ? l.account : '', accountCredit: out ? '' : l.account, amount: l.amount, vatCode: l.vat ?? '', description: merchantOf(tx.description),
  }));
  const receiptDate = mapped.map((r) => r.date).filter((d): d is string => !!d).sort()[0];
  const code = lines[0].vat;
  // The rule names a rate, the payment got the zero code: the reason says why, never the rule's rate alone.
  const zero = booking.vat && code && code.replace(/^-/, '') !== booking.vat ? `; ${wordsIn('de').t('rules.say.zeroCode', { code })}` : '';
  // A payout rule without its report: these lines are the proposal the person may take (the whole payout as sales); a report linked later books it again.
  const noReport = booking.fees ? `; ${wordsIn('de').t('rules.say.noPayoutReport')}` : '';
  const lock = periodLock(books);
  return entriesFor(tx, entries, { fx, receiptDate, receipts: mapped.map((r) => r.id), bankAccount, lock, reason: `Regel: ${ruleLine(placed, { ...context, payers: payerNames([tx]) })}${zero}${noReport}`, by: { kind: 'rule', rule: placed.rule.id }, money: context.moneyAccounts, corrects: correctsFor(tx, mapped, lock.isClosed, filing().length) })
    .map((e) => ({ ...e, rule: placed.rule.id }));
}

/**
 * A collective payment no rule decides as a whole, by its parts (r10h-14): each part is a payment
 * of its own to the rules (its payer, its amount, its reference as the text), and a rule that books
 * books that part's line. Undefined when no part is decided. `whole`: every part was, so the lines
 * add up to the payment; else the payment is booked in part and the rest is the person's (a run
 * never books over a payment booked in part, src/workflows/actions.ts). A rule that asks, or books
 * a payout's fees, decides no part.
 */
function partRuleEntries(books: Books, tx: BankTransaction, context: ClassifyContext, fx: FxResolver): { entries: JournalEntry[]; whole: boolean; rest?: BankTransaction } | undefined {
  const parts = context.rules?.length ? partsOf(tx) : undefined;
  if (!parts) return undefined;
  const sign = tx.amount < 0 ? -1 : 1;
  const decided = parts.map((p) => {
    const part: BankTransaction = { ...tx, amount: sign * Math.abs(p.amount), description: partText(p), counterparty: p.counterparty, counterpartyIban: p.counterpartyIban, parts: undefined, reference: p.reference };
    const routing = identify(signalsOfTransaction(part, []), context.counterparties ?? []);
    const rate = tx.currency === baseCurrency() ? 1 : fx.daily(tx.currency, tx.date) ?? fx.flat(tx.currency) ?? 1;
    const placed = ruleFor(context.rules!, { tx: part, counterparty: routing.kind === 'known' ? routing.counterparty : undefined, bankAccount: bankAccountFor(tx, context.bankAccounts), amount: part.amount * rate });
    const then = placed?.rule.then;
    return placed && then?.kind === 'book' && !then.booking.fees ? ruleEntries(books, part, placed, then.booking, context, fx) : undefined;
  });
  const entries = decided.flatMap((e) => e ?? []);
  if (!entries.length) return undefined;
  const open = parts.filter((_, i) => !decided[i]);
  // The parts no rule decided, as a payment of their own for the model: the same ref, what is left of the amount.
  const rest = open.length ? { ...tx, amount: sign * open.reduce((sum, p) => sum + Math.abs(p.amount), 0), description: open.map(partText).join('; '), parts: open.length > 1 ? open : undefined } : undefined;
  return { entries, whole: !rest, rest };
}

type PromptInput = Parameters<typeof buildBatchClassifyPrompt>[0][number];

/** What the prompt says about one transaction: the transaction and its receipts, with their VAT facts. */
export function classifyInput(books: Books, tx: BankTransaction): PromptInput {
  const receipts = mappedReceipts(books, tx)
    .filter((r) => r.extractedText && r.extractedText.length > 10)
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
  return {
    tx: { ref: tx.ref, date: tx.date, amount: tx.amount, currency: tx.currency, direction: tx.direction, description: tx.description, bank: tx.bank, ...(tx.counterparty ? { counterparty: tx.counterparty } : {}), ...(fee ? { separateFee: { ref: fee.ref, amount: fee.amount, currency: fee.currency } } : {}), ...(tx.businessPart ? { businessPart: { ...(tx.businessPart.what && { what: tx.businessPart.what }) } } : {}) },
    receipts,
  };
}

/** The receipts linked to a payment; a copy a person marked as such never claims its input tax a second time. */
export function mappedReceipts(books: Books, tx: BankTransaction) {
  return books.mappings
    .filter((m) => m.transactionRef === tx.ref)
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
 * A code the firm's form does not take is left off the entry: a firm not registered for VAT books
 * everything gross, one on the net tax rate method its purchases. On the effective method the
 * model's code stands as written; one the engine does not know is refused (paymentRefusal).
 */
const permittedCode = (code: string | undefined): string | undefined => (code && formTakes(code) ? code : undefined);
/** The model's code with the sign the accounts give it (r9h-11): a credit note's M0 becomes -M0, whatever the model wrote. */
const signed = (code: string | undefined, accountDebit: string, accountCredit: string, amount: number): string | undefined => codeSignFor(code, accountDebit, accountCredit, amount) ?? code;

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
  /** Collective payments booked in part, one line per part a rule decided; the rest is the person's (r10h-14). Also in `classified`. */
  partly: string[];
  /** Payouts their order documents hold (also in `asked` or `failed`), each with why: the run's note names every one. */
  held: Array<{ ref: string; hold: OrderHold }>;
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
  const outcome: ClassifyOutcome = { classified: [], failed: [], asked: [], unasked: [], partly: [], held: [] };
  const toModel: BankTransaction[] = [];
  /** Asked payments whose rule proposes nothing: the model proposes, the entries go to `asked`. */
  const proposing = new Map<string, ClassifyOutcome['asked'][number]>();
  /** Payouts a rule books from the model's reading of their report (RuleBooking.fees). */
  const payouts = new Map<string, { placed: PlacedRule; booking: RuleBooking; fees: NonNullable<RuleBooking['fees']> }>();
  for (const tx of txs) {
    const placed = ruleOfPayment(books, tx, context, fx);
    const then = placed?.rule.then;
    // A payout whose report's figures are read (Receipt.payout) is booked from them in code, by the rule naming the provider, else by the firm's own split (r10f-29).
    const split = then?.kind === 'book' && then.booking.fees ? then.booking : !placed && context.payout?.fees ? context.payout : undefined;
    if (split?.fees) {
      const by: BookedBy = placed ? { kind: 'rule', rule: placed.rule.id } : { kind: 'code', check: 'payoutReport' };
      const reason = placed ? `Regel: ${ruleLine(placed, { ...context, payers: payerNames([tx]) })}; ` : '';
      const byOrders = payoutFromOrders(books, tx, { ...split, fees: split.fees }, context, fx, placed ? by : { kind: 'code', check: 'payoutOrders' }, reason);
      const read = Array.isArray(byOrders) ? byOrders : payoutFromReport(books, tx, { ...split, fees: split.fees }, context, fx, by, reason);
      if (read) {
        books.journalEntries.push(...(placed ? read.map((e) => ({ ...e, rule: placed.rule.id })) : read));
        log(`  ${tx.ref}  → ${read === byOrders ? 'orders' : 'payout report'}${placed ? ` (rule ${placed.rule.id})` : ''}`);
        outcome.classified.push(tx.ref);
        continue;
      }
      if (byOrders && !Array.isArray(byOrders)) {
        // Its order documents do not book it, and no model may guess past them: under a rule the payout waits as its question, the whole payout as sales to take over; else it is the person's to book.
        log(`  ${tx.ref}  waits for its orders${placed ? ` (rule ${placed.rule.id})` : ''}`);
        const why = wordsIn('de').t('rules.say.ordersAsk', { why: orderHoldWords(byOrders) });
        outcome.held.push({ ref: tx.ref, hold: byOrders });
        if (placed) outcome.asked.push({ ref: tx.ref, rule: placed.rule.id, question: why, entries: ruleEntries(books, tx, placed, split, context, fx) });
        else outcome.failed.push({ ref: tx.ref, reason: why });
        continue;
      }
    }
    const byParts = placed ? undefined : partRuleEntries(books, tx, context, fx);
    if (byParts) {
      books.journalEntries.push(...byParts.entries);
      // The parts no rule decided go to the model when there is one; the rule-decided parts stay the rules'.
      const model = byParts.rest && ask;
      log(`  ${tx.ref}  → rules by part${byParts.whole ? '' : model ? ', the rest to the model' : ', the rest waits for the person'}`);
      if (model) { toModel.push(byParts.rest!); continue; }
      outcome.classified.push(tx.ref);
      if (!byParts.whole) outcome.partly.push(tx.ref);
      continue;
    }
    if (!placed || !then) { toModel.push(tx); continue; }
    if (then.kind === 'book' && then.booking.fees && mappedReceipts(books, tx).length) {
      // The payout report's figures need reading: the model reads them, the rule books them.
      payouts.set(tx.ref, { placed, booking: then.booking, fees: then.booking.fees });
      toModel.push(tx);
      continue;
    }
    if (then.kind === 'book' && then.booking.fees) {
      // No report to read the gross sales and the fees from: the payout waits for the person (r4c-21, r5h-12), with the whole payout as sales to take over.
      log(`  ${tx.ref}  waits for its payout report (rule ${placed.rule.id})`);
      outcome.asked.push({ ref: tx.ref, rule: placed.rule.id, question: wordsIn('de').t('rules.say.payoutAsk'), entries: ruleEntries(books, tx, placed, then.booking, context, fx) });
      continue;
    }
    if (then.kind === 'book') {
      books.journalEntries.push(...ruleEntries(books, tx, placed, then.booking, context, fx));
      log(`  ${tx.ref}  → rule ${placed.rule.id}`);
      outcome.classified.push(tx.ref);
      continue;
    }
    const asked = { ref: tx.ref, rule: placed.rule.id, question: then.question, entries: then.booking ? ruleEntries(books, tx, placed, then.booking, context, fx) : [] };
    log(`  ${tx.ref}  waits for the person (rule ${placed.rule.id})`);
    outcome.asked.push(asked);
    if (!then.booking && proposeAsked) { proposing.set(tx.ref, asked); toModel.push(tx); }
  }
  afterWave?.();
  if (!ask) {
    outcome.unasked = toModel.filter((tx) => !proposing.has(tx.ref)).map((tx) => tx.ref);
    return outcome;
  }
  const batches: BankTransaction[][] = [];
  for (let i = 0; i < toModel.length; i += BATCH_SIZE) batches.push(toModel.slice(i, i + BATCH_SIZE));

  const processBatch = async (batch: BankTransaction[], batchNum: number) => {
    // An asked payment the model could not propose for still waits for the person, without a proposal.
    const fail = (tx: BankTransaction, reason: string) => { if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, reason }); };
    try {
      const examples = casebook.length ? casesForBatch(books, batch, casebook) : [];
      const prompt = buildBatchClassifyPrompt(batch.map((tx) => classifyInput(books, tx)), context, examples);
      const raw = await ask(prompt, { step: 'booking.guide.yaml#classify', model: CLASSIFY_MODEL, timeoutMs: CALL_TIMEOUT_MS });
      const result = parseBatchClassifyResult(raw);
      if (!result) {
        log(`  [Batch ${batchNum}/${batches.length}]  could not parse response`);
        for (const tx of batch) fail(tx, 'could not parse response');
        return;
      }
      for (const tx of batch) {
        const llmEntries = result[tx.ref]?.entries;
        if (!llmEntries?.length) {
          log(`  [Batch ${batchNum}]  ${tx.ref}  no entries in response`);
          fail(tx, 'no entries in response');
          continue;
        }
        const mapped = mappedReceipts(books, tx);
        const receiptDate = mapped.map((r) => r.date).filter((d): d is string => !!d).sort()[0];
        const bankAccount = bankAccountFor(tx, context.bankAccounts);
        const said = result[tx.ref].reason;
        const reason = typeof said === 'string' && said.trim() ? said.trim().slice(0, 300) : undefined;
        const payout = payouts.get(tx.ref);
        const normalised = payout && payoutLines(llmEntries, bankAccount, payout.booking, payout.fees, (a) => chart().typeOf(a) === 'revenue');
        const read = payout && normalised && entriesFor(tx, normalised, { fx, receiptDate, receipts: mapped.map((r) => r.id), bankAccount, lock, money: context.moneyAccounts, by: { kind: 'rule', rule: payout.placed.rule.id }, reason: `Regel: ${ruleLine(payout.placed, { ...context, payers: payerNames([tx]) })}; ${wordsIn('de').t('rules.say.payoutRead')}`, corrects: correctsFor(tx, mapped, lock.isClosed, filing().length) })
          .map((e) => ({ ...e, rule: payout.placed.rule.id }));
        if (payout && !read) {
          log(`  [Batch ${batchNum}]  ${tx.ref}  refused: the reading of the payout report is no payout`);
          fail(tx, `Claudes Lesung des Auszahlungsberichts passt nicht zur Regel ${payout.placed.rule.id}: nichts gebucht.`);
          continue;
        }
        const derived = withDerivedCodes(llmEntries, tx.direction, bankAccount);
        const separate = read ? undefined : separateFeeOf(tx, books.transactions);
        const fee = separate && withoutSeparateFee(tx, separate, derived, { booked: books.journalEntries, answered: result[separate.ref]?.entries });
        if (fee && 'refused' in fee) {
          log(`  [Batch ${batchNum}]  ${tx.ref}  refused: ${fee.refused.reason}`);
          if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, ...fee.refused });
          continue;
        }
        const lines = splitByReceipts(tx, fee?.lines ?? derived, mapped);
        const noted = fee?.note ? [reason, fee.note].filter(Boolean).join(' ') : reason;
        const entries = read ?? withPurchaseVat(tx, withCreditNoteCodes(books, tx, withSaleCodes(tx, entriesFor(tx, lines, { fx, receiptDate, receipts: mapped.map((r) => r.id), bankAccount, lock, reason: noted, by: { kind: 'model', model: CLASSIFY_MODEL }, money: context.moneyAccounts, corrects: correctsFor(tx, mapped, lock.isClosed, filing().length), acquisition: { documents: mapped, setup: context.vat ?? EFFECTIVE_QUARTERLY } }), mapped, context.vat ?? EFFECTIVE_QUARTERLY), mapped), mapped, context.purchaseVat, context.counterparties);
        const refused = paymentRefusal(tx, entries, bankAccount, chartAccounts);
        if (refused) {
          log(`  [Batch ${batchNum}]  ${tx.ref}  refused: ${refused.reason}`);
          if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, ...refused });
          continue;
        }
        const held = proposing.get(tx.ref);
        if (held) { held.entries = entries.map((e) => ({ ...e, rule: held.rule })); continue; }
        books.journalEntries.push(...entries);
        log(`  [Batch ${batchNum}]  ${tx.ref}  → ${lines.length} entries (${lines.map((e) => e.accountDebit || e.accountCredit).join(', ')})`);
        outcome.classified.push(tx.ref);
      }
    } catch (e) {
      if (e instanceof NoClaudeError) throw e;
      log(`  [Batch ${batchNum}/${batches.length}]  error: ${e}`);
      for (const tx of batch) if (!outcome.classified.includes(tx.ref)) fail(tx, String(e));
    }
    log(`  [Batch ${batchNum}/${batches.length}]  done (${outcome.classified.length} classified, ${outcome.failed.length} failed)`);
  };

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    await Promise.all(batches.slice(i, i + CONCURRENCY).map((b, j) => processBatch(b, i + j + 1)));
    afterWave?.();
  }
  return outcome;
}
