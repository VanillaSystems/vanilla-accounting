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
import { SHORT_LIST, pairMapping, pairablePayment, pairableReceipt, searchPairs, stagesOf, type Maker, type PairCandidate, type PairStage, type ToChf } from './pairing.js';

export type { Found, Maker } from './pairing.js';

/** Clear pairs per call of the model's check, receipts per call of its choice: every pair is asked, in as many calls as it takes. */
export const CHECK_BATCH = 20;
export const CHOOSE_BATCH = 10;
const SURE = 0.8;



/** What the chain did and left. `left`: the receipts that are the person's, each with the code's candidates (`total` of them before the cut to the short list). */
export interface ChainResult {
  linked: Array<{ receipt: string; payment: string; by: Maker; filed?: true }>;
  left: Array<{ receipt: string; candidates: PairCandidate[]; total: number }>;
  /** The clear pairs of `staged` receipts, for the caller to archive, name and link (filed: point at) in its own change. */
  staged: Array<{ receipt: string; payment: string; by: Maker; filed?: true }>;
  /** Model calls made, and the pairs and receipts they were asked about. */
  calls: number;
  checked: number;
  chosen: number;
  /** The model could not be asked (an error): the clear pairs were linked by code. */
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
}

/** Amounts in the books' currency at the official daily rate of the day (the flat rate only where no daily rate is known: fine for a candidate's proximity, never for booking). */
export function estvToChf(fx: FxResolver = loadFxResolver()): ToChf {
  return (amount, currency, date) => {
    if (currency === baseCurrency()) return amount;
    const rate = fx.daily(currency, date) ?? fx.flat(currency);
    return rate === undefined ? undefined : amount * rate;
  };
}

/** The short facts of a receipt the model sees: vendor, day, amount, currency, its numbers. */
function receiptFacts(r: Receipt): Record<string, unknown> {
  const named = r.title?.vendor ?? r.description;
  return { vendor: named ?? r.filename, ...(named ? {} : { text: (r.extractedText ?? '').replace(/\s+/g, ' ').slice(0, 160) }), what: r.title?.what, date: r.date, amount: r.amount, currency: r.currency || baseCurrency(), numbers: numbersIn(r.extractedText ?? '').slice(0, 4) };
}

/** The short facts of a payment the model sees: its text, day, amount, currency and way. */
function paymentFacts(t: BankTransaction): Record<string, unknown> {
  const text = [t.counterparty, t.description, t.reference].filter(Boolean).join(' · ').slice(0, 160);
  return { text, date: t.date, amount: Math.abs(t.amount), currency: t.currency, way: t.direction === 'CRDT' ? 'in' : 'out' };
}

export function checkPrompt(pairs: ReadonlyArray<{ r: Receipt; t: BankTransaction }>): string {
  const list = pairs.map((p, i) => ({ i, receipt: receiptFacts(p.r), payment: paymentFacts(p.t) }));
  return `Each item pairs a receipt with a bank payment that has the same amount (across currencies: within a few percent at the official rate) and a near date. Decide for each whether the payment is what paid this receipt: the payment's text should name the receipt's vendor, its card acquirer or its payment provider, or carry one of its numbers. A different shop, a refund against a purchase, or a vendor the text contradicts does not fit.

${JSON.stringify(list)}

Answer ONLY a JSON array, one object per item: [{"i":0,"fits":true,"why":"text names the vendor"}]. Keep "why" under 10 words.`;
}

