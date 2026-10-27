/**
 * A payment provider's sales or fee report taken in (#203): recognised by its columns
 * (src/booking/sales-report.ts recognizeReport, by the providers' business files), filed as a
 * receipt of its year (a sales record), and booked onto the provider's clearing account at once,
 * as a module of the app through the write door: never into a filed period, never earlier than the
 * company's cut-over day (`provider.since`) less the provider's payout days (a sale collected then is
 * paid out after the cut-over day, from the clearing account), never over a person's booking. No
 * existing entry is ever booked again: what is dated before the cut-over day stays as it was booked,
 * and a sale the clearing account carries from elsewhere, or a payout booked as sales, holds the
 * orders it may be (ReportContext.legacy), so no sale counts twice and none is lost. What the report cannot book is kept on its receipt (`report.held`) for the person.
 * «Rückgängig» takes the report's own entries and links back (removeSalesReport). What the company's
 * file of the provider lacks (its clearing account with the cut-over day, its revenue account, its
 * fee account) is asked once, in the drop row (setProviderAccount), and kept in that file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadBooks, moduleActor, periodLock, receiptFile, receiptHome, updateSaved, type Books } from '../books/store.js';
import { loadClassifyContext, chartOf, mappedReceipts, type ClassifyContext } from '../booking/classify.js';
import { chartNames } from '../booking/rule-book.js';
import { fromClearing, isProvider, payoutDaysOf, providerOfMoneyIn, providerOfPayment, type Provider } from '../booking/providers.js';
import { bookReport, isReportRef, linkOrdersToSales, readReport, recognizeReport, reportFacts, REPORT_LINK_RULE, saleRef, type ReadReport, type ReportContext, type ReportOutcome, type ReportTexts } from '../booking/sales-report.js';
import { loadKnowledge, homeOf } from '../knowledge/layers.js';
import { silentUids } from '../knowledge/counterparties.js';
import { businessOfReceipt } from './batch-payers.js';
import { loadFxResolver, type FxResolver } from '../accounting/fx-rates.js';
import { normalRate, saleVatCode } from '../accounting/sales-without-vat.js';
import { formTakes } from '../accounting/vat-codes.js';
import { addDays, isIsoDate } from '../accounting/periods.js';
import { sideOf } from '../accounting/tax-point.js';
import { agreedBasis, baseCurrency, chart, invoicing, setup, vat, withoutInputTax } from '../engines/index.js';
import { toRappen } from '../accounting/rappen.js';
import { payoutSales } from '../workspace/sells.js';
import { findFile, APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { wordsIn } from '../export/texts.js';
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';
import type { ProviderAsk, ReportSummary } from '../types/drop.js';

const ACTOR = moduleActor('sales-report');
/** At most this much of the file is kept as the receipt's text (its header and first rows): the books never hold a whole export. */
export const TEXT_KEPT = 4000;
/** At most this many held orders are named one by one in the drop row; the rest are counted. */
export const HELD_NAMED = 10;
/** At most this many held orders are kept on the report's receipt, for its detail; the rest are counted there (`heldMore`). */
export const HELD_KEPT = 200;
/** At most this many ways of paying the provider did not collect are named; the rest are counted. */
export const WAYS_NAMED = 5;

const sha16 = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);

/** The providers of the workspace's business files; none when its knowledge does not load. */
export function providersOf(ws: Pick<Workspace, 'paths'>): Provider[] {
  try {
    return loadKnowledge(APP_ROOT, ws.paths.root).counterparties.filter(isProvider);
  } catch {
    return [];
  }
}

/** What the drop recognises a CSV as, by the providers' files: whose report and which kind. */
export function recognizeCsv(ws: Pick<Workspace, 'paths'>, bytes: Buffer): { provider: string; name: string; kind: 'sales' | 'fees' } | undefined {
  const providers = providersOf(ws);
  const hit = recognizeReport(bytes.subarray(0, 16384).toString('utf8'), providers);
  const p = hit && providers.find((x) => x.id === hit.provider);
  return hit && p ? { ...hit, name: p.name } : undefined;
}

/** The booking texts, in the books' language (German, docs/i18n.md). */
function texts(name: string, file: string): ReportTexts {
  const de = wordsIn('de');
  return {
    sale: (order, country) => de.t('salesReport.saleText', { provider: name, order, country: country ?? '–' }),
    refund: (order) => de.t('salesReport.refundText', { provider: name, order }),
    fee: (key) => de.t('salesReport.feeText', { provider: name, key }),
    reason: (kind, country) => de.t(`salesReport.reason.${kind}`, { file, country: country ?? '–' }),
  };
}

