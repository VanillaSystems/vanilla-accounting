/**
 * «Immer so?» under an answer to the app's sale question (#38). An answer books only its own
 * payment (src/server/questions.ts); a rule for the payer is drafted only on the person's click, and
 * only after code read the payer's other payments. They must be booked as the answer booked this one:
 * then the usual rule card (src/saving/hand-rule.ts draftHandRule). A mixed payer gets no «always»
 * rule: a payment provider's payouts (an order document or payout report linked, or a payout booked
 * from one) are split per order (#26), and a payer booked on other accounts or codes is answered
 * payment by payment. An answer that split a foreign VAT off the sale drafts the rule with that split
 * (`then.foreignTax`), so the payer's next payment is booked so too. Nothing is kept until the person clicks «Behalten» on the card.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { bankAccountFor } from '../workspace/money-accounts.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { loadBooks, type Books } from '../books/store.js';
import { loadClassifyContext, mappedReceipts, paymentFacts, ruleOfPayment, type ClassifyContext } from '../booking/classify.js';
import { bookedNow } from '../booking/rule-preview.js';
import { RULE_SECTION, RULE_STEP } from '../booking/rules.js';
import { homeOf, RULES_DIR } from '../knowledge/layers.js';
import { payerKey, payerNames } from '../knowledge/payer.js';
import type { Question } from '../questions/model.js';
import { readQuestions } from '../questions/store.js';
import type { BankTransaction } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { draftDir } from './changes.js';
import { draftHandRule, type HandMatch } from './hand-rule.js';

/**
 * POST /api/rules/sale: the rule drafted for the card; the payer is mixed (`other`: its payments
 * booked otherwise); or why nothing is offered.
 */
export type SaleRuleOffer =
  | { kind: 'rule'; path: string }
  | { kind: 'mixed'; why: 'payout' | 'bookings'; name: string; other: number }
  | { kind: 'none'; why: 'notAnswered' | 'noPayer' | 'ruleHolds' | 'invalid' };

/** A payment's bookings as one key per line opposite the bank: account and code, amounts aside. */
function bookedAs(books: Books, tx: BankTransaction, context: ClassifyContext): Set<string> {
  return new Set(bookedNow(books, tx, bankAccountFor(tx, context.bankAccounts)).map((l) => `${l.account}|${l.vat ?? ''}`));
}

/** Whether a payment is a provider's payout: a payout report or an order document linked, or booked from one. */
function isPayout(books: Books, tx: BankTransaction): boolean {
  return mappedReceipts(books, tx).some((r) => r?.payout || r?.order)
    || books.journalEntries.some((e) => e.transactionRef === tx.ref && e.by?.kind === 'code' && (e.by.check === 'payoutOrders' || e.by.check === 'payoutReport'));
}

