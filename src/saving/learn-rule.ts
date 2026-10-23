/**
 * «Ins Wissen übernehmen?» under a person's correction of a booking no company rule made (issue #40;
 * MISSION: «every correction teaches»). Two ways: «Vorschlag der KI», where a small model drafts a
 * booking rule for the payment's partner or a sentence for its notes, or the person writes it in the
 * form of Firma › Regeln. Either way the entry goes through the existing paths (the rule card with its
 * preview and «Trotzdem behalten», or the partner's notes), and nothing is kept until the person keeps it.
 *
 * Code decides what is offered and checks what the model drafts, never the model's confidence:
 * - only a change of account or VAT code teaches; a changed amount or date is a fix, not a practice;
 * - a correction of a rule's booking goes to «Regel anpassen?» (correction-rule.ts), not here;
 * - a rule only for a partner with at least GENERAL payments it books as they are booked today, the
 *   corrected one counted; a one-off gets a note or nothing;
 * - the rule must book the corrected payment exactly as the person did, for one business (its file)
 *   or one payer: never a match the app cannot carry out;
 * - parseRule refuses what the app could not carry out; the card then says what it would do, and
 *   warns when it books against a national VAT rule (#75).
 */
import { bankAccountFor } from '../accounting/bank-accounts.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { loadBooks, periodLock, type Books } from '../books/store.js';
import { loadClassifyContext, mappedReceipts, paymentFacts, ruleBookingLines, ruleOfPayment, type ClassifyContext, type RuleLine } from '../booking/classify.js';
import { chartNames } from '../booking/rule-book.js';
import { bookedNow, openYear, sameLines } from '../booking/rule-preview.js';
import { parseRule, type RuleBooking } from '../booking/rules.js';
import { payerKey, payerNames } from '../knowledge/payer.js';
import { ask, type AskOptions } from '../llm/ask.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { correctionOffer } from './correction-rule.js';
import { draftHandRule, type HandMatch } from './hand-rule.js';
import { ruleFactsOf } from './rules.js';
import { ruleCode } from './share-rule.js';

/** Payments of a partner a rule must book as they are booked today, the corrected one counted, before the AI may propose it. */
export const GENERAL = 2;

/** The model that drafts the entry: Haiku proposed as well as Sonnet in the learning-loop eval (#7 M2c), at a fraction of the cost. */
export const LEARN_MODEL: NonNullable<AskOptions['model']> = 'haiku';

/** Whose payments a learned rule books: a business the firm knows (its file), else the payer. */
export type LearnPartner = { kind: 'business'; id: string; name: string } | { kind: 'payer'; payer: string; name: string };

/** A booking as the correction reads: the account opposite the bank and the VAT code (null: none). */
export interface Booked { account: string; vat: string | null }

/** GET /api/rules/learn?ref=: what a corrected booking may teach, or none. */
export interface LearnOffer {
  ref: string;
  /** The corrected booking. */
  entry: string;
  partner: LearnPartner;
  was: Booked;
  booked: Booked;
  /** The partner's payments of the open year booked today as the correction books, this one counted. */
  same: number;
  /** The partner's payments of the open year. */
  of: number;
}

/** Why the AI's draft is not offered: it saw no general practice, its answer is not one the app takes, it books the payment otherwise than the person did, or it would be a one-off. */
export type LearnRefusal = 'model' | 'invalid' | 'contradicts' | 'oneOff';

/** POST /api/rules/learn: the AI's draft, checked. A rule is drafted into its file for the card; a note waits for the person to put it in the partner's notes. */
export type LearnProposal =
  | { kind: 'rule'; path: string }
  | { kind: 'note'; partner: string; name: string; sentence: string }
  | { kind: 'none'; why: LearnRefusal };

/** The model's answer, parsed. */
export type LearnAnswer = { kind: 'rule'; then: Booked } | { kind: 'note'; sentence: string } | { kind: 'none' };

interface Corrected { tx: BankTransaction; entry: JournalEntry; offer: LearnOffer; partnerTxs: BankTransaction[] }