export type ImportResult =
  | { ok: true; summary: ReportSummary }
  | { ok: false; ask?: ProviderAsk; message: string };

/** The firm's revenue account for a provider's sales: its file's, else the one of what the firm sells (modules/ch/setup.yaml). */
function revenueOf(ws: Workspace, p: Provider): string | undefined {
  if (p.provider.revenue) return p.provider.revenue;
  const sells = ws.profile?.sells;
  return sells?.length ? payoutSales(sells, setup().sells, setup().answers.payouts.sales.otherwise) : undefined;
}

/** What the company's file of the provider must still say before `kind` can be booked, or nothing. */
function lacking(ws: Workspace, p: Provider, kind: 'sales' | 'fees', chart: ReadonlyMap<string, string>): ProviderAsk | { account: string } | undefined {
  const ask = (missing: ProviderAsk['missing']): ProviderAsk => ({
    provider: p.id, name: p.name, missing, file: homeOf('workspace', p.role, p.id),
    // The cut-over day is asked with the clearing account, the first day of the open period proposed.
    ...((missing === 'clearing' || missing === 'since') && !p.provider.since ? { since: firstOpenDay(ws) } : {}),
  });
  const clearing = p.provider.clearing;
  if (!clearing) return ask('clearing');
  if (!chart.has(clearing)) return { account: clearing };
  if (!p.provider.since) return ask('since');
  if (kind === 'sales') {
    const revenue = revenueOf(ws, p);
    if (!revenue) return ask('revenue');
    if (!chart.has(revenue)) return { account: revenue };
  } else {
    if (!p.provider.fees) return ask('fees');
    if (!chart.has(p.provider.fees.account)) return { account: p.provider.fees.account };
  }
  return undefined;
}

/** Whether the app made an entry: not a person, not the assistant, no correction. */
const appMade = (e: JournalEntry): boolean => (e.origin === undefined || e.origin === 'classify') && !e.corrects && e.by?.kind !== 'person' && e.by?.kind !== 'assistant';

/** The first day of the open period: the day after the locked line, else the books' first day, else today. */
export function firstOpenDay(ws: Workspace): string {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const lock = periodLock(loadBooks(ws));
    return lock.lockedThrough ? addDays(lock.lockedThrough, 1) : lock.opens ?? today;
  } catch {
    return today;
  }
}

/** The provider's payouts in the books with their entries. */
function payoutsOf(books: Books, p: Provider, context: ClassifyContext): Array<{ tx: BankTransaction; entries: JournalEntry[] }> {
  return books.transactions.flatMap((tx) => (providerOfPayment(tx, mappedReceipts(books, tx), context.counterparties ?? [])?.id === p.id ? [{ tx, entries: books.journalEntries.filter((e) => e.transactionRef === tx.ref) }] : []));
}

/**
 * What the books carry already from elsewhere for a report of `kind` (ReportContext.legacy): the
 * entries on its clearing account that no report booked (for a sales report a sale onto it, from its
 * revenue account or with a sale code; for a fee report a fee off it onto its fee account), those
 * before the cut-over day only to name the rows they are; the last day of a payout of the provider on
 * or after the cut-over day booked otherwise than from the clearing account (as sales, by a person):
 * it may hold every row up to then; and the days of its payouts between `from` and the cut-over day
 * not booked bank / clearing account (as sales the old way, or not yet booked): each may have paid
 * the rows before it.
 */
function legacyOf(books: Books, p: Provider, kind: 'sales' | 'fees', revenue: string, from: string, context: ClassifyContext): NonNullable<ReportContext['legacy']> {
  const lock = periodLock(books);
  const clearing = p.provider.clearing!;
  const since = p.provider.since!;
  const carried = (e: JournalEntry) => !isReportRef(e.transactionRef) && (e.date < since || !lock.isClosed(e.date));
  const entries = books.journalEntries.filter((e) => carried(e) && (kind === 'sales'
    ? e.accountDebit === clearing && (e.accountCredit === revenue || sideOf(e.vatCode) === 'sale')
    : e.accountCredit === clearing && e.accountDebit === p.provider.fees?.account));
  const otherwise = (booked: readonly JournalEntry[]) => !fromClearing(booked, clearing);
  const through = payoutsOf(books, p, context)
    .filter(({ tx, entries: booked }) => booked.length && otherwise(booked) && !lock.isClosed(tx.date))
    .map(({ tx }) => tx.date).sort().at(-1);
  const paidBefore = books.transactions
    .filter((tx) => tx.date >= from && tx.date < since && providerOfMoneyIn(tx, mappedReceipts(books, tx), context.counterparties ?? [])?.id === p.id
      && otherwise(books.journalEntries.filter((e) => e.transactionRef === tx.ref)))
    .map((tx) => tx.date).sort();
  return { entries, ...(through ? { through } : {}), ...(paidBefore.length ? { paidBefore } : {}) };
}

