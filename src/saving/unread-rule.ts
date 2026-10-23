/**
 * A receipt whose VAT could not be read (issue #57): what the person is offered beside «neu
 * fotografieren» and «ohne Vorsteuer buchen». «So buchen wie meistens» names the rate this
 * business's receipts showed most often before; «Immer so?» under that answer drafts the company's
 * rule for the business (`apply: { unreadReceipt: <rate> }` on booking.guide.yaml#purchase_vat,
 * src/booking/purchase-vat.ts), which waits in Änderungen to be kept. Nothing shipped assumes a
 * rate: the rule stands only in the company's own file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { linkedOf } from '../accounting/receipt-due.js';
import { isPurchaseDocument } from '../accounting/evidence-check.js';
import { vat } from '../engines/index.js';
import { loadBooks, periodLock, type Books } from '../books/store.js';
import { loadClassifyContext, mappedReceipts, paymentFacts, type ClassifyContext } from '../booking/classify.js';
import { PURCHASE_VAT_STEP } from '../booking/purchase-vat.js';
import { homeOf } from '../knowledge/layers.js';
import type { Receipt } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { draftDir } from './changes.js';

/** GET /api/rules/unread: the business of a payment whose receipt could not be read, and the rate its receipts showed most often. */
export interface UnreadOffer {
  ref: string;
  business: { id: string; name: string };
  /** The Swiss VAT rate most of the business's read receipts showed; absent when most showed none, or none was read. */
  usual?: number;
  /** The company's file of the business, where «Immer so?» drafts the rule. */
  path: string;
}

/** What a read purchase receipt shows: its Swiss rate, 0 for no Swiss VAT, undefined when it was not read. */
function shown(r: Receipt): number | undefined {
  if (r.hasSwissVat === false) return 0;
  if (!r.hasSwissVat) return undefined;
  return r.vatSummary?.find((g) => g.ratePercent > 0 && vat().isDomesticRate(g.ratePercent))?.ratePercent;
}

/**
 * The rate that most of `business`'s other payments' receipts showed: one count per receipt, a
 * receipt without Swiss VAT counting for none. Undefined when «none» wins or ties, or nothing was read.
 */
export function usualRate(books: Books, business: string, except: string, routeOf: (ref: string) => string | undefined): number | undefined {
  const tally = new Map<number, number>();
  for (const tx of books.transactions) {
    if (tx.ref === except || routeOf(tx.ref) !== business) continue;
    for (const r of mappedReceipts(books, tx).filter(isPurchaseDocument)) {
      const rate = shown(r);
      if (rate !== undefined) tally.set(rate, (tally.get(rate) ?? 0) + 1);
    }
  }
  const [first, second] = [...tally].sort((a, b) => b[1] - a[1]);
  return first && first[0] > 0 && (!second || second[1] < first[1]) ? first[0] : undefined;
}

/** The offer while the payment's receipt is unread; `answered`: also after the person answered with a rate, for «Immer so?». */
export function unreadOffer(ws: Workspace, books: Books, ref: string, { context = loadClassifyContext(ws), answered = false }: { context?: ClassifyContext; answered?: boolean } = {}): UnreadOffer | undefined {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx || periodLock(books).isClosed(tx.date) || (!answered && linkedOf(mappedReceipts(books, tx)) !== 'unread')) return undefined;
  const fx = loadFxResolver();
  const routeOf = (r: string) => { const t = books.transactions.find((x) => x.ref === r); return t ? paymentFacts(books, t, context, fx).counterparty : undefined; };
  const id = routeOf(ref);
  const cp = id ? context.counterparties?.find((c) => c.id === id) : undefined;
  if (!cp) return undefined;
  const usual = usualRate(books, cp.id, ref, routeOf);
  return { ref, business: { id: cp.id, name: cp.name }, ...(usual !== undefined ? { usual } : {}), path: homeOf('workspace', cp.role, cp.id) };
}

/** The text of the business's company file with its rule for an unread receipt at `rate`: the business's own such rule takes the rate, else one is added. */
export function withUnreadRule(text: string, offer: UnreadOffer, rate: number, today: string): string {
  const doc = parseDocument(text || `id: ${offer.business.id}\n`);
  const rules = doc.getIn(['steps', PURCHASE_VAT_STEP, 'rules']);
  const seq = rules instanceof YAMLSeq ? rules : doc.createNode([]) as YAMLSeq;
  if (!(rules instanceof YAMLSeq)) doc.setIn(['steps', PURCHASE_VAT_STEP, 'rules'], seq);
  const apply = doc.createNode({ unreadReceipt: rate }, { flow: true });
  const source = `correction ${today}`;
  const mine = seq.items.find((item): item is YAMLMap => item instanceof YAMLMap && item.getIn(['apply', 'unreadReceipt']) !== undefined);
  if (mine) {
    mine.set('apply', apply);
    mine.set('then', `count it as Swiss VAT at ${rate} % on its whole amount`);
    mine.set('source', source);
  } else {
    seq.add(doc.createNode({
      id: `${offer.business.id}-unread-receipt`,
      when: `a receipt of ${offer.business.name} whose VAT could not be read`,
      then: `count it as Swiss VAT at ${rate} % on its whole amount`,
      apply: { unreadReceipt: rate },
      source,
    }));
    const added = seq.items.at(-1) as YAMLMap;
    const a = added.get('apply', true);
    if (a instanceof YAMLMap) a.flow = true;
  }
  return doc.toString({ lineWidth: 0 });
}

/** POST /api/rules/unread: the rule drafted into the business's company file (the draft of it, when one waits). Returns the file. */
export function draftUnreadRule(ws: Workspace, ref: string, rate: number, today = new Date().toISOString().slice(0, 10)): string | undefined {
  const offer = unreadOffer(ws, loadBooks(ws), ref, { answered: true });
  if (!offer || !(rate > 0 && rate < 100)) return undefined;
  const draft = join(draftDir(ws), offer.path);
  const real = join(ws.paths.root, offer.path);
  const text = existsSync(draft) ? readFileSync(draft, 'utf8') : existsSync(real) ? readFileSync(real, 'utf8') : '';
  mkdirSync(dirname(draft), { recursive: true });
  writeFileSync(draft, withUnreadRule(text, offer, rate, today));
  return offer.path;
}