export function choosePrompt(items: ReadonlyArray<{ r: Receipt; candidates: BankTransaction[] }>): string {
  const list = items.map((x, i) => ({ i, receipt: receiptFacts(x.r), payments: x.candidates.map((t, k) => ({ k, ...paymentFacts(t) })) }));
  return `Each item is a receipt and the bank payments that could have paid it (amount and date fit). Choose the payment that paid it, by its text naming the vendor, a card acquirer or payment provider of the vendor, or one of the receipt's numbers, then by the date. Choose none when nothing points to one of them.

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
  const search = searchPairs(books, opts.toChf, lock.isClosed);
  const stages = stagesOf(search, opts.only);
  const receipt = new Map(books.receipts.map((r) => [r.id, r]));
  const payment = new Map(books.transactions.map((t) => [t.ref, t]));
  const doubted = (c: PairCandidate) => !opts.only && !!receipt.get(c.receipt)?.pairDoubted?.includes(c.payment);
  const result: ChainResult = { linked: [], left: [], staged: [], calls: 0, checked: 0, chosen: 0 };
  const links: Array<{ c: PairCandidate; by: Maker }> = [];
  const doubts: PairCandidate[] = [];
  const toPerson = (s: Extract<PairStage, { kind: 'short' | 'person' }>) => result.left.push({ receipt: s.receipt, candidates: s.candidates, total: s.kind === 'person' ? s.total : s.candidates.length });

  const clear = stages.flatMap((s) => (s.kind === 'clear' && !doubted(s.pair) ? [s.pair] : []));
  const shortLists = stages.filter((s): s is Extract<PairStage, { kind: 'short' }> => s.kind === 'short');
  for (const s of stages) if (s.kind === 'person' || (s.kind === 'clear' && doubted(s.pair))) toPerson(s.kind === 'clear' ? { kind: 'short', receipt: s.pair.receipt, candidates: [s.pair] } : s);

  const ask = opts.ask;
  const call = async (prompt: string, detail: 'check' | 'choose'): Promise<string | undefined> => {
    if (!ask || result.modelFailed) return undefined;
    result.calls++;
    try {
      return await ask(prompt, { step: 'receipt-pair', detail, timeoutMs: 120_000 });
    } catch (e) {
      result.modelFailed = String(e instanceof Error ? e.message : e).slice(0, 300);
      log(`the model could not be asked (${result.modelFailed}): clear pairs are linked by code, the rest waits for a person`);
      return undefined;
    }
  };

  // Stage 2: the model checks the clear pairs; without one (or when it fails) code links them.
  const choose: Array<{ receipt: string; candidates: PairCandidate[] }> = [];
  for (const batch of chunks(clear, CHECK_BATCH)) {
    const raw = await call(checkPrompt(batch.map((c) => ({ r: receipt.get(c.receipt)!, t: payment.get(c.payment)! }))), 'check');
    if (raw === undefined) { for (const c of batch) links.push({ c, by: 'code' }); continue; }
    result.checked += batch.length;
    const verdict = parseCheck(raw);
    batch.forEach((c, i) => {
      if (verdict.get(i) === true) { links.push({ c, by: 'checked' }); return; }
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
    const raw = await call(choosePrompt(batch.map((x) => ({ r: receipt.get(x.receipt)!, candidates: x.candidates.map((c) => payment.get(c.payment)!) }))), 'choose');
    if (raw === undefined) { for (const x of batch) result.left.push({ receipt: x.receipt, candidates: x.candidates, total: x.candidates.length }); continue; }
    result.chosen += batch.length;
    const answers = parseChoice(raw);
    batch.forEach((x, i) => {
      const a = answers.get(i);
      const c = a && a.k !== null && a.confidence >= SURE ? x.candidates[a.k] : undefined;
      if (c) { links.push({ c, by: 'model' }); return; }
      doubts.push(...x.candidates);
      result.left.push({ receipt: x.receipt, candidates: x.candidates, total: x.candidates.length });
    });
  }

  // «Beleg suchen» links only its own payment: what the model chose for its candidate receipts elsewhere waits for their own run.
  const only = opts.only;
  const asked = only && 'payment' in only ? links.filter((l) => l.c.payment === only.payment) : links;
  // A payment two receipts were linked to in this run goes to neither: the person decides.
  const times = new Map<string, number>();
  for (const { c } of asked) times.set(c.payment, (times.get(c.payment) ?? 0) + 1);
  const mine = asked.filter((l) => times.get(l.c.payment) === 1);
  result.staged = mine.filter((l) => stagedIds.has(l.c.receipt)).map(({ c, by }) => ({ receipt: c.receipt, payment: c.payment, by, ...(c.filed ? { filed: true as const } : {}) }));
  result.linked = port.update((index: Books) => applyLinks(index, mine.filter((l) => !stagedIds.has(l.c.receipt)), doubts));
  const leftStored = result.left.filter((l) => !stagedIds.has(l.receipt));
  const cut = leftStored.filter((l) => l.total > l.candidates.length);
  if (cut.length) log(`${cut.length} receipt(s) have more than ${SHORT_LIST} candidate payments: only the best ${SHORT_LIST} of each are offered to the person`);
  if (leftStored.length) log(`${leftStored.length} receipt(s) left for the person, with the code's candidates`);
  for (const l of result.linked) {
    const how = l.by === 'code' ? 'by code' : l.by === 'checked' ? 'by code, checked by the model' : 'by the model from the short list';
    log(l.filed ? `pays the filed payment ${l.payment} (${how}): receipt ${l.receipt}, not linked` : `linked ${how}: receipt ${l.receipt} → ${l.payment}`);
  }
  return result;
}

/**
 * Writes the chain's links on the books as they are now: a pair whose receipt or payment is no
 * longer free is left out. A filed payment's receipt names it
 * (filedPayment) instead of a link. The model's doubts are kept on the receipt.
 */
function applyLinks(index: Books, links: ReadonlyArray<{ c: PairCandidate; by: Maker }>, doubts: readonly PairCandidate[]): ChainResult['linked'] {
  const lock = periodLock(index);
  const linkedReceipts = new Set(index.mappings.map((m) => m.receiptId));
  const linkedPayments = new Set(index.mappings.map((m) => m.transactionRef));
  const done: ChainResult['linked'] = [];
  for (const { c, by } of links) {
    const r = index.receipts.find((x) => x.id === c.receipt);
    const t = index.transactions.find((x) => x.ref === c.payment);
    if (!r || !t || !pairableReceipt(r, linkedReceipts) || !pairablePayment(t, linkedPayments) || r.notPaidBy?.includes(t.ref)) continue;
    if (lock.isClosed(t.date)) {
      r.filedPayment = t.ref;
      done.push({ receipt: r.id, payment: t.ref, by, filed: true });
      continue;
    }
    index.mappings.push(pairMapping(by, t.ref, r.id));
    linkedReceipts.add(r.id);
    linkedPayments.add(t.ref);
    done.push({ receipt: r.id, payment: t.ref, by });
  }
  for (const c of doubts) {
    const r = index.receipts.find((x) => x.id === c.receipt);
    if (r && !r.pairDoubted?.includes(c.payment)) r.pairDoubted = [...(r.pairDoubted ?? []), c.payment];
  }
  return done;
}