const opposite = (e: Pick<JournalEntry, 'accountDebit' | 'accountCredit'>, bank: string): string | undefined =>
  e.accountDebit === bank ? e.accountCredit : e.accountCredit === bank ? e.accountDebit : undefined;

/** The rule's booking for a correction: its code as a rule names it (a refund's minus left to the rule, the zero code widened to the standard rate where receipts decide), unless that would book this payment otherwise. */
function bookingOf(books: Books, tx: BankTransaction, booked: Booked, owner: string | undefined): RuleBooking {
  const base = booked.vat?.replace(/^-/, '') ?? null;
  const swiss = mappedReceipts(books, tx).some((r) => r.hasSwissVat);
  const wide = { account: booked.account, vat: ruleCode(base ?? undefined) };
  const asBooked: RuleLine[] = [{ account: booked.account, ...(booked.vat ? { vat: booked.vat } : {}), amount: tx.amount }];
  return sameLines(ruleBookingLines(tx, wide, swiss, owner), asBooked) ? wide : { account: booked.account, vat: base };
}

/** How many of `txs` `booking` books as they are booked today. */
function agreeing(books: Books, txs: readonly BankTransaction[], booking: RuleBooking, context: ClassifyContext): number {
  return txs.filter((tx) => {
    const now = bookedNow(books, tx, bankAccountFor(tx, context.bankAccounts));
    return now.length > 0 && sameLines(now, ruleBookingLines(tx, booking, mappedReceipts(books, tx).some((r) => r.hasSwissVat), context.ownerAccount));
  }).length;
}

function corrected(ws: Workspace, books: Books, ref: string, context: ClassifyContext): Corrected | undefined {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx || periodLock(books).isClosed(tx.date)) return undefined;
  const entries = books.journalEntries.filter((e) => e.transactionRef === ref);
  const [entry] = entries;
  if (entries.length !== 1 || (entry.by?.kind !== 'person' && entry.by?.kind !== 'assistant') || !entry.by.was) return undefined;
  const was = entry.by.was;
  // Only a changed account or code teaches: an amount or a date put right is a fix, not a practice.
  if (was.accountDebit === undefined && was.accountCredit === undefined && was.vatCode === undefined) return undefined;
  if (correctionOffer(ws, books, ref, context)) return undefined;
  const bank = bankAccountFor(tx, context.bankAccounts);
  const account = opposite(entry, bank);
  const before = opposite({ ...entry, ...was }, bank);
  if (!account || account === bank || !before) return undefined;
  const booked: Booked = { account, vat: entry.vatCode ?? null };
  const fx = loadFxResolver();
  const placed = ruleOfPayment(books, tx, context, fx);
  if (placed?.rule.then.kind === 'book' && placed.rule.then.booking.account === account && !placed.rule.then.booking.private && !placed.rule.then.booking.fees) return undefined;
  const business = paymentFacts(books, tx, context, fx).counterparty;
  const cp = business ? context.counterparties?.find((c) => c.id === business) : undefined;
  const payer = payerKey(tx);
  const partner: LearnPartner | undefined = cp ? { kind: 'business', id: cp.id, name: cp.name }
    : payer ? { kind: 'payer', payer, name: payerNames([tx])[payer] ?? payer } : undefined;
  if (!partner) return undefined;
  const year = openYear(books);
  const partnerTxs = books.transactions.filter((t) => t.date.startsWith(year) && t.direction === tx.direction
    && (partner.kind === 'business' ? paymentFacts(books, t, context, fx).counterparty === partner.id : payerKey(t) === partner.payer));
  const same = agreeing(books, partnerTxs, bookingOf(books, tx, booked, context.ownerAccount), context);
  return {
    tx, entry, partnerTxs,
    offer: { ref, entry: entry.id, partner, was: { account: before, vat: was.vatCode !== undefined ? was.vatCode || null : booked.vat }, booked, same, of: partnerTxs.length },
  };
}

