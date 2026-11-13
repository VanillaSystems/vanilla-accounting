/**
 * Step 3 of the inbox processing (`npm run match`): every staged receipt (location: 'staged').
 * - needsVisionReview: moved to receipts/ under its own name, archived, no model call
 * - code first (#187): a receipt whose payment the chain pairs clearly by the facts code reads off
 *   it is archived under its day and title (the fast model's, batched), with code's date and total,
 *   and linked (or pointed at its filed payment) without a match prompt
 * - otherwise: the model (src/llm/ask.ts) names it and finds its payment among the code's short
 *   list, or the 20 payments ranked here; the file is renamed into receipts/ and linked when the
 *   model is at least 80 % sure
 * The matching chain (pair-chain.ts) runs before and after, over every receipt nothing is linked
 * to and every payment without one, whichever came first; code also links an order document to its
 * sale booked from the provider's sales report (src/booking/sales-report.ts, never to the payout:
 * a payout has no receipt of its own, #203) and several receipts that add up to one payment (receipt-sets.ts).
 * A link to a payment of a filed quarter is never made (golden rule 1).
 */
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { buildMatchPrompt, parseMatchResult, type MatchResult } from '../llm/prompts.js';
import type { BankTransaction, Receipt, ReceiptTitle } from '../types/index.js';
import { periodLock, type Books } from '../books/store.js';
import { archiveReceipt } from '../books/archive.js';
import type { IntakeNote, StepRun } from './pipeline.js';
import { baseCurrency, documents } from '../engines/index.js';
import { textFacts } from '../parsers/receipt-text.js';
import { twinFinder } from './duplicates.js';
import { capturedDay } from './captured.js';
import { isIsoDate } from '../accounting/periods.js';
import { numbersIn, squash } from '../accounting/document-numbers.js';
import { freeFor, nameWords, pairMapping, takenPayments } from './pairing.js';
import { legOf } from '../workspace/money-accounts.js';
import { titlesFor } from './titles.js';
import { estvToChf, noPaymentFor, noReceiptFor, runPairChain, takeOver, vatCorrectionsIn } from './pair-chain.js';
import { linkOrdersToSales } from '../booking/sales-report.js';
import { linkReceiptSets, linkSplitLegs, MAX_RUN, MAX_TRIED } from './receipt-sets.js';
import { batchPayers, businesses, NO_BATCH_PAYERS, type BatchPayers, type Businesses } from './batch-payers.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { buyerUids } from './own-invoice.js';
import { providersOf } from './sales-report-import.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { creditSigned } from '../accounting/credit-signed.js';
import { excessOfPayment } from '../accounting/receipt-due.js';
import { isBankFee } from '../booking/separate-fee.js';
import { linkCardLines } from '../books/card-lines.js';
import { unbookPayments } from '../accounting/classify-force.js';

const MAPPING_THRESHOLD = 0.8;
const CONCURRENCY = 10;


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

type Read = Partial<Pick<Receipt, 'date' | 'amount' | 'currency' | 'description' | 'title'>>;

/**
 * What the step read, less the facts a person entered while the run still worked on the receipt
 * (`handSet`, #218): hers win, the step never writes over them. The mark goes once the receipt is filed.
 */
export function keepHand(r: Receipt, read: Read): Read {
  const hand = new Set(r.handSet);
  delete r.handSet;
  const out = { ...read };
  if (hand.has('date')) delete out.date;
  if (hand.has('amount')) { delete out.amount; delete out.currency; }
  if (hand.has('description')) { delete out.description; delete out.title; }
  return out;
}

/**
 * A name the model dated 00000000 (it found no date) takes the receipt's date. Without a date the name
 * starts with no day at all, whatever eight digits the model put there: Belege would read a day off it (#361).
 */
export const datedName = (name: string, date: string | undefined) =>
  (date ? name.replace(/^0{8}(?=[-_.])/, date.replace(/-/g, '')) : name.replace(/^\d{8}(?=[-_.])/, '')).replace(/^[-_]+/, '') || 'receipt.pdf';

