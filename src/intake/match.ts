/**
 * Step 3 of the inbox processing (`npm run match`): every staged receipt (location: 'staged').
 * - needsVisionReview: moved to receipts/ under its own name, archived, no model call
 * - otherwise: the model (src/llm/ask.ts) names it and finds its payment; the file is renamed
 *   into receipts/ and linked when the model is at least 80 % sure
 * A link to a payment of a filed quarter is never made (golden rule 1).
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { buildMatchPrompt, parseMatchResult, type MatchResult } from '../llm/prompts.js';
import type { BankTransaction, Receipt } from '../types/index.js';
import { periodLock, receiptHome, type Books } from '../books/store.js';
import { findFile } from '../workspace/workspace.js';
import type { IntakeNote, StepRun } from './pipeline.js';
import { baseCurrency, documents } from '../engines/index.js';
import { textFacts } from '../parsers/receipt-text.js';
import { twinFinder } from './duplicates.js';
import { capturedDay } from './captured.js';
import { isIsoDate } from '../accounting/periods.js';

const MAPPING_THRESHOLD = 0.8;
const CONCURRENCY = 10;

// Amazon/AliExpress/FedEx group multiple separate purchases (each its own receipt) into a
// single bank transaction — a receipt's amount is often only a fraction of the transaction
// total, so the amount must not rank the transaction out for these vendors (AGENTS.md).
const GROUPED_VENDOR_PATTERN = /amazon|aliexpress|fedex/i;

function toCHF(amount: number, currency: string): number {
  const rates: Record<string, number> = {
    'CHF': 1,
    'EUR': 0.91,
    'USD': 0.78,
    'GBP': 1.15,
  };
  const rate = rates[currency] || 1;
  return amount * rate;
}

function guessDate(filename: string): string | undefined {
  const m = filename.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
}

function normalizeFilename(raw: string): string {
  // Strip path separators and other unsafe chars; enforce .pdf extension
  let name = basename(raw).replace(/[/\\:*?"<>|]/g, '-');
  if (!name.toLowerCase().endsWith('.pdf')) {
    name = name.replace(/\.[^.]*$/, '') + '.pdf';
    if (!name.endsWith('.pdf')) name += '.pdf';
  }
  return name || 'receipt.pdf';
}

/**
 * The day a receipt is dated by: the one the model read off it when that is a day, else the day
 * the phone took it (from the inbox name, src/intake/captured.ts), marked so. "" or 0000-00-00 is
 * no date.
 */
function dateOf(read: string | undefined, r: Receipt): Pick<Receipt, 'date' | 'dateSource'> {
  if (read && isIsoDate(read)) return { date: read };
  const captured = capturedDay(r.originalFilename ?? r.filename);
  return captured ? { date: captured, dateSource: 'captured' } : {};
}

/** A name the model dated 00000000 (it found no date) takes the receipt's date, or none. */
const datedName = (name: string, date: string | undefined) =>
  name.replace(/^0{8}(?=[-_.])/, date ? date.replace(/-/g, '') : '').replace(/^[-_]+/, '') || 'receipt.pdf';

/** `desiredName`, or with -2, -3, … when a year folder already holds that name. */
function resolveCollision(desiredName: string, taken: (name: string) => boolean): string {
  if (!taken(desiredName)) return desiredName;
  const base = desiredName.replace(/\.pdf$/i, '');
  let i = 2;
  while (taken(`${base}-${i}.pdf`)) i++;
  return `${base}-${i}.pdf`;
}

/** What a receipt says before the model reads it: its date and total as stored, from the file name, the VAT block or the text. */
function factsOf(r: Receipt): { date?: string; amount?: number; currency?: string } {
  const text = textFacts(r.extractedText ?? '');
  const groups = r.vatSummary ?? [];
  const gross = groups.length && groups.every((g) => g.gross != null) ? groups.reduce((sum, g) => sum + g.gross!, 0) : undefined;
  return { date: r.date || guessDate(r.filename) || text.date, amount: r.amount ?? gross ?? text.amount, currency: r.currency ?? text.currency };
}

const squash = (s: string) => s.toUpperCase().replace(/[\s\-/]/g, '');