/** What the corrected booking of payment `ref` may teach; none when it teaches nothing here. */
export function learnOffer(ws: Workspace, books: Books, ref: string, context: ClassifyContext = loadClassifyContext(ws)): LearnOffer | undefined {
  return corrected(ws, books, ref, context)?.offer;
}

const MAX_PAST = 12;

/** Pure. The one small prompt: the correction, the partner's other payments and how they are booked, the receipt's facts. */
export function learnPrompt(c: Corrected, books: Books, context: ClassifyContext): string {
  const names = chartNames(context.chartOfAccounts);
  const acc = (a: string) => (names.get(a) ? `${a} ${names.get(a)}` : a);
  const bk = (b: Booked) => `account ${acc(b.account)}, VAT code ${b.vat ?? 'none'}`;
  const pay = (tx: BankTransaction) => `${tx.date} ${tx.direction === 'DBIT' ? 'paid' : 'received'} ${tx.amount.toFixed(2)} ${tx.currency} «${[tx.description, tx.counterparty].filter(Boolean).join(' · ')}»`;
  const receipts = mappedReceipts(books, c.tx).map((r) => `- ${[r.description, r.vatId ? `UID ${r.vatId}` : '', r.hasSwissVat ? 'shows Swiss VAT' : 'shows no Swiss VAT', ...(r.vatSummary ?? []).map((g) => `${g.ratePercent} %: ${g.vat}`)].filter(Boolean).join(', ')}`);
  const past = c.partnerTxs.filter((t) => t.ref !== c.tx.ref).sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_PAST).map((t) => {
    const now = bookedNow(books, t, bankAccountFor(t, context.bankAccounts));
    return `- ${pay(t)} → ${now.length ? now.map((l) => `${acc(l.account)} ${l.vat ?? 'none'}`).join(' + ') : 'not booked'}`;
  });
  const { partner, was, booked, same, of } = c.offer;
  return `A person corrected how the bookkeeping app booked one payment of a Swiss company. Decide whether the correction is the company's practice for this ${partner.kind === 'business' ? 'business partner' : 'payer'}, and draft one knowledge entry.

${partner.kind === 'business' ? 'Business partner' : 'Payer'}: ${partner.name}
The corrected payment: ${pay(c.tx)}
Booked before: ${bk(was)}
Corrected to: ${bk(booked)}
Receipts linked to it:
${receipts.length ? receipts.join('\n') : '- none'}
The ${partner.kind === 'business' ? 'partner' : 'payer'}'s other payments this year, as booked today:
${past.length ? past.join('\n') : '- none'}
Of its ${of} payments this year, ${same} are booked the corrected way, this one counted.

Answer with exactly one JSON object and nothing else:
- {"kind":"rule","then":{"account":"<number>","vat":"<code or none>"}} when every payment of this ${partner.kind === 'business' ? 'partner' : 'payer'} should be booked the corrected way: the app will book them so by itself. Only when at least ${GENERAL} of its payments, the corrected one counted, are booked so. Name the corrected account; name a VAT code with a rate (I81, M81) only when its receipts show Swiss VAT, else the corrected code.
- {"kind":"note","sentence":"<one sentence in German>"} when the correction depends on something a rule cannot see (the item bought, the kind of invoice): the sentence goes in the partner's notes for whoever books its next payment.${partner.kind === 'payer' ? ' Not for a payer: answer none instead.' : ''}
- {"kind":"none"} when the correction is a one-off, or puts right a mistake of the app (a double booking, a wrong amount) rather than a practice.`;
}

const ACCOUNT = /^\d{3,6}$/;

