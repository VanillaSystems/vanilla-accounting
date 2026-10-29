/**
 * npm run eval:pairing -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * The matching chain (#187) measured on a workspace's own links, blinded: every link whose payment
 * lies between --from and --to (default: the whole year) is taken away in memory, the chain runs
 * on what is left, and its links are compared with the ones taken away. Prints counts per stage,
 * never a name, an amount or a ref, so its output says how well the chain does without saying
 * whose books it read. Reads the workspace (VANILLA_WORKSPACE); never writes it.
 *
 * Two runs: the code alone (no model: what an owner without a subscription gets), and the code
 * with an oracle in the model's place, which answers every check and choice as the books do: the
 * best the model stages can do, and what their prompts cost (tokens estimated at 4 characters
 * each). «Before» is the intake's own match prompt for the same receipts, which stays.
 *
 * Multi-receipt payments (#190): after the code-alone chain, the match step's set search (with the
 * batch payers of the business files) and the legs of split card charges run too, and the payments
 * the books link several receipts to are counted as found in full, in part, wrong or missed. A payment
 * provider's payout is out of matching (#203): it is left out of the counts and named on its own line.
 */
import { pathToFileURL } from 'node:url';
import { loadBooks, type Books } from '../../src/books/store.js';
import { openWorkspace } from '../../src/workspace/workspace.js';
import { runPairChain, estvToChf, noReceiptFor, CHECK_BATCH, CHOOSE_BATCH, type ChainResult } from '../../src/intake/pair-chain.js';
import { candidates, provisional } from '../../src/intake/match.js';
import { titlesPrompt } from '../../src/intake/titles.js';
import { buildMatchPrompt } from '../../src/llm/prompts.js';
import type { Ask, BooksPort } from '../../src/intake/pipeline.js';
import type { Mapping } from '../../src/types/index.js';
import { paysIn, searchPairs, type PairCandidate, type ToChf } from '../../src/intake/pairing.js';
import { duplicatesIn } from '../../src/intake/duplicates.js';
import { documents } from '../../src/engines/index.js';
import { linkReceiptSets, linkSplitLegs } from '../../src/intake/receipt-sets.js';
import { chargesOf } from '../../src/intake/charges.js';
import { batchPayersOf } from '../../src/intake/match.js';
import { businesses, type Businesses } from '../../src/intake/batch-payers.js';
import { namesToLearn } from '../../src/knowledge/learned-names.js';
import { delaysOf } from '../../src/intake/delays.js';
import { providerOfPayment } from '../../src/booking/providers.js';
import { loadKnowledge } from '../../src/knowledge/layers.js';
import { APP_ROOT } from '../../src/workspace/workspace.js';
import type { BankTransaction } from '../../src/types/index.js';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

/** The books with every link of the window taken away, and the receipts' traces of them (late receipt, doubts, a person's unlink). */
export function blinded(books: Books, from: string, to: string): { books: Books; truth: Mapping[] } {
  const date = new Map(books.transactions.map((t) => [t.ref, t.date]));
  const inWindow = (m: Mapping) => { const d = date.get(m.transactionRef); return !!d && d >= from && d <= to; };
  const truth = books.mappings.filter(inWindow);
  const touched = new Set(truth.map((m) => m.receiptId));
  const copy = structuredClone(books);
  copy.mappings = copy.mappings.filter((m) => !inWindow(m));
  for (const r of copy.receipts) if (touched.has(r.id) || (r.filedPayment && (date.get(r.filedPayment) ?? '') >= from)) { delete r.filedPayment; delete r.pairDoubted; delete r.notPaidBy; }
  // Blinded books link as if nothing were filed: the eval compares pairs, not where a pair goes.
  copy.config = { ...copy.config, closedThrough: undefined, approvedReturn: undefined };
  return { books: copy, truth };
}

const memoryPort = (books: Books): BooksPort => ({ read: () => books, update: (fn) => fn(books) });

