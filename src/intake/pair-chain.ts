/**
 * The matching chain (#187), run on every intake run and by «Zahlung suchen» / «Beleg suchen»:
 *
 * 1. code finds the candidates (pairing.ts); a clear pair is unique both ways within strict bounds;
 * 2. the model checks the clear pairs, about 20 per call, on their short facts: a confirmed pair is
 *    linked as «code, checked by the model», a doubted one goes to 3;
 * 3. the model chooses from a receipt's short list (2–5 candidates), linking only at 80 % or more;
 * 4. the rest is the person's, with the code's candidates.
 *
 * Without a model the clear pairs are linked by code and the rest is the person's. A payment of a
 * filed quarter is never linked: its receipt is pointed at it (Receipt.filedPayment, golden rule 1).
 * A pair the model was shown and did not take is not asked about again (Receipt.pairDoubted), unless
 * a person asks with the button; a pair a person took apart is never a candidate (Receipt.notPaidBy).
 */
import type { Receipt, BankTransaction } from '../types/index.js';
import { periodLock, type Books } from '../books/store.js';
import type { Ask, BooksPort } from './pipeline.js';
import { numbersIn } from '../accounting/document-numbers.js';
import { baseCurrency } from '../engines/index.js';
import { loadFxResolver, type FxResolver } from '../accounting/fx-rates.js';
import { SHORT_LIST, chainMade, freeFor, pairMapping, pairablePayment, slotOf, pairableReceipt, searchPairs, signalsOfCandidate, stagesOf, takenPayments, type Maker, type PairCandidate, type PairStage, type Signal, type ToChf } from './pairing.js';
import { legOf } from '../workspace/money-accounts.js';
import { partPayment } from '../accounting/batch-parts.js';
import { chargesOf } from './charges.js';
import type { Businesses } from './batch-payers.js';
import type { Firm } from './own-invoice.js';
import { delaysOf } from './delays.js';
import { nearPairs, type NearPair } from './near-pairs.js';
import { partsOf } from '../accounting/batch-parts.js';
import { appBooked, noReceiptOfItsOwn, receiptKnowledge } from '../booking/receipt-wait.js';
import { loadClassifyContext } from '../booking/classify.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { noPaymentOf, orderPagesOf, type OrderPage } from '../booking/order-pages.js';
import { providersOf } from './sales-report-import.js';
import { vatCorrectionsOf, type VatCorrection } from '../booking/vat-corrections.js';
import type { Counterparty } from '../knowledge/counterparties.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';

export type { Found, Maker } from './pairing.js';

/** Clear pairs per call of the model's check, receipts per call of its choice: every pair is asked, in as many calls as it takes. */
export const CHECK_BATCH = 20;
export const CHOOSE_BATCH = 10;
const SURE = 0.8;



/** A pair the chain made. `legs`: every movement of a card charge split across balances, each linked (src/intake/charges.ts); absent for one movement. `replaced`: the receipt whose link it took over (takeOver, #291). */
export interface ChainLink { receipt: string; payment: string; by: Maker; signals: Signal[]; filed?: true; legs?: string[]; replaced?: string }

/** What the chain did and left. `left`: the receipts that are the person's, each with the code's candidates (`total` of them before the cut to the short list). */
export interface ChainResult {
  linked: ChainLink[];
  left: Array<{ receipt: string; candidates: PairCandidate[]; total: number }>;
  /** The clear pairs of `staged` receipts, for the caller to archive, name and link (filed: point at; replaced: takeOver first) in its own change. */
  staged: ChainLink[];
  /** Model calls made, and the pairs and receipts they were asked about. */
  calls: number;
  checked: number;
  chosen: number;
  /** The model could not be asked, or its answer could not be read: the clear pairs were linked by code, and no doubt was kept. */
  modelFailed?: string;
}

