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
import { periodLock, type Books, type PeriodLock } from '../books/store.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { loadCases, OWN_HISTORY_THRESHOLD, selectCases, type BookingCase } from '../knowledge/cases.js';
import { REFERENCE_DIR, type LedgerBankAccount, type Workspace } from '../workspace/workspace.js';

export const BATCH_SIZE = 10;
export const CONCURRENCY = 3;
const CALL_TIMEOUT_MS = 360_000;

/** Shopify/Stripe clearing account: revenue and fees on it are dated by the order, and its payout is booked automatically. */
const SHOPIFY_ACCOUNT = '1093';

export interface EntryContext {
  fx: FxResolver;
  /** The earliest date of the receipts mapped to the transaction (a Shopify order date). */
  receiptDate: string | undefined;
  bankAccount: string;
  lock: PeriodLock;
}

/**
 * The journal entries for one transaction from the model's answer. The bank side the model
 * left empty is the transaction's bank account; a foreign entry carries the ESTV daily sell
 * rate of the payment date (ADR 0001). Entries on 1093 take the order date, unless that lies
 * in a closed period: then the payment date, because nothing new is ever dated there.
 */
export function entriesFor(tx: BankTransaction, llmEntries: ClassifyEntry[], { fx, receiptDate, bankAccount, lock }: EntryContext): JournalEntry[] {
  lock.assertOpen(tx.date, `${tx.ref} wird nicht neu gebucht.`);
  const fxStamp = tx.currency === 'CHF'
    ? {}
    : { exchangeCurrency: tx.currency, exchangeRate: fx.daily(tx.currency, tx.date) ?? fx.flat(tx.currency) ?? 1 };
  const orderDate = receiptDate && !lock.isClosed(receiptDate) ? receiptDate : tx.date;
  const entry = (e: Omit<JournalEntry, 'id' | 'transactionRef' | 'origin'>): JournalEntry =>
    ({ id: randomBytes(8).toString('hex'), transactionRef: tx.ref, ...e, ...fxStamp, origin: 'classify' });

  const entries = llmEntries.map((e) => {
    const accountDebit = e.accountDebit || (tx.direction === 'CRDT' ? bankAccount : '');
    const accountCredit = e.accountCredit || (tx.direction === 'DBIT' ? bankAccount : '');
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

export interface ClassifyContext extends ClassifyPromptContext {
  bankAccounts: readonly LedgerBankAccount[];
  /** The casebook (examples/cases/): examples for a company with little history of its own. */
  casebook?: readonly BookingCase[];
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
function chartFromAccounts(ws: Workspace): string {
  if (!existsSync(ws.paths.accounts)) {
    throw new Error(`classify needs a chart of accounts: ${ws.paths.accounts} (npm run init writes it), or a prior-year Banana export in ${ws.paths.history} (<name>.Konten.txt and <name>.Buchungen-sample.tsv)`);
  }
  const accounts = JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as { number: string; name: string }[];
  return ['Konto\tBeschreibung', ...accounts.map((a) => `${a.number}\t${a.name}`)].join('\n');
}

/**
 * The company (manifest), its chart and example entries (the prior-year export in history/, else
 * accounts.json and no examples of its own: the casebook stands in), and the app's VAT codes.
 */
export function loadClassifyContext(ws: Workspace): ClassifyContext {
  const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
  const prior = priorYearExport(ws.paths.history);
  return {
    companyName: ws.company.name,
    bankAccounts: ws.bankAccounts,
    chartOfAccounts: prior ? read(ws.paths.history, `${prior}.Konten.txt`) : chartFromAccounts(ws),
    historicEntries: prior ? read(ws.paths.history, `${prior}.Buchungen-sample.tsv`) : '',
    vatCodes: read(REFERENCE_DIR, 'MWST-codes.txt'),
    casebook: loadCases(),
  };
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
    tx: { ref: tx.ref, date: tx.date, amount: tx.amount, currency: tx.currency, direction: tx.direction, description: tx.description, bank: tx.bank },
    receipts,
  };
}

function mappedReceipts(books: Books, tx: BankTransaction) {
  return books.mappings
    .filter((m) => m.transactionRef === tx.ref)
    .map((m) => books.receipts.find((r) => r.id === m.receiptId))
    .filter((r): r is NonNullable<typeof r> => !!r);
}

export interface ClassifyDeps {
  ask: (prompt: string, opts: AskOptions) => Promise<string>;
  fx: FxResolver;
  context: ClassifyContext;
  log?: (line: string) => void;
  /** Runs after each wave of concurrent batches, e.g. to save the books so far. */
  afterWave?: () => void;
}

export interface ClassifyOutcome {
  classified: string[];
  failed: Array<{ ref: string; reason: string }>;
}

/**
 * Asks the model for the entries of `txs`, ten transactions per call, three calls at a time,
 * and appends them to `books.journalEntries`. A transaction the model gives no entries for
 * is reported in `failed` and left unbooked.
 */
export async function classifyTransactions(books: Books, txs: BankTransaction[], deps: ClassifyDeps): Promise<ClassifyOutcome> {
  const { ask, fx, context, log = () => {}, afterWave } = deps;
  const lock = periodLock(books);
  const casebook = context.casebook && ownHistoryRows(books, context) < OWN_HISTORY_THRESHOLD ? context.casebook : [];
  const outcome: ClassifyOutcome = { classified: [], failed: [] };
  const batches: BankTransaction[][] = [];
  for (let i = 0; i < txs.length; i += BATCH_SIZE) batches.push(txs.slice(i, i + BATCH_SIZE));

  const processBatch = async (batch: BankTransaction[], batchNum: number) => {
    const fail = (tx: BankTransaction, reason: string) => outcome.failed.push({ ref: tx.ref, reason });
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
        const receiptDate = mappedReceipts(books, tx).map((r) => r.date).filter((d): d is string => !!d).sort()[0];
        books.journalEntries.push(...entriesFor(tx, llmEntries, { fx, receiptDate, bankAccount: bankAccountFor(tx, context.bankAccounts), lock }));
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