/** What a receipt says before the model reads it: its date and total as stored, from the file name, the VAT block or the text. */
export function factsOf(r: Receipt): { date?: string; amount?: number; currency?: string } {
  const text = textFacts(r.extractedText ?? '');
  const groups = r.vatSummary ?? [];
  const gross = groups.length && groups.every((g) => g.gross != null) ? groups.reduce((sum, g) => sum + g.gross!, 0) : undefined;
  return { date: r.date || guessDate(r.filename) || text.date, amount: r.amount ?? gross ?? text.amount, currency: r.currency ?? text.currency };
}

/**
 * The receipt `r` waits behind as its possible copy, or undefined when `r` is the one to link
 * (r5h-32). Of two receipts that seem one document, the one linked already, or the one staged
 * before it in this run (`staged`, the run's order), is the original; `r` then waits for a person
 * in Belege. A twin in the books that nothing is linked to does not hold `r` back: `r` is linked,
 * and that twin, now the one without a link, is the one Belege asks about. Before, each of the
 * pair held the other back, and neither was ever linked.
 */
export function waitsBehind(index: Pick<Books, 'receipts' | 'mappings'>, r: Receipt, staged: readonly string[]): string | undefined {
  const t = twinFinder(index.receipts, documents()).find(r);
  if (t?.relation !== 'duplicate') return undefined;
  const linked = index.mappings.some((m) => m.receiptId === t.of);
  const before = staged.includes(t.of) && staged.indexOf(t.of) < staged.indexOf(r.id);
  return linked || before ? t.of : undefined;
}

const DAY = 864e5;
const CANDIDATES = 20;
/** The score from which a filed payment is shown: its amount to the half per mille, or a number of the receipt in its text. */
const FILED_FIT = 40;

export type Candidate = BankTransaction & { filed?: true };

/**
 * The payments the model is shown for one receipt, at most 20, best first: the payments without a
 * receipt yet, ranked by an invoice number of the receipt in the payment's text, the amount, the
 * vendor's name and the date; newest first where nothing tells them apart. A batch payer's
 * payment (its business's file says `grouped: true`, src/intake/batch-payers.ts) stays a candidate
 * with receipts on it, and its amount does not count: a receipt is often only a part of it. A
 * payment of a filed quarter is shown, marked `filed`, only when its number or amount fits and
 * after the open ones of the same fit: a late receipt is pointed at it, never linked (golden rule 1, corner-33).
 */
export function candidates(receipt: Receipt, all: readonly BankTransaction[], linked: ReadonlySet<string> = new Set(), isClosed: (date: string) => boolean = () => false, payers: BatchPayers = NO_BATCH_PAYERS, receiptsOf: (tx: BankTransaction) => readonly Receipt[] = () => []): Candidate[] {
  const text = receipt.extractedText ?? '';
  const grouped = payers.ofReceipt(receipt);
  const usable = all.filter((tx) => tx.amount !== 0 && !isBankFee(tx));
  const ofVendor = grouped ? usable.filter((tx) => payers.ofPayment(tx, receiptsOf(tx)) === grouped) : [];
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
  return pool.map((tx) => ({ tx, s: score(tx), filed: isClosed(tx.date) }))
    .filter((x) => !x.filed || x.s >= FILED_FIT)
    .map((x) => (x.filed ? { ...x, s: x.s - 1 } : x))
    .sort((a, b) => b.s - a.s || (b.tx.date ?? '').localeCompare(a.tx.date ?? ''))
    .slice(0, CANDIDATES).map((x) => (x.filed ? { ...x.tx, filed: true as const } : x.tx));
}

/**
 * A staged receipt as the matching chain sees it before any model read it (#187): the date, total
 * and currency code reads off it (factsOf), signed as a credit note's when its VAT says so. None
 * without a day and an amount: then only the model can read it.
 */