/** The first day a report of `p` books: its cut-over day less its payout days (a sale collected then may be paid out after the cut-over day). */
const reachOf = (p: Provider): string => addDays(p.provider.since!, -payoutDaysOf(p));

/** The context of a report's booking for provider `p`: its accounts, the firm's codes and basis, the official daily sell rates (ADR 0001), the lock. */
function reportContext(ws: Workspace, books: Books, p: Provider, kind: 'sales' | 'fees', receipt: string, texts: ReportTexts, fx: FxResolver, context: ClassifyContext): ReportContext {
  const lock = periodLock(books);
  const codes = saleCodes();
  const revenue = revenueOf(ws, p) ?? '';
  const from = reachOf(p);
  return {
    provider: { id: p.id, name: p.name }, clearing: p.provider.clearing!, revenue, since: p.provider.since!, from,
    legacy: legacyOf(books, p, kind, revenue, from, context),
    ...(p.provider.fees ? { fees: { account: p.provider.fees.account, ...(formTakes(p.provider.fees.vat) ? { vat: p.provider.fees.vat } : {}) } } : {}),
    receipt, base: baseCurrency(), rate: (c, d) => fx.daily(c, d), ...(codes ? { codes } : {}), territory: invoicing().territory,
    ...(p.provider.gateways?.length ? { gateways: p.provider.gateways } : {}),
    agreed: agreedBasis(), isClosed: (d) => lock.isClosed(d), beforeBooks: (d) => lock.beforeBooks(d), newId: () => randomBytes(8).toString('hex'),
    texts,
  };
}

/** A report's entries and links pushed into the books; the entries the books carried already with the same figures name the report too, while open and the app's. */
function pushOutcome(books: Books, out: ReportOutcome, receipt: string): void {
  books.journalEntries.push(...out.entries);
  const lock = periodLock(books);
  const link = (ref: string) => { if (!books.mappings.some((x) => x.transactionRef === ref && x.receiptId === receipt)) books.mappings.push({ transactionRef: ref, receiptId: receipt, by: 'rule', rule: REPORT_LINK_RULE }); };
  for (const m of out.links) link(m.transactionRef);
  const known = new Set(out.knownRefs);
  books.journalEntries = books.journalEntries.map((e) => (known.has(e.transactionRef) && appMade(e) && !lock.isClosed(e.date) && !e.receipts?.includes(receipt) ? { ...e, receipts: [...(e.receipts ?? []), receipt].sort() } : e));
  for (const ref of known) link(ref);
}

/**
 * Takes in a report file: recognises it, files it as a receipt, books it. A file of no provider, one
 * whose columns the provider's file does not find, or one the company's file cannot book yet (the
 * clearing account, the revenue account or the fee account missing) books nothing; the last says
 * what to ask (`ask`). The orders it holds are kept on its receipt (`report.held`, the latest taking's).
 */
