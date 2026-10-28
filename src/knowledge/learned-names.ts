/**
 * Learned merchant names (#190 part 1). A card statement names a merchant otherwise than its
 * receipt does («AMZN Mktp DE*AB12CD» for the marketplace's invoice). Every confirmed link (by a
 * person, the model, or code checked by the model) pairs such a name with the business the receipt
 * is of. Code collects them in the company's file of that business, as `match.tx`, so the payment
 * names the business by its file: the pair search counts that as the name (src/intake/pairing.ts
 * fitOf), and the booking routes the payment to the business's rules like any `tx` signal.
 *
 * The company's file keeps each name it learned in `learnedTx` too. A name a person took out of
 * `match.tx` (on the partner's page, or by editing the file) stays there and is never learned
 * again: the person's removal sticks.
 *
 * A name is learned only when it is safe to route by: it names something beyond the bank's words
 * once its references are cut off (merchantName), no business's file claims its payments yet,
 * LEARN_AFTER payments with it are linked to the business's receipts by a confirmed link, and no
 * link at all puts it on a payment of another business's receipt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSeq, parseDocument, type Document } from 'yaml';
import type { BankTransaction, Mapping, Receipt } from '../types/index.js';
import { identify, merchantOf, signalsOfTransaction, type Counterparty } from './counterparties.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { homeOf, loadKnowledge } from './layers.js';
import { businesses } from '../intake/batch-payers.js';
import { BANK_WORDS, makerOf } from '../intake/pairing.js';

/** A name is learned once this many payments with it are linked to one business's receipts by a confirmed link. */
export const LEARN_AFTER = 2;

/**
 * The name a payment gives its merchant, as a learned name keeps it: the bank's counterparty field,
 * else the merchant of its text (merchantOf), cut before the first part with a digit (a card's
 * reference «*AB12CD», a terminal's number) and trimmed. None when what is left names nothing: fewer
 * than four letters, or only the bank's own words («Karte», «Einkauf»).
 */