export function provisional(r: Receipt): Receipt | undefined {
  const f = factsOf(r);
  if (!f.date || !isIsoDate(f.date) || !f.amount) return undefined;
  return { ...r, location: 'archived', date: f.date, amount: creditSigned({ amount: f.amount, vatSummary: r.vatSummary }), currency: f.currency ?? baseCurrency() };
}

/** The name of a receipt code linked: its day, then its title («Coop Pronto Benzin»), else the name it came with. */
export function codeName(date: string, title: ReceiptTitle | undefined, came: string): string {
  const slug = (title ? `${title.vendor} ${title.what}` : came.replace(/\.[^.]*$/, '').replace(/^\d{8}[-_]?/, ''))
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'beleg';
  return `${date.replace(/-/g, '')}-${slug}.pdf`;
}

/** The books the firm's own UIDs are read from (buyerUids): without them only the settings' UID. */
type UidBooks = Parameters<typeof buyerUids>[1];

/** The firm's own UIDs, as digits: the settings' UID, else the ones `books` show to be the buyer's (src/intake/own-invoice.ts buyerUids). */
export const buyerUidsOf = (ws: Pick<Workspace, 'company'>, books: UidBooks = { receipts: [] }): string[] => buyerUids(ws.company, books);

/** The workspace's batch payers, from its business files in both layers; none when its knowledge does not load (a test's bare workspace). */
export function batchPayersOf(ws: Pick<Workspace, 'paths' | 'company'>, books?: UidBooks): BatchPayers {
  try {
    return batchPayers(loadKnowledge(APP_ROOT, ws.paths.root).counterparties, buyerUidsOf(ws, books));
  } catch {
    return NO_BATCH_PAYERS;
  }
}

/** Whose receipts and payments are by the workspace's business files in both layers; none when its knowledge does not load (a test's bare workspace). */
export function businessesOf(ws: Pick<Workspace, 'paths' | 'company'>, books?: UidBooks): Businesses | undefined {
  try {
    return businesses(loadKnowledge(APP_ROOT, ws.paths.root).counterparties, buyerUidsOf(ws, books));
  } catch {
    return undefined;
  }
}