export function importSalesReport(ws: Workspace, bytes: Buffer, name: string, now: Date = new Date()): ImportResult {
  const de = wordsIn('de');
  const providers = providersOf(ws);
  const text = bytes.toString('utf8');
  const hit = recognizeReport(text, providers);
  const p = hit && providers.find((x) => x.id === hit.provider);
  if (!hit || !p) return { ok: false, message: de.t('salesReport.unknown', { file: name }) };
  const read = readReport(text, hit.kind, p.provider);
  if ('missing' in read) return { ok: false, message: de.t('salesReport.columns', { file: name, columns: read.missing.join(', ') }) };
  if (!read.rows.length) return { ok: false, message: de.t('salesReport.empty', { file: name }) };
  const accounts = chartNames(chartOf(ws));
  const missing = lacking(ws, p, hit.kind, accounts);
  if (missing && 'account' in missing) return { ok: false, message: de.t('salesReport.noAccount', { account: missing.account, file: homeOf('workspace', p.role, p.id) }) };
  if (missing) return { ok: false, ask: missing, message: de.t(`salesReport.ask.${missing.missing}`, { provider: p.name }) };
  const facts = reportFacts(p.id, read);
  const id = sha16(bytes);
  const context = loadClassifyContext(ws);
  const fx = loadFxResolver();
  const result = updateSaved(ws, ACTOR, (books) => {
    let receipt = books.receipts.find((r) => r.id === id);
    if (!receipt) {
      const word = hit.kind === 'sales' ? 'verkaufsbericht' : 'gebuehrenbericht';
      const stem = `${facts.to.replace(/-/g, '')}-${p.id}-${word}`;
      let filename = `${stem}.csv`;
      for (let i = 2; findFile(ws.paths, 'receipts', filename) || books.receipts.some((r) => r.filename === filename); i++) filename = `${stem}-${i}.csv`;
      receipt = {
        id, filename, originalFilename: name, extractedText: text.slice(0, TEXT_KEPT), extractionMethod: 'pdftotext', fileSize: bytes.length,
        indexedAt: now.toISOString(), location: 'archived', date: facts.to, description: de.t('salesReport.title', { provider: p.name, kind: de.t(`salesReport.kind.${hit.kind}`) }),
        kind: 'sales-record', report: facts,
      } satisfies Receipt;
      books.receipts.push(receipt);
      const path = join(receiptHome(ws, books, receipt), filename);
      if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
    }
    const out = bookReport(books, read, reportContext(ws, books, p, hit.kind, id, texts(p.name, receipt.filename), fx, context));
    pushOutcome(books, out, id);
    // What it could not book stays on its receipt for the person, the latest taking's: a held order booked meanwhile is known now.
    const r = books.receipts.find((x) => x.id === id)!;
    const { held: _held, heldMore: _more, ...said } = r.report ?? facts;
    r.report = { ...said, ...(out.held.length ? { held: out.held.slice(0, HELD_KEPT) } : {}), ...(out.held.length > HELD_KEPT ? { heldMore: out.held.length - HELD_KEPT } : {}) };
    const lock = periodLock(books);
    const proofs = linkOrdersToSales(books, (d) => !lock.isClosed(d), providers);
    return { out, proofs: proofs.length, filename: receipt.filename };
  });
  return { ok: true, summary: summaryOf(p, hit.kind, facts, read, result) };
}

/** The firm's sale codes for a sales report: the domestic one at the normal rate and at each other rate its form takes, the export one, the minus; none for a firm that books no codes. */
function saleCodes(): ReportContext['codes'] {
  const domestic = saleVatCode('saleDomestic');
  if (!domestic) return undefined;
  const abroad = saleVatCode('saleAbroad');
  const normal = normalRate();
  const reduced = invoicing().rates.flatMap((rate) => {
    const code = rate > 0 && rate !== normal ? vat().codes.saleAt(rate) : undefined;
    return code && formTakes(code) ? [{ code, rate }] : [];
  });
  return { domestic, rate: normal, ...(reduced.length ? { reduced } : {}), ...(abroad ? { abroad } : {}), negative: vat().codes.negativePrefix };
}

function summaryOf(p: Provider, kind: 'sales' | 'fees', facts: ReturnType<typeof reportFacts>, read: ReadReport, r: { out: ReportOutcome; proofs: number; filename: string }): ReportSummary {
  const held = r.out.held;
  return {
    provider: p.id, name: p.name, kind, from: facts.from, to: facts.to, file: r.filename, since: p.provider.since!, reach: reachOf(p),
    orders: r.out.orders, refunds: r.out.refunds, fees: r.out.fees, known: r.out.known, filed: r.out.filed, before: r.out.before, beforeSince: r.out.beforeSince,
    other: r.out.other, ways: r.out.ways.slice(0, WAYS_NAMED), waysMore: Math.max(0, r.out.ways.length - WAYS_NAMED),
    held: held.slice(0, HELD_NAMED), heldMore: Math.max(0, held.length - HELD_NAMED), unread: read.unread.length, proofs: r.proofs,
  };
}

/**
 * «Rückgängig» for a report: its own bookings (its SR-/SF- entries), its links, its receipt and its
 * file. A booking another report in the books names too (they overlap) stays, with that report only.
 * The links of order documents to a sale that is gone go too. No other entry is touched: the report
 * booked none again. Returns false, and takes nothing back, when a booking of it lies in a filed
 * period or a person changed one.
 */
