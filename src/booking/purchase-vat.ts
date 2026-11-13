/**
 * The input-tax code of the model's purchase lines, decided in code where the shipped knowledge
 * decides it (issue #45: most misses that needed Swiss knowledge had it shipped and unapplied).
 *
 * Two sources:
 * - a business's file states as `apply:` on a rule of booking.guide.yaml#purchase_vat what code
 *   carries out (BusinessFact): the app layer (processes/) a fact true for every company, that its
 *   payouts claim no input tax; the company layer (knowledge/) the company's own choice, that the
 *   business's receipt that could not be read counts as Swiss VAT at a rate (a risk only the
 *   company takes, so no shipped file states it);
 * - booking.guide.yaml#purchase_vat itself: the receipt decides the code (pv-no-receipt,
 *   pv-charged, pv-otherwise), the proposal the evidence check shows a person
 *   (src/accounting/evidence-check.ts), carried out at booking only where it cannot be wrong.
 * A rule without `apply:` (a choice, a case to ask about) stays the model's. A business whose file
 * in the company's knowledge/ has rules of its own for the step keeps the model's code: the
 * company's word goes before the app's, unless that file states such a choice itself. The company's executable rules book before the model and
 * a person's booking is never classified, so neither reaches this.
 */
import { evidenceCheck, isPurchaseDocument, lineReceipts } from '../accounting/evidence-check.js';
import { formTakes, lookupVatCode } from '../accounting/vat-codes.js';
import { isUnreadable, vatNotRead } from '../accounting/receipt-due.js';
import { baseCurrency, vat, yearEnd } from '../engines/index.js';
import { wordsIn } from '../export/texts.js';
import { identify, signalsOfTransaction, type Counterparty } from '../knowledge/counterparties.js';
import type { Knowledge, Layer } from '../knowledge/layers.js';
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';

export const PURCHASE_VAT_STEP = 'booking.guide.yaml#purchase_vat';

/** What a business's file states about input tax, as code carries it out: noInputTax in the app layer, unreadReceipt in the company's. */
export type VatFact =
  /** Its purchase lines claim no input tax on such a payment: the tax is proven and claimed elsewhere (a monthly bill). */
  | { kind: 'noInputTax' }
  /** Its receipt that was not read shows Swiss VAT at this rate on its whole amount. */
  | { kind: 'unreadReceipt'; rate: number };

/** A fact of one business's file: its rule id, and the direction of the payments it holds for. */
export interface BusinessFact { rule: string; business: string; direction?: 'in' | 'out'; fact: VatFact }

/** The facts by business, and the businesses whose company file decides the step itself. */
export interface BusinessVat { facts: ReadonlyMap<string, readonly BusinessFact[]>; companyDecides: ReadonlySet<string> }

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A rule's `apply:` as written in a business file of `layer`: in the app layer
 * `{ inputTax: none, direction: in }`, a fact; in the company's `{ unreadReceipt: 8.1 }`, its choice.
 * The lint (check-processes) reports the problem; the loader skips such a rule.
 */
export function parseApply(raw: unknown, layer: Layer): { ok: true; fact: VatFact; direction?: 'in' | 'out' } | { ok: false; problem: string } {
  const form = layer === 'app' ? '{ inputTax: none }' : '{ unreadReceipt: <rate> }';
  if (!isMap(raw)) return { ok: false, problem: `apply must be a map: ${form}` };
  const { inputTax, unreadReceipt, direction, ...rest } = raw;
  const extra = Object.keys(rest)[0];
  if (extra) return { ok: false, problem: `apply.${extra} is unknown — apply takes inputTax, unreadReceipt and direction` };
  if (direction !== undefined && direction !== 'in' && direction !== 'out') return { ok: false, problem: 'apply.direction must be in or out' };
  const dir = direction === undefined ? {} : { direction: direction as 'in' | 'out' };
  if ((inputTax === undefined) === (unreadReceipt === undefined)) return { ok: false, problem: 'apply takes one of inputTax and unreadReceipt' };
  if (layer === 'app' && unreadReceipt !== undefined) return { ok: false, problem: 'apply.unreadReceipt is a company\'s choice, not a fact of the business: it goes in the company\'s file (knowledge/<role>/<id>.yaml)' };
  if (layer === 'workspace' && inputTax !== undefined) return { ok: false, problem: 'apply.inputTax is a fact of the business for every company: it goes in the app\'s file (processes/<role>/<id>.yaml)' };
  if (inputTax !== undefined) return inputTax === 'none' ? { ok: true, fact: { kind: 'noInputTax' }, ...dir } : { ok: false, problem: 'apply.inputTax must be none' };
  const rate = Number(unreadReceipt);
  if (typeof unreadReceipt !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate >= 100) return { ok: false, problem: 'apply.unreadReceipt must be a VAT rate in percent, e.g. 8.1' };
  return { ok: true, fact: { kind: 'unreadReceipt', rate }, ...dir };
}

