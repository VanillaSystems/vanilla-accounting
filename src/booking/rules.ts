/**
 * The company's booking rules that the app carries out itself (MISSION: «the AI turns a wish into a
 * rule, shows it plainly, and the person keeps it with one click»). Browser-safe and pure.
 *
 * A rule lives in the step `classify` of knowledge/rules/booking.guide.yaml, or in a business's
 * file under `steps: booking.guide.yaml#classify` (then it holds for that business only). It is
 * executable when its `then` is a map:
 *
 *   - id: swisscom-telefon
 *     then: { account: "6510", vat: I81 }              # book: this account, this VAT code
 *     source: wish 2026-10-15
 *   - id: barbezug-gross
 *     when: { text: "Bargeldbezug|Bancomat", direction: out, amount: { over: 500 } }
 *     then: { ask: "Wofür war der Barbezug?", account: "1000", vat: none }   # ask the person first
 *     source: wish 2026-10-15
 *
 * `when` takes counterparty (a business's file id), payer (the other party's IBAN or its
 * counterparty text as a key, src/knowledge/payer.ts: what an answered question keeps), text (a
 * pattern over the payment's text), direction (in, out), amount ({ over, under }, in the books'
 * currency) and account (the bank account that paid); all must hold. A rule whose `when` and
 * `then` are sentences is a note for
 * the AI and people: it loads and shows, but nothing carries it out, so a new one is refused when
 * it is kept (src/saving/rules.ts).
 */
import type { BankTransaction } from '../types/index.js';
import { ibanKey, isGenericText, isPayer } from '../knowledge/payer.js';

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

/** A booking a rule makes or proposes; `vat` null: no VAT code (a private share, a transfer). */
export interface RuleBooking { account: string; vat: string | null }

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
}

/** Why a rule cannot be carried out; the UI words each code (`rules.refuse.<code>`). */
export type RuleRefusal =
  | { code: 'prose' }
  | { code: 'noId' }
  | { code: 'noCondition' }
  | { code: 'field'; params: { field: string } }
  | { code: 'outcome' }
  | { code: 'question' }
  | { code: 'account'; params: { account: string } }
  | { code: 'vat'; params: { vat: string } }
  | { code: 'pattern'; params: { text: string } }
  | { code: 'amount' }
  | { code: 'direction'; params: { direction: string } }
  | { code: 'counterparty'; params: { counterparty: string } }
  | { code: 'payer'; params: { payer: string } };

export type RefusalCode = RuleRefusal['code'];

/** What the rule's `then` and `when` may name: the chart, the VAT codes, the businesses. */
export interface RuleFacts {
  account(number: string): boolean;
  vat(code: string): boolean;
  counterparty(id: string): boolean;
}

const WHEN_KEYS = new Set(['counterparty', 'payer', 'text', 'direction', 'amount', 'account']);
const THEN_KEYS = new Set(['account', 'vat', 'ask']);
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

  let booking: RuleBooking | undefined;
  if (t.account !== undefined || t.vat !== undefined) {
    const account = text(t.account);
    if (!account || !facts.account(account)) return no({ code: 'account', params: { account: String(t.account ?? '') } });
    const v = text(t.vat);
    if (!v) return no({ code: 'vat', params: { vat: '' } });
    if (v.toLowerCase() !== 'none' && !facts.vat(v)) return no({ code: 'vat', params: { vat: v } });
    booking = { account, vat: v.toLowerCase() === 'none' ? null : v };
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
    },
  };
}

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
  'rules.say.ask': { question: string };
  'rules.say.askWith': { question: string; booking: string };
}
export type RuleWordKey = keyof RuleWordVars;
export type RuleWords = <K extends RuleWordKey>(key: K, vars: RuleWordVars[K]) => string;

/** Names the plain words use: an account with its name, a business by its name, an amount in the books' currency. */
export interface RuleNames {
  account(number: string): string | undefined;
  business(id: string): string | undefined;
  money(amount: number): string;
}

/** «Bargeldbezug» or «Bancomat»: a pattern of plain words separated by | reads as alternatives; any other pattern as written. */
function patternWords(p: string, w: RuleWords): string {
  const parts = p.split('|');
  return parts.every((x) => /^[\p{L}\p{N} .&'-]+$/u.test(x)) ? parts.map((x) => `«${x.trim()}»`).join(w('rules.say.or', {})) : `«${p}»`;
}

const accountWords = (n: string, names: RuleNames) => { const name = names.account(n); return name ? `${n} ${name}` : n; };

function bookingWords(b: RuleBooking, names: RuleNames, w: RuleWords): string {
  return b.vat ? w('rules.say.book', { account: accountWords(b.account, names), vat: b.vat }) : w('rules.say.bookNoVat', { account: accountWords(b.account, names) });
}

/** The rule in one line: «Swisscom → Konto 6510 Telefon» and its VAT code. */
export function ruleWords({ rule, business }: PlacedRule, names: RuleNames, w: RuleWords): { when: string; then: string; line: string } {
  const c = rule.when;
  const who = business ?? c.counterparty;
  const parts = [
    who && (names.business(who) ?? who),
    c.payer && w('rules.say.payer', { payer: c.payer }),
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
