/**
 * The input-tax code of the model's purchase lines, decided in code where the shipped knowledge
 * decides it (issue #45: most misses that needed Swiss knowledge had it shipped and unapplied).
 *
 * Two sources, both of the app layer (processes/), so both true for every company:
 * - a business's file states a fact about its documents as `apply:` on a rule of
 *   booking.guide.yaml#purchase_vat (ShippedFact): its payouts claim no input tax, or its receipt
 *   that could not be read shows Swiss VAT at a rate;
 * - booking.guide.yaml#purchase_vat itself: the receipt decides the code (pv-no-receipt,
 *   pv-charged, pv-otherwise), the proposal the evidence check shows a person
 *   (src/accounting/evidence-check.ts), carried out at booking only where it cannot be wrong.
 * A rule without `apply:` (a choice, a case to ask about) stays the model's. A business whose file
 * in the company's knowledge/ has rules of its own for the step keeps the model's code: the
 * company's word goes before the app's. The company's executable rules book before the model and
 * a person's booking is never classified, so neither reaches this.
 */
import { evidenceCheck } from '../accounting/evidence-check.js';
import { formTakes } from '../accounting/vat-codes.js';
import { vat } from '../engines/index.js';
import { wordsIn } from '../export/texts.js';
import { identify, signalsOfTransaction, type Counterparty } from '../knowledge/counterparties.js';
import type { Knowledge } from '../knowledge/layers.js';
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';

export const PURCHASE_VAT_STEP = 'booking.guide.yaml#purchase_vat';

/** What a business's file states about input tax, as code carries it out. */
export type VatFact =
  /** Its purchase lines claim no input tax on such a payment: the tax is proven and claimed elsewhere (a monthly bill). */
  | { kind: 'noInputTax' }
  /** Its receipt that was not read shows Swiss VAT at this rate on its whole amount. */
  | { kind: 'unreadReceipt'; rate: number };

/** A fact of one business's file: its rule id, and the direction of the payments it holds for. */
export interface ShippedFact { rule: string; business: string; direction?: 'in' | 'out'; fact: VatFact }

/** The shipped facts by business, and the businesses whose company file decides the step itself. */
export interface ShippedVat { facts: ReadonlyMap<string, readonly ShippedFact[]>; companyDecides: ReadonlySet<string> }

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A rule's `apply:` as written: `{ inputTax: none, direction: in }` or `{ unreadReceipt: 8.1 }`.
 * The lint (check-processes) reports the problem; the loader skips such a rule.
 */
export function parseApply(raw: unknown): { ok: true; fact: VatFact; direction?: 'in' | 'out' } | { ok: false; problem: string } {
  if (!isMap(raw)) return { ok: false, problem: 'apply must be a map: { inputTax: none } or { unreadReceipt: <rate> }' };
  const { inputTax, unreadReceipt, direction, ...rest } = raw;
  const extra = Object.keys(rest)[0];
  if (extra) return { ok: false, problem: `apply.${extra} is unknown — apply takes inputTax, unreadReceipt and direction` };
  if (direction !== undefined && direction !== 'in' && direction !== 'out') return { ok: false, problem: 'apply.direction must be in or out' };
  const dir = direction === undefined ? {} : { direction: direction as 'in' | 'out' };
  if ((inputTax === undefined) === (unreadReceipt === undefined)) return { ok: false, problem: 'apply takes one of inputTax and unreadReceipt' };
  if (inputTax !== undefined) return inputTax === 'none' ? { ok: true, fact: { kind: 'noInputTax' }, ...dir } : { ok: false, problem: 'apply.inputTax must be none' };
  const rate = Number(unreadReceipt);
  if (typeof unreadReceipt !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate >= 100) return { ok: false, problem: 'apply.unreadReceipt must be a VAT rate in percent, e.g. 8.1' };
  return { ok: true, fact: { kind: 'unreadReceipt', rate }, ...dir };
}

type Rules = { rules?: Array<{ id?: string; status?: string; apply?: unknown }> } | undefined;
const rulesOf = (steps: Record<string, unknown> | undefined) => (steps?.[PURCHASE_VAT_STEP] as Rules)?.rules ?? [];

/**
 * The facts of the app layer's business files, by business. A business whose company file has
 * rules of its own for the step contributes none, and neither does a rule whose question is open.
 */