export const matchStep: StepRun = async ({ ws, books, ask, progress, log }) => {
  const IMPORT_DIR = ws.paths.inbox;
  const toChf = estvToChf();
  const first = books.read();
  const staged = first.receipts.filter((r) => r.location === 'staged');
  const visionNeeded = staged.filter((r) => r.needsVisionReview);
  // A file the reading found no receipt at all (a holiday photo, #361) is set aside under the name it came with: no payment, no name the model makes up.
  const aside = staged.filter((r) => !r.needsVisionReview && r.kind === 'noise');
  const toRead = staged.filter((r) => !r.needsVisionReview && r.kind !== 'noise');
  // Code first (#187): the staged receipts take part in the chain with the facts code reads off them.
  const early = toRead.flatMap((r) => provisional(r) ?? []);
  const payers = batchPayersOf(ws, first);
  const noPayment = noPaymentFor(ws);
  const byCode = async (stagedNow: readonly Receipt[] = []) => {
    const noReceipt = noReceiptFor(ws);
    const chain = await runPairChain(books, { ask, toChf, log, staged: stagedNow, noReceipt, noPayment, businesses: businessesOf(ws, books.read()), firm: ws.company && { uid: ws.company.uid, name: ws.company.name, owner: ws.company.owner } });
    const providers = providersOf(ws);
    for (const l of books.update((index) => linkOrdersToSales(index, (d) => !periodLock(index).isClosed(d), providers))) log(`linked the order document to its sale: receipt ${l.receipt} → ${l.sale}`);
    const found = books.update((index) => { const lock = periodLock(index); return linkReceiptSets(index, { isOpen: (d) => !lock.isClosed(d), payers, toChf, buyerUids: buyerUidsOf(ws, index), noReceipt: noReceipt(index), noPayment: noPayment(index) }); });
    for (const s of found.sets) log(`linked ${s.receipts.length} receipts that add up to the payment${s.basis === 'original' ? ' in the amount its bank names' : s.basis === 'rate' ? ' at the official daily rate' : ''}${s.run ? ' (the batch payer\'s open receipts in date order)' : ''}: ${s.receipts.join(', ')} → ${s.legs.join(', ')}`);
    const runs = found.cuts.filter((c) => c.limit === 'run');
    const combos = found.cuts.filter((c) => c.limit === 'combinations');
    if (combos.length) log(`${combos.length} payment(s) have more receipts of one vendor near them than code combines (at most ${MAX_TRIED}, the nearest; up to ${Math.max(...combos.map((c) => c.near))} there): a set among those is only proposed, never linked`);
    if (runs.length) log(`${runs.length} payment(s) of a batch payer have more open receipts than code tries in date order (at most ${MAX_RUN}, the oldest; up to ${Math.max(...runs.map((c) => c.near))} there): they are left to a person`);
    for (const l of books.update((index) => { const lock = periodLock(index); return linkSplitLegs(index, (d) => !lock.isClosed(d), toChf); })) log(`linked the receipts of a card charge split across balances to its other legs: ${l.receipts.join(', ')} → ${l.legs.join(', ')}`);
    // A card statement's lines, and the one bill that fits a line (#409): the app's booking of its settlement that saw no such bill goes, the booking step books it again by its lines.
    const cards = books.update((index) => {
      const lock = periodLock(index);
      const done = linkCardLines(index, (d) => !lock.isClosed(d));
      // Without a model the booking stays: never taken away for a rebooking nobody can make (r8f-41).
      if (done.linked.length && ask) unbookPayments(index, done.linked.map((l) => l.payment), 'links');
      return done;
    });
    if (cards.read.length) log(`read the lines of ${cards.read.length} card statement(s)`);
    for (const l of cards.linked) log(`linked receipt ${l.receipt} to line ${l.line + 1} of the card statement of ${l.payment}`);
    return chain;
  };
  const chain = await byCode(early);
  if (staged.length === 0) {
    log('No staged receipts to process. Drop PDFs into beleg-import/ and run `npm run extract` first.');
    return { notes: [] };
  }
  const order = staged.map((r) => r.id);
  const total = staged.length;
  let completed = 0;
  progress(0, total);

  /**
   * Moves the staged file into its year's receipts/ and changes its receipt in the same synchronous change,
   * if the receipt is still the staged file it was. Returns the new file name, or why not.
   */
  const archive = (receipt: Receipt, desired: string | ((r: Receipt) => string), change: (r: Receipt, books: Books) => void): string | undefined => books.update((index) => {
    const r = index.receipts.find((x) => x.id === receipt.id);
    if (!r || r.location !== 'staged' || r.filename !== receipt.filename || !existsSync(join(IMPORT_DIR, receipt.filename))) return undefined;
    change(r, index);
    return archiveReceipt(ws, index, r, typeof desired === 'string' ? desired : desired(r));
  });

  // ── Move needsVisionReview receipts without a model ────────────────────────
  if (visionNeeded.length > 0) log(`Moving ${visionNeeded.length} receipt(s) that need vision review to receipts/ (unlinked)...\n`);
  for (const receipt of visionNeeded) {
    const target = archive(receipt, receipt.filename, (r) => { if (!r.date) Object.assign(r, dateOf(undefined, r)); });
    progress(++completed, total);
    log(target ? `  moved (needsVisionReview): ${receipt.filename} → ${target}` : `  warn: ${receipt.filename} is not staged in beleg-import/ any more, skipping`);
  }
  for (const receipt of aside) {
    const target = archive(receipt, receipt.filename, () => undefined);
    progress(++completed, total);
    log(target ? `  set aside, no receipt${receipt.kindWhy ? ` (${receipt.kindWhy})` : ''}: ${receipt.filename} → ${target}` : `  warn: ${receipt.filename} is not staged in beleg-import/ any more, skipping`);
  }

  // ── The receipts the chain paired: archived, named and linked without their model match ──
  const pairedByCode = new Set<string>();
  if (chain.staged.length) {
    const facts = new Map(early.map((r) => [r.id, r]));
    const titles = ask ? await titlesFor(ask, chain.staged.map((l) => facts.get(l.receipt)!), log) : new Map<string, ReceiptTitle>();
    for (const l of chain.staged) {
      const receipt = toRead.find((r) => r.id === l.receipt)!;
      const p = facts.get(l.receipt)!;
      const title = titles.get(l.receipt);
      const out: { result: 'linked' | 'filed' | 'twin' | 'taken' } = { result: 'taken' };
      const target = archive(receipt, codeName(p.date!, title, receipt.originalFilename ?? receipt.filename), (r, index) => {
        out.result = 'taken';
        Object.assign(r, keepHand(r, { date: p.date, amount: p.amount, currency: p.currency, ...(title ? { title, description: `${title.vendor} ${title.what}`.trim() } : {}) }));
        if (waitsBehind(index, r, order)) { out.result = 'twin'; return; }
        // Every movement of the charge: one, or each leg of a charge split across balances.
        const refs = l.legs ?? [l.payment];
        const t = index.transactions.find((x) => x.ref === l.payment);
        if (!t || refs.some((ref) => r.notPaidBy?.includes(ref))) return;
        if (l.replaced && (periodLock(index).isClosed(t.date) || !takeOver(index, refs, l.replaced))) return;
        const taken = takenPayments(index);
        if (refs.some((ref) => taken.has(ref)) || !freeFor(index, t, r)) return;
        if (periodLock(index).isClosed(t.date)) { r.filedPayment = t.ref; out.result = 'filed'; return; }
        for (const ref of refs) index.mappings.push(pairMapping(l.by, ref, r.id, l.signals));
        out.result = 'linked';
      });
      if (!target) continue;
      pairedByCode.add(l.receipt);
      progress(++completed, total);
      log(`  ${receipt.filename} → ${target}  ${out.result === 'linked' ? `linked ${l.by === 'checked' ? 'by code, checked by the model' : 'by code'}: ${l.payment}${l.replaced ? ` in place of receipt ${l.replaced}, a whole period off the payment's day` : ''}` : out.result === 'filed' ? `pays the filed payment ${l.payment}: not linked` : out.result === 'twin' ? 'possibly a copy of another receipt: not linked, Belege asks' : `${l.payment} was linked meanwhile: not linked`}  (no model match)`);
    }
  }
  // ── A bill of a VAT-only correction (a provider's Payments Invoice, #190): no payment will come for it, so the model's
  // match has nothing to decide. The day and the total its text states plainly date and name it, by code (#458): before,
  // one failed model answer left such a bill staged without a date and its input tax unbooked.
  // One a person booked already from Belege («Vorsteuer buchen») is linked to that booking: still such a bill, never a payment's.
  const bills = vatCorrectionsIn(ws, { ...books.read(), mappings: [] });
  const billsByCode = toRead.flatMap((r) => (pairedByCode.has(r.id) || !bills[r.id] ? [] : provisional(r) ?? []));
  if (billsByCode.length) {
    const titles = ask ? await titlesFor(ask, billsByCode, log) : new Map<string, ReceiptTitle>();
    for (const p of billsByCode) {
      const receipt = toRead.find((r) => r.id === p.id)!;
      const title = titles.get(p.id);
      // A copy of another receipt (by its facts, now read) is filed, never booked: the booking step books a bill's input tax once (vatCorrectionsOf `twin`).
      let twin: string | undefined;
      const target = archive(receipt, codeName(p.date!, title, receipt.originalFilename ?? receipt.filename), (r, index) => {
        Object.assign(r, keepHand(r, { date: p.date, amount: p.amount, currency: p.currency, ...(title ? { title, description: `${title.vendor} ${title.what}`.trim() } : {}) }));
        twin = waitsBehind(index, r, order);
      });
      if (!target) continue;
      pairedByCode.add(p.id);
      progress(++completed, total);
      log(`  ${receipt.filename} → ${target}  a bill of a VAT-only correction: dated and named by code, no payment${twin ? `; possibly a copy of ${twin}, Belege asks` : ''}  (no model match)`);
    }
  }
  const toProcess = toRead.filter((r) => !pairedByCode.has(r.id));
  if (toProcess.length === 0) {
    log('\nNo receipts left for the model.');
    return { notes: [] };
  }
  if (!ask) return { notes: [{ code: 'noModel', waiting: toProcess.length }] };
  // The model is shown the code's short list where there is one, else the payments the intake ranks.
  const snapshot = books.read();
  const taken = takenPayments(snapshot);
  const lock = periodLock(snapshot);
  const noReceipt = noReceiptFor(ws);
  const exempt = noReceipt(snapshot);
  // The payments the model may be shown: none that has no receipt of its own (marked, own transfer, booked onto the owner…).
  const shown = snapshot.transactions.filter((t) => !t.noReceiptNeeded && !exempt(t));
  const shortList = new Map(chain.left.filter((l) => l.candidates.length && l.total === l.candidates.length).map((l) => [l.receipt, l.candidates]));
  const shownFor = (receipt: Receipt): Candidate[] => {
    const list = shortList.get(receipt.id)?.flatMap((c) => { const t = shown.find((x) => legOf(x) === c.leg); return t && !taken.has(t.ref) ? [c.filed ? { ...t, filed: true as const } : t] : []; });
    const apart = new Set(receipt.notPaidBy ?? []);
    return list?.length ? list : candidates(receipt, shown.filter((t) => !apart.has(t.ref)), taken, lock.isClosed, payers, (t) => snapshot.mappings.flatMap((m) => (m.transactionRef === t.ref ? snapshot.receipts.filter((r) => r.id === m.receiptId) : [])));
  };

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
    const prompt = buildMatchPrompt(receipt.extractedText, shownFor(receipt), useVision ? srcPath : undefined);
    let result: MatchResult | null;
    try {
      result = parseMatchResult(await ask!(prompt, { step: 'receipt-match', timeoutMs: 120_000, attachments: useVision ? [srcPath] : undefined }));
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
    let filed: string[] = [];
    // A bank statement keeps its period's last day (#151), whatever day the model read off it.
    const dated = receipt.kind === 'statement' && receipt.date ? { date: receipt.date } : dateOf(answer.date, receipt);
    // A model that read no date never erases one code read (a customs assessment's) or a person set (#361).
    const day = dated.date ?? receipt.date;
    // The change runs once more on books loaded afresh after a stale save (src/books/store.ts updateSaved): what it finds starts empty.
    // A date a person entered while the run read it names the file too (#218).
    let handDate: string | undefined;
    // The model read no day: whatever eight digits it put first are no date of the receipt.
    const suggested = normalizeFilename(answer.suggestedFilename);
    const named = datedName(dated.date ? suggested : suggested.replace(/^\d{8}(?=[-_.])/, '00000000'), day);
    const target = archive(receipt, (r) => (handDate && r.date ? named.replace(/^\d{8}(?=[-_.])/, r.date.replace(/-/g, '')) : named), (r, index) => {
      linked = [];
      twin = undefined;
      filed = [];
      const byHand = new Set(r.handSet);
      handDate = byHand.has('date') ? r.date : undefined;
      Object.assign(r, keepHand(r, { date: dated.date ?? r.date, description: answer.description, amount: creditSigned({ amount: answer.amount, vatSummary: r.vatSummary }), currency: answer.currency, ...(answer.title ? { title: answer.title } : {}) }), { ...(answer.payout ? { payout: answer.payout } : {}), ...(answer.order ? { order: answer.order } : {}) });
      if (dated.dateSource && !byHand.has('date')) r.dateSource = dated.dateSource;
      // Only an invoice is paid by a payment; a copy of one (by its facts, now read) waits for a person in Belege.
      if (!sure || (r.kind && r.kind !== 'invoice' && r.kind !== 'sales-record')) return;
      // An order page of the provider way goes with its sale from the order export (#253), a bill that proves a VAT-only correction with its booking (#190): never with a payment.
      if (noPayment(index)(r)) { log(`  ${receipt.filename}: an order page the provider's export books, or a bill of a VAT-only correction: no payment linked`); return; }
      const behind = waitsBehind(index, r, order);
      if (behind) { twin = index.receipts.find((x) => x.id === behind)?.filename; return; }
      // Periodensperre: never attach a mapping to a transaction inside a closed period.
      const lock = periodLock(index);
      const held = takenPayments(index);
      const grouped = !!payers.ofReceipt(r);
      const without = noReceipt(index);
      linked = answer.matchedTransactionRefs.filter((ref) => {
        const tx = index.transactions.find((t) => t.ref === ref);
        // A payment without a receipt of its own takes none, whatever the model says.
        if (tx && (tx.noReceiptNeeded || without(tx) || r.notPaidBy?.includes(ref))) { log(`  ⚠ skipped ${ref}: it needs no receipt, or a person took it apart from this receipt`); return false; }
        // A payment another receipt took meanwhile (another of this run's receipts, read from the same snapshot) stays with it, unless the vendor groups several receipts into one payment
        // or it is a collective payment with a part of this receipt's amount still free.
        if (tx && !freeFor(index, tx, r) && !grouped && !index.mappings.some((m) => m.transactionRef === ref && m.receiptId === r.id)) { log(`  ⚠ skipped ${ref}: another receipt holds it; this one waits for a person`); return false; }
        // Nor one whose receipts would add up to more than it paid (a grouping vendor's receipt of another of its payments): the receipt stays free for its own.
        if (tx && answer.matchedTransactionRefs.length === 1 && excessOfPayment(index, ref, r.id) !== undefined) { log(`  ⚠ skipped ${ref}: with this receipt its receipts add up to more than it paid; this one waits for its own payment`); return false; }
        if (tx && !lock.isClosed(tx.date)) return true;
        if (tx) { log(`  ⚠ skipped mapping to ${ref}: transaction is in the closed period (≤ ${lock.closedThrough})`); filed.push(ref); }
        return false;
      });
      // Its only payment is filed: the receipt names it, so the person sees where its tax goes (a correction in the open quarter).
      // Never a filed payment another receipt holds (its tax would be corrected twice), nor one a person took apart from this one.
      const pointed = filed.find((ref) => !held.has(ref) && !r.notPaidBy?.includes(ref));
      if (!linked.length && pointed) r.filedPayment = pointed;
      for (const transactionRef of linked) {
        if (!index.mappings.some((m) => m.transactionRef === transactionRef && m.receiptId === receipt.id)) index.mappings.push({ transactionRef, receiptId: receipt.id, by: 'llm' });
      }
    });
    skippedClosed += filed.length;
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
    progress(visionNeeded.length + aside.length + pairedByCode.size + completed, total);
  }));

  // The receipts just read: what code finds for them the model was not sure of.
  await byCode();
  log(`\nDone.`);
  log(`  Matched & linked : ${matched}`);
  log(`  Moved (unlinked) : ${unlinked}`);
  log(`  Failed           : ${failures.length}`);
  if (skippedClosed > 0) log(`  Skipped (closed) : ${skippedClosed}  — mappings refused because the transaction is in a closed period`);
  const notes: IntakeNote[] = failures.length ? [{ code: 'failed', count: failures.length, detail: failures[0].slice(0, 300) }] : [];
  return { notes };
};
