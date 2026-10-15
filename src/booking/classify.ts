/**
 * The one classifier: bank transactions → journal entries, for `npm run classify` and the
 * UI's re-classify route alike. See processes/booking.guide.yaml#classify.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBatchClassifyPrompt, parseBatchClassifyResult, type ClassifyEntry, type ClassifyPromptContext } from '../llm/prompts.js';
import { NoClaudeError, type AskOptions } from '../llm/ask.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { bankAccountFor } from '../accounting/bank-accounts.js';
import { SHOPIFY_ACCOUNT, paymentSides } from '../accounting/payment-entries.js';
import { isVatAmountCode } from '../accounting/validate.js';
import { periodLock, type Books, type PeriodLock } from '../books/store.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import type { ClassifyRefusal } from '../types/api-error.js';
import { loadCases, OWN_HISTORY_THRESHOLD, selectCases, type BookingCase } from '../knowledge/cases.js';
import { APP_ROOT, REFERENCE_DIR, type LedgerBankAccount, type Workspace } from '../workspace/workspace.js';
import { baseCurrency } from '../engines/index.js';
import { lookupVatCode } from '../accounting/vat-codes.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { identify, merchantOf, signalsOfTransaction, type Counterparty } from '../knowledge/counterparties.js';
import { wordsIn } from '../export/texts.js';
import { ruleFor, ruleWords, type PlacedRule, type RuleBooking, type RuleNames } from './rules.js';
import { chartNames, companyRules, factsOf, placedRules } from './rule-book.js';

export const BATCH_SIZE = 10;
export const CONCURRENCY = 3;
const CALL_TIMEOUT_MS = 360_000;

export interface EntryContext {
  fx: FxResolver;
  /** The earliest date of the receipts mapped to the transaction (a Shopify order date). */
  receiptDate: string | undefined;
  /** The receipts mapped to the transaction, which the model saw: stamped on the entries. */
  receipts: string[];
  bankAccount: string;
  lock: PeriodLock;
  /** The model's reason in words, stamped on the entries. */
  reason?: string;
}

/**
 * The journal entries for one transaction from the model's answer. The side the model left empty
 * is the transaction's bank account (a Skonto line the bank received back is the bank's debit on a
 * payment out), except on a VAT-amount code (M81-2), whose code is its other leg; whether the bank
 * really was the missing side, paymentRefusal decides. A foreign entry carries the ESTV daily sell
 * rate of the payment date (ADR 0001). Entries on 1093 take the order date, unless that lies
 * in a closed period: then the payment date, because nothing new is ever dated there.
 */
