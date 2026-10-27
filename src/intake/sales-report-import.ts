/**
 * A payment provider's sales or fee report taken in (#203): recognised by its columns
 * (src/booking/sales-report.ts recognizeReport, by the providers' business files), filed as a
 * receipt of its year (a sales record), and booked onto the provider's clearing account at once,
 * as a module of the app through the write door: never into a filed period, never over a person's
 * booking. The provider's payouts of the report's days that the app booked before as sales are
 * booked again from the clearing account (the one way since #203), so no sale counts twice. What the
 * company's file of the provider lacks (its clearing account, its revenue account, its fee account)
 * is asked once, in the drop row (setProviderAccount), and kept in that file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadBooks, moduleActor, periodLock, receiptFile, receiptHome, updateSaved, type Books } from '../books/store.js';
import { loadClassifyContext, chartOf, providerPayout, mappedReceipts, type ClassifyContext } from '../booking/classify.js';
import { chartNames } from '../booking/rule-book.js';
import { isProvider, providerOfPayment, type Provider } from '../booking/providers.js';
import { bookReport, isReportRef, linkOrdersToSales, readReport, recognizeReport, reportFacts, saleRef, type ReadReport, type ReportHold, type ReportTexts } from '../booking/sales-report.js';
import { loadKnowledge, homeOf } from '../knowledge/layers.js';
import { silentUids } from '../knowledge/counterparties.js';
import { businessOfReceipt } from './batch-payers.js';
import { loadFxResolver, type FxResolver } from '../accounting/fx-rates.js';
import { normalRate, saleVatCode } from '../accounting/sales-without-vat.js';
import { formTakes } from '../accounting/vat-codes.js';
import { addDays } from '../accounting/periods.js';
import { agreedBasis, baseCurrency, invoicing, setup, vat, withoutInputTax } from '../engines/index.js';
import { payoutSales } from '../workspace/sells.js';
import { findFile, APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { wordsIn } from '../export/texts.js';
import type { Receipt } from '../types/index.js';
import type { ProviderAsk, ReportSummary } from '../types/drop.js';

const ACTOR = moduleActor('sales-report');
/** At most this much of the file is kept as the receipt's text (its header and first rows): the books never hold a whole export. */
export const TEXT_KEPT = 4000;
/** At most this many held orders are named one by one; the rest are counted. */
export const HELD_NAMED = 10;

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
  const ask = (missing: ProviderAsk['missing']): ProviderAsk => ({ provider: p.id, name: p.name, missing, file: homeOf('workspace', p.role, p.id) });
  const clearing = p.provider.clearing;
  if (!clearing) return ask('clearing');
  if (!chart.has(clearing)) return { account: clearing };
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

/**
 * The provider's payouts in the report's days (from its first day to its last plus the provider's
 * payout days) that the app booked otherwise before #203 (as sales, by a rule or the model): booked
 * again bank / clearing account. A person's booking, a filed one and one that corrects stay.
 */
export function rebookPayouts(books: Books, p: Provider, from: string, to: string, context: ClassifyContext, fx: FxResolver): string[] {
  const clearing = p.provider.clearing;
  if (!clearing) return [];
  const lock = periodLock(books);
  const until = addDays(to, p.provider.payoutDays ?? 7);
  const done: string[] = [];
  for (const tx of books.transactions) {
    if (tx.date < from || tx.date > until || lock.isClosed(tx.date)) continue;
    if (providerOfPayment(tx, mappedReceipts(books, tx), context.counterparties ?? [])?.id !== p.id) continue;
    const entries = books.journalEntries.filter((e) => e.transactionRef === tx.ref);
    if (!entries.length) continue;
    // Booked the one way already: the bank against the clearing account, one line. A payout whose sales an older run put on the clearing account per order is booked again too: the report books those sales now.
    const already = entries.length === 1 && entries[0].accountCredit === clearing;
    const apps = entries.every((e) => (e.origin === undefined || e.origin === 'classify') && !e.corrects && e.by?.kind !== 'person' && e.by?.kind !== 'assistant');
    if (already || !apps) continue;
    const booked = providerPayout(books, tx, p, context, fx);
    if ('refusal' in booked) continue;
    books.journalEntries = [...books.journalEntries.filter((e) => e.transactionRef !== tx.ref), ...booked];
    done.push(tx.ref);
  }
  return done;
}

