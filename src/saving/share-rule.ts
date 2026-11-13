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
import { bankAccountFor } from '../workspace/money-accounts.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { paymentSides } from '../accounting/payment-entries.js';
import { loadBooks, periodLock, type Books } from '../books/store.js';
import { handOwnUse, loadClassifyContext, ownUseCode, paymentFacts, ruleBookingLines, ruleOfPayment, mappedReceipts, type ClassifyContext } from '../booking/classify.js';
import { OWN_USE, RULE_SECTION, RULE_STEP, type RuleBooking } from '../booking/rules.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { homeOf, RULES_DIR } from '../knowledge/layers.js';
import { payerKey, payerNames } from '../knowledge/payer.js';
import type { Workspace } from '../workspace/workspace.js';
import { draftDir } from './changes.js';
import { readProgress, setShares } from '../onboarding/store.js';
import { loadChart } from '../workspace/chart.js';
import { setup } from '../engines/index.js';

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
  /** The offer comes from the setup (#402): the share the person named there for this kind of private use, with her words. */
  setup?: { item: 'car' | 'phone'; said: string };
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

/** A payment's bookings as split: the business part's account and code, the owner's share in money, and whether it is own use; `setup`: a share the setup named, not booked yet. */
interface Split { account: string; vat: string | undefined; share: number; ownUse: boolean; setup?: { item: 'car' | 'phone'; said: string } }

/**
 * A payment out booked whole, in one line against the bank, on the account of a kind of private use
 * (setup.yaml `privateUse`: the phone's, the car's) whose share the person named in the setup
 * (onboarding.json `shares`, #402): that share, offered as the rule of its business on its card.
 */
/** Whether the firm's own chart names `account` as the module's chart does: a firm that uses the number for something else gets no offer. */
function sameAccount(ws: Workspace, account: string): boolean {
  const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const theirs = existsSync(ws.paths.accounts) ? (JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as Array<{ number: string; name?: string }>).find((a) => a.number === account) : undefined;
  const ours = loadChart().accounts.find((a) => a.number === account);
  return !theirs || !ours || norm(theirs.name) === norm(ours.name);
}

function setupSplit(ws: Workspace, tx: BankTransaction, entries: readonly JournalEntry[], bank: string): Split | undefined {
  const shares = readProgress(ws).shares;
  const pays = entries.filter((e) => e.accountDebit === bank || e.accountCredit === bank);
  if (!shares || tx.direction !== 'DBIT' || pays.length !== 1 || entries.length !== 1) return undefined;
  const account = pays[0].accountDebit === bank ? pays[0].accountCredit : pays[0].accountDebit;
  // The phone's only: a car's costs come from many businesses (each petrol station), so its share stays the year close's (#402).
  if (setup().privateUse?.phone !== account || !shares.phone || !sameAccount(ws, account)) return undefined;
  const { percent, said } = shares.phone;
  return { account, vat: pays[0].vatCode, share: (tx.amount * percent) / 100, ownUse: false, setup: { item: 'phone', said } };
}

/**
 * The split `entries` (a payment's bookings) show: two bookings against the bank, one on the
 * owner's account without VAT; or one booking against the bank with input tax and one own-use
 * correction of it (owner's account / that account with the private-use code), booked with the
 * payment or by hand on a ref of its own (handOwnUse), as the owner books Eigenverbrauch.
 */
function splitOf(books: Books, tx: BankTransaction, entries: readonly JournalEntry[], bank: string, owner: string): Split | undefined {
  const other = (e: JournalEntry) => (e.accountDebit === bank ? e.accountCredit : e.accountCredit === bank ? e.accountDebit : undefined);
  const pays = entries.filter((e) => other(e) !== undefined);
  if (pays.length === 2) {
    const own = pays.find((e) => other(e) === owner && !e.vatCode);
    const biz = pays.find((e) => e !== own);
    const account = biz && other(biz);
    return own && biz && account && account !== owner && entries.length === 2 ? { account, vat: biz.vatCode, share: own.amount, ownUse: false } : undefined;
  }
  const biz = pays.length === 1 ? pays[0] : undefined;
  const account = biz && other(biz);
  const code = ownUseCode(biz?.vatCode);
  if (!biz || !account || account === owner || !code) return undefined;
  const [debit, credit] = tx.direction === 'DBIT' ? [owner, account] : [account, owner];
  const inside = entries.filter((e) => e !== biz && e.accountDebit === debit && e.accountCredit === credit && e.vatCode === code);
  const corrections = [...inside, ...handOwnUse(books, tx, { account: owner, against: account, vat: code })];
  return corrections.length === 1 && entries.length === 1 + inside.length ? { account, vat: biz.vatCode, share: corrections[0].amount, ownUse: true } : undefined;
}

