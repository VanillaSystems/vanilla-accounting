/**
 * The company's booking rules that the app carries out itself (MISSION: «the AI turns a wish into a
 * rule, shows it plainly, and the person keeps it with one click»). Browser-safe and pure.
 *
 * A rule lives in the step `classify` of knowledge/rules/booking.guide.yaml, or in a business's
 * file under `steps: booking.guide.yaml#classify` (then it holds for that business only). It is
 * executable when its `then` is a map:
 *
 *   - id: swisscom-telefon
 *     then: { account: "6510", vat: 81 }               # book: this account at this rate (I81: the account gives the letter)
 *     source: wish 2026-10-15
 *   - id: barbezug-gross
 *     when: { text: "Bargeldbezug|Bancomat", direction: out, amount: { over: 500 } }
 *     then: { ask: "Wofür war der Barbezug?", account: "1000", vat: none }   # ask the person first
 *     source: wish 2026-10-15
 *
 * `when` takes counterparty (a business's file id), payer (the other party's IBAN or its
 * counterparty text as a key, src/knowledge/payer.ts: what an answered question keeps), text (a
 * pattern over the payment's text), direction (in, out), amount ({ over, under }, in the books'
 * currency) and account (the bank account that paid); all must hold. `then.private` (a percent)
 * books that share on the owner's account without VAT and the rest as the rule says.
 * `then.foreignTax` ({ rate, account }) splits a sale abroad that carried a foreign VAT (OSS, IOSS):
 * the tax at that rate onto that account without a code, the net on the rule's account at its zero
 * code, as a sales report books such an order (#206). A payment
 * provider's payout takes no rule: code books it from the provider's clearing account, and the sales
 * come from its sales report (src/booking/providers.ts, #203); `then.fees`, which split a payout into
 * sales and fees before, is refused. A rule whose `when` and `then` are sentences is a note for
 * the AI and people: it loads and shows, but nothing carries it out, so a new one is refused when
 * it is kept (src/saving/rules.ts).
 */
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { ibanKey, isGenericText, isPayer } from '../knowledge/payer.js';
import { chart, vat, withoutInputTax } from '../engines/index.js';
import { codeOfFacts, codeOnAccount, rateOf } from '../accounting/vat-codes.js';
import { parseTags, type Tags } from '../books/tags.js';

export const RULE_STEP = 'booking.guide.yaml#classify';
/** The step's id inside knowledge/rules/booking.guide.yaml. */
export const RULE_SECTION = 'classify';

export interface RuleWhen {
  counterparty?: string;
  payer?: string;
  text?: string;
  direction?: 'in' | 'out';
  amount?: { over?: number; under?: number };
  account?: string;
}

/**
 * A booking a rule makes or proposes; `vat` null: no VAT code (a private share, a transfer).
 * `private`: this percent of the payment is the owner's, on the owner's account without VAT; the
 * rest goes on `account` with `vat` («das Natel ist zur Hälfte privat»: private 50).
 * `foreignTax`: the payment holds a foreign VAT at `rate` percent, booked onto `account` without a code;
 * the rest goes on `account` with `vat`, a zero code (a sale abroad, never the gross at it).
 * `tags`: the reporting dimensions every line it books carries ({ projekt: "alpha" }, #127).
 */
export interface RuleBooking { account: string; vat: string | null; private?: number; foreignTax?: { rate: number; account: string }; tags?: Tags }

export type RuleThen =
  | { kind: 'book'; booking: RuleBooking }
  | { kind: 'ask'; question: string; booking?: RuleBooking };

export interface BookingRule {
  id: string;
  when: RuleWhen;
  then: RuleThen;
  off: boolean;
  source?: string;
  why?: string;
  /** The sentence of the partner's notes the rule carries out, quoted as it stood when the rule was kept (`source: notes <date>`). */
  note?: string;
}

import type { RuleRefusal } from '../types/rule-refusal.js';
export type { RuleRefusal };

export type RefusalCode = RuleRefusal['code'];

