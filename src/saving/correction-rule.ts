/**
 * «Regel anpassen?» after a person corrected a booking a rule made (MISSION: «every correction
 * teaches»; r9k-5): the rule's `then` as the correction has it, drafted into the rule's own file
 * and shown on the rule's card to keep with one click, without the AI. Code reads the correction:
 * the account the person put opposite the bank, and the VAT code when she changed it. Nothing is
 * kept until «Behalten»; the card shows the payments the changed rule would book differently.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { bankAccountFor } from '../accounting/bank-accounts.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { loadBooks, periodLock, type Books } from '../books/store.js';
import { loadClassifyContext, ruleOfPayment, type ClassifyContext } from '../booking/classify.js';
import { companyRules } from '../booking/rule-book.js';
import { RULE_SECTION, RULE_STEP } from '../booking/rules.js';
import { RULES_DIR } from '../knowledge/layers.js';
import type { Workspace } from '../workspace/workspace.js';
import { draftDir } from './changes.js';
import { ruleFactsOf } from './rules.js';

/** GET /api/rules/correction: the rule change a corrected booking offers, or none. */
export interface CorrectionOffer {
  ref: string;
  /** The corrected booking. */
  entry: string;
  /** The rule that booked the payment, and the file it stands in. */
  rule: string;
  path: string;
  from: { account: string; vat: string | null };
  to: { account: string; vat: string | null };
  /** The business whose file holds the rule, when it is a business's rule. */
  business?: { id: string; name: string };
}

/**
 * The change a corrected booking teaches: the payment's rule books on one account; the person
 * moved the one booking to another (and maybe changed its code). None when no rule holds the
 * payment, the booking is not a person's correction, the rule books a split or a payout (fees,
 * private: too many shapes to read one account from), or the rule is the app's, not the company's.
 */
export function correctionOffer(ws: Workspace, books: Books, ref: string, context: ClassifyContext = loadClassifyContext(ws)): CorrectionOffer | undefined {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx || periodLock(books).isClosed(tx.date)) return undefined;
  const entries = books.journalEntries.filter((e) => e.transactionRef === ref);
  const e = entries[0];
  if (entries.length !== 1 || e.by?.kind !== 'person' || !e.by.was) return undefined;
  const placed = ruleOfPayment(books, tx, context, loadFxResolver());
  if (!placed || placed.rule.then.kind !== 'book') return undefined;
  const booking = placed.rule.then.booking;
  if (booking.fees || booking.private) return undefined;
  const bank = bankAccountFor(tx, context.bankAccounts);
  const account = e.accountDebit === bank ? e.accountCredit : e.accountCredit === bank ? e.accountDebit : undefined;
  if (!account || account === bank) return undefined;
  const to = { account, vat: e.by.was.vatCode !== undefined ? e.vatCode ?? null : booking.vat };
  if (to.account === booking.account && to.vat === booking.vat) return undefined;
  const row = companyRules(ws, ruleFactsOf(ws, placed.business)).find((r) => r.id === placed.rule.id && (r.business ?? undefined) === placed.business);
  if (!row) return undefined;
  const cp = placed.business ? context.counterparties?.find((c) => c.id === placed.business) : undefined;
  return { ref, entry: e.id, rule: placed.rule.id, path: row.file, from: { account: booking.account, vat: booking.vat }, to, ...(cp ? { business: { id: cp.id, name: cp.name } } : {}) };
}

/** The text of the rule's file with the offer's `then` on its rule; the rule's source names the correction. */
export function withCorrectedRule(text: string, offer: CorrectionOffer, today: string): string {
  const doc = parseDocument(text);
  const section = offer.path.startsWith(`${RULES_DIR}/`) ? RULE_SECTION : RULE_STEP;
  const rules = doc.getIn(['steps', section, 'rules']);
  const mine = rules instanceof YAMLSeq ? rules.items.find((item): item is YAMLMap => item instanceof YAMLMap && item.get('id') === offer.rule) : undefined;
  if (!mine) throw new Error(`${offer.path}: no rule ${offer.rule}`);
  const then = mine.get('then', true);
  if (!(then instanceof YAMLMap)) throw new Error(`${offer.path}: rule ${offer.rule} has no then map`);
  then.set('account', offer.to.account);
  then.set('vat', offer.to.vat ?? 'none');
  mine.set('source', `correction ${today}`);
  return doc.toString({ lineWidth: 0 });
}

/** POST /api/rules/correction: the offer drafted into its file (the draft of it, when one waits), for the rule's card. */
export function draftCorrectionRule(ws: Workspace, ref: string, today = new Date().toISOString().slice(0, 10)): string | undefined {
  const offer = correctionOffer(ws, loadBooks(ws), ref);
  if (!offer) return undefined;
  const draft = join(draftDir(ws), offer.path);
  const real = join(ws.paths.root, offer.path);
  const text = existsSync(draft) ? readFileSync(draft, 'utf8') : readFileSync(real, 'utf8');
  mkdirSync(dirname(draft), { recursive: true });
  writeFileSync(draft, withCorrectedRule(text, offer, today));
  return offer.path;
}