export function entriesFor(tx: BankTransaction, llmEntries: ClassifyEntry[], { fx, receiptDate, receipts, bankAccount, lock, reason }: EntryContext): JournalEntry[] {
  lock.assertOpen(tx.date, `${tx.ref} wird nicht neu gebucht.`);
  const fxStamp = tx.currency === baseCurrency()
    ? {}
    : { exchangeCurrency: tx.currency, exchangeRate: fx.daily(tx.currency, tx.date) ?? fx.flat(tx.currency) ?? 1 };
  const orderDate = receiptDate && !lock.isClosed(receiptDate) ? receiptDate : tx.date;
  const entry = (e: Omit<JournalEntry, 'id' | 'transactionRef' | 'origin'>): JournalEntry =>
    ({ id: randomBytes(8).toString('hex'), transactionRef: tx.ref, ...e, ...fxStamp, origin: 'classify', receipts: [...receipts].sort(), ...(reason && { reason }) });

  const entries = llmEntries.map((e) => {
    let accountDebit = e.accountDebit || (tx.direction === 'CRDT' ? bankAccount : '');
    let accountCredit = e.accountCredit || (tx.direction === 'DBIT' ? bankAccount : '');
    if (!isVatAmountCode(e.vatCode)) {
      accountDebit ||= e.accountCredit && bankAccount;
      accountCredit ||= e.accountDebit && bankAccount;
    }
    const onShopify = accountDebit === SHOPIFY_ACCOUNT || accountCredit === SHOPIFY_ACCOUNT;
    return entry({
      date: onShopify ? orderDate : tx.date,
      accountDebit,
      accountCredit,
      amount: e.amount,
      vatCode: e.vatCode || undefined,
      description: e.description || tx.description,
    });
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
 * a VAT-amount code's one leg), or entries that do not move the bank account by what the bank paid,
 * the rule the AI sidebar's changes keep too (src/server/edits.ts applyAnswer). The payment then
 * stays unbooked for the person, with this reason.
 */
export function paymentRefusal(tx: BankTransaction, entries: readonly JournalEntry[], bankAccount: string): { reason: string; refusal: ClassifyRefusal } | undefined {
  const legless = entries.find((e) => !e.accountDebit !== !e.accountCredit ? !isVatAmountCode(e.vatCode) : !e.accountDebit);
  if (legless) {
    const description = legless.description ?? '';
    return {
      reason: `Claudes Antwort hat eine Buchung ohne Konto («${description}»): nichts gebucht, die Zahlung bleibt, wie sie war.`,
      refusal: { code: 'classifyAccount', params: { description } },
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

/** The chart the classifier books on, as `number<TAB>name` lines: the prior-year export, else accounts.json. */
export function chartOf(ws: Pick<Workspace, 'paths'>): string {
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
  const { counterparties } = loadKnowledge(APP_ROOT, ws.paths.root);
  const facts = factsOf(chartNames(chartOfAccounts), new Set(counterparties.map((c) => c.id)));
  return {
    companyName: ws.company.name,
    bankAccounts: ws.bankAccounts,
    chartOfAccounts,
    historicEntries: prior ? read(ws.paths.history, `${prior}.Buchungen-sample.tsv`) : '',
    vatCodes: read(REFERENCE_DIR, 'MWST-codes.txt'),
    casebook: loadCases(),
    rules: placedRules(companyRules(ws, facts)),
    counterparties,
  };
}

/** The money a rule names, in the books' currency, as the books write it. */
const money = (n: number) => `${baseCurrency()} ${n.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** A rule in plain German words, for the booking's reason (booking texts stay German, docs/i18n.md). */
export function ruleLine(placed: PlacedRule, context: Pick<ClassifyContext, 'chartOfAccounts' | 'counterparties'>): string {
  const accounts = chartNames(context.chartOfAccounts);
  const names: RuleNames = {
    account: (n) => accounts.get(n),
    business: (id) => context.counterparties?.find((c) => c.id === id)?.name,
    money,
  };
  const de = wordsIn('de');
  return ruleWords(placed, names, (key, vars) => de.t(key, vars as Record<string, string>)).line;
}

/** The rule that decides `tx`, if one does: its business by routing, its amount in the books' currency at the payment day's rate. */
export function ruleOfPayment(books: Books, tx: BankTransaction, context: ClassifyContext, fx: FxResolver): PlacedRule | undefined {
  if (!context.rules?.length) return undefined;
  const routing = identify(signalsOfTransaction(tx, mappedReceipts(books, tx)), context.counterparties ?? []);
  const rate = tx.currency === baseCurrency() ? 1 : fx.daily(tx.currency, tx.date) ?? fx.flat(tx.currency) ?? 1;
  return ruleFor(context.rules, {
    tx, counterparty: routing.kind === 'known' ? routing.counterparty : undefined,
    bankAccount: bankAccountFor(tx, context.bankAccounts), amount: tx.amount * rate,
  });
}

/**
 * The VAT code a rule's booking takes on this payment. Only the receipt decides a rate (AGENTS.md
 * § VAT code rules): an input-tax code with a rate falls to its zero code when no linked receipt
 * shows Swiss VAT. Money coming back on a purchase, or going out on a sale, takes the code's minus.
 */
export function ruleVatCode(code: string | null, tx: BankTransaction, swissVat: boolean): string | undefined {
  if (!code) return undefined;
  const found = lookupVatCode(code);
  if (!found || found.negative) return code;
  const { family, rate } = found.entry;
  const purchase = family === 'I' || family === 'M';
  const unsigned = purchase && rate && rate > 0 && !swissVat ? `${family}0` : code;
  const back = (purchase || family === 'B') ? tx.direction === 'CRDT' : family === 'V' ? tx.direction === 'DBIT' : false;
  return back ? `-${unsigned}` : unsigned;
}

/** The entry a rule's booking makes for `tx`: the whole amount on the rule's account, the bank on the other side, stamped with the rule. */
export function ruleEntries(books: Books, tx: BankTransaction, placed: PlacedRule, booking: RuleBooking, context: ClassifyContext, fx: FxResolver): JournalEntry[] {
  const mapped = mappedReceipts(books, tx);
  const bankAccount = bankAccountFor(tx, context.bankAccounts);
  const out = tx.direction === 'DBIT';
  const line: ClassifyEntry = {
    accountDebit: out ? booking.account : '', accountCredit: out ? '' : booking.account, amount: tx.amount,
    vatCode: ruleVatCode(booking.vat, tx, mapped.some((r) => r.hasSwissVat)) ?? '', description: merchantOf(tx.description),
  };
  const receiptDate = mapped.map((r) => r.date).filter((d): d is string => !!d).sort()[0];
  return entriesFor(tx, [line], { fx, receiptDate, receipts: mapped.map((r) => r.id), bankAccount, lock: periodLock(books), reason: `Regel: ${ruleLine(placed, context)}` })
    .map((e) => ({ ...e, rule: placed.rule.id }));
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
  return {
    tx: { ref: tx.ref, date: tx.date, amount: tx.amount, currency: tx.currency, direction: tx.direction, description: tx.description, bank: tx.bank, ...(tx.counterparty ? { counterparty: tx.counterparty } : {}) },
    receipts,
  };
}

/** The receipts linked to a payment; a copy a person marked as such never claims its input tax a second time. */
function mappedReceipts(books: Books, tx: BankTransaction) {
  return books.mappings
    .filter((m) => m.transactionRef === tx.ref)
    .map((m) => books.receipts.find((r) => r.id === m.receiptId))
    .filter((r): r is NonNullable<typeof r> => !!r && r.kind !== 'duplicate');
}

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
  const outcome: ClassifyOutcome = { classified: [], failed: [], asked: [], unasked: [] };
  const toModel: BankTransaction[] = [];
  /** Asked payments whose rule proposes nothing: the model proposes, the entries go to `asked`. */
  const proposing = new Map<string, ClassifyOutcome['asked'][number]>();
  for (const tx of txs) {
    const placed = ruleOfPayment(books, tx, context, fx);
    const then = placed?.rule.then;
    if (!placed || !then) { toModel.push(tx); continue; }
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
      const raw = await ask(prompt, { step: 'booking.guide.yaml#classify', model: 'sonnet', timeoutMs: CALL_TIMEOUT_MS });
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
        const entries = entriesFor(tx, llmEntries, { fx, receiptDate, receipts: mapped.map((r) => r.id), bankAccount, lock, reason });
        const refused = paymentRefusal(tx, entries, bankAccount);
        if (refused) {
          log(`  [Batch ${batchNum}]  ${tx.ref}  refused: ${refused.reason}`);
          if (!proposing.has(tx.ref)) outcome.failed.push({ ref: tx.ref, ...refused });
          continue;
        }
        const held = proposing.get(tx.ref);
        if (held) { held.entries = entries.map((e) => ({ ...e, rule: held.rule })); continue; }
        books.journalEntries.push(...entries);
        log(`  [Batch ${batchNum}]  ${tx.ref}  → ${llmEntries.length} entries (${llmEntries.map((e) => e.accountDebit || e.accountCredit).join(', ')})`);
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
