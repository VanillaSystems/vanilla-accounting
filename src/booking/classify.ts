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
import type { ClassifyRefusal } from '../types/api-error.js';
import { loadCases, OWN_HISTORY_THRESHOLD, selectCases, type BookingCase } from '../knowledge/cases.js';
import { APP_ROOT, type LedgerBankAccount, type Workspace } from '../workspace/workspace.js';
import { sharedReceipts, inputTaxOverReceipts } from './shared-receipts.js';
import { chargesOf, legKey } from '../intake/charges.js';
import { agreedBasis, baseCurrency, documents, filing, setup, vat, withoutInputTax } from '../engines/index.js';
import { paymentProposals, type PaymentProposal } from '../invoices/payments.js';
import { loadInvoices } from '../invoices/store.js';
import type { InvoiceBook } from '../invoices/model.js';
import { correctsFor } from '../accounting/correction.js';
import { EFFECTIVE_QUARTERLY, type VatSetup } from '../workspace/vat-setup.js';
import { saleCodeOf, saleCodeReason } from '../accounting/sales-without-vat.js';
import { formTakes, lookupVatCode } from '../accounting/vat-codes.js';
import { creditNoteCodeOf } from '../accounting/credit-note-code.js';
import { acquisitionCodeOf, acquisitionReason, readSupplier, type AcquisitionDocument } from '../accounting/acquisition-tax.js';
import { codeSignFor } from '../accounting/code-sign.js';
import { homeOf, loadKnowledge } from '../knowledge/layers.js';
import { identify, merchantOf, signalsOfTransaction, type Counterparty } from '../knowledge/counterparties.js';
import { payerNames } from '../knowledge/payer.js';
import { partsOf, partText } from '../accounting/manual-booking.js';
import { wordsIn } from '../export/texts.js';
import { ruleFor, ruleWords, stampRule, type PaymentFacts, type PlacedRule, type RuleBooking, type RuleNames } from './rules.js';
import { chartNames, companyRules, factsOf, placedRules } from './rule-book.js';
import { businessVat, withPurchaseVat, type BusinessVat } from './purchase-vat.js';
import { separateFeeOf, withoutSeparateFee } from './separate-fee.js';
import { sidesOf, withDerivedCodes } from './line-vat.js';
import { clearingAccounts, payoutWaitOf, providerOfPayment, type PayoutWait, type Provider } from './providers.js';
import { splitByReceipts } from './receipt-lines.js';
import { CUSTOMS_BY, customsSplit, importVatDeductions, type Assessment, type CustomsHold, type CustomsTexts } from './customs-invoice.js';
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

  return llmEntries.map((e) => {
    const { accountDebit, accountCredit } = sidesOf(e, tx.direction, bankAccount, isVatAmountCode(e.vatCode));
    const transfer = !!money?.has(accountDebit) && money.has(accountCredit);
    const acquired = acquisition && !transfer ? acquisitionCodeOf({ ...e, accountDebit, accountCredit }, acquisition.documents, acquisition.setup) : undefined;
    return entry({
      ...(acquisition && readSupplier(e)),
      date: tx.date,
      accountDebit,
      accountCredit,
      amount: e.amount,
      vatCode: transfer ? undefined : acquired ? acquired.code : signed(permittedCode(e.vatCode), accountDebit, accountCredit, e.amount),
      description: e.description || tx.description,
    }, acquired && { reason: acquisitionReason(acquired), by: { kind: 'code', check: 'acquisitionTax' } });
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
  /** The owner's private account (its number): where a rule's private share goes. */
  ownerAccount?: string;
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
    ownerAccount: ownerAccount(ws).split(' ')[0],
    ownerName: ws.company.owner,
    vat: ws.company.vat,
    ...(ws.profile?.sells.length ? { sells: salesDefaults(ws.profile.sells, setup().sells) } : {}),
    moneyAccounts: moneyAccounts(ws.bankAccounts, loadChart().accounts),
    ...(agreedBasis() ? { invoices: loadInvoices(ws) } : {}),
    companyUid: ws.company.uid,
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

/** Why a provider's payout waits for the person (PayoutWait), in the books' language: what the run's note and the payment say. */
export function payoutWaitReason(w: PayoutWait): string {
  const key = w.why === 'clearing' ? 'salesReport.noClearing' : w.why === 'since' ? 'salesReport.noSince' : 'salesReport.gapPayout';
  return wordsIn('de').t(key, { provider: w.provider.name, file: homeOf('workspace', w.provider.role, w.provider.id), since: w.provider.provider.since ?? '', account: w.provider.provider.clearing ?? '' });
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

/** The entries a rule's booking makes for `tx` (ruleBookingLines), the bank on the other side, stamped with the rule. */
export function ruleEntries(books: Books, tx: BankTransaction, placed: PlacedRule, booking: RuleBooking, context: ClassifyContext, fx: FxResolver): JournalEntry[] {
  const mapped = mappedReceipts(books, tx);
  const bankAccount = bankAccountFor(tx, context.bankAccounts);
  const out = tx.direction === 'DBIT';
  const lines = ruleBookingLines(tx, booking, mapped, context.ownerAccount);
  const entries: ClassifyEntry[] = lines.map((l) => ({
    accountDebit: out ? l.account : '', accountCredit: out ? '' : l.account, amount: l.amount, vatCode: l.vat ?? '', description: merchantOf(tx.description),
  }));
  const code = lines[0].vat;
  // The rule names a rate, the payment got the zero code: the reason says why, never the rule's rate alone.
  const zero = booking.vat && code && code.replace(/^-/, '') !== booking.vat ? `; ${wordsIn('de').t('rules.say.zeroCode', { code })}` : '';
  const lock = periodLock(books);
  return entriesFor(tx, entries, { fx, receipts: mapped.map((r) => r.id), bankAccount, lock, reason: `Regel: ${ruleLine(placed, { ...context, payers: payerNames([tx]) })}${zero}`, by: { kind: 'rule', rule: placed.rule.id }, money: context.moneyAccounts, corrects: correctsFor(tx, mapped, lock.isClosed, filing().length) })
    .map((e) => stampRule(e, placed.rule.id, booking));
}

/**
 * A collective payment no rule decides as a whole, by its parts (r10h-14): each part is a payment
 * of its own to the rules (its payer, its amount, its reference as the text), and a rule that books
 * books that part's line. Undefined when no part is decided. `whole`: every part was, so the lines
 * add up to the payment; else the payment is booked in part and the rest is the person's (a run
 * never books over a payment booked in part, src/workflows/actions.ts). A rule that asks decides no part.
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
    return placed && then?.kind === 'book' ? ruleEntries(books, part, placed, then.booking, context, fx) : undefined;
  });
  const entries = decided.flatMap((e) => e ?? []);
  if (!entries.length) return undefined;
  const open = parts.filter((_, i) => !decided[i]);
  // The parts no rule decided, as a payment of their own for the model: the same ref, what is left of the amount.
  const rest = open.length ? { ...tx, amount: sign * open.reduce((sum, p) => sum + Math.abs(p.amount), 0), description: open.map(partText).join('; '), parts: open.length > 1 ? open : undefined } : undefined;
  return { entries, whole: !rest, rest };
}

type PromptInput = Parameters<typeof buildBatchClassifyPrompt>[0][number];

/**
 * What the prompt says about one transaction: the transaction and its receipts, with their VAT facts; `legs`: the movements of its
 * card charge (src/intake/charges.ts), whose other legs that hold its receipts it names. A leg that shares its ref goes by its legKey.
 */
export function classifyInput(books: Books, tx: BankTransaction, legs: readonly BankTransaction[] = [tx]): PromptInput {
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
  const shared = sharedReceipts(books, tx, legs);
  return {
    tx: { ref: legKey(tx, legs), date: tx.date, amount: tx.amount, currency: tx.currency, direction: tx.direction, description: tx.description, bank: tx.bank, ...(tx.counterparty ? { counterparty: tx.counterparty } : {}), ...(fee ? { separateFee: { ref: fee.ref, amount: fee.amount, currency: fee.currency } } : {}), ...(tx.businessPart ? { businessPart: { ...(tx.businessPart.what && { what: tx.businessPart.what }) } } : {}), ...(shared ? { sharedWith: shared.others.map((t) => ({ ref: t.ref, amount: t.amount, currency: t.currency })) } : {}) },
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
  // On the agreed basis a coded line takes its document's date and the open item; on the cash basis this changes nothing (src/accounting/tax-point.ts).
  const atPoint = (tx: BankTransaction, entries: JournalEntry[]): JournalEntry[] => atTaxPoint(tx, entries, {
    accounts: items, bankAccount: bankAccountFor(tx, context.bankAccounts), clearing, lock, rateOn: (c, d) => fx.daily(c, d),
    documents: mappedReceipts(books, tx), length: filing().length, newId: () => randomBytes(8).toString('hex'),
  });
  const outcome: ClassifyOutcome = { classified: [], failed: [], asked: [], unasked: [], partly: [] };
  // The legs of a card charge split across balances share its receipts: each books its share, the input tax of all of them never more than the receipts show (#190).
  const charges = chargesOf(books.transactions, (amount, currency, date) => { if (currency === baseCurrency()) return amount; const rate = fx.daily(currency, date) ?? fx.flat(currency); return rate === undefined ? undefined : amount * rate; });
  const legsOf = (tx: BankTransaction) => charges.of(tx).legs;
  // The model answers by the key the prompt gives each transaction: the legs of a split under one ref apart (#287).
  const keyOf = (tx: BankTransaction) => legKey(tx, legsOf(tx));
  const invoicePaid = openInvoicesPaid(books, context);
  const toModel: BankTransaction[] = [];
  /** Asked payments whose rule proposes nothing: the model proposes, the entries go to `asked`. */
  const proposing = new Map<string, ClassifyOutcome['asked'][number]>();
  /** Why a payment's customs invoices were not split in code: the model's reason says it. */
  const customsNotes = new Map<string, string>();
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
    const byParts = placed ? undefined : partRuleEntries(books, tx, context, fx);
    if (byParts) {
      books.journalEntries.push(...atPoint(tx, byParts.entries));
      // The parts no rule decided go to the model when there is one; the rule-decided parts stay the rules'.
      const model = byParts.rest && ask;
      log(`  ${tx.ref}  → rules by part${byParts.whole ? '' : model ? ', the rest to the model' : ', the rest waits for the person'}`);
      if (model) { toModel.push(byParts.rest!); continue; }
      outcome.classified.push(tx.ref);
      if (!byParts.whole) outcome.partly.push(tx.ref);
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
      if (customs) customsNotes.set(tx.ref, customs.note);
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
  const batches: BankTransaction[][] = [];
  for (let i = 0; i < toModel.length; i += BATCH_SIZE) batches.push(toModel.slice(i, i + BATCH_SIZE));

  const processBatch = async (batch: BankTransaction[], batchNum: number) => {
    // An asked payment the model could not propose for still waits for the person, without a proposal.
    const fail = (tx: BankTransaction, reason: string) => { if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, reason }); };
    try {
      const examples = casebook.length ? casesForBatch(books, batch, casebook) : [];
      const prompt = buildBatchClassifyPrompt(batch.map((tx) => classifyInput(books, tx, legsOf(tx))), context, examples);
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
        const mapped = mappedReceipts(books, tx);
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
        const noted = [reason, fee?.note, customsNotes.get(tx.ref)].filter(Boolean).join(' ') || undefined;
        const entries = withPurchaseVat(tx, withCreditNoteCodes(books, tx, withSaleCodes(tx, entriesFor(tx, lines, { fx, receipts: mapped.map((r) => r.id), bankAccount, lock, reason: noted, by: { kind: 'model', model }, money: context.moneyAccounts, corrects: correctsFor(tx, mapped, lock.isClosed, filing().length), acquisition: { documents: mapped, setup: context.vat ?? EFFECTIVE_QUARTERLY } }), mapped, context.vat ?? EFFECTIVE_QUARTERLY), mapped), mapped, context.purchaseVat, context.counterparties);
        const twice = inputTaxOverReceipts(books, tx, legsOf(tx), entries, (c, d) => fx.daily(c, d));
        if (twice) {
          const others = twice.others.map((t) => t.ref).join(', ');
          log(`  [Batch ${batchNum}]  ${tx.ref}  refused: input tax ${twice.booked} with ${others} above the receipt's VAT ${twice.shown}`);
          if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, reason: `Die Vorsteuer dieser Zahlung ergäbe mit ${others} zusammen ${baseCurrency()} ${twice.booked.toFixed(2)}, der Beleg weist nur ${baseCurrency()} ${twice.shown.toFixed(2)} MWST aus: nichts gebucht. Jede Zahlung trägt nur ihren Teil der MWST; von Hand buchen.`, refusal: { code: 'classifyInputTaxShared', params: { payments: others, currency: baseCurrency(), booked: twice.booked, shown: twice.shown } } });
          continue;
        }
        const refused = paymentRefusal(tx, entries, bankAccount, chartAccounts);
        if (refused) {
          log(`  [Batch ${batchNum}]  ${tx.ref}  refused: ${refused.reason}`);
          if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, ...refused });
          continue;
        }
        const held = proposing.get(tx.ref);
        if (held) { held.entries = atPoint(tx, entries.map((e) => ({ ...e, rule: held.rule }))); continue; }
        books.journalEntries.push(...atPoint(tx, entries));
        log(`  [Batch ${batchNum}]  ${tx.ref}  → ${lines.length} entries (${lines.map((e) => e.accountDebit || e.accountCredit).join(', ')})`);
        outcome.classified.push(tx.ref);
      }
    } catch (e) {
      if (e instanceof NoClaudeError || (e instanceof AiRefused && e.refusal.reason !== 'limit')) throw e;
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