export function shippedVat(k: Pick<Knowledge, 'counterpartyFiles'>): ShippedVat {
  const companyDecides = new Set(k.counterpartyFiles
    .filter((f) => f.layer === 'workspace' && f.body.id && rulesOf(f.body.steps).length > 0)
    .map((f) => f.body.id!));
  const facts = new Map<string, ShippedFact[]>();
  for (const f of k.counterpartyFiles) {
    const business = f.body.id;
    if (f.layer !== 'app' || !business || companyDecides.has(business)) continue;
    for (const r of rulesOf(f.body.steps)) {
      if (r.apply === undefined || !r.id || r.status === 'open') continue;
      const parsed = parseApply(r.apply);
      if (!parsed.ok) continue;
      facts.set(business, [...(facts.get(business) ?? []), { rule: r.id, business, fact: parsed.fact, ...(parsed.direction && { direction: parsed.direction }) }]);
    }
  }
  return { facts, companyDecides };
}

const isPurchaseDocument = (r: Receipt): boolean => r.kind === undefined || r.kind === 'invoice';
const unread = (r: Receipt): boolean => r.hasSwissVat === undefined && !r.vatSummary?.length;
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

/** An unread receipt as the business's fact reads it: Swiss VAT at the fact's rate on its whole amount (the line's, when the receipt names none). */
function asRead(r: Receipt, rate: number, amount: number): Receipt {
  const gross = r.amount ?? Math.abs(amount);
  return { ...r, hasSwissVat: true, vatSummary: [{ ratePercent: rate, gross, vat: (gross * rate) / (100 + rate) }] };
}

/** Booking texts stay German (docs/i18n.md). */
const de = () => wordsIn('de');

/**
 * The model's entries of `tx` with the input-tax codes the shipped knowledge decides; every other
 * entry as it came. `documents` are the payment's linked receipts; the business it routes to
 * (among `counterparties`) brings its file's facts from `shipped`. Only an entry the model decided,
 * with an input-tax code, changes; its reason then names the rule that decided, and it is booked
 * by code. A business whose company file decides the step keeps every code the model wrote.
 */
export function withPurchaseVat(tx: BankTransaction, entries: JournalEntry[], documents: readonly Receipt[], shipped: ShippedVat | undefined, counterparties: readonly Counterparty[] = []): JournalEntry[] {
  const routing = identify(signalsOfTransaction(tx, [...documents]), counterparties);
  const business = routing.kind === 'known' ? counterparties.find((c) => c.id === routing.counterparty) : undefined;
  if (business && shipped?.companyDecides.has(business.id)) return entries;
  const way = tx.direction === 'CRDT' ? 'in' : 'out';
  const holding = ((business && shipped?.facts.get(business.id)) || []).filter((f) => !f.direction || f.direction === way);
  const none = holding.find((f) => f.fact.kind === 'noInputTax');
  const assume = holding.map((f) => (f.fact.kind === 'unreadReceipt' ? { rule: f.rule, rate: f.fact.rate } : undefined)).find((f) => f);
  const model = entries.filter((e) => e.by?.kind === 'model' && ratedCode.test(e.vatCode ?? '') && vat().codes.parse(e.vatCode!));
  const decide = (e: JournalEntry, code: string, reason: string): JournalEntry =>
    (formTakes(code) && code !== e.vatCode ? { ...e, vatCode: code, reason, by: { kind: 'code', check: 'purchaseVat' } } : e);
  const name = business?.name ?? '';

  return entries.map((e) => {
    if (!model.includes(e)) return e;
    const [, sign, family] = ratedCode.exec(e.vatCode!)!;
    if (none) {
      const code = `${sign}${family}0`;
      return decide(e, code, de().t('rules.say.purchaseVat.noInputTax', { business: name, rule: none.rule, code }));
    }
    const purchase = documents.filter(isPurchaseDocument);
    const read = assume ? purchase.map((r) => (unread(r) ? asRead(r, assume.rate, e.amount) : r)) : purchase;
    // Only a sales record or a supporting document linked: no purchase document, so no input tax (pv-no-receipt).
    const check = evidenceCheck(e, read, undefined);
    if (check?.kind === 'vatWithoutReceipt') return decide(e, check.code, de().t('rules.say.zeroCode', { code: check.code }));
    if (check?.kind !== 'receiptShowsVat' || model.length > 1 || !taxedWhole(read, check.rate, e.amount, tx.currency)) return e;
    return decide(e, check.code, assume && purchase.some(unread)
      ? de().t('rules.say.purchaseVat.unreadReceipt', { business: name, rule: assume.rule, rate: String(check.rate), code: check.code })
      : de().t('rules.say.purchaseVat.receiptShowsVat', { rate: String(check.rate), code: check.code }));
  });
}