/**
 * Takes in a report file: recognises it, files it as a receipt, books it. A file of no provider, one
 * whose columns the provider's file does not find, or one the company's file cannot book yet (the
 * clearing account, the revenue account or the fee account missing) books nothing; the last says
 * what to ask (`ask`).
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
  const context = loadClassifyContext(ws);
  const chart = chartNames(chartOf(ws));
  const missing = lacking(ws, p, hit.kind, chart);
  if (missing && 'account' in missing) return { ok: false, message: de.t('salesReport.noAccount', { account: missing.account, file: homeOf('workspace', p.role, p.id) }) };
  if (missing) return { ok: false, ask: missing, message: de.t(`salesReport.ask.${missing.missing}`, { provider: p.name }) };
  const facts = reportFacts(p.id, read);
  const id = sha16(bytes);
  const fx = loadFxResolver();
  const codes = saleCodes();
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
    const lock = periodLock(books);
    const out = bookReport(books, read, {
      provider: { id: p.id, name: p.name }, clearing: p.provider.clearing!, revenue: revenueOf(ws, p) ?? '',
      ...(p.provider.fees ? { fees: { account: p.provider.fees.account, ...(formTakes(p.provider.fees.vat) ? { vat: p.provider.fees.vat } : {}) } } : {}),
      receipt: id, base: baseCurrency(), rate: (c, d) => fx.daily(c, d), ...(codes ? { codes } : {}), territory: invoicing().territory,
      agreed: agreedBasis(), isClosed: (d) => lock.isClosed(d), beforeBooks: (d) => lock.beforeBooks(d), newId: () => randomBytes(8).toString('hex'),
      texts: texts(p.name, receipt.filename),
    });
    books.journalEntries.push(...out.entries);
    for (const m of out.links) if (!books.mappings.some((x) => x.transactionRef === m.transactionRef && x.receiptId === m.receiptId)) books.mappings.push(m);
    const proofs = linkOrdersToSales(books, (d) => !lock.isClosed(d));
    const rebooked = rebookPayouts(books, p, facts.from, facts.to, context, fx);
    return { out, proofs: proofs.length, rebooked: rebooked.length, filename: receipt.filename };
  });
  return { ok: true, summary: summaryOf(p, hit.kind, facts, read, result) };
}

/** The firm's sale codes for a sales report: the domestic one at the normal rate, the export one, the minus; none for a firm that books no codes. */
function saleCodes(): { domestic: string; rate: number; abroad?: string; negative: string } | undefined {
  const domestic = saleVatCode('saleDomestic');
  if (!domestic) return undefined;
  const abroad = saleVatCode('saleAbroad');
  return { domestic, rate: normalRate(), ...(abroad ? { abroad } : {}), negative: vat().codes.negativePrefix };
}

function summaryOf(p: Provider, kind: 'sales' | 'fees', facts: ReturnType<typeof reportFacts>, read: ReadReport, r: { out: ReturnType<typeof bookReport>; proofs: number; rebooked: number; filename: string }): ReportSummary {
  const held: ReportHold[] = r.out.held;
  return {
    provider: p.id, name: p.name, kind, from: facts.from, to: facts.to, file: r.filename,
    orders: r.out.orders, refunds: r.out.refunds, fees: r.out.fees, known: r.out.known, filed: r.out.filed, before: r.out.before,
    held: held.slice(0, HELD_NAMED), heldMore: Math.max(0, held.length - HELD_NAMED), unread: read.unread.length, proofs: r.proofs, rebooked: r.rebooked,
  };
}

/**
 * «Rückgängig» for a report: its bookings in the open period that the app made (a person's change of
 * one keeps it, and the receipt with it), its links, its receipt and its file. Returns false when a
 * booking of it lies in a filed period or a person changed one: then nothing is taken back.
 */
export function removeSalesReport(ws: Workspace, id: string): boolean {
  const books = loadBooks(ws);
  const receipt = books.receipts.find((r) => r.id === id);
  if (!receipt?.report) return false;
  const lock = periodLock(books);
  const mine = books.journalEntries.filter((e) => isReportRef(e.transactionRef) && e.receipts?.includes(id));
  if (mine.some((e) => lock.isClosed(e.date) || e.origin === 'manual' || e.by?.kind === 'person' || e.by?.kind === 'assistant')) return false;
  const path = receiptFile(ws, books, receipt);
  updateSaved(ws, ACTOR, (b) => {
    const ids = new Set(b.journalEntries.filter((e) => isReportRef(e.transactionRef) && e.receipts?.includes(id)).map((e) => e.id));
    b.journalEntries = b.journalEntries.filter((e) => !ids.has(e.id));
    b.mappings = b.mappings.filter((m) => m.receiptId !== id);
    b.receipts = b.receipts.filter((r) => r.id !== id);
  });
  rmSync(path, { force: true });
  return true;
}

/**
 * The drop row's answer kept in the company's file of the provider (knowledge/<role>/<id>.yaml):
 * its clearing account, its revenue account or its fee account and code, as the person gave them.
 * The account must be in the chart, the code one the firm books with.
 */