type Rules = { rules?: Array<{ id?: string; status?: string; apply?: unknown }> } | undefined;
const rulesOf = (steps: Record<string, unknown> | undefined) => (steps?.[PURCHASE_VAT_STEP] as Rules)?.rules ?? [];

/**
 * The facts of the business files, by business. A business whose company file has rules of its
 * own for the step takes its facts from that file alone, and a rule whose question is open gives none.
 */
export function businessVat(k: Pick<Knowledge, 'counterpartyFiles'>): BusinessVat {
  const companyDecides = new Set(k.counterpartyFiles
    .filter((f) => f.layer === 'workspace' && f.body.id && rulesOf(f.body.steps).length > 0)
    .map((f) => f.body.id!));
  const facts = new Map<string, BusinessFact[]>();
  for (const f of k.counterpartyFiles) {
    const business = f.body.id;
    if (!business || (f.layer === 'app' && companyDecides.has(business))) continue;
    for (const r of rulesOf(f.body.steps)) {
      if (r.apply === undefined || !r.id || r.status === 'open') continue;
      const parsed = parseApply(r.apply, f.layer);
      if (!parsed.ok) continue;
      facts.set(business, [...(facts.get(business) ?? []), { rule: r.id, business, fact: parsed.fact, ...(parsed.direction && { direction: parsed.direction }) }]);
    }
  }
  return { facts, companyDecides };
}

/** A receipt the company's `unreadReceipt` speaks of: one that could not be read, never one not read yet (#391, receipt-wait's companyRate). */
const unread = (r: Receipt): boolean => isUnreadable(r);
const ratedCode = /^(-?)([MI])(\d+)$/;

/** The gross a receipt's rate group taxes: as read, else from its net or its tax. */
function grossOf(g: NonNullable<Receipt['vatSummary']>[number]): number {
  return g.gross ?? (g.net !== undefined ? g.net + g.vat : (g.vat * (100 + g.ratePercent)) / g.ratePercent);
}

/**
 * Whether the receipts tax the whole line at `rate`: each shows exactly that one rate, in the
 * payment's currency, and their gross adds up to the line's amount. A split invoice (customs duty
 * beside a courier's fee), a mixed cart or a discount does not, and stays the model's.
 */
function taxedWhole(receipts: readonly Receipt[], rate: number, amount: number, currency: string): boolean {
  if (!receipts.length) return false;
  let gross = 0;
  for (const r of receipts) {
    const groups = r.vatSummary ?? [];
    if (!r.hasSwissVat || groups.length !== 1 || groups[0].ratePercent !== rate || (r.currency ?? currency) !== currency) return false;
    gross += grossOf(groups[0]);
  }
  return Math.abs(gross - Math.abs(amount)) <= 0.05;
}

/**
 * The Swiss rate an owner's business part of its one receipt is taxed at (#87): the receipt's only
 * rate when it taxes the whole receipt, or the rate line the person named among several, when the
 * part fits in that line's gross, in the payment's currency. Undefined when the receipt shows no
 * Swiss VAT (the zero-code rule decides), holds untaxed items beside its one rate (the part may be
 * one of them: the model's facts stand), or the part does not fit.
 */