/** A model that answers as the books do, and counts what it was asked. */
function oracle(truth: ReadonlySet<string>, books: Books): { ask: Ask; usage: { calls: number; promptChars: number; answerChars: number } } {
  const usage = { calls: 0, promptChars: 0, answerChars: 0 };
  const byFacts = (o: { vendor: unknown; date: unknown; amount: unknown }) => books.receipts.filter((r) => (r.title?.vendor ?? r.description ?? r.filename) === o.vendor && r.date === o.date && r.amount === o.amount);
  const payOf = (p: { text: string; date: string; amount: number }) => books.transactions.filter((t) => t.date === p.date && Math.abs(t.amount) === p.amount && p.text.includes(t.description.slice(0, 40)));
  const fits = (rs: ReturnType<typeof byFacts>, ps: ReturnType<typeof payOf>) => rs.some((r) => ps.some((t) => truth.has(`${r.id}|${t.ref}`)));
  const ask: Ask = async (prompt, opts) => {
    usage.calls++;
    usage.promptChars += prompt.length;
    const list = JSON.parse(prompt.slice(prompt.indexOf('\n\n[') + 2, prompt.lastIndexOf(']\n\n') + 1)) as Array<{ i: number; receipt: { vendor: unknown; date: unknown; amount: unknown }; payment?: { text: string; date: string; amount: number }; payments?: Array<{ k: number; text: string; date: string; amount: number }> }>;
    const answer = opts.detail === 'check'
      ? list.map((x) => ({ i: x.i, fits: fits(byFacts(x.receipt), payOf(x.payment!)), why: 'oracle' }))
      : list.map((x) => { const k = x.payments!.find((p) => fits(byFacts(x.receipt), payOf(p)))?.k ?? null; return { i: x.i, k, confidence: k === null ? 0 : 0.95 }; });
    const text = JSON.stringify(answer);
    usage.answerChars += text.length;
    return text;
  };
  return { ask, usage };
}

interface Tally { oneToOneRight: number; linkedRight: number; linkedWrong: number; linkedNew: number; leftWithRight: number; leftWithout: number; notSearched: number; byMaker: Record<string, { right: number; wrong: number }> }

/** The chain's result against the links taken away: per receipt linked one to one in the books. */
function tally(result: ChainResult, truth: readonly Mapping[], books: Books): Tally {
  const pairs = new Set(truth.map((m) => `${m.receiptId}|${m.transactionRef}`));
  const linkedAnyway = new Set(truth.flatMap((m) => [m.receiptId, m.transactionRef]));
  const t: Tally = { oneToOneRight: 0, linkedRight: 0, linkedWrong: 0, linkedNew: 0, leftWithRight: 0, leftWithout: 0, notSearched: 0, byMaker: {} };
  for (const l of result.linked) {
    const k = pairs.has(`${l.receipt}|${l.payment}`) ? 'right' : linkedAnyway.has(l.receipt) || linkedAnyway.has(l.payment) ? 'wrong' : 'new';
    if (k === 'right') t.linkedRight++; else if (k === 'wrong') t.linkedWrong++; else t.linkedNew++;
    const m = (t.byMaker[`${l.by}${l.signals.includes('name') || l.signals.includes('number') ? '' : ' (amount and day only)'}`] ??= { right: 0, wrong: 0 });
    if (k === 'right') m.right++; else if (k === 'wrong') m.wrong++;
  }
  const once = (list: readonly Mapping[], key: 'receiptId' | 'transactionRef') => { const n = new Map<string, number>(); for (const m of books.mappings) n.set(m[key], (n.get(m[key]) ?? 0) + 1); return list.filter((m) => n.get(m[key]) === 1); };
  const oneToOne = once(once(truth, 'receiptId'), 'transactionRef');
  const left = new Map(result.left.map((x) => [x.receipt, x]));
  const linked = new Set(result.linked.map((l) => l.receipt));
  for (const m of oneToOne) {
    if (result.linked.some((l) => l.receipt === m.receiptId && l.payment === m.transactionRef)) { t.oneToOneRight++; continue; }
    if (linked.has(m.receiptId)) continue;
    const l = left.get(m.receiptId);
    if (!l) t.notSearched++;
    else if (l.candidates.some((c) => c.payment === m.transactionRef)) t.leftWithRight++;
    else t.leftWithout++;
  }
  return t;
}