/** Whether a VAT code is one the firm books with: unknown to the app, or known but not taken by this firm's form. */
export type VatTaken = 'taken' | 'unknown' | 'notTaken';

/** What the rule's `then` and `when` may name: the chart, the VAT codes, the businesses. */
export interface RuleFacts {
  account(number: string): boolean;
  vat(code: string): VatTaken;
  counterparty(id: string): boolean;
  /** Whether the workspace declares this reporting dimension (#127); absent: it declares none. */
  dimension?(id: string): boolean;
}

const WHEN_KEYS = new Set(['counterparty', 'payer', 'text', 'direction', 'amount', 'account']);
const THEN_KEYS = new Set(['account', 'vat', 'ask', 'private', 'foreignTax', 'fees', 'tags']);
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

/** A rule as written: executable (its `then` is a map) or a note (sentences). */
export const isExecutable = (raw: { then?: unknown }): boolean => isMap(raw.then);

/**
 * Parses one rule as written. `inBusiness`: it stands in a business's file, so it needs no
 * condition of its own. Every refusal says what the person or the AI must change.
 */
export function parseRule(raw: Record<string, unknown>, facts: RuleFacts, inBusiness = false): { ok: true; rule: BookingRule } | { ok: false; refusal: RuleRefusal } {
  const no = (refusal: RuleRefusal) => ({ ok: false as const, refusal });
  if (!isExecutable(raw)) return no({ code: 'prose' });
  const id = text(raw.id);
  if (!id) return no({ code: 'noId' });
  const w = raw.when === undefined || raw.when === null ? {} : raw.when;
  if (!isMap(w)) return no({ code: 'prose' });
  const t = raw.then as Record<string, unknown>;
  for (const k of Object.keys(w)) if (!WHEN_KEYS.has(k)) return no({ code: 'field', params: { field: `when.${k}` } });
  for (const k of Object.keys(t)) if (!THEN_KEYS.has(k)) return no({ code: 'field', params: { field: `then.${k}` } });
  // A payout's split into sales and fees is the provider's clearing account now (#203): the rule that said it is refused, saying where it went.
  if (t.fees !== undefined) return no({ code: 'fees' });

  const when: RuleWhen = {};
  if (w.counterparty !== undefined) {
    const c = text(w.counterparty);
    if (!c || !facts.counterparty(c)) return no({ code: 'counterparty', params: { counterparty: String(w.counterparty) } });
    when.counterparty = c;
  }
  if (w.payer !== undefined) {
    const p = text(w.payer);
    if (!p || (!ibanKey(p) && isGenericText(p))) return no({ code: 'payer', params: { payer: String(w.payer) } });
    when.payer = p;
  }
  if (w.text !== undefined) {
    const p = text(w.text);
    try { if (!p) throw new Error(); new RegExp(p, 'i'); } catch { return no({ code: 'pattern', params: { text: String(w.text) } }); }
    when.text = p;
  }
  if (w.direction !== undefined) {
    if (w.direction !== 'in' && w.direction !== 'out') return no({ code: 'direction', params: { direction: String(w.direction) } });
    when.direction = w.direction;
  }
  if (w.amount !== undefined) {
    if (!isMap(w.amount)) return no({ code: 'amount' });
    const { over, under, ...rest } = w.amount;
    const ok = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
    if (Object.keys(rest).length || !ok(over) || !ok(under) || (over === undefined && under === undefined)) return no({ code: 'amount' });
    if (typeof over === 'number' && typeof under === 'number' && over >= under) return no({ code: 'amount' });
    when.amount = { ...(over !== undefined ? { over: over as number } : {}), ...(under !== undefined ? { under: under as number } : {}) };
  }
  if (w.account !== undefined) {
    const a = text(w.account);
    if (!a || !facts.account(a)) return no({ code: 'account', params: { account: String(w.account) } });
    when.account = a;
  }
  if (!inBusiness && !Object.keys(when).length) return no({ code: 'noCondition' });

  // The code before the account: a code this firm cannot book with is the reason the person must hear, whatever the account (r7f-32).
  // A rate («81», «8.1») names no code until the account does (issue #64).
  const rated = (v: string | undefined) => (v && facts.vat(v) === 'unknown' ? rateOf(v) : undefined);
  const code = (v: string | undefined): RuleRefusal | undefined => {
    if (!v) return { code: 'vat', params: { vat: '' } };
    if (rated(v) !== undefined) return undefined;
    const taken = facts.vat(v);
    if (taken === 'unknown') return { code: 'vat', params: { vat: v } };
    if (taken === 'notTaken') return { code: 'codeNotTaken', params: { vat: v, method: withoutInputTax() ?? 'none' } };
    return undefined;
  };
  // What the rule books on its account: a rate's code there, or its code with the letter the account takes (pv-prefix-from-account).
  const onAccount = (v: string, account: string): { code: string } | { refusal: RuleRefusal } => {
    const rate = rated(v);
    const derived = rate === undefined ? codeOnAccount(v, account, account) ?? v : codeOfFacts({ charge: rate > 0 ? 'charged' : 'none', rate }, account, account);
    if (!derived) return { refusal: { code: 'vat', params: { vat: v } } };
    const refused = code(derived);
    return refused ? { refusal: refused } : { code: derived };
  };
  let booking: RuleBooking | undefined;
  if (t.account !== undefined || t.vat !== undefined) {
    const v = text(t.vat);
    const refused = v?.toLowerCase() === 'none' ? undefined : code(v);
    if (refused) return no(refused);
    const account = text(t.account);
    if (!account || !facts.account(account)) return no({ code: 'account', params: { account: String(t.account ?? '') } });
    if (!chart().isPlaced(account)) return no({ code: 'unplaced', params: { account, classes: chart().placedClasses } });
    const vat = v!.toLowerCase() === 'none' ? null : onAccount(v!, account);
    if (vat && 'refusal' in vat) return no(vat.refusal);
    booking = { account, vat: vat && vat.code };
  }
  if (t.private !== undefined) {
    const share = typeof t.private === 'number' ? t.private : Number(String(t.private).replace(/\s*%$/, ''));
    if (!booking || !Number.isFinite(share) || share <= 0 || share >= 100) return no({ code: 'share', params: { share: String(t.private) } });
    booking.private = share;
  }
  if (t.foreignTax !== undefined) {
    const f = isMap(t.foreignTax) ? t.foreignTax : {};
    const rate = typeof f.rate === 'number' ? f.rate : Number(String(f.rate ?? '').replace(/\s*%$/, ''));
    const account = text(f.account);
    const said = isMap(t.foreignTax) ? JSON.stringify(t.foreignTax) : String(t.foreignTax);
    // Foreign VAT is split off a sale abroad: the rest at a zero code, never with a private share beside it.
    const zero = !booking?.vat || (vat().codes.parse(booking.vat)?.rate ?? 0) === 0;
    if (!booking || booking.private || !zero || Object.keys(f).some((k) => k !== 'rate' && k !== 'account') || !Number.isFinite(rate) || rate <= 0 || rate >= 100 || !account) return no({ code: 'foreignTax', params: { value: said } });
    if (!facts.account(account)) return no({ code: 'account', params: { account } });
    if (!chart().isPlaced(account)) return no({ code: 'unplaced', params: { account, classes: chart().placedClasses } });
    booking.foreignTax = { rate, account };
  }
  if (t.tags !== undefined) {
    // Tags ride on the booking the rule makes or proposes: without one there is nothing to carry them.
    if (!booking) return no({ code: 'outcome' });
    const declared = Object.keys(isMap(t.tags) ? t.tags : {}).filter((d) => facts.dimension?.(d)).map((id) => ({ id }));
    const tags = parseTags(t.tags, declared);
    if (!tags.ok) return no(tags.refusal.code === 'tagDimension' ? { code: 'dimension', params: { dimension: tags.refusal.params.dimension } } : { code: 'tags' });
    if (tags.tags) booking.tags = tags.tags;
  }
  let then: RuleThen;
  if (t.ask !== undefined) {
    const question = text(t.ask);
    if (!question) return no({ code: 'question' });
    then = { kind: 'ask', question, ...(booking ? { booking } : {}) };
  } else if (booking) then = { kind: 'book', booking };
  else return no({ code: 'outcome' });

  return {
    ok: true,
    rule: {
      id, when, then, off: raw.off === true,
      ...(text(raw.source) ? { source: text(raw.source) } : {}),
      ...(text(raw.why) ? { why: text(raw.why) } : {}),
      ...(typeof raw.note === 'string' && raw.note.trim() ? { note: raw.note.trim() } : {}),
    },
  };
}