function partRate(receipts: readonly Receipt[], part: NonNullable<BankTransaction['businessPart']>, amount: number, currency: string): number | undefined {
  if (receipts.length !== 1) return undefined;
  const [r] = receipts;
  const groups = (r.vatSummary ?? []).filter((g) => g.ratePercent > 0 && vat().isDomesticRate(g.ratePercent));
  if (!r.hasSwissVat || !groups.length || (r.currency ?? currency) !== currency) return undefined;
  const whole = groups.length === 1 && r.amount != null && grossOf(groups[0]) >= Math.abs(r.amount) - 0.05;
  const line = groups.length === 1 ? (whole ? groups[0] : undefined) : groups.find((g) => g.ratePercent === part.rate);
  return line && Math.abs(amount) <= grossOf(line) + 0.05 ? line.ratePercent : undefined;
}

/**
 * A line of a card's settlement whose bill shows less than the line charged (a tip, #409): at each
 * input-tax rate, the entries claim it on no more than the bills' gross at that rate; what is over
 * is split off onto a line of its own with the zero code of the same family. Entries in another
 * currency than the bills', or without a rated input code, stay as they are.
 */
export function capAtBills(entries: JournalEntry[], bills: readonly Receipt[], currency: string, newId: () => string): JournalEntry[] {
  const gross = (rate: number) => bills.filter((r) => r.hasSwissVat && (r.currency ?? currency) === currency)
    .reduce((s, r) => s + (r.vatSummary ?? []).filter((g) => g.ratePercent === rate).reduce((t, g) => t + grossOf(g), 0), 0);
  const out: JournalEntry[] = [];
  const left = new Map<number, number>();
  for (const e of entries) {
    const m = ratedCode.exec(e.vatCode ?? '');
    const rate = m ? lookupVatCode(e.vatCode!)?.entry.rate : undefined;
    if (!m || !rate || e.exchangeCurrency) { out.push(e); continue; }
    const room = left.get(rate) ?? gross(rate);
    const amount = Math.abs(e.amount);
    if (amount <= room + 0.05) { left.set(rate, room - amount); out.push(e); continue; }
    left.set(rate, 0);
    const keep = Math.max(0, Math.round(room * 100) / 100);
    const over = Math.round((amount - keep) * 100) / 100;
    const sign = e.amount < 0 ? -1 : 1;
    if (keep > 0) out.push({ ...e, amount: sign * keep });
    out.push({ ...e, id: keep > 0 ? newId() : e.id, amount: sign * over, vatCode: `${m[1]}${m[2]}0`, reason: de().t('rules.say.purchaseVat.overBill', { rate: String(rate) }), by: { kind: 'code', check: 'purchaseVat' } });
  }
  return out;
}

/**
 * A booking of a payment by a rule or the model, claiming no more input tax than its linked
 * receipts show (#469): at each rate, the lines claim it on no more than the receipts' gross at that
 * rate. What a line books beyond goes first to a rate the receipts show and the lines leave unused
 * (the receipt's 2.6 % for a line the model put at 8.1 %), with the code of the line's family, and
 * the rest to the zero code of that family. Only where the receipts' VAT is known: every purchase
 * document read, in the lines' currency, each group at a rate of the jurisdiction; else, and for a
 * line in another currency, a minus code, or a code without a rate, the entries stay as they are.
 */