export async function main(): Promise<void> {
  const ws = openWorkspace();
  const books = loadBooks(ws);
  const year = books.transactions.map((t) => t.date).sort()[0]?.slice(0, 4) ?? '';
  const from = arg('from') ?? `${year}-01-01`;
  const to = arg('to') ?? `${year}-12-31`;
  const toChf = estvToChf();
  const { books: blind, truth } = blinded(books, from, to);
  const pairs = new Set(truth.map((m) => `${m.receiptId}|${m.transactionRef}`));
  const oneToOne = truth.filter((m) => books.mappings.filter((x) => x.receiptId === m.receiptId).length === 1 && books.mappings.filter((x) => x.transactionRef === m.transactionRef).length === 1).length;

  const noReceipt = noReceiptFor(ws);
  // The names the links outside the window teach (#190 part 1), as the app would have written them into the company's files: in memory only.
  const counterparties = loadKnowledge(APP_ROOT, ws.paths.root).counterparties;
  const taught = namesToLearn(blind, counterparties, ws.company.uid);
  const known = businesses(counterparties.map((c) => { const add = taught.filter((l) => l.business === c.id).map((l) => l.name); return add.length ? { ...c, match: { ...c.match, tx: [...c.match.tx, ...add] } } : c; }), ws.company.uid);
  const afterCode = structuredClone(blind);
  const code = await runPairChain(memoryPort(afterCode), { toChf, noReceipt, businesses: known });
  const o = oracle(pairs, blind);
  const withModel = await runPairChain(memoryPort(structuredClone(blind)), { toChf, ask: o.ask, noReceipt, businesses: known });

  // Before: the intake's match prompt of each receipt of the window (candidates as the intake ranks them), which the chain does not replace.
  const linked = new Set(blind.mappings.map((m) => m.transactionRef));
  const inWindow = blind.receipts.filter((r) => truth.some((m) => m.receiptId === r.id));
  const intakeChars = inWindow.reduce((sum, r) => sum + buildMatchPrompt(r.extractedText, []).length + JSON.stringify(candidates(r, blind.transactions, linked), null, 2).length, 0);

  const line = (name: string, r: ChainResult, t: Tally) => console.log(`${name.padEnd(18)} linked ${String(r.linked.length).padStart(4)}  right ${String(t.linkedRight).padStart(4)}  wrong ${String(t.linkedWrong).padStart(3)}  new ${String(t.linkedNew).padStart(3)}  | of ${oneToOne} one-to-one: left with the right candidate ${t.leftWithRight}, left without ${t.leftWithout}, not searched ${t.notSearched}  | ${Object.entries(t.byMaker).map(([k, v]) => `${k} ${v.right}/${v.right + v.wrong}`).join(', ')}`);
  console.log(`window ${from} – ${to}: ${truth.length} links taken away, ${oneToOne} of them one receipt to one payment; ${taught.length} merchant name(s) of ${new Set(taught.map((l) => l.business)).size} business(es) learned from the links outside it`);
  const tc = tally(code, truth, books);
  const tm = tally(withModel, truth, books);
  line('code alone', code, tc);
  line('code + oracle', withModel, tm);
  // --detail: what spoke for each wrong code link, and for the right one (features only: no name, amount or ref).
  if (process.argv.includes('--detail')) {
    const search = searchPairs(blind, toChf, () => false, { businesses: known, delays: delaysOf(blind, known) });
    for (const l of code.linked.filter((x) => !pairs.has(`${x.receipt}|${x.payment}`))) {
      const list = search.byReceipt.get(l.receipt) ?? [];
      const right = truth.find((m) => m.receiptId === l.receipt);
      const show = (c?: PairCandidate) => (c ? `${c.score}pt ${c.amount} ${c.days}d words ${c.words}${c.number ? ' number' : ''}` : 'none');
      const rt = right && blind.transactions.find((x) => x.ref === right.transactionRef);
      const why = rt ? `${rt.noReceiptNeeded ? 'marked ' : ''}${noReceipt(blind)(rt) ? 'no receipt of its own (' + blind.journalEntries.filter((e) => e.transactionRef === rt.ref).map((e) => `${e.accountDebit}/${e.accountCredit}`).join(' ') + ')' : ''}` : '';
      console.log(`wrong: ${why} chose ${show(list.find((c) => c.payment === l.payment))}; the books' payment ${right ? show(list.find((c) => c.payment === right.transactionRef)) ?? 'not a candidate' : 'none'}; ${list.length} candidates; the payment's own receipts in the books: ${truth.filter((m) => m.transactionRef === l.payment).map((m) => { const a = blind.receipts.find((r) => r.id === m.receiptId); const b = blind.receipts.find((r) => r.id === l.receipt); return a && b ? (a.amount === b.amount && a.date === b.date ? 'same amount and day' : a.amount === b.amount ? 'same amount' : 'other amount') : '?'; }).join(', ')}`);
    }
  }
  if (process.argv.includes('--detail')) {
    const why: Record<string, number> = {};
    const left = new Map(code.left.map((x) => [x.receipt, x]));
    for (const m of truth) {
      const l = left.get(m.receiptId);
      if (!l || l.candidates.some((c) => c.payment === m.transactionRef) || books.mappings.filter((x) => x.receiptId === m.receiptId || x.transactionRef === m.transactionRef).length !== 2) continue;
      const r = blind.receipts.find((x) => x.id === m.receiptId)!;
      const t = blind.transactions.find((x) => x.ref === m.transactionRef)!;
      const days = Math.round((Date.parse(t.date) - Date.parse(r.date!)) / 864e5);
      const ratio = Math.abs(t.amount) / Math.abs(r.amount!);
      const k = [`way ${paysIn(r) === (t.direction === 'CRDT') ? 'ok' : `wrong (receipt ${paysIn(r) ? 'in' : 'out'}${(r.amount ?? 0) < 0 ? ', negative' : ''})`}`, days < -10 ? 'early' : days > 60 ? 'late' : 'days ok', (r.currency || 'CHF') === t.currency ? (Math.abs(ratio - 1) < 0.001 ? 'same' : `same currency ${ratio < 1 ? 'less' : 'more'}`) : 'cross'].join(', ');
      why[k] = (why[k] ?? 0) + 1;
    }
    console.log('left without the right candidate:', JSON.stringify(why));
    const byWords = books.receipts.filter((r) => r.amount && r.amount > 0 && r.kind !== 'sales-record' && paysIn(r));
    const way = (r: { id: string }) => books.mappings.filter((m) => m.receiptId === r.id).map((m) => books.transactions.find((t) => t.ref === m.transactionRef)?.direction ?? '?');
    console.log(`credit notes by their title alone: ${byWords.length}, linked in the books to money in ${byWords.filter((r) => way(r).includes('CRDT')).length}, to money out ${byWords.filter((r) => way(r).includes('DBIT')).length}`);
  }
  const precision = (t: Tally) => (t.linkedRight + t.linkedWrong ? (t.linkedRight / (t.linkedRight + t.linkedWrong)).toFixed(3) : '-');
  console.log(`precision (links the books know): code ${precision(tc)}, code + oracle ${precision(tm)}; recall of one-to-one links: code ${(tc.oneToOneRight / Math.max(1, oneToOne)).toFixed(3)}, code + oracle ${(tm.oneToOneRight / Math.max(1, oneToOne)).toFixed(3)}`);
  // The match step's code after the chain: receipt sets (with the batch payers of the business files) and the legs of split card charges (#190).
  const isOpen = () => true;
  linkReceiptSets(afterCode, { isOpen, payers: batchPayersOf(ws), toChf, buyerUid: ws.company.uid });
  linkSplitLegs(afterCode, isOpen, toChf);
  const multi = multiTally(afterCode, truth, books, toChf, (t) => !!providerOfPayment(t, [], counterparties));
  const say = (t: MultiTally) => `${t.payments} in the window; code alone found ${t.full} in full, ${t.part} in part, ${t.wrong} with a document the books do not have there, missed ${t.missed}`;
  console.log(`multi-receipt payments (two documents or more, or one on every leg of a card charge split across balances; documents counted, copies once): ${say(multi.out)}`);
  console.log(`  left out: ${multi.payouts.payments} payout(s) of a payment provider with documents linked in the books (out of matching since #203: their documents prove the sales, not the payout)`);
  console.log(`model stages: ${o.usage.calls} calls (batches of ${CHECK_BATCH} checks, ${CHOOSE_BATCH} choices), ${withModel.checked} pairs checked, ${withModel.chosen} short lists; ~${Math.round(o.usage.promptChars / 4)} prompt and ~${Math.round(o.usage.answerChars / 4)} answer tokens (estimated, 4 characters each)`);
  console.log(`intake match prompts before #187 of the window's ${inWindow.length} receipts (read facts): ~${Math.round(intakeChars / 4)} prompt tokens (estimated; standard tier)`);
  await intake(blind, truth, toChf, noReceipt, known);
}