/** An entry a rule booked, named by the rule and carrying the rule's tags. */
export const stampRule = <E extends JournalEntry>(e: E, rule: string, booking: Pick<RuleBooking, 'tags'>): E => ({ ...e, rule, ...(booking.tags && { tags: booking.tags }) });

/** What a payment offers a rule: its text, the business it routes to, the bank account that paid, its amount in the books' currency. */
export interface PaymentFacts {
  tx: Pick<BankTransaction, 'description' | 'counterparty' | 'counterpartyIban' | 'direction'>;
  counterparty?: string;
  bankAccount: string;
  amount: number;
}

/** A rule where it stands: the business whose file holds it, if any. */
export interface PlacedRule { rule: BookingRule; business?: string }

/** Whether a rule holds for a payment. A business's rule holds only for a payment of that business. */
export function holds({ rule, business }: PlacedRule, p: PaymentFacts): boolean {
  const w = rule.when;
  if (business && p.counterparty !== business) return false;
  if (w.counterparty && p.counterparty !== w.counterparty) return false;
  if (w.payer && !isPayer(w.payer, p.tx)) return false;
  if (w.text && !new RegExp(w.text, 'i').test(`${p.tx.description} ${p.tx.counterparty ?? ''}`)) return false;
  if (w.direction && w.direction !== (p.tx.direction === 'CRDT' ? 'in' : 'out')) return false;
  const amount = Math.abs(p.amount);
  if (w.amount?.over !== undefined && !(amount > w.amount.over)) return false;
  if (w.amount?.under !== undefined && !(amount < w.amount.under)) return false;
  if (w.account && w.account !== p.bankAccount) return false;
  return true;
}

