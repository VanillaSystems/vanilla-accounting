/**
 * «Immer so?» after a person linked several receipts of one business to one payment, the second
 * time (#190 2d; MISSION: «every correction teaches»): the business as a batch payer, `grouped:
 * true` in the company's file of it, drafted on the click and shown on the usual card (RuleDraft,
 * src/saving/rules.ts ruleDiff `grouped`) to keep with one click. From then on code tries its open
 * receipts in date order for its payments (src/intake/receipt-sets.ts). Nothing is kept until the
 * person clicks «Behalten».
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadBooks, periodLock, type Books } from '../books/store.js';
import { loadClassifyContext, mappedReceipts, type ClassifyContext } from '../booking/classify.js';
import { homeOf } from '../knowledge/layers.js';
import { chargesOf } from '../intake/charges.js';
import { businessOfPayment } from '../intake/batch-payers.js';
import { buyerUids } from '../intake/own-invoice.js';
import { duplicatesIn } from '../intake/duplicates.js';
import { estvToChf } from '../intake/pair-chain.js';
import { documents } from '../engines/index.js';
import type { BankTransaction } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { draftDir } from './changes.js';

/** After this many payments a person linked several receipts of one business to, the app asks «Immer so?». */
export const LEARN_AFTER = 2;

/** GET /api/rules/grouped: the batch payer a payment's links offer, or none. */
export interface GroupedOffer {
  ref: string;
  business: { id: string; name: string };
  /** The payments of the business a person linked several receipts to, this one among them. */
  payments: number;
  /** The company's file of the business, where the flag would stand. */
  path: string;
}

/** How many documents a person linked to a charge (each of its movements): two copies of one invoice count once (src/intake/duplicates.ts). */
function byPerson(books: Books, refs: readonly string[]): number {
  const ids = new Set(books.mappings.filter((m) => m.by === 'human' && refs.includes(m.transactionRef)).map((m) => m.receiptId));
  const receipts = books.receipts.filter((r) => ids.has(r.id) && r.kind !== 'duplicate');
  return receipts.length < 2 ? receipts.length : receipts.length - duplicatesIn(receipts, ids, documents()).size;
}

/**
 * The offer for payment `ref`: a person linked two documents or more to it (a copy counted once),
 * its business (businessOfPayment, as the batch payers recognise it) has no file that says
 * `grouped` either way, and a person did the same on another of its payments, so LEARN_AFTER
 * payments in all. None for a payment of a filed quarter.
 */
export function groupedOffer(ws: Workspace, books: Books, ref: string, context: ClassifyContext = loadClassifyContext(ws)): GroupedOffer | undefined {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx || periodLock(books).isClosed(tx.date)) return undefined;
  const charges = chargesOf(books.transactions, estvToChf());
  const buyer = buyerUids(ws.company, books);
  const businessOf = (t: BankTransaction) => businessOfPayment(t, mappedReceipts(books, t), context.counterparties ?? [], buyer);
  const mine = charges.of(tx);
  if (byPerson(books, mine.refs) < 2) return undefined;
  const id = businessOf(tx);
  const cp = id ? context.counterparties?.find((c) => c.id === id) : undefined;
  // A file that says `grouped` at all, true or false, has said it: nothing to offer.
  if (!cp || cp.grouped || cp.groupedSaid) return undefined;
  const seen = new Set<string>();
  let payments = 0;
  for (const t of books.transactions) {
    const charge = charges.of(t);
    if (seen.has(charge.refs[0])) continue;
    seen.add(charge.refs[0]);
    if (byPerson(books, charge.refs) >= 2 && businessOf(t) === cp.id) payments++;
  }
  return payments >= LEARN_AFTER ? { ref, business: { id: cp.id, name: cp.name }, payments, path: homeOf('workspace', cp.role, cp.id) } : undefined;
}

/** The text of a business's company file with `grouped: true` in it (a new file names the business's id). */
export function withGroupedFlag(text: string, id: string): string {
  const doc = parseDocument(text || `id: ${id}\n`);
  doc.set('grouped', true);
  return doc.toString({ lineWidth: 0 });
}

/** POST /api/rules/grouped: the flag drafted into the business's company file (its draft, when one waits), for the card. */
export function draftGroupedFlag(ws: Workspace, ref: string): string | undefined {
  const offer = groupedOffer(ws, loadBooks(ws), ref);
  if (!offer) return undefined;
  const draft = join(draftDir(ws), offer.path);
  const real = join(ws.paths.root, offer.path);
  const text = existsSync(draft) ? readFileSync(draft, 'utf8') : existsSync(real) ? readFileSync(real, 'utf8') : '';
  mkdirSync(dirname(draft), { recursive: true });
  writeFileSync(draft, withGroupedFlag(text, offer.business.id));
  return offer.path;
}