interface MultiTally { payments: number; full: number; part: number; wrong: number; missed: number }

/**
 * The payments of the window that hold several documents in the books, or one on several legs of
 * a split card charge, each counted once per charge, by documents, not links: only invoices count
 * (a sales record, a supporting document or a copy marked as such does not), two copies of one
 * invoice count once (duplicatesIn, on either side), a charge left with fewer than two documents on
 * its one movement is no multi-receipt payment, nor one whose first movement is a Wise fee row.
 * Whether code's links after the chain and the set search hold exactly the books' documents (in
 * full), some of them (in part), one the books link elsewhere or not at all (wrong), or none
 * (missed). A payment provider's payout (`payout`) is counted apart: it is out of matching (#203).
 */
function multiTally(after: Books, truth: readonly Mapping[], books: Books, toChf: ToChf, payout: (t: BankTransaction) => boolean): { out: MultiTally; payouts: MultiTally } {
  const charges = chargesOf(books.transactions, toChf);
  const receipt = new Map(books.receipts.map((r) => [r.id, r]));
  const invoice = (id: string) => { const r = receipt.get(id); return !!r && (!r.kind || r.kind === 'invoice'); };
  const byCharge = new Map<string, { charge: ReturnType<typeof charges.of>; receipts: Set<string> }>();
  for (const m of truth) {
    const tx = books.transactions.find((t) => t.ref === m.transactionRef);
    if (!tx) continue;
    const c = charges.of(tx);
    const e = byCharge.get(c.refs[0]) ?? { charge: c, receipts: new Set<string>() };
    e.receipts.add(m.receiptId);
    byCharge.set(c.refs[0], e);
  }
  const zero = (): MultiTally => ({ payments: 0, full: 0, part: 0, wrong: 0, missed: 0 });
  const out = zero();
  const payouts = zero();
  for (const { charge, receipts } of byCharge.values()) {
    const [first] = charge.legs;
    if (first.type === 'wise-fee') continue;
    const got = new Set(after.mappings.filter((m) => charge.refs.includes(m.transactionRef)).map((m) => m.receiptId));
    // One document per invoice: a copy (on either side) stands for its original.
    const docs = [...new Set([...receipts, ...got])].filter(invoice).map((id) => receipt.get(id)!);
    const twins = duplicatesIn(docs, receipts, documents());
    const doc = (id: string) => { const t = twins.get(id); return t?.relation === 'duplicate' ? t.of : id; };
    const want = new Set([...receipts].filter(invoice).map(doc));
    const have = new Set([...got].filter(invoice).map(doc));
    if (want.size < 2 && charge.refs.length < 2) continue;
    const t = charge.legs.some(payout) ? payouts : out;
    t.payments++;
    const right = [...have].filter((id) => want.has(id)).length;
    if (have.size > right) t.wrong++;
    else if (right === want.size && charge.refs.every((ref) => after.mappings.some((m) => m.transactionRef === ref))) t.full++;
    else if (right > 0) t.part++;
    else t.missed++;
  }
  return { out, payouts };
}