/** Pure. The model's answer as the app takes it, or undefined: one JSON object of exactly the shapes the prompt names. */
export function parseLearnAnswer(raw: string): LearnAnswer | undefined {
  const m = /\{[\s\S]*\}/.exec(raw);
  let x: unknown;
  try { x = m ? JSON.parse(m[0]) : undefined; } catch { return undefined; }
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  if (o.kind === 'none') return { kind: 'none' };
  if (o.kind === 'note') {
    const s = typeof o.sentence === 'string' ? o.sentence.trim() : '';
    return s && s.length <= 300 && !s.includes('\n') ? { kind: 'note', sentence: s } : undefined;
  }
  if (o.kind !== 'rule' || !o.then || typeof o.then !== 'object') return undefined;
  const t = o.then as Record<string, unknown>;
  if (Object.keys(t).some((k) => k !== 'account' && k !== 'vat')) return undefined;
  if (typeof t.account !== 'string' || !ACCOUNT.test(t.account) || typeof t.vat !== 'string' || !t.vat) return undefined;
  return { kind: 'rule', then: { account: t.account, vat: t.vat === 'none' ? null : t.vat } };
}

/** Code's verdict on the model's answer: the rule to draft, the note to offer, or why nothing is offered. */
function checkAnswer(ws: Workspace, books: Books, c: Corrected, answer: LearnAnswer | undefined, context: ClassifyContext): { kind: 'rule'; match: HandMatch; booking: RuleBooking } | Exclude<LearnProposal, { kind: 'rule' }> {
  if (!answer) return { kind: 'none', why: 'invalid' };
  const { partner } = c.offer;
  if (answer.kind === 'none') return { kind: 'none', why: 'model' };
  if (answer.kind === 'note') return partner.kind === 'business' ? { kind: 'note', partner: partner.id, name: partner.name, sentence: answer.sentence } : { kind: 'none', why: 'model' };
  const booking: RuleBooking = { account: answer.then.account, vat: answer.then.vat };
  const raw = { id: 'learn', ...(partner.kind === 'payer' ? { when: { payer: partner.payer } } : {}), then: { account: booking.account, vat: booking.vat ?? 'none' } };
  if (!parseRule(raw, ruleFactsOf(ws), partner.kind === 'business').ok) return { kind: 'none', why: 'invalid' };
  const swiss = mappedReceipts(books, c.tx).some((r) => r.hasSwissVat);
  const asBooked: RuleLine[] = [{ account: c.offer.booked.account, ...(c.offer.booked.vat ? { vat: c.offer.booked.vat } : {}), amount: c.tx.amount }];
  if (!sameLines(ruleBookingLines(c.tx, booking, swiss, context.ownerAccount), asBooked)) return { kind: 'none', why: 'contradicts' };
  if (agreeing(books, c.partnerTxs, booking, context) < GENERAL) return { kind: 'none', why: 'oneOff' };
  return { kind: 'rule', match: partner.kind === 'business' ? { kind: 'business', id: partner.id } : { kind: 'payer', payer: partner.payer }, booking };
}

/**
 * POST /api/rules/learn: the model's draft for the corrected booking of `ref`, checked by code. A
 * rule is drafted into its file (the business's, else the company's booking guide with the payer as
 * its condition) with `source: correction <date>`, for the card; undefined when the booking teaches nothing.
 */
export async function proposeFromCorrection(ws: Workspace, ref: string, today = new Date().toISOString().slice(0, 10), model: (prompt: string, opts: AskOptions) => Promise<string> = ask): Promise<LearnProposal | undefined> {
  const books = loadBooks(ws);
  const context = loadClassifyContext(ws);
  const c = corrected(ws, books, ref, context);
  if (!c) return undefined;
  const raw = await model(learnPrompt(c, books, context), { step: 'learn.correction', model: LEARN_MODEL, timeoutMs: 120_000 });
  const verdict = checkAnswer(ws, books, c, parseLearnAnswer(raw), context);
  if (verdict.kind !== 'rule') return verdict;
  const drafted = draftHandRule(ws, { match: verdict.match, direction: c.tx.direction === 'CRDT' ? 'in' : 'out', account: verdict.booking.account, vat: verdict.booking.vat }, today, 'correction');
  return drafted.ok ? { kind: 'rule', path: drafted.path } : { kind: 'none', why: 'invalid' };
}
