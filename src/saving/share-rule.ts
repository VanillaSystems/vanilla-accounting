/**
 * «Immer so?» after a person split a payment into a business part and a private part (MISSION:
 * «every correction teaches»; wishes3-6): the split as a rule with a private share
 * (src/booking/rules.ts `then.private`), drafted for the business the payment routes to, else for
 * its payer, and shown on the rule's card to keep with one click. Code reads the split; nothing
 * is kept until the person clicks «Behalten».
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { lookupVatCode, vatCodes } from '../accounting/vat-codes.js';
import { bankAccountFor } from '../accounting/bank-accounts.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { paymentSides } from '../accounting/payment-entries.js';
import { loadBooks, periodLock, type Books } from '../books/store.js';
import { loadClassifyContext, paymentFacts, ruleBookingLines, ruleOfPayment, mappedReceipts, type ClassifyContext } from '../booking/classify.js';
import { RULE_SECTION, RULE_STEP, type RuleBooking } from '../booking/rules.js';
import { homeOf, RULES_DIR } from '../knowledge/layers.js';
import { payerKey, payerNames } from '../knowledge/payer.js';
import type { Workspace } from '../workspace/workspace.js';
import { draftDir } from './changes.js';

/** GET /api/rules/share: the rule a split payment offers, or none. */
export interface ShareOffer {
  ref: string;
  /** The private share in percent. */
  percent: number;
  booking: RuleBooking;
  /** Whose rule: a business (its id and name), else the payer's key and name. */
  business?: { id: string; name: string };
  payer?: string;
  payerName?: string;
  /** The file the rule would stand in. */
  path: string;
}

/**
 * The code a rule names for the business part: a purchase booked with the zero code (no receipt
 * showed VAT that time) names its family's standard rate, since the rule falls back to the zero
 * code for any payment whose receipt shows none (ruleVatCode); any other code as booked.
 */
export function ruleCode(code: string | undefined): string | null {
  if (!code) return null;
  const found = lookupVatCode(code);
  if (!found || found.negative) return code;
  const { family, rate } = found.entry;
  if ((family !== 'I' && family !== 'M') || rate) return code;
  const standard = vatCodes().filter((c) => c.family === family && c.rate && !c.superseded && /^[A-Z]+\d+$/.test(c.code)).sort((a, b) => b.rate! - a.rate!)[0];
  return standard?.code ?? code;
}

/**
 * The share rule `ref`'s bookings show, when they are a split: two bookings against the bank, one
 * on the owner's account without VAT, adding up to what the bank paid, at a whole percent the rule
 * books again (to the cent, but for the odd cent of an uneven half). None when a rule already books it that way.
 */
export function shareOffer(ws: Workspace, books: Books, ref: string, context: ClassifyContext = loadClassifyContext(ws)): ShareOffer | undefined {
  const tx = books.transactions.find((t) => t.ref === ref);
  const owner = context.ownerAccount;
  if (!tx || !owner || periodLock(books).isClosed(tx.date)) return undefined;
  const bank = bankAccountFor(tx, context.bankAccounts);
  const entries = books.journalEntries.filter((e) => e.transactionRef === ref);
  if (entries.length !== 2 || paymentSides(books, ref, context.bankAccounts).some((s) => s.booked !== s.paid)) return undefined;
  const other = (e: (typeof entries)[number]) => (e.accountDebit === bank ? e.accountCredit : e.accountCredit === bank ? e.accountDebit : undefined);
  const own = entries.find((e) => other(e) === owner && !e.vatCode);
  const biz = entries.find((e) => e !== own);
  const account = biz && other(biz);
  if (!own || !biz || !account || account === owner) return undefined;
  const percent = Math.round((own.amount / tx.amount) * 100);
  const booking: RuleBooking = { account, vat: ruleCode(biz.vatCode), private: percent };
  if (percent <= 0 || percent >= 100) return undefined;
  const lines = ruleBookingLines(tx, booking, mappedReceipts(books, tx).some((r) => r.hasSwissVat), owner);
  // A whole percent: the rule books the split again, give or take the odd cent of an uneven half.
  if (!lines[1] || Math.abs(Math.round(lines[1].amount * 100) - Math.round(own.amount * 100)) > 1) return undefined;
  const fx = loadFxResolver();
  const ruled = ruleOfPayment(books, tx, context, fx)?.rule.then;
  if (ruled?.kind === 'book' && ruled.booking.private === percent && ruled.booking.account === account) return undefined;
  const id = paymentFacts(books, tx, context, fx).counterparty;
  const cp = id ? context.counterparties?.find((c) => c.id === id) : undefined;
  if (cp) return { ref, percent, booking, business: { id: cp.id, name: cp.name }, path: homeOf('workspace', cp.role, cp.id) };
  const payer = payerKey(tx);
  return payer ? { ref, percent, booking, payer, payerName: payerNames([tx])[payer] ?? payer, path: `${RULES_DIR}/booking.guide.yaml` } : undefined;
}

/** The text of `path` with the offer's rule in it: a business's own rule takes the share, else a new rule is added. */
export function withShareRule(text: string, offer: ShareOffer, today: string): string {
  const doc = parseDocument(text || (offer.business ? `id: ${offer.business.id}\n` : 'process: booking\n'));
  const section = offer.business ? RULE_STEP : RULE_SECTION;
  const then = { account: offer.booking.account, vat: offer.booking.vat ?? 'none', private: offer.percent };
  const source = `correction ${today}`;
  const rules = doc.getIn(['steps', section, 'rules']);
  const seq = rules instanceof YAMLSeq ? rules : doc.createNode([]) as YAMLSeq;
  if (!(rules instanceof YAMLSeq)) doc.setIn(['steps', section, 'rules'], seq);
  const mine = seq.items.find((item): item is YAMLMap => item instanceof YAMLMap && item.get('then') instanceof YAMLMap
    && (offer.business ? !item.get('when') : (item.getIn(['when', 'payer']) === offer.payer)));
  if (mine) {
    mine.set('then', doc.createNode(then, { flow: true }));
    mine.set('source', source);
    mine.delete('off');
  } else {
    const id = `${offer.business?.id ?? 'zahler'}-privatanteil`;
    seq.add(doc.createNode({ id, ...(offer.payer ? { when: { payer: offer.payer } } : {}), then, source }, { flow: false }));
    const added = seq.items.at(-1) as YAMLMap;
    for (const k of ['when', 'then']) { const v = added.get(k, true); if (v instanceof YAMLMap) v.flow = true; }
  }
  return doc.toString({ lineWidth: 0 });
}

/** POST /api/rules/share: the offer drafted into its file (the draft of it, when one waits), for the rule's card. */
export function draftShareRule(ws: Workspace, ref: string, today = new Date().toISOString().slice(0, 10)): string | undefined {
  const offer = shareOffer(ws, loadBooks(ws), ref);
  if (!offer) return undefined;
  const draft = join(draftDir(ws), offer.path);
  const real = join(ws.paths.root, offer.path);
  const text = existsSync(draft) ? readFileSync(draft, 'utf8') : existsSync(real) ? readFileSync(real, 'utf8') : '';
  mkdirSync(dirname(draft), { recursive: true });
  writeFileSync(draft, withShareRule(text, offer, today));
  return offer.path;
}