/**
 * The inbox as it was when the window's receipts came in: each one staged, with only what the read
 * and VAT steps leave (its text, its VAT block, its kind), none of the facts the model's match
 * writes. Before #187 each one cost a match prompt; now code pairs what it can first (with the
 * oracle checking), names those on the fast tier, and only the rest get a match prompt, with the
 * code's short list where there is one. Tokens estimated at 4 characters each; a file attached to
 * a match prompt (a scan with little text) is not counted on either side.
 */
async function intake(blind: Books, truth: readonly Mapping[], toChf: ReturnType<typeof estvToChf>, noReceipt: ReturnType<typeof noReceiptFor>, known: Businesses): Promise<void> {
  const ids = new Set(truth.map((m) => m.receiptId));
  const books = structuredClone(blind);
  for (const r of books.receipts) {
    if (!ids.has(r.id) || r.location !== 'archived' || r.needsVisionReview) continue;
    r.location = 'staged';
    for (const k of ['date', 'dateSource', 'amount', 'currency', 'title', 'description', 'payout', 'order'] as const) delete r[k];
  }
  const staged = books.receipts.filter((r) => r.location === 'staged');
  const early = staged.flatMap((r) => provisional(r) ?? []);
  const view: Books = { ...books, receipts: [...books.receipts.filter((r) => r.location !== 'staged'), ...early] };
  const pairs = new Set(truth.map((m) => `${m.receiptId}|${m.transactionRef}`));
  const o = oracle(pairs, view);
  const chain = await runPairChain(memoryPort(books), { toChf, ask: o.ask, staged: early, noReceipt, businesses: known });
  const linked = new Set(books.mappings.map((m) => m.transactionRef));
  const matchChars = (r: typeof staged[number], shown = candidates(r, books.transactions, linked)) => buildMatchPrompt(r.extractedText, shown).length;
  // Before #187 the prompt listed the 20 candidates as indented JSON with every field.
  const before = staged.reduce((sum, r) => sum + buildMatchPrompt(r.extractedText, []).length + JSON.stringify(candidates(r, books.transactions, linked), null, 2).length, 0);
  const paired = new Set(chain.staged.map((l) => l.receipt));
  const short = new Map(chain.left.filter((l) => l.candidates.length && l.total === l.candidates.length).map((l) => [l.receipt, l.candidates]));
  const rest = staged.filter((r) => !paired.has(r.id));
  const restChars = rest.reduce((sum, r) => {
    const list = short.get(r.id)?.flatMap((c) => books.transactions.filter((t) => t.ref === c.payment));
    return sum + matchChars(r, list?.length ? list : undefined);
  }, 0);
  const titleChars = paired.size ? titlesPrompt(early.filter((r) => paired.has(r.id))).length : 0;
  const right = chain.staged.filter((l) => pairs.has(`${l.receipt}|${l.payment}`)).length;
  console.log(`intake: ${staged.length} receipts staged, ${early.length} with a day and an amount code reads; code paired ${paired.size} before the model (right ${right}, wrong ${paired.size - right}), ${rest.length} go to the match prompt (${[...short.keys()].filter((id) => !paired.has(id)).length} with the code's short list)`);
  const k = (chars: number) => Math.round(chars / 4);
  console.log(`intake tokens (estimated): before ~${k(before)} match prompt (standard tier); after ~${k(restChars)} match prompt (standard) + ~${k(o.usage.promptChars + titleChars)} checks and titles (fast, ${o.usage.calls} check/choice calls + ${paired.size ? Math.ceil(paired.size / 100) : 0} title calls); standard-tier prompt tokens saved ~${k(before - restChars)} (${Math.round((100 * (before - restChars)) / Math.max(1, before))} %)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