export function removeSalesReport(ws: Workspace, id: string): boolean {
  const books = loadBooks(ws);
  const receipt = books.receipts.find((r) => r.id === id);
  if (!receipt?.report) return false;
  const lock = periodLock(books);
  const mine = books.journalEntries.filter((e) => isReportRef(e.transactionRef) && e.receipts?.includes(id));
  if (mine.some((e) => lock.isClosed(e.date) || !appMade(e))) return false;
  const path = receiptFile(ws, books, receipt);
  updateSaved(ws, ACTOR, (b) => {
    const reports = new Set(b.receipts.filter((r) => r.report && r.id !== id).map((r) => r.id));
    b.journalEntries = b.journalEntries.flatMap((e) => {
      if (!isReportRef(e.transactionRef) || !e.receipts?.includes(id)) return [e];
      const others = e.receipts.filter((r) => r !== id);
      return others.some((r) => reports.has(r)) ? [{ ...e, receipts: others }] : [];
    });
    const booked = new Set(b.journalEntries.map((e) => e.transactionRef));
    b.mappings = b.mappings.filter((m) => m.receiptId !== id && !(m.rule === REPORT_LINK_RULE && isReportRef(m.transactionRef) && !booked.has(m.transactionRef)));
    b.receipts = b.receipts.filter((x) => x.id !== id);
  });
  rmSync(path, { force: true });
  return true;
}

/** Why the drop row's answer is not kept (src/types/api-error.ts). */
export type ProviderRefusal =
  | { code: 'unknownAccount'; params: { account: string } }
  | { code: 'clearingNotBalance'; params: { account: string } }
  | { code: 'unknownVatCode'; params: { code: string } }
  | { code: 'codeNotTaken'; params: { code: string; method: 'none' | 'net-rate' } }
  | { code: 'sinceNotOpen'; params: { since: string; from: string } };

/**
 * The drop row's answer kept in the company's file of the provider (knowledge/<role>/<id>.yaml):
 * its clearing account with the cut-over day, its revenue account or its fee account and code, as
 * the person gave them. The account must be in the chart, the clearing account a balance-sheet one
 * (an asset or a liability: what the provider holds), the code one the firm books with, the
 * cut-over day a day of the open period.
 */
export function setProviderAccount(ws: Workspace, providerId: string, set: { clearing?: string; since?: string; revenue?: string; fees?: { account: string; vat: string } }): { ok: true } | { ok: false; refusal: ProviderRefusal } {
  const p = providersOf(ws).find((x) => x.id === providerId);
  if (!p) return { ok: false, refusal: { code: 'unknownAccount', params: { account: providerId } } };
  const accounts = chartNames(chartOf(ws));
  for (const a of [set.clearing, set.revenue, set.fees?.account]) if (a !== undefined && !accounts.has(a)) return { ok: false, refusal: { code: 'unknownAccount', params: { account: a } } };
  if (set.clearing !== undefined && !['asset', 'liability'].includes(chart().typeOf(set.clearing) ?? '')) return { ok: false, refusal: { code: 'clearingNotBalance', params: { account: set.clearing } } };
  if (set.since !== undefined) {
    const lock = periodLock(loadBooks(ws));
    if (!isIsoDate(set.since) || lock.isClosed(set.since) || lock.beforeBooks(set.since)) return { ok: false, refusal: { code: 'sinceNotOpen', params: { since: set.since, from: firstOpenDay(ws) } } };
  }
  if (set.fees) {
    if (!vat().codes.parse(set.fees.vat)) return { ok: false, refusal: { code: 'unknownVatCode', params: { code: set.fees.vat } } };
    if (!formTakes(set.fees.vat)) return { ok: false, refusal: { code: 'codeNotTaken', params: { code: set.fees.vat, method: withoutInputTax() ?? 'none' } } };
  }
  const file = join(ws.paths.root, homeOf('workspace', p.role, p.id));
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : `id: ${p.id}\n`);
  if (set.clearing) doc.setIn(['provider', 'clearing'], set.clearing);
  if (set.since) doc.setIn(['provider', 'since'], set.since);
  if (set.revenue) doc.setIn(['provider', 'revenue'], set.revenue);
  if (set.fees) doc.setIn(['provider', 'fees'], doc.createNode({ account: set.fees.account, vat: set.fees.vat }));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  return { ok: true };
}