/** Invoice, order and customer numbers in a receipt's text («FM-79010», «RE-4471», «2026-031»): no dates, amounts or postcodes. */
function numbersIn(text: string): string[] {
  const tokens = text.split(/[\s,;:()[\]«»"']+/).map((x) => x.replace(/^[-/#]+|[-/#.]+$/g, ''));
  return [...new Set(tokens.filter((x) => !x.includes('.') && /\d/.test(x) && (/[A-Za-z\-/]/.test(x) || x.length >= 5)).map(squash).filter((x) => x.length >= 5))];
}

/** Words of a payment's text that name who was paid, not what the bank calls the booking. */
const BANK_WORDS = new Set(['zahlung', 'gutschrift', 'belastung', 'lastschrift', 'einkauf', 'karte', 'debit', 'kredit', 'transfer', 'payment', 'rechnung', 'auftrag', 'dauerauftrag', 'ebanking', 'twint', 'mastercard', 'visa', 'august', 'september', 'oktober', 'november', 'dezember', 'januar', 'februar', 'april', 'juni', 'juli']);
const nameWords = (tx: BankTransaction) => [...new Set([tx.description, ...(tx.parts ?? []).flatMap((p) => [p.counterparty, p.reference ?? ''])].join(' ').toLowerCase().match(/\p{L}{4,}/gu) ?? [])].filter((w) => !BANK_WORDS.has(w));

/**
 * A credit note's total is money back: when the receipt's VAT says so (its tax, or its net and
 * gross, below zero), its amount is negative too, whatever sign the reader gave it (corner-34).
 */
export function creditSigned(r: Pick<Receipt, 'amount' | 'vatSummary'>): number | undefined {
  const groups = r.vatSummary ?? [];
  const back = groups.length > 0 && (groups.reduce((sum, g) => sum + g.vat, 0) < 0 || groups.every((g) => (g.gross ?? g.net ?? 0) < 0));
  return r.amount !== undefined && back && r.amount > 0 ? -r.amount : r.amount;
}

/**
 * What code links without the model (MISSION: a payment that matches a receipt by amount and
 * number): an archived receipt nothing is linked to, and an open payment without a receipt, the
 * same amount to the Rappen in the same currency, money out for an invoice and in for a credit
 * note, and one of the receipt's numbers («GS-1207») in the payment's text. Only a pair that is
 * unique both ways is linked. Returns the links made.
 */
export function linkByCode(index: Books): Array<{ receipt: string; payment: string }> {
  const lock = periodLock(index);
  const linked = new Set(index.mappings.flatMap((m) => [m.receiptId, m.transactionRef]));
  const cents = (n: number) => Math.round(Math.abs(n) * 100);
  const receipts = index.receipts.filter((r) => r.location === 'archived' && !linked.has(r.id) && (!r.kind || r.kind === 'invoice')
    && r.amount !== undefined && r.amount !== 0 && !(r.date && lock.isClosed(r.date)));
  const payments = index.transactions.filter((t) => !linked.has(t.ref) && t.amount !== 0 && t.type !== 'wise-fee' && !lock.isClosed(t.date));
  const fits = (r: Receipt, t: BankTransaction) => {
    const numbers = numbersIn(r.extractedText ?? '');
    const paid = squash([t.description, t.reference ?? '', t.remarks ?? '', ...(t.parts ?? []).map((p) => p.reference ?? '')].join(' '));
    return (r.currency ?? baseCurrency()) === t.currency && cents(r.amount!) === cents(t.amount)
      && (r.amount! < 0) === (t.direction === 'CRDT') && numbers.some((n) => paid.includes(n));
  };
  const pairs = receipts.flatMap((r) => payments.filter((t) => fits(r, t)).map((t) => ({ r, t })));
  const once = pairs.filter(({ r, t }) => pairs.filter((p) => p.r === r).length === 1 && pairs.filter((p) => p.t === t).length === 1);
  for (const { r, t } of once) index.mappings.push({ transactionRef: t.ref, receiptId: r.id });
  return once.map(({ r, t }) => ({ receipt: r.id, payment: t.ref }));
}

const DAY = 864e5;
const CANDIDATES = 20;

/**
 * The payments the model is shown for one receipt, at most 20, best first: the open payments (no
 * receipt yet, not in a filed quarter), ranked by an invoice number of the receipt in the payment's
 * text, the amount, the vendor's name and the date; newest first where nothing tells them apart. A
 * grouped vendor's payment (Amazon, AliExpress, FedEx) stays a candidate with receipts on it, and
 * its amount does not count.
 */
export function candidates(receipt: Receipt, all: readonly BankTransaction[], linked: ReadonlySet<string> = new Set(), isClosed: (date: string) => boolean = () => false): BankTransaction[] {
  const text = receipt.extractedText ?? '';
  const grouped = text.match(GROUPED_VENDOR_PATTERN)?.[0].toLowerCase();
  const usable = all.filter((tx) => tx.amount !== 0 && tx.type !== 'wise-fee' && !isClosed(tx.date));
  const ofVendor = grouped ? usable.filter((tx) => (tx.description || '').toLowerCase().includes(grouped)) : [];
  const pool = ofVendor.length ? ofVendor : usable.filter((tx) => !linked.has(tx.ref));
  const { date, amount, currency } = factsOf(receipt);
  const want = amount ? Math.abs(toCHF(amount, currency || baseCurrency())) : undefined;
  const numbers = numbersIn(text);
  const lower = text.toLowerCase();
  const score = (tx: BankTransaction): number => {
    const paid = squash([tx.description, ...(tx.parts ?? []).map((p) => p.reference ?? '')].join(' '));
    let s = numbers.some((n) => paid.includes(n)) ? 50 : 0;
    if (want && !grouped) {
      const off = Math.abs(Math.abs(toCHF(tx.amount, tx.currency || baseCurrency())) - want) / want;
      s += off <= 0.005 ? 40 : off <= 0.05 ? 25 : off <= 0.3 ? 10 : 0;
    }
    s += 8 * Math.min(2, nameWords(tx).filter((w) => lower.includes(w)).length);
    if (date && tx.date) {
      const days = Math.abs(Date.parse(tx.date) - Date.parse(date)) / DAY;
      s += days <= 3 ? 12 : days <= 14 ? 8 : days <= 45 ? 3 : days > 120 ? -5 : 0;
    }
    return s;
  };
  return pool.map((tx) => ({ tx, s: score(tx) }))
    .sort((a, b) => b.s - a.s || (b.tx.date ?? '').localeCompare(a.tx.date ?? ''))
    .slice(0, CANDIDATES).map((x) => x.tx);
}

export const matchStep: StepRun = async ({ ws, books, ask, progress, log }) => {
  const IMPORT_DIR = ws.paths.inbox;
  const byCode = books.update(linkByCode);
  for (const l of byCode) log(`linked by amount and number: receipt ${l.receipt} → ${l.payment}`);
  const snapshot = books.read();
  const staged = snapshot.receipts.filter((r) => r.location === 'staged');
  if (staged.length === 0) {
    log('No staged receipts to process. Drop PDFs into beleg-import/ and run `npm run extract` first.');
    return { notes: [] };
  }
  const visionNeeded = staged.filter((r) => r.needsVisionReview);
  const toProcess = staged.filter((r) => !r.needsVisionReview);
  const taken = new Set(snapshot.mappings.map((m) => m.transactionRef));
  const lock = periodLock(snapshot);
  const total = staged.length;
  let completed = 0;
  progress(0, total);

  /**
   * Moves the staged file into its year's receipts/ and changes its receipt in the same synchronous change,
   * if the receipt is still the staged file it was. Returns the new file name, or why not.
   */
  const archive = (receipt: Receipt, desired: string, change: (r: Receipt, books: Books) => void): string | undefined => books.update((index) => {
    const r = index.receipts.find((x) => x.id === receipt.id);
    const srcPath = join(IMPORT_DIR, receipt.filename);
    if (!r || r.location !== 'staged' || r.filename !== receipt.filename || !existsSync(srcPath)) return undefined;
    const target = resolveCollision(desired, (name) => !!findFile(ws.paths, 'receipts', name));
    change(r, index);
    Object.assign(r, { filename: target, location: 'archived' });
    const home = receiptHome(ws, index, r);
    mkdirSync(home, { recursive: true });
    renameSync(srcPath, join(home, target));
    return target;
  });

  // ── Move needsVisionReview receipts without a model ────────────────────────
  if (visionNeeded.length > 0) log(`Moving ${visionNeeded.length} receipt(s) that need vision review to receipts/ (unlinked)...\n`);
  for (const receipt of visionNeeded) {
    const target = archive(receipt, receipt.filename, (r) => { if (!r.date) Object.assign(r, dateOf(undefined, r)); });
    progress(++completed, total);
    log(target ? `  moved (needsVisionReview): ${receipt.filename} → ${target}` : `  warn: ${receipt.filename} is not staged in beleg-import/ any more, skipping`);
  }

  if (toProcess.length === 0) {
    log('\nNo receipts to match.');
    return { notes: [] };
  }
  if (!ask) return { notes: [{ code: 'noModel', waiting: toProcess.length }] };

  log(`\nProcessing ${toProcess.length} staged receipt(s) (concurrency: ${CONCURRENCY})...\n`);
  completed = 0;
  let matched = 0;
  let skippedClosed = 0;
  let unlinked = 0;
  const failures: string[] = [];

  async function processReceipt(receipt: Receipt) {
    const srcPath = join(IMPORT_DIR, receipt.filename);
    const line = (msg: string) => log(`  [${completed}/${toProcess.length}]  ${receipt.filename}  ${msg}`);
    if (!existsSync(srcPath)) {
      completed++;
      line('not found in beleg-import/, skipping');
      return;
    }
    const useVision = (receipt.extractedText?.length ?? 0) < 200;
    // absolute: the lean call runs from an empty directory
    const prompt = buildMatchPrompt(receipt.extractedText, candidates(receipt, snapshot.transactions, taken, lock.isClosed), useVision ? srcPath : undefined);
    let result: MatchResult | null;
    try {
      result = parseMatchResult(await ask!(prompt, { step: 'evidence.guide.yaml#ai', model: 'sonnet', timeoutMs: 120_000, read: useVision ? [IMPORT_DIR] : undefined }));
    } catch (e) {
      completed++;
      failures.push(String(e instanceof Error ? e.message : e));
      line(`error: ${e}`);
      return;
    }
    completed++;
    if (!result) {
      failures.push('could not parse response (no suggestedFilename)');
      line('could not parse response (no suggestedFilename)');
      return;
    }
    const answer = result;
    const sure = answer.confidence >= MAPPING_THRESHOLD && (answer.matchedTransactionRefs?.length ?? 0) > 0;
    let linked: string[] = [];
    let twin: string | undefined;
    const dated = dateOf(answer.date, receipt);
    const target = archive(receipt, datedName(normalizeFilename(answer.suggestedFilename), dated.date), (r, index) => {
      Object.assign(r, { date: dated.date, description: answer.description, amount: creditSigned({ amount: answer.amount, vatSummary: r.vatSummary }), currency: answer.currency, ...(answer.title ? { title: answer.title } : {}) });
      if (dated.dateSource) r.dateSource = dated.dateSource;
      // Only an invoice is paid by a payment; a copy of one (by its facts, now read) waits for a person in Belege.
      if (!sure || (r.kind && r.kind !== 'invoice' && r.kind !== 'sales-record')) return;
      const t = twinFinder(index.receipts, documents()).find(r);
      if (t?.relation === 'duplicate') { twin = index.receipts.find((x) => x.id === t.of)?.filename; return; }
      // Periodensperre: never attach a mapping to a transaction inside a closed period.
      const lock = periodLock(index);
      linked = answer.matchedTransactionRefs.filter((ref) => {
        const tx = index.transactions.find((t) => t.ref === ref);
        if (tx && !lock.isClosed(tx.date)) return true;
        if (tx) { log(`  ⚠ skipped mapping to ${ref}: transaction is in the closed period (≤ ${lock.closedThrough})`); skippedClosed++; }
        return false;
      });
      for (const transactionRef of linked) {
        if (!index.mappings.some((m) => m.transactionRef === transactionRef && m.receiptId === receipt.id)) index.mappings.push({ transactionRef, receiptId: receipt.id });
      }
    });
    const pct = `(${((answer.confidence ?? 0) * 100).toFixed(0)}%)`;
    if (!target) line('is not staged in beleg-import/ any more, skipping');
    else if (twin) { unlinked++; line(`→ ${target}  possibly the same as ${twin}: not linked, Belege asks`); }
    else if (linked.length) { matched++; line(`→ ${target}  ${pct} refs: ${linked.join(', ')}`); }
    else { unlinked++; line(`→ ${target}  ${pct} unlinked${sure ? ' — all refs in closed period' : ''}`); }
  }

  let running = 0;
  const queue: (() => void)[] = [];
  await Promise.all(toProcess.map(async (receipt) => {
    while (running >= CONCURRENCY) await new Promise<void>((resolve) => queue.push(resolve));
    running++;
    try { await processReceipt(receipt); } finally { running--; queue.shift()?.(); }
    progress(visionNeeded.length + completed, total);
  }));

  log(`\nDone.`);
  log(`  Matched & linked : ${matched}`);
  log(`  Moved (unlinked) : ${unlinked}`);
  log(`  Failed           : ${failures.length}`);
  if (skippedClosed > 0) log(`  Skipped (closed) : ${skippedClosed}  — mappings refused because the transaction is in a closed period`);
  const notes: IntakeNote[] = failures.length ? [{ code: 'failed', count: failures.length, detail: failures[0].slice(0, 300) }] : [];
  return { notes };
};