export function setProviderAccount(ws: Workspace, providerId: string, set: { clearing?: string; revenue?: string; fees?: { account: string; vat: string } }): { ok: true } | { ok: false; refusal: { code: 'unknownAccount'; params: { account: string } } | { code: 'unknownVatCode'; params: { code: string } } | { code: 'codeNotTaken'; params: { code: string; method: 'none' | 'net-rate' } } } {
  const p = providersOf(ws).find((x) => x.id === providerId);
  if (!p) return { ok: false, refusal: { code: 'unknownAccount', params: { account: providerId } } };
  const chart = chartNames(chartOf(ws));
  for (const a of [set.clearing, set.revenue, set.fees?.account]) if (a !== undefined && !chart.has(a)) return { ok: false, refusal: { code: 'unknownAccount', params: { account: a } } };
  if (set.fees) {
    if (!vat().codes.parse(set.fees.vat)) return { ok: false, refusal: { code: 'unknownVatCode', params: { code: set.fees.vat } } };
    if (!formTakes(set.fees.vat)) return { ok: false, refusal: { code: 'codeNotTaken', params: { code: set.fees.vat, method: withoutInputTax() ?? 'none' } } };
  }
  const file = join(ws.paths.root, homeOf('workspace', p.role, p.id));
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : `id: ${p.id}\n`);
  if (set.clearing) doc.setIn(['provider', 'clearing'], set.clearing);
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
 * minus, the fees on the company's fee account, all on the report's day. A report of a filed period
 * is left as it is. Returns how many reports it booked; call inside the write door.
 */
export function bookPayoutReports(ws: Workspace, books: Books, fx: FxResolver = loadFxResolver()): number {
  const providers = providersOf(ws);
  if (!providers.length) return 0;
  const counterparties = loadKnowledge(APP_ROOT, ws.paths.root).counterparties;
  const silent = silentUids(counterparties, ws.company?.uid);
  const lock = periodLock(books);
  const codes = saleCodes();
  const de = wordsIn('de');
  let booked = 0;
  for (const r of books.receipts) {
    if (!r.payout || !r.date || r.kind === 'duplicate' || r.location !== 'archived') continue;
    const id = businessOfReceipt(r, counterparties, ws.company?.uid, silent);
    const p = providers.find((x) => x.id === id);
    const revenue = p && revenueOf(ws, p);
    if (!p?.provider.clearing || !revenue || books.journalEntries.some((e) => e.transactionRef === saleRef(p.id, r.id))) continue;
    const said: ReportTexts = {
      sale: () => de.t('salesReport.payoutSales', { provider: p.name, file: r.filename }),
      refund: () => de.t('salesReport.payoutRefunds', { provider: p.name, file: r.filename }),
      fee: () => de.t('salesReport.payoutFees', { provider: p.name, file: r.filename }),
      reason: (kind) => de.t(`salesReport.reason.${kind}`, { file: r.filename, country: '' }),
    };
    const ctx = {
      provider: { id: p.id, name: p.name }, clearing: p.provider.clearing, revenue,
      ...(p.provider.fees ? { fees: { account: p.provider.fees.account, ...(formTakes(p.provider.fees.vat) ? { vat: p.provider.fees.vat } : {}) } } : {}),
      receipt: r.id, base: baseCurrency(), rate: (c: string, d: string) => fx.daily(c, d), ...(codes ? { codes } : {}), territory: invoicing().territory,
      agreed: agreedBasis(), isClosed: (d: string) => lock.isClosed(d), beforeBooks: (d: string) => lock.beforeBooks(d), newId: () => randomBytes(8).toString('hex'), texts: said,
    };
    const currency = r.currency ?? baseCurrency();
    // Card sales at the firm's own place: delivered in the territory, whatever the card's country.
    const sales = bookReport(books, { kind: 'sales', rows: [{ order: r.id, date: r.date, shipTo: invoicing().territory[0], gross: r.payout.sales, refunded: r.payout.refunds, currency }], unread: [] }, ctx);
    if (!sales.entries.length) continue;
    const fees = r.payout.fees > 0 ? bookReport(books, { kind: 'fees', rows: [{ order: r.id, date: r.date, fee: r.payout.fees, currency }], unread: [] }, ctx) : undefined;
    for (const out of [sales, ...(fees ? [fees] : [])]) {
      books.journalEntries.push(...out.entries);
      for (const m of out.links) if (!books.mappings.some((x) => x.transactionRef === m.transactionRef && x.receiptId === m.receiptId)) books.mappings.push(m);
    }
    booked++;
  }
  return booked;
}