/**
 * The single words a rule rests on when nothing else anchors it: a general rule (not in a
 * business's file) without a business, payer or amount whose text pattern has an alternative of
 * one word («Werbung»). Such a word also stands in bills nobody meant (wishes3-2), so keeping the
 * rule asks the person to look at the payments it matches first. Empty: the rule is anchored.
 */
export function loneWords({ rule, business }: PlacedRule): string[] {
  const w = rule.when;
  if (business || w.counterparty || w.payer || w.amount || !w.text) return [];
  return w.text.split('|').map((x) => x.trim()).filter((x) => /^[\p{L}\p{N}.&'-]+$/u.test(x));
}

/**
 * The rule that decides a payment: of the rules switched on that hold, a question first (asking
 * is the safe outcome when two rules meet), then a business's own rule, then the company's
 * general ones, each in file order.
 */
export function ruleFor(rules: readonly PlacedRule[], p: PaymentFacts): PlacedRule | undefined {
  const on = rules.filter((r) => !r.rule.off && holds(r, p));
  const rank = (r: PlacedRule) => (r.rule.then.kind === 'ask' ? 0 : r.business ? 1 : 2);
  return on.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)[0]?.r;
}

// ─── The rule in plain words ─────────────────────────────────────────────────

/** The dictionary keys a rule is said with (src/app/i18n/locales/*.ts), and what each fills in. */
export interface RuleWordVars {
  'rules.say.text': { text: string };
  'rules.say.payer': { payer: string };
  'rules.say.in': Record<string, never>;
  'rules.say.out': Record<string, never>;
  'rules.say.over': { amount: string };
  'rules.say.under': { amount: string };
  'rules.say.between': { over: string; under: string };
  'rules.say.account': { account: string };
  'rules.say.or': Record<string, never>;
  'rules.say.any': Record<string, never>;
  'rules.say.book': { account: string; vat: string };
  'rules.say.bookNoVat': { account: string };
  'rules.say.private': { percent: string };
  'rules.say.foreignTax': { rate: string; account: string };
  'rules.say.ask': { question: string };
  'rules.say.tags': { tags: string };
  'rules.say.askWith': { question: string; booking: string };
}
export type RuleWordKey = keyof RuleWordVars;
export type RuleWords = <K extends RuleWordKey>(key: K, vars: RuleWordVars[K]) => string;

/** Names the plain words use: an account with its name, a business by its name, a payer by its name, an amount in the books' currency. */
export interface RuleNames {
  account(number: string): string | undefined;
  business(id: string): string | undefined;
  /** The payer `when.payer` names (an IBAN or a counterparty key), when the books know them. */
  payer?(key: string): string | undefined;
  money(amount: number): string;
  /** A tag as it reads: «Projekt Alpha» for { projekt: "alpha" }; absent: dimension id and value as written. */
  tag?(dimension: string, value: string): string | undefined;
  /** A VAT code as it reads: «Operating expense 8.1 % (VAT included) · I81»; absent: the code as written. */
  vat?(code: string): string;
}

/** «Bargeldbezug» or «Bancomat»: a pattern of plain words separated by | reads as alternatives; any other pattern as written. */
function patternWords(p: string, w: RuleWords): string {
  const parts = p.split('|');
  return parts.every((x) => /^[\p{L}\p{N} .&'-]+$/u.test(x)) ? parts.map((x) => `«${x.trim()}»`).join(w('rules.say.or', {})) : `«${p}»`;
}

const accountWords = (n: string, names: RuleNames) => { const name = names.account(n); return name ? `${n} ${name}` : n; };

export function bookingWords(b: RuleBooking, names: RuleNames, w: RuleWords): string {
  const main = b.vat ? w('rules.say.book', { account: accountWords(b.account, names), vat: names.vat?.(b.vat) ?? b.vat }) : w('rules.say.bookNoVat', { account: accountWords(b.account, names) });
  const tags = b.tags ? w('rules.say.tags', { tags: Object.entries(b.tags).map(([d, v]) => names.tag?.(d, v) ?? `${d}: ${v}`).join(', ') }) : '';
  const foreign = b.foreignTax ? w('rules.say.foreignTax', { rate: String(b.foreignTax.rate), account: accountWords(b.foreignTax.account, names) }) : '';
  return `${b.private ? `${main}${w('rules.say.private', { percent: String(b.private) })}` : main}${foreign}${tags}`;
}

/** The rule in one line: «Swisscom → Konto 6510 Telefon» and its VAT code. */
export function ruleWords({ rule, business }: PlacedRule, names: RuleNames, w: RuleWords): { when: string; then: string; line: string } {
  const c = rule.when;
  const who = business ?? c.counterparty;
  const parts = [
    who && (names.business(who) ?? who),
    c.payer && w('rules.say.payer', { payer: names.payer?.(c.payer) ?? c.payer }),
    c.text && w('rules.say.text', { text: patternWords(c.text, w) }),
    c.direction && w(c.direction === 'in' ? 'rules.say.in' : 'rules.say.out', {}),
    c.amount?.over !== undefined && c.amount.under !== undefined
      ? w('rules.say.between', { over: names.money(c.amount.over), under: names.money(c.amount.under) })
      : c.amount?.over !== undefined ? w('rules.say.over', { amount: names.money(c.amount.over) })
        : c.amount?.under !== undefined ? w('rules.say.under', { amount: names.money(c.amount.under) }) : undefined,
    c.account && w('rules.say.account', { account: accountWords(c.account, names) }),
  ].filter((x): x is string => !!x);
  const when = parts.length ? parts.join(', ') : w('rules.say.any', {});
  const t = rule.then;
  const then = t.kind === 'book' ? bookingWords(t.booking, names, w)
    : t.booking ? w('rules.say.askWith', { question: t.question, booking: bookingWords(t.booking, names, w) })
      : w('rules.say.ask', { question: t.question });
  return { when, then, line: `${when} → ${then}` };
}