export interface ChainOptions {
  ask?: Ask;
  toChf: ToChf;
  log?: (line: string) => void;
  /** «Zahlung suchen» on one receipt or «Beleg suchen» on one payment: only its pairs, asked again even when the model doubted them before. */
  only?: { receipt: string } | { payment: string };
  /**
   * Receipts still in the inbox, with the facts code read off them (date, amount, currency) and
   * `location: 'archived'` so the search takes them: their clear pairs come back in `staged`,
   * unwritten; their short lists go to the intake's own model match, which names them anyway, so
   * the chain asks no choice for them.
   */
  staged?: readonly Receipt[];
  /** The payments without a receipt of their own on these books, beside those marked so (noReceiptFor): never a candidate. */
  noReceipt?: (books: Books) => (t: BankTransaction) => boolean;
  /** The receipts without a payment of their own on these books (noPaymentFor: an order page of the provider way): never a candidate. */
  noPayment?: (books: Books) => (r: Receipt) => boolean;
  /** Whose a receipt and a payment are by the business files (businessesOf): a payment naming the receipt's business counts as its name. */
  businesses?: Businesses;
  /** The firm (company.uid, company.name): money in pays its own invoices (src/intake/own-invoice.ts, #365). */
  firm?: Firm;
}

/** The payments of `books` without a receipt of their own, as the wait for a receipt decides it (src/booking/receipt-wait.ts noReceiptOfItsOwn), for the workspace `ws`. */
export function noReceiptFor(ws: Workspace): (books: Books) => (t: BankTransaction) => boolean {
  let firm: Parameters<typeof noReceiptOfItsOwn> extends [unknown, ...infer R] ? R : never;
  try {
    firm = [loadClassifyContext(ws), receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws), loadFxResolver()];
  } catch {
    // A workspace without its settings (a test's bare one) exempts only what pairablePayment knows itself.
    return () => () => false;
  }
  return (books) => noReceiptOfItsOwn(books, ...firm);
}

/**
 * The receipts of `books` without a payment of their own, for the workspace `ws`: an order page of a
 * provider whose order export books its order (src/booking/order-pages.ts, #253), and a bill that
 * proves a VAT-only correction (src/booking/vat-corrections.ts, #190).
 */
export function noPaymentFor(ws: Pick<Workspace, 'paths'>): (books: Books) => (r: Receipt) => boolean {
  const providers = providersOf(ws);
  const counterparties = counterpartiesOf(ws);
  return (books) => {
    const page = noPaymentOf(books, providers);
    const corrections = vatCorrectionsOf(books, counterparties);
    return (r) => page(r) || corrections.has(r.id);
  };
}

/** The workspace's businesses in both layers; none when its knowledge does not load (a test's bare workspace). */
function counterpartiesOf(ws: Pick<Workspace, 'paths'>): Counterparty[] {
  try {
    return loadKnowledge(APP_ROOT, ws.paths.root).counterparties;
  } catch {
    return [];
  }
}

/** The bills of `books` that prove a VAT-only correction, by receipt id (src/booking/vat-corrections.ts, #190): Belege says what each is instead of a missing payment. */
export function vatCorrectionsIn(ws: Pick<Workspace, 'paths'>, books: Parameters<typeof vatCorrectionsOf>[0]): Record<string, VatCorrection> {
  return Object.fromEntries(vatCorrectionsOf(books, counterpartiesOf(ws)));
}

/** The order pages of the provider way nothing is linked to yet, by receipt id (src/booking/order-pages.ts, #253): Belege shows where each stands instead of a missing payment. */
export function orderPagesIn(ws: Pick<Workspace, 'paths'>, books: Parameters<typeof orderPagesOf>[0]): Record<string, OrderPage> {
  return Object.fromEntries(orderPagesOf(books, providersOf(ws)));
}

/** Amounts in the books' currency at the official daily rate of the day (the flat rate only where no daily rate is known: fine for a candidate's proximity, never for booking). */
export function estvToChf(fx: FxResolver = loadFxResolver()): ToChf {
  return (amount, currency, date) => {
    if (currency === baseCurrency()) return amount;
    const rate = fx.daily(currency, date) ?? fx.flat(currency);
    return rate === undefined ? undefined : amount * rate;
  };
}