export function capAtReceipts(entries: JournalEntry[], documents: readonly Receipt[], newId: () => string): JournalEntry[] {
  const receipts = documents.filter(isPurchaseDocument);
  if (!receipts.length) return entries;
  const currency = receipts[0].currency ?? baseCurrency();
  if (receipts.some((r) => (r.currency ?? baseCurrency()) !== currency || r.hasSwissVat === undefined || (r.hasSwissVat && !r.vatSummary?.length)
    || (r.hasSwissVat && r.vatSummary!.some((g) => g.ratePercent > 0 && !vat().isDomesticRate(g.ratePercent))))) return entries;
  const left = new Map<number, number>();
  const slack = new Map<number, number>();
  for (const r of receipts.filter((x) => x.hasSwissVat)) {
    for (const g of r.vatSummary!) {
      if (!(g.ratePercent > 0)) continue;
      left.set(g.ratePercent, (left.get(g.ratePercent) ?? 0) + Math.abs(grossOf(g)));
      if (g.gross === undefined && g.net === undefined) slack.set(g.ratePercent, (slack.get(g.ratePercent) ?? 0) + (0.005 * (100 + g.ratePercent)) / g.ratePercent);
    }
  }
  const rated = (e: JournalEntry) => {
    const m = ratedCode.exec(e.vatCode ?? '');
    const rate = m && !m[1] && !settlesVat(e.accountDebit) && !settlesVat(e.accountCredit) && (e.exchangeCurrency ?? baseCurrency()) === currency ? vat().codes.parse(e.vatCode!)?.rate : undefined;
    return rate ? { rate, family: m![2] } : undefined;
  };
  if (!entries.some((e) => { const r = rated(e); return r && Math.abs(e.amount) > (left.get(r.rate) ?? 0) + 0.05 + (slack.get(r.rate) ?? 0); })) return entries;
  // Each line first on its own rate, in order; then what is over goes to the rates left unused.
  const over = new Map<JournalEntry, number>();
  const kept = new Map<JournalEntry, number>();
  for (const e of entries) {
    const r = rated(e);
    if (!r) continue;
    const room = left.get(r.rate) ?? 0;
    const amount = Math.abs(e.amount);
    if (amount <= room + 0.05 + (slack.get(r.rate) ?? 0)) { left.set(r.rate, room - amount); continue; }
    const keep = Math.max(0, cents(room));
    left.set(r.rate, 0);
    kept.set(e, keep);
    over.set(e, cents(amount - keep));
  }
  const boxes = vat().codes.purchaseBoxes;
  const out: JournalEntry[] = [];
  for (const e of entries) {
    const rest = over.get(e);
    if (rest === undefined) { out.push(e); continue; }
    const { family } = rated(e)!;
    const sign = e.amount < 0 ? -1 : 1;
    const parts: JournalEntry[] = [];
    if (kept.get(e)! > 0) parts.push({ ...e, amount: sign * kept.get(e)! });
    let open = rest;
    for (const [rate, room] of [...left].sort(([a], [b]) => b - a)) {
      const code = vat().codes.purchaseAt(rate, family === 'M' ? boxes.costOfGoods : boxes.otherwise);
      const take = cents(Math.min(open, room));
      if (!code || !formTakes(code) || take <= 0.05) continue;
      left.set(rate, room - take);
      open = cents(open - take);
      parts.push({ ...e, id: parts.length ? newId() : e.id, amount: sign * take, vatCode: code, reason: de().t('rules.say.purchaseVat.receiptRate', { rate: String(rate), code }), by: { kind: 'code', check: 'purchaseVat' } });
    }
    if (open > 0) parts.push({ ...e, id: parts.length ? newId() : e.id, amount: sign * open, vatCode: `${family}0`, reason: de().t('rules.say.purchaseVat.overReceipt', { rate: String(rated(e)!.rate) }), by: { kind: 'code', check: 'purchaseVat' } });
    out.push(...parts);
  }
  return out;
}
const cents = (n: number): number => Math.round(n * 100) / 100;

/** An unread receipt as the business's fact reads it: Swiss VAT at the fact's rate on its whole amount (the line's, when the receipt names none). */
function asRead(r: Receipt, rate: number, amount: number): Receipt {
  const gross = r.amount ?? Math.abs(amount);
  return { ...r, hasSwissVat: true, vatSummary: [{ ratePercent: rate, gross, vat: (gross * rate) / (100 + rate) }] };
}

/** The VAT settlement accounts (year-end.yaml vatSettlement): a line on one pays or receives the tax itself and carries no VAT code, nor does code give it one (#456). */
export const settlesVat = (account: string | undefined): boolean => !!account && yearEnd().accounts.vatSettlement.includes(account);

/** Booking texts stay German (docs/i18n.md). */
const de = () => wordsIn('de');