export function merchantName(tx: Pick<BankTransaction, 'counterparty' | 'description'>): string | undefined {
  const raw = (tx.counterparty?.trim() || merchantOf(tx.description)).replace(/\s+/g, ' ');
  const cut = raw.search(/[\s*#/]*[^\s*#/]*\d/);
  const name = (cut < 0 ? raw : raw.slice(0, cut)).replace(/[\s*#/.,;:–-]+$/u, '').trim();
  const words = name.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  if ((name.match(/\p{L}/gu) ?? []).length < 4 || !words.some((w) => !BANK_WORDS.has(w))) return undefined;
  return name;
}

/** A name the company's file of a business learns: which business, the name, on how many payments a confirmed link showed it. */
export interface LearnedName { business: string; name: string; payments: number }

type Books = { receipts: readonly Receipt[]; transactions: readonly BankTransaction[]; mappings: readonly Mapping[] };

/**
 * Pure. The names the books' links teach, per business: from confirmed links (makerOf: not code
 * alone) of a payment no business's file claims to a receipt whose business is known, on
 * LEARN_AFTER payments or more, never a name a link puts on another business's receipt, nor one the
 * business's files hold or learned before (`learnedTx`, a person's removal among them).
 */
export function namesToLearn(books: Books, counterparties: readonly Counterparty[], buyerUid?: string): LearnedName[] {
  const known = businesses(counterparties, buyerUid);
  const payment = new Map(books.transactions.map((t) => [t.ref, t]));
  const receipt = new Map(books.receipts.map((r) => [r.id, r]));
  const byName = new Map<string, { name: string; business: Map<string, Set<string>>; others: boolean }>();
  for (const m of books.mappings) {
    const tx = payment.get(m.transactionRef);
    const r = receipt.get(m.receiptId);
    const name = tx && merchantName(tx);
    if (!tx || !r || !name) continue;
    const key = name.toLowerCase();
    const seen = byName.get(key) ?? { name, business: new Map(), others: false };
    byName.set(key, seen);
    const of = known.ofReceipt(r);
    if (!of || makerOf(m) === 'code') continue;
    if (identify(signalsOfTransaction(tx, []), counterparties).kind !== 'unknown') { seen.others = true; continue; }
    seen.business.set(of, (seen.business.get(of) ?? new Set()).add(tx.ref));
  }
  // A name another business's receipt was linked to, by anyone, is no name of one business.
  for (const m of books.mappings) {
    const tx = payment.get(m.transactionRef);
    const r = receipt.get(m.receiptId);
    const of = r && known.ofReceipt(r);
    if (!tx || !of) continue;
    const names = [tx.counterparty ?? '', merchantOf(tx.description)].map((n) => n.toLowerCase());
    for (const [key, seen] of byName) if (names.some((n) => n.includes(key)) && [...seen.business.keys()].some((b) => b !== of)) seen.others = true;
  }
  const byId = new Map(counterparties.map((c) => [c.id, c]));
  const out: LearnedName[] = [];
  for (const [key, seen] of byName) {
    if (seen.others || seen.business.size !== 1) continue;
    const [[business, refs]] = [...seen.business];
    const cp = byId.get(business);
    if (!cp || refs.size < LEARN_AFTER) continue;
    if ([...cp.match.tx, ...(cp.learnedTx ?? [])].some((t) => t.toLowerCase() === key)) continue;
    out.push({ business, name: seen.name, payments: refs.size });
  }
  return out.sort((a, b) => a.business.localeCompare(b.business) || a.name.localeCompare(b.name));
}

/** The list at `path` of a business file as a flow sequence, made when missing. */
function listAt(doc: Document, path: string[]) {
  const node = doc.getIn(path);
  if (isSeq(node)) return node;
  const seq = doc.createNode([]);
  seq.flow = true;
  doc.setIn(path, seq);
  return seq;
}

/** The text of a business's company file with `name` learned: in `match.tx` and in `learnedTx` (a new file names the business's id). */
export function withLearnedName(text: string, id: string, name: string): string {
  const doc = parseDocument(text || `id: ${id}\n`);
  listAt(doc, ['match', 'tx']).items.push(doc.createNode(name));
  listAt(doc, ['learnedTx']).items.push(doc.createNode(name));
  return doc.toString({ lineWidth: 0 });
}

/** The text of a business's company file without the learned `name` in `match.tx`; `learnedTx` keeps it, so it is not learned again. Undefined when the file holds no such learned name. */
export function withoutLearnedName(text: string, name: string): string | undefined {
  const doc = parseDocument(text);
  const learned = doc.getIn(['learnedTx']);
  const tx = doc.getIn(['match', 'tx']);
  const same = (node: unknown) => String((node as { value?: unknown })?.value ?? node).toLowerCase() === name.toLowerCase();
  if (!isSeq(learned) || !learned.items.some(same) || !isSeq(tx) || !tx.items.some(same)) return undefined;
  tx.items = tx.items.filter((n) => !same(n));
  return doc.toString({ lineWidth: 0 });
}

const fileOf = (ws: Pick<Workspace, 'paths'>, cp: Pick<Counterparty, 'role' | 'id'>) => join(ws.paths.root, homeOf('workspace', cp.role, cp.id));

/**
 * Writes what the books' links teach into the company's files of the businesses (namesToLearn),
 * and returns it; nothing when the knowledge does not load. Called after a link is confirmed (an
 * intake run, a person's link). Idempotent: what was learned once is never written again.
 */
export function learnMerchantNames(ws: Pick<Workspace, 'paths' | 'company'>, books: Books): LearnedName[] {
  let counterparties: Counterparty[];
  try { counterparties = loadKnowledge(APP_ROOT, ws.paths.root).counterparties; } catch { return []; }
  const learned = namesToLearn(books, counterparties, ws.company?.uid);
  const byId = new Map(counterparties.map((c) => [c.id, c]));
  for (const l of learned) {
    const file = fileOf(ws, byId.get(l.business)!);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, withLearnedName(existsSync(file) ? readFileSync(file, 'utf8') : '', l.business, l.name));
  }
  return learned;
}

/** A person takes a learned name out of a business's company file (the partner's page): its path, or undefined when the file holds no such learned name. */
export function removeLearnedName(ws: Pick<Workspace, 'paths'>, cp: Pick<Counterparty, 'role' | 'id'>, name: string): string | undefined {
  const file = fileOf(ws, cp);
  if (!existsSync(file)) return undefined;
  const next = withoutLearnedName(readFileSync(file, 'utf8'), name);
  if (next === undefined) return undefined;
  writeFileSync(file, next);
  return homeOf('workspace', cp.role, cp.id);
}