/** The short facts of a receipt the model sees: vendor, day, amount, currency, its numbers; `own`: the firm's own invoice, paid by its customer. */
function receiptFacts(r: Receipt, own?: boolean): Record<string, unknown> {
  const named = r.title?.vendor ?? r.description;
  return { ...(own ? { own: true } : {}), vendor: named ?? r.filename, ...(named ? {} : { text: (r.extractedText ?? '').replace(/\s+/g, ' ').slice(0, 160) }), what: r.title?.what, date: r.date, amount: r.amount, currency: r.currency || baseCurrency(), numbers: numbersIn(r.extractedText ?? '').slice(0, 4) };
}

/** The short facts of a payment the model sees: its text, day, amount, currency and way. */
function paymentFacts(t: BankTransaction): Record<string, unknown> {
  const said = [t.counterparty, t.description, t.reference].filter((x): x is string => !!x);
  // A part of a collective payment names its payee and reference in its text too: each once.
  const text = said.filter((x, i) => !said.some((y, j) => j !== i && y.includes(x) && (y.length > x.length || j < i))).join(' · ').slice(0, 160);
  return { text, date: t.date, amount: Math.abs(t.amount), currency: t.currency, way: t.direction === 'CRDT' ? 'in' : 'out' };
}

export function checkPrompt(pairs: ReadonlyArray<{ r: Receipt; t: BankTransaction; own?: boolean }>): string {
  const list = pairs.map((p, i) => ({ i, receipt: receiptFacts(p.r, p.own), payment: paymentFacts(p.t) }));
  return `Each item pairs a receipt with a bank payment that has the same amount (across currencies: within a few percent at the official rate) and a near date. Decide for each whether the payment is what paid this receipt: the payment's text should name the receipt's vendor, its card acquirer or its payment provider, or carry one of its numbers. A different shop, a refund against a purchase, or a vendor the text contradicts does not fit. A receipt with "own":true is the company's own invoice to a customer: money in pays it, its "vendor" is the company itself, and the payment names the customer or the invoice's number, never that vendor.

${JSON.stringify(list)}

Answer ONLY a JSON array, one object per item: [{"i":0,"fits":true,"why":"text names the vendor"}]. Keep "why" under 10 words.`;
}

export function choosePrompt(items: ReadonlyArray<{ r: Receipt; candidates: BankTransaction[]; own?: boolean }>): string {
  const list = items.map((x, i) => ({ i, receipt: receiptFacts(x.r, x.own), payments: x.candidates.map((t, k) => ({ k, ...paymentFacts(t) })) }));
  return `Each item is a receipt and the bank payments that could have paid it (amount and date fit). Choose the payment that paid it, by its text naming the vendor, a card acquirer or payment provider of the vendor, or one of the receipt's numbers, then by the date. Choose none when nothing points to one of them. A receipt with "own":true is the company's own invoice to a customer: money in pays it, and the payment names the customer or the invoice's number, never the company.

${JSON.stringify(list)}

Answer ONLY a JSON array, one object per item: [{"i":0,"k":1,"confidence":0.9}] with "k": null when none fits. Confidence 0.8 or more only when the text points to that payment and to no other.`;
}