/**
 * The payout reports of a provider's card terminal (Receipt.payout: sales, refunds, fees, paid out,
 * read once at the match step) booked onto its clearing account in code, once each (#203): the sales
 * at the domestic sale code (card sales at the firm's own place of business), the refunds with its
 * minus, the fees on the company's fee account, all on the report's day. One source of sales per
 * provider: a provider whose file names a sales report (`reports.sales`) takes its sales from there,
 * never from a payout report as well. A report books only on or after the company's cut-over day and
 * only with its payouts: the ones linked to it, else the one payout of the provider of what it paid
 * out within the payout days of its day (linked then); they must add up to what it paid out and each
 * be booked bank / clearing account already. No payout is ever booked again here: one booked
 * otherwise (as sales, by a person) leaves its report as it is. Returns how many reports it booked;
 * call inside the write door.
 */
export function bookPayoutReports(ws: Workspace, books: Books, fx: FxResolver = loadFxResolver()): number {
  const providers = providersOf(ws).filter((p) => !p.provider.reports.sales && p.provider.since);
  if (!providers.length) return 0;
  const counterparties = loadKnowledge(APP_ROOT, ws.paths.root).counterparties;
  const silent = silentUids(counterparties, ws.company?.uid);
  const context = loadClassifyContext(ws);
  const accounts = chartNames(chartOf(ws));
  const de = wordsIn('de');
  let booked = 0;
  for (const r of books.receipts) {
    const day = r.date;
    if (!r.payout || !day || r.kind === 'duplicate' || r.location !== 'archived') continue;
    const id = businessOfReceipt(r, counterparties, ws.company?.uid, silent);
    const p = providers.find((x) => x.id === id);
    const clearing = p?.provider.clearing;
    const revenue = p && revenueOf(ws, p);
    if (!p || !clearing || !revenue || !accounts.has(clearing) || !accounts.has(revenue) || day < p.provider.since! || books.journalEntries.some((e) => e.transactionRef === saleRef(p.id, r.id))) continue;
    const lock = periodLock(books);
    if (lock.isClosed(day) || lock.beforeBooks(day)) continue;
    const currency = r.currency ?? baseCurrency();
    const payouts = payoutsOf(books, p, context).filter(({ tx }) => tx.currency === currency);
    const linked = new Set(books.mappings.filter((m) => m.receiptId === r.id).map((m) => m.transactionRef));
    let mine = payouts.filter(({ tx }) => linked.has(tx.ref));
    if (!mine.length) {
      const taken = new Set(books.mappings.filter((m) => books.receipts.some((x) => x.id === m.receiptId && x.payout)).map((m) => m.transactionRef));
      const days = payoutDaysOf(p);
      const near = payouts.filter(({ tx }) => !taken.has(tx.ref) && toRappen(tx.amount) === toRappen(r.payout!.paidOut) && tx.date >= addDays(day, -days) && tx.date <= addDays(day, days));
      if (near.length !== 1) continue;
      mine = near;
    }
    if (toRappen(mine.reduce((s, { tx }) => s + tx.amount, 0)) !== toRappen(r.payout.paidOut)) continue;
    // Its sales count once: only beside payouts that settle the clearing account, never beside one booked as sales.
    if (!mine.every(({ entries }) => fromClearing(entries, clearing))) continue;
    const said: ReportTexts = {
      sale: () => de.t('salesReport.payoutSales', { provider: p.name, file: r.filename }),
      refund: () => de.t('salesReport.payoutRefunds', { provider: p.name, file: r.filename }),
      fee: () => de.t('salesReport.payoutFees', { provider: p.name, file: r.filename }),
      reason: (kind) => de.t(`salesReport.reason.${kind}`, { file: r.filename, country: '' }),
    };
    // Card sales at the firm's own place: delivered in the territory, whatever the card's country; the refunds on the report's day too.
    const sales = bookReport(books, { kind: 'sales', rows: [{ order: r.id, date: day, shipTo: invoicing().territory[0], gross: r.payout.sales, refunded: r.payout.refunds, refundedAt: day, currency }], unread: [] }, reportContext(ws, books, p, 'sales', r.id, said, fx, context));
    if (!sales.entries.length || sales.held.length) continue;
    const fees = r.payout.fees > 0 ? bookReport(books, { kind: 'fees', rows: [{ order: r.id, date: day, fee: r.payout.fees, currency }], unread: [] }, reportContext(ws, books, p, 'fees', r.id, said, fx, context)) : undefined;
    if (fees && (!fees.entries.length || fees.held.length)) continue;
    for (const { tx } of mine) if (!linked.has(tx.ref)) books.mappings.push({ transactionRef: tx.ref, receiptId: r.id, by: 'rule', rule: REPORT_LINK_RULE });
    for (const out of [sales, ...(fees ? [fees] : [])]) pushOutcome(books, out, r.id);
    booked++;
  }
  return booked;
}