/** Code's verdict for the answered question `q`: the rule to draft, a mixed payer, or why none. */
export function saleRuleVerdict(ws: Workspace, books: Books, q: Question, context: ClassifyContext = loadClassifyContext(ws)):
  { kind: 'rule'; match: HandMatch; account: string; vat: string | null; foreignTax?: { rate: number; account: string }; path: string } | Exclude<SaleRuleOffer, { kind: 'rule' }> {
  const acted = q.answer?.acted;
  const tx = books.transactions.find((t) => t.ref === q.on.id);
  if (q.topic !== 'saleVat' || q.status !== 'answered' || !acted || !('vatCode' in acted) || !tx) return { kind: 'none', why: 'notAnswered' };
  const fx = loadFxResolver();
  if (ruleOfPayment(books, tx, context, fx)) return { kind: 'none', why: 'ruleHolds' };
  const business = paymentFacts(books, tx, context, fx).counterparty;
  const cp = business ? context.counterparties?.find((c) => c.id === business) : undefined;
  const payer = payerKey(tx);
  const match: HandMatch | undefined = cp ? { kind: 'business', id: cp.id } : payer ? { kind: 'payer', payer } : undefined;
  if (!match) return { kind: 'none', why: 'noPayer' };
  const name = cp?.name ?? payerNames([tx])[payer!] ?? payer!;
  const partnerTxs = books.transactions.filter((t) => t.direction === 'CRDT'
    && (cp ? paymentFacts(books, t, context, fx).counterparty === cp.id : payerKey(t) === payer));
  if (partnerTxs.some((t) => isPayout(books, t))) return { kind: 'mixed', why: 'payout', name, other: 0 };
  const own = bookedAs(books, tx, context);
  // An answer that split a foreign VAT off books two lines: the sale, and the tax on its account without a code.
  const foreign = acted.foreignTax;
  const taxLine = foreign && `${foreign.account}|`;
  const [line] = [...own].filter((l) => l !== taxLine);
  const same = (as: Set<string>) => as.size === own.size && [...as].every((l) => own.has(l));
  // A payment still waiting for its answer is booked by the app's guess, which says nothing about the payer.
  const waiting = new Set(readQuestions(ws).filter((x) => x.topic === 'saleVat' && x.status === 'open').map((x) => x.on.id));
  const other = partnerTxs.filter((t) => {
    if (t.ref === tx.ref || waiting.has(t.ref)) return false;
    const as = bookedAs(books, t, context);
    return as.size > 0 && !same(as);
  }).length;
  if (own.size !== (taxLine ? 2 : 1) || (taxLine && !own.has(taxLine)) || other > 0) return { kind: 'mixed', why: 'bookings', name, other };
  const [account, vat] = line.split('|');
  return { kind: 'rule', match, account, vat: vat || null, ...(foreign ? { foreignTax: { rate: foreign.rate, account: foreign.account } } : {}), path: cp ? homeOf('workspace', cp.role, cp.id) : `${RULES_DIR}/booking.guide.yaml` };
}

/** Whether the draft waiting at `path` holds this rule already: a second «Immer so?» shows the same card, never a second rule. */
function draftHolds(ws: Workspace, v: Extract<ReturnType<typeof saleRuleVerdict>, { kind: 'rule' }>): boolean {
  const file = join(draftDir(ws), v.path);
  if (!existsSync(file)) return false;
  const doc = parse(readFileSync(file, 'utf8')) as { steps?: Record<string, { rules?: Array<{ when?: { payer?: string }; then?: { account?: string; vat?: string; foreignTax?: { rate?: number; account?: string } } }> }> } | null;
  const rules = doc?.steps?.[v.match.kind === 'business' ? RULE_STEP : RULE_SECTION]?.rules ?? [];
  return rules.some((r) => r.then?.account === v.account && r.then?.vat === (v.vat ?? 'none')
    && r.then?.foreignTax?.rate === v.foreignTax?.rate && r.then?.foreignTax?.account === v.foreignTax?.account
    && (v.match.kind === 'payer' ? r.when?.payer === v.match.payer : !r.when?.payer));
}

/** POST /api/rules/sale: «Immer so?» on the answered question `id`, the rule drafted into its file for the card when the payer is consistent. */
export function draftSaleRule(ws: Workspace, id: string, today = new Date().toISOString().slice(0, 10)): SaleRuleOffer | undefined {
  const q = readQuestions(ws).find((x) => x.id === id);
  if (!q) return undefined;
  const verdict = saleRuleVerdict(ws, loadBooks(ws), q);
  if (verdict.kind !== 'rule') return verdict;
  if (draftHolds(ws, verdict)) return { kind: 'rule', path: verdict.path };
  const drafted = draftHandRule(ws, { match: verdict.match, direction: 'in', account: verdict.account, vat: verdict.vat, ...(verdict.foreignTax ? { foreignTax: verdict.foreignTax } : {}) }, today, 'correction');
  return drafted.ok ? { kind: 'rule', path: drafted.path } : { kind: 'none', why: 'invalid' };
}