/** The JSON array of an answer, or undefined. */
function arrayOf(raw: string): unknown[] | undefined {
  const text = raw.replace(/```(?:json)?/g, '').trim();
  for (const s of [text, text.match(/\[[\s\S]*\]/)?.[0]]) {
    if (!s) continue;
    try { const v = JSON.parse(s); if (Array.isArray(v)) return v; } catch { /* the next form */ }
  }
  return undefined;
}

export const parseCheck = (raw: string): Map<number, boolean> =>
  new Map((arrayOf(raw) ?? []).flatMap((x) => { const o = x as { i?: unknown; fits?: unknown }; return typeof o.i === 'number' && typeof o.fits === 'boolean' ? [[o.i, o.fits] as const] : []; }));

export const parseChoice = (raw: string): Map<number, { k: number | null; confidence: number }> =>
  new Map((arrayOf(raw) ?? []).flatMap((x) => {
    const o = x as { i?: unknown; k?: unknown; confidence?: unknown };
    return typeof o.i === 'number' && (o.k === null || typeof o.k === 'number') ? [[o.i, { k: o.k as number | null, confidence: typeof o.confidence === 'number' ? o.confidence : 0 }] as const] : [];
  }));

const chunks = <T>(list: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/**
 * Runs the chain over the books `port` holds and writes its links (and the model's doubts) in one
 * change. The change re-checks every link on the books as they are then: a receipt or payment
 * linked meanwhile, by a person or another run, is left as it is.
 */
export async function runPairChain(port: BooksPort, opts: ChainOptions): Promise<ChainResult> {
  const log = opts.log ?? (() => {});
  const stored = port.read();
  const stagedIds = new Set((opts.staged ?? []).map((r) => r.id));
  const books = stagedIds.size ? { ...stored, receipts: [...stored.receipts.filter((r) => !stagedIds.has(r.id)), ...opts.staged!] } : stored;
  const lock = periodLock(books);
  const search = searchPairs(books, opts.toChf, lock.isClosed, { noReceipt: opts.noReceipt?.(books), noPayment: opts.noPayment?.(books), businesses: opts.businesses, delays: delaysOf(books, opts.businesses), firm: opts.firm });
  // «Beleg suchen» on a leg of a split charge searches for the charge, which its first movement names.
  const onlyTx = opts.only && 'payment' in opts.only ? books.transactions.find((t) => t.ref === (opts.only as { payment: string }).payment) : undefined;
  const only = onlyTx ? { payment: chargesOf(books.transactions, opts.toChf).of(onlyTx).refs[0] } : opts.only;
  const stages = stagesOf(search, only);
  const receipt = new Map(books.receipts.map((r) => [r.id, r]));
  const byLeg = new Map(books.transactions.map((t) => [legOf(t), t]));
  // What the model is shown of a candidate: its payment, or the part of a collective payment it pays.
  const payment = { get: (c: PairCandidate): BankTransaction | undefined => { const t = byLeg.get(c.leg); return t && c.part !== undefined ? partPayment(t, t.parts![c.part]) : t; } };
  const doubted = (c: PairCandidate) => !opts.only && !!receipt.get(c.receipt)?.pairDoubted?.includes(c.payment);
  const result: ChainResult = { linked: [], left: [], staged: [], calls: 0, checked: 0, chosen: 0 };
  const links: Array<{ c: PairCandidate; by: Maker }> = [];
  const doubts: PairCandidate[] = [];
  const toPerson = (s: Extract<PairStage, { kind: 'short' | 'person' }>) => result.left.push({ receipt: s.receipt, candidates: s.candidates, total: s.kind === 'person' ? s.total : s.candidates.length });

  const clear = stages.flatMap((s) => (s.kind === 'clear' && !doubted(s.pair) ? [s.pair] : []));
  const shortLists = stages.filter((s): s is Extract<PairStage, { kind: 'short' }> => s.kind === 'short');
  for (const s of stages) if (s.kind === 'person' || (s.kind === 'clear' && doubted(s.pair))) toPerson(s.kind === 'clear' ? { kind: 'short', receipt: s.pair.receipt, candidates: [s.pair] } : s);

  const ask = opts.ask;
  const failed = (why: string) => {
    result.modelFailed = why.slice(0, 300);
    log(`the model could not be asked or read (${result.modelFailed}): clear pairs are linked by code, the rest waits for a person`);
  };
  /** The model's answers by item, or undefined when it could not be asked or its answer holds no item at all (failed: nothing is recorded). */
  const call = async <T>(prompt: string, detail: 'check' | 'choose', parse: (raw: string) => Map<number, T>): Promise<Map<number, T> | undefined> => {
    if (!ask || result.modelFailed) return undefined;
    result.calls++;
    try {
      const answers = parse(await ask(prompt, { step: 'receipt-pair', detail, timeoutMs: 120_000 }));
      if (answers.size) return answers;
      failed('no item in the answer');
    } catch (e) {
      failed(String(e instanceof Error ? e.message : e));
    }
    return undefined;
  };

  // Without a model's check, an amount and a day alone are no proof: code links only a pair that also names the vendor (by its words or its business's file), carries a number or the bank's original amount.
  const byCodeAlone = (c: PairCandidate) => {
    if (c.number || c.words > 0 || c.business || c.amount === 'original') links.push({ c, by: 'code' });
    else { const list = search.byReceipt.get(c.receipt) ?? [c]; result.left.push({ receipt: c.receipt, candidates: list.slice(0, SHORT_LIST), total: list.length }); }
  };

  // Stage 2: the model checks the clear pairs; without one (or when it fails) code links those it may link alone.
  const choose: Array<{ receipt: string; candidates: PairCandidate[] }> = [];
  for (const batch of chunks(clear, CHECK_BATCH)) {
    const verdict = await call(checkPrompt(batch.map((c) => ({ r: receipt.get(c.receipt)!, t: payment.get(c)!, own: !!c.against }))), 'check', parseCheck);
    if (verdict === undefined) { for (const c of batch) byCodeAlone(c); continue; }
    result.checked += batch.length;
    batch.forEach((c, i) => {
      const fits = verdict.get(i);
      if (fits === true) { links.push({ c, by: 'checked' }); return; }
      // An item the answer left out is no verdict: code links it, as without a model.
      if (fits === undefined) { byCodeAlone(c); return; }
      doubts.push(c);
      const rest = (search.byReceipt.get(c.receipt) ?? []).filter((x) => x !== c && !doubted(x));
      if (rest.length && !stagedIds.has(c.receipt)) choose.push({ receipt: c.receipt, candidates: rest });
      else if (rest.length) result.left.push({ receipt: c.receipt, candidates: rest, total: rest.length });
      else result.left.push({ receipt: c.receipt, candidates: [c], total: 1 });
    });
  }

  // Stage 3: the model chooses from each short list; without one, the short lists are the person's.
  for (const s of shortLists) {
    const open = s.candidates.filter((c) => !doubted(c));
    if (open.length && ask && !result.modelFailed && !stagedIds.has(s.receipt)) choose.push({ receipt: s.receipt, candidates: open });
    else toPerson(s);
  }
  for (const batch of chunks(choose, CHOOSE_BATCH)) {
    const answers = await call(choosePrompt(batch.map((x) => ({ r: receipt.get(x.receipt)!, candidates: x.candidates.map((c) => payment.get(c)!), own: x.candidates.some((c) => !!c.against) }))), 'choose', parseChoice);
    if (answers === undefined) { for (const x of batch) result.left.push({ receipt: x.receipt, candidates: x.candidates, total: x.candidates.length }); continue; }
    result.chosen += batch.length;
    batch.forEach((x, i) => {
      const a = answers.get(i);
      const c = a && a.k !== null && a.confidence >= SURE ? x.candidates[a.k] : undefined;
      if (c) { links.push({ c, by: 'model' }); return; }
      // Only an answer is a doubt: an item left out, or a choice outside the list, is asked again next time.
      if (a && (a.k === null || x.candidates[a.k])) doubts.push(...x.candidates);
      result.left.push({ receipt: x.receipt, candidates: x.candidates, total: x.candidates.length });
    });
  }

  // Near pairs code may link (#397): the number named with a rounding or a stated discount, or the supplier with the exact amount within its terms; never past a link of this run or a candidate of the chain's own.
  const sure = sureNearPairs(books, search, links.map((l) => l.c), doubts, lock.isClosed, opts, only);
  if (sure.length) {
    links.push(...sure.map((c) => ({ c, by: 'code' as const })));
    const done = new Set(sure.map((c) => c.receipt));
    result.left = result.left.filter((l) => !done.has(l.receipt));
  }

  // «Beleg suchen» links only its own payment: what the model chose for its candidate receipts elsewhere waits for their own run.
  const asked = only && 'payment' in only ? links.filter((l) => l.c.payment === only.payment) : links;
  // A payment (or a collective payment's part) two receipts were linked to in this run goes to neither: the person decides.
  const times = new Map<string, number>();
  for (const { c } of asked) times.set(slotOf(c), (times.get(slotOf(c)) ?? 0) + 1);
  const mine = asked.filter((l) => times.get(slotOf(l.c)) === 1);
  result.staged = mine.filter((l) => stagedIds.has(l.c.receipt)).map(({ c, by }) => ({ receipt: c.receipt, payment: c.payment, by, signals: signalsOfCandidate(c), ...(c.filed ? { filed: true as const } : {}), ...legsOf(c), ...(c.replaces ? { replaced: c.replaces } : {}) }));
  result.linked = port.update((index: Books) => applyLinks(index, mine.filter((l) => !stagedIds.has(l.c.receipt)), doubts, opts.noReceipt?.(index)));
  const leftStored = result.left.filter((l) => !stagedIds.has(l.receipt));
  const cut = leftStored.filter((l) => l.total > l.candidates.length);
  if (cut.length) log(`${cut.length} receipt(s) have more than ${SHORT_LIST} candidate payments: only the best ${SHORT_LIST} of each are offered to the person`);
  if (leftStored.length) log(`${leftStored.length} receipt(s) left for the person, with the code's candidates`);
  for (const l of result.linked) {
    const how = l.by === 'code' ? 'by code' : l.by === 'checked' ? 'by code, checked by the model' : 'by the model from the short list';
    log(l.filed ? `pays the filed payment ${l.payment} (${how}): receipt ${l.receipt}, not linked` : `linked ${how}: receipt ${l.receipt} → ${l.payment}${l.replaced ? ` in place of receipt ${l.replaced}, a whole period off the payment's day` : ''}`);
  }
  return result;
}

/**
 * The near pairs code links (src/intake/near-pairs.ts), as candidates of the chain: those marked
 * sure, not doubted by the model in this run, whose receipt and payment no link of this run takes and the chain's own search offers
 * nothing else for (no other payment for the receipt, no other receipt for the payment), of one
 * movement (no charge split across balances, no collective payment). With `only`, those of it.
 */
function sureNearPairs(books: Books, search: ReturnType<typeof searchPairs>, linking: readonly PairCandidate[], doubted: readonly PairCandidate[], isClosed: (date: string) => boolean, opts: ChainOptions, only?: { receipt: string } | { payment: string }): PairCandidate[] {
  const charges = chargesOf(books.transactions, opts.toChf);
  const byRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const busyReceipts = new Set(linking.map((c) => c.receipt));
  const busyPayments = new Set(linking.flatMap((c) => c.charge));
  const near = nearPairs(books, { isClosed, firm: opts.firm, businesses: opts.businesses, noReceipt: opts.noReceipt?.(books), noPayment: opts.noPayment?.(books) });
  return near.flatMap((p: NearPair): PairCandidate[] => {
    const t = byRef.get(p.payment);
    if (!p.sure || !t || doubted.some((d) => d.receipt === p.receipt && d.payment === p.payment) || busyReceipts.has(p.receipt) || busyPayments.has(p.payment) || partsOf(t) || charges.of(t).refs.length > 1) return [];
    if (only && ('receipt' in only ? only.receipt !== p.receipt : only.payment !== p.payment)) return [];
    if ((search.byReceipt.get(p.receipt) ?? []).some((c) => c.payment !== p.payment) || (search.byPayment.get(p.payment) ?? []).some((c) => c.receipt !== p.receipt)) return [];
    const days = p.days ?? 0;
    return [{ receipt: p.receipt, payment: p.payment, leg: legOf(t), charge: [t.ref], filed: false, score: 0, amount: 'same', number: !!p.number, words: 0, business: p.supplier, days, offDays: days,
      near: p.sure, ...(p.gap.kind === 'rounded' || p.gap.kind === 'discount' ? { gap: p.gap.kind } : {}) }];
  });
}

/**
 * Takes the chain's link of receipt `old` off the payment's movements `refs`, for a receipt that fits
 * the payment's day where `old` lies a whole period off (#291), while that link is still the
 * chain's alone and every booking of the payment the app's own. The classify step then books the
 * payment again with the new receipt (src/accounting/classify-force.ts entriesWithoutTheirReceipts).
 * False, and nothing changed, when not.
 */
export function takeOver(index: Pick<Books, 'mappings' | 'journalEntries'>, refs: readonly string[], old: string): boolean {
  const theirs = index.mappings.filter((m) => refs.includes(m.transactionRef) || m.receiptId === old);
  if (!theirs.length || theirs.some((m) => m.receiptId !== old || !refs.includes(m.transactionRef) || !chainMade(m))) return false;
  if (index.journalEntries.some((e) => refs.includes(e.transactionRef) && !appBooked(e))) return false;
  index.mappings = index.mappings.filter((m) => !theirs.includes(m));
  return true;
}

/** The legs a link names beside its payment: only for a charge split across balances. */
const legsOf = (c: PairCandidate): { legs?: string[] } => (c.charge.length > 1 ? { legs: c.charge } : {});

/**
 * Writes the chain's links on the books as they are now: a pair whose receipt or payment is no
 * longer free (linked, or a filed payment another receipt points at) is left out. A filed
 * payment's receipt names it (filedPayment) instead of a link. The model's doubts are kept on the receipt.
 */
function applyLinks(index: Books, links: ReadonlyArray<{ c: PairCandidate; by: Maker }>, doubts: readonly PairCandidate[], noReceipt?: (t: BankTransaction) => boolean): ChainResult['linked'] {
  const lock = periodLock(index);
  const linkedReceipts = new Set(index.mappings.map((m) => m.receiptId));
  const linkedPayments = takenPayments(index);
  const done: ChainResult['linked'] = [];
  for (const { c, by } of links) {
    const r = index.receipts.find((x) => x.id === c.receipt);
    // Every movement of the charge: the leg that fit, and the other legs of a charge split across balances.
    const legs = c.charge.length > 1 ? c.charge.map((ref) => index.transactions.find((x) => x.ref === ref)) : [index.transactions.find((x) => legOf(x) === c.leg)];
    const t = legs[0];
    // A link taken over (#291): its payment counts as free while the rest is checked, and is freed only once all of it holds.
    const taken = c.replaces ? new Set([...linkedPayments].filter((ref) => !c.charge.includes(ref))) : linkedPayments;
    if (!r || !t || legs.some((x) => !x || !pairablePayment(x, taken, noReceipt) || r.notPaidBy?.includes(x.ref)) || !pairableReceipt(r, linkedReceipts)) continue;
    // A collective payment takes a receipt while a part of its amount is free.
    if (!c.replaces && !freeFor(index, t, r)) continue;
    if (c.replaces && (lock.isClosed(t.date) || !takeOver(index, c.charge, c.replaces))) continue;
    const signals = signalsOfCandidate(c);
    linkedReceipts.add(r.id);
    // A collective payment's other parts stay free: freeFor asks the links themselves.
    if (c.part === undefined) for (const ref of c.charge) linkedPayments.add(ref);
    if (lock.isClosed(t.date)) {
      r.filedPayment = t.ref;
      done.push({ receipt: r.id, payment: t.ref, by, signals, filed: true, ...legsOf(c) });
      continue;
    }
    for (const ref of c.charge) index.mappings.push(pairMapping(by, ref, r.id, signals));
    done.push({ receipt: r.id, payment: t.ref, by, signals, ...legsOf(c), ...(c.replaces ? { replaced: c.replaces } : {}) });
  }
  for (const c of doubts) {
    const r = index.receipts.find((x) => x.id === c.receipt);
    if (r && !r.pairDoubted?.includes(c.payment)) r.pairDoubted = [...(r.pairDoubted ?? []), c.payment];
  }
  return done;
}