/**
 * The payment an own-use correction booked by hand on a ref of its own corrects (`ref` is that
 * ref): the one payment of its day it corrects (handOwnUse). Undefined for any other ref.
 */
function paymentOfCorrection(books: Books, ref: string, owner: string): BankTransaction | undefined {
  const own = books.journalEntries.filter((e) => e.transactionRef === ref);
  const e = own.length === 1 && own[0].vatCode ? own[0] : undefined;
  if (!e) return undefined;
  const hits = books.transactions.filter((tx) => tx.date === e.date && handOwnUse(books, tx, { account: owner, against: tx.direction === 'DBIT' ? e.accountCredit : e.accountDebit, vat: e.vatCode }).includes(e)
    && books.journalEntries.some((p) => p.transactionRef === tx.ref && (p.accountDebit === e.accountCredit || p.accountCredit === e.accountDebit)));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The share rule `ref`'s bookings show, when they are a split (splitOf), at a whole percent the
 * rule books again (to the cent, but for the odd cent of an uneven half). `ref` may also be an
 * own-use correction booked by hand: the offer is then its payment's. None when a rule already books it that way.
 */
export function shareOffer(ws: Workspace, books: Books, ref: string, context: ClassifyContext = loadClassifyContext(ws)): ShareOffer | undefined {
  const owner = context.ownerAccount;
  const tx = books.transactions.find((t) => t.ref === ref) ?? (owner ? paymentOfCorrection(books, ref, owner) : undefined);
  if (!tx || !owner || periodLock(books).isClosed(tx.date)) return undefined;
  const bank = bankAccountFor(tx, context.bankAccounts);
  const entries = books.journalEntries.filter((e) => e.transactionRef === tx.ref);
  if (paymentSides(books, tx.ref, context.bankAccounts).some((s) => s.booked !== s.paid)) return undefined;
  const split = splitOf(books, tx, entries, bank, owner) ?? setupSplit(ws, tx, entries, bank);
  if (!split) return undefined;
  const { account } = split;
  const percent = Math.round((split.share / tx.amount) * 100);
  const booking: RuleBooking = { account, vat: ruleCode(split.vat), private: percent, ...(split.ownUse ? { ownUse: true as const } : {}) };
  if (percent <= 0 || percent >= 100) return undefined;
  const lines = ruleBookingLines(tx, booking, mappedReceipts(books, tx), owner, books);
  // A whole percent: the rule books the split again, give or take the odd cent of an uneven half (a setup's share is no split yet).
  if (!split.setup && (!lines[1] || Math.abs(Math.round(lines[1].amount * 100) - Math.round(split.share * 100)) > 1)) return undefined;
  const fx = loadFxResolver();
  const ruled = ruleOfPayment(books, tx, context, fx)?.rule.then;
  if (ruled?.kind === 'book' && ruled.booking.private === percent && !!ruled.booking.ownUse === split.ownUse && ruled.booking.account === account) return undefined;
  // The setup's share is offered while no rule books the payment privately; a rule that does (any share) was her answer to it.
  if (split.setup && ruled?.kind === 'book' && ruled.booking.private !== undefined) return undefined;
  const setup = split.setup ? { setup: split.setup } : {};
  const id = paymentFacts(books, tx, context, fx).counterparty;
  const cp = id ? context.counterparties?.find((c) => c.id === id) : undefined;
  if (split.setup) {
    // Once per business: on its first payment booked on the account, never after «Nicht jetzt» (#402).
    const key = cp?.id ?? payerKey(tx);
    if (!key || readProgress(ws).shares?.phone?.dismissed?.includes(key)) return undefined;
    const keyOf = (t: BankTransaction) => (cp ? paymentFacts(books, t, context, fx).counterparty : payerKey(t));
    const onAccount = (t: BankTransaction) => books.journalEntries.some((e) => e.transactionRef === t.ref && (e.accountDebit === account || e.accountCredit === account));
    const first = books.transactions.filter((t) => t.direction === 'DBIT' && onAccount(t) && keyOf(t) === key).sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref))[0];
    if (first?.ref !== tx.ref) return undefined;
  }
  if (cp) return { ref: tx.ref, percent, booking, business: { id: cp.id, name: cp.name }, path: homeOf('workspace', cp.role, cp.id), ...setup };
  const payer = payerKey(tx);
  return payer ? { ref: tx.ref, percent, booking, payer, payerName: payerNames([tx])[payer] ?? payer, path: `${RULES_DIR}/booking.guide.yaml`, ...setup } : undefined;
}

