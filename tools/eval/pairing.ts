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
 */
import { pathToFileURL } from 'node:url';
import { loadBooks, type Books } from '../../src/books/store.js';
import { openWorkspace } from '../../src/workspace/workspace.js';
import { runPairChain, estvToChf, CHECK_BATCH, CHOOSE_BATCH, type ChainResult } from '../../src/intake/pair-chain.js';
import { candidates } from '../../src/intake/match.js';
import { buildMatchPrompt } from '../../src/llm/prompts.js';
import type { Ask, BooksPort } from '../../src/intake/pipeline.js';
import type { Mapping } from '../../src/types/index.js';
import { paysIn, searchPairs, type PairCandidate } from '../../src/intake/pairing.js';

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
    const m = (t.byMaker[l.by] ??= { right: 0, wrong: 0 });
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

  const code = await runPairChain(memoryPort(structuredClone(blind)), { toChf });
  const o = oracle(pairs, blind);
  const withModel = await runPairChain(memoryPort(structuredClone(blind)), { toChf, ask: o.ask });

  // Before: the intake's match prompt of each receipt of the window (candidates as the intake ranks them), which the chain does not replace.
  const linked = new Set(blind.mappings.map((m) => m.transactionRef));
  const inWindow = blind.receipts.filter((r) => truth.some((m) => m.receiptId === r.id));
  const intakeChars = inWindow.reduce((sum, r) => sum + buildMatchPrompt(r.extractedText, candidates(r, blind.transactions, linked)).length, 0);

  const line = (name: string, r: ChainResult, t: Tally) => console.log(`${name.padEnd(18)} linked ${String(r.linked.length).padStart(4)}  right ${String(t.linkedRight).padStart(4)}  wrong ${String(t.linkedWrong).padStart(3)}  new ${String(t.linkedNew).padStart(3)}  | of ${oneToOne} one-to-one: left with the right candidate ${t.leftWithRight}, left without ${t.leftWithout}, not searched ${t.notSearched}  | ${Object.entries(t.byMaker).map(([k, v]) => `${k} ${v.right}/${v.right + v.wrong}`).join(', ')}`);
  console.log(`window ${from} – ${to}: ${truth.length} links taken away, ${oneToOne} of them one receipt to one payment`);
  const tc = tally(code, truth, books);
  const tm = tally(withModel, truth, books);
  line('code alone', code, tc);
  line('code + oracle', withModel, tm);
  // --detail: what spoke for each wrong code link, and for the right one (features only: no name, amount or ref).
  if (process.argv.includes('--detail')) {
    const search = searchPairs(blind, toChf, () => false);
    for (const l of code.linked.filter((x) => !pairs.has(`${x.receipt}|${x.payment}`))) {
      const list = search.byReceipt.get(l.receipt) ?? [];
      const right = truth.find((m) => m.receiptId === l.receipt);
      const show = (c?: PairCandidate) => (c ? `${c.score}pt ${c.amount} ${c.days}d words ${c.words}${c.number ? ' number' : ''}` : 'none');
      console.log(`wrong: chose ${show(list.find((c) => c.payment === l.payment))}; the books' payment ${right ? show(list.find((c) => c.payment === right.transactionRef)) ?? 'not a candidate' : 'none'}; ${list.length} candidates; the payment's own receipts in the books: ${truth.filter((m) => m.transactionRef === l.payment).map((m) => { const a = blind.receipts.find((r) => r.id === m.receiptId); const b = blind.receipts.find((r) => r.id === l.receipt); return a && b ? (a.amount === b.amount && a.date === b.date ? 'same amount and day' : a.amount === b.amount ? 'same amount' : 'other amount') : '?'; }).join(', ')}`);
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
  console.log(`model stages: ${o.usage.calls} calls (batches of ${CHECK_BATCH} checks, ${CHOOSE_BATCH} choices), ${withModel.checked} pairs checked, ${withModel.chosen} short lists; ~${Math.round(o.usage.promptChars / 4)} prompt and ~${Math.round(o.usage.answerChars / 4)} answer tokens (estimated, 4 characters each)`);
  console.log(`intake match prompts of the window's ${inWindow.length} receipts: ~${Math.round(intakeChars / 4)} prompt tokens (estimated; standard tier, with a file where the text is short)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