/**
 * The model's entries of `tx` with the input-tax codes the business files and the receipt rules decide; every other
 * entry as it came. `documents` are the payment's linked receipts; the business it routes to
 * (among `counterparties`) brings its files' facts from `known`. Only an entry the model decided,
 * with an input-tax code, changes; its reason then names the rule that decided, and it is booked
 * by code. A business whose company file decides the step without a fact of its own keeps every code the model wrote.
 */
export function withPurchaseVat(tx: BankTransaction, entries: JournalEntry[], documents: readonly Receipt[], known: BusinessVat | undefined, counterparties: readonly Counterparty[] = []): JournalEntry[] {
  const routing = identify(signalsOfTransaction(tx, [...documents]), counterparties);
  const business = routing.kind === 'known' ? counterparties.find((c) => c.id === routing.counterparty) : undefined;
  if (business && known?.companyDecides.has(business.id) && !known.facts.has(business.id)) return entries;
  const way = tx.direction === 'CRDT' ? 'in' : 'out';
  const holding = ((business && known?.facts.get(business.id)) || []).filter((f) => !f.direction || f.direction === way);
  const none = holding.find((f) => f.fact.kind === 'noInputTax');
  const assume = holding.map((f) => (f.fact.kind === 'unreadReceipt' ? { rule: f.rule, rate: f.fact.rate } : undefined)).find((f) => f);
  const model = entries.filter((e) => e.by?.kind === 'model' && ratedCode.test(e.vatCode ?? '') && vat().codes.parse(e.vatCode!));
  const decide = (e: JournalEntry, code: string, reason: string): JournalEntry =>
    (formTakes(code) && code !== e.vatCode ? { ...e, vatCode: code, reason, by: { kind: 'code', check: 'purchaseVat' } } : e);
  const name = business?.name ?? '';

  return entries.map((e) => {
    if (!model.includes(e) || settlesVat(e.accountDebit) || settlesVat(e.accountCredit)) return e;
    const [, sign, family] = ratedCode.exec(e.vatCode!)!;
    if (none) {
      const code = `${sign}${family}0`;
      return decide(e, code, de().t('rules.say.purchaseVat.noInputTax', { business: name, rule: none.rule, code }));
    }
    const purchase = documents.filter(isPurchaseDocument);
    const read = assume ? purchase.map((r) => (unread(r) ? asRead(r, assume.rate, e.amount) : r)) : purchase;
    // Only a sales record or a supporting document linked: no purchase document, so no input tax (pv-no-receipt).
    const check = evidenceCheck(e, read, undefined, undefined, entries);
    if (check?.kind === 'vatWithoutReceipt') return decide(e, check.code, de().t('rules.say.zeroCode', { code: check.code }));
    // Receipts nobody has read show no Swiss VAT yet: no input tax on the model's word alone (#391).
    const mine = lineReceipts(e, read);
    if (!sign && mine.length && mine.every(vatNotRead)) return decide(e, `${family}0`, de().t('rules.say.zeroCode', { code: `${family}0` }));
    const part = tx.businessPart && model.length === 1 ? partRate(read, tx.businessPart, e.amount, tx.currency) : undefined;
    if (part !== undefined) {
      const box = vat().codes.purchaseBoxes;
      const code = vat().codes.purchaseAt(part, family === 'M' ? box.costOfGoods : box.otherwise);
      return code ? decide(e, sign + code, de().t('rules.say.purchaseVat.receiptShowsVat', { rate: String(part), code: sign + code })) : e;
    }
    // A line of its own receipt (#27) is that receipt's; of several lines on all the receipts, none is decided here.
    const own = lineReceipts(e, read);
    if (check?.kind !== 'receiptShowsVat' || (model.length > 1 && own === read) || !taxedWhole(own, check.rate, e.amount, tx.currency)) return e;
    return decide(e, check.code, assume && purchase.some(unread)
      ? de().t('rules.say.purchaseVat.unreadReceipt', { business: name, rule: assume.rule, rate: String(check.rate), code: check.code })
      : de().t('rules.say.purchaseVat.receiptShowsVat', { rate: String(check.rate), code: check.code }));
  });
}