/** The text of `path` with the offer's rule in it: a business's own rule takes the share, else a new rule is added. */
export function withShareRule(text: string, offer: ShareOffer, today: string): string {
  const doc = parseDocument(text || (offer.business ? `id: ${offer.business.id}\n` : 'process: booking\n'));
  const section = offer.business ? RULE_STEP : RULE_SECTION;
  const then = { account: offer.booking.account, vat: offer.booking.vat ?? 'none', private: offer.booking.ownUse ? { share: offer.percent, as: OWN_USE } : offer.percent };
  // A share she named in the setup is her wish; a split she booked, her correction (AGENTS.md: source).
  const source = `${offer.setup ? 'wish' : 'correction'} ${today}`;
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

/** A share the setup named, offered as a rule on the payment `ref` and not answered yet (#428). */
export interface PendingOffer { ref: string; date: string; name: string; percent: number; account: string }

/**
 * The setup's shares offered and not answered yet (#428): for each business, the payment that
 * offers its rule (shareOffer with `setup`), as «was muss ich noch machen?» names it. Only payments
 * booked on the account of the private use the setup named are asked; none while it named none.
 */
export function setupShareOffers(ws: Workspace, books: Books, given?: ClassifyContext): PendingOffer[] {
  const account = setup().privateUse?.phone;
  if (!account || !readProgress(ws).shares?.phone) return [];
  const context = given ?? loadClassifyContext(ws);
  const lock = periodLock(books);
  const on = new Set(books.journalEntries.filter((e) => e.accountDebit === account || e.accountCredit === account).map((e) => e.transactionRef));
  return books.transactions
    .filter((t) => t.direction === 'DBIT' && on.has(t.ref) && !lock.isClosed(t.date))
    .flatMap((t): PendingOffer[] => {
      const o = shareOffer(ws, books, t.ref, context);
      return o?.setup ? [{ ref: o.ref, date: t.date, name: o.business?.name ?? o.payerName ?? o.payer ?? '', percent: o.percent, account: o.booking.account }] : [];
    });
}

/** «Nicht jetzt» on the setup's offer (#402): not offered again for this payment's business; `never`: the share goes, no business is offered it again. */
export function dismissSetupShare(ws: Workspace, ref: string, never = false): boolean {
  const offer = shareOffer(ws, loadBooks(ws), ref);
  const shares = readProgress(ws).shares;
  if (!offer?.setup || !shares?.phone) return false;
  if (never) { const { phone: _p, ...rest } = shares; setShares(ws, rest); return true; }
  const key = offer.business?.id ?? offer.payer!;
  setShares(ws, { ...shares, phone: { ...shares.phone, dismissed: [...new Set([...(shares.phone.dismissed ?? []), key])] } });
  return true;
}

/** After a keep (#402): the setup's phone share goes once a company rule books a private share on the phone's account; it did its job. */
export function clearTakenShares(ws: Workspace, context: ClassifyContext = loadClassifyContext(ws)): void {
  const shares = readProgress(ws).shares;
  const account = setup().privateUse?.phone;
  if (!shares?.phone || !account) return;
  const taken = (context.rules ?? []).some((p) => p.rule.then.kind === 'book' && p.rule.then.booking.account === account && p.rule.then.booking.private !== undefined);
  if (!taken) return;
  const { phone: _p, ...rest } = shares;
  setShares(ws, rest);
}
