/**
 * Teilrechnungen, Akonto and Schlussrechnung (docs/specs/invoicing.md 4.4.9): an Auftrag's plan of
 * stages, the Teilrechnung each stage makes (one position per rate in proportion to the Auftrag),
 * and the Schlussrechnung that lists the whole work and deducts every Teilrechnung issued and not
 * cancelled at what it invoiced, so each document keeps its own VAT (MWSTG Art. 40 Abs. 1 lit. b).
 * Pure functions over invoices.json; src/invoices/service.ts writes what they return.
 */
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { convertDraft } from './chain.js';
import { isItem, type Draft, type Envelope, type Invoice, type InvoiceLine, type Issued, type ItemLine, type Stage } from './model.js';
import { InvoiceRuleError, apportion, creditable, creditNotesOf, distribute, priced, totals, type Part } from './rules.js';
import { TEXTS, formatAmount, formatDate } from './texts.js';

const alive = (docs: readonly Invoice[]) => docs.filter((d) => !d.deleted);
const stands = (d: Invoice): d is Issued => d.status === 'issued' && !d.cancelled;

/** The Auftrag's total in its own prices (net or gross as its positions), in cents: what a stage's percent takes its share of. */
export const planBase = (order: Pick<Invoice, 'lines' | 'prices'>): number => priced(order).parts.reduce((s, p) => s + p.rappen, 0);

/** A stage's amount in cents: its percent of `base`, its amount, or (the last stage with neither) the rest. */
function stageAmounts(stages: readonly Stage[], base: number): number[] {
  const fixed = stages.map((s) => (s.amount !== undefined ? toRappen(s.amount) : s.percent !== undefined ? toRappen(fromRappen(base) * s.percent / 100) : undefined));
  // Percents that add up to 100 add up to the total: the last percent stage takes the rest, so no cent is lost to rounding.
  const last = stages.at(-1);
  if (last && last.percent !== undefined && stages.every((x) => x.percent !== undefined) && Math.abs(stages.reduce((t, x) => t + x.percent!, 0) - 100) < 1e-9) {
    fixed[fixed.length - 1] = base - fixed.slice(0, -1).reduce<number>((t, x) => t + (x ?? 0), 0);
  }
  const known = fixed.reduce<number>((s, x) => s + (x ?? 0), 0);
  return fixed.map((x) => x ?? base - known);
}

/** What a plan lacks to add up to the Auftrag's total, or has too much, in cents; 0 when it adds up. */
export function planGap(order: Pick<Invoice, 'lines' | 'prices'>, stages: readonly Stage[]): number {
  if (!stages.length) return 0;
  const base = planBase(order);
  const amounts = stageAmounts(stages, base);
  // A rest stage is what is left: it may not be below zero.
  if (stages.at(-1)!.percent === undefined && stages.at(-1)!.amount === undefined) return Math.min(0, amounts.at(-1)!);
  return base - amounts.reduce((s, x) => s + x, 0);
}

/**
 * A plan checked: each stage a text and either a percent (above 0, at most 100) or an amount (above
 * 0), the last one may have neither (the rest); the stages add up to the total (`stagesSum` names
 * what is missing or too much, in the Auftrag's currency).
 */
export function checkPlan(order: Pick<Invoice, 'kind' | 'lines' | 'prices' | 'currency'>, stages: readonly Stage[]): void {
  if (order.kind !== 'sales-order') throw new InvoiceRuleError('notOrder', 'Einen Teilrechnungsplan hat nur ein Auftrag.');
  stages.forEach((s, k) => {
    const last = k === stages.length - 1;
    if (!s.label.trim()) throw new InvoiceRuleError('stages', `Stufe ${k + 1}: der Text fehlt.`, undefined, { stage: k + 1 });
    if (s.percent !== undefined && s.amount !== undefined) throw new InvoiceRuleError('stages', `Stufe ${k + 1}: Prozent oder Betrag, nicht beides.`, undefined, { stage: k + 1 });
    if (s.percent !== undefined && !(s.percent > 0 && s.percent <= 100)) throw new InvoiceRuleError('stages', `Stufe ${k + 1}: Prozent zwischen 0 und 100.`, undefined, { stage: k + 1 });
    if (s.amount !== undefined && !(s.amount > 0)) throw new InvoiceRuleError('stages', `Stufe ${k + 1}: ein Betrag über 0.`, undefined, { stage: k + 1 });
    if (s.percent === undefined && s.amount === undefined && !last) throw new InvoiceRuleError('stages', `Stufe ${k + 1}: nur die letzte Stufe ist der Rest, jede andere hat Prozent oder Betrag.`, undefined, { stage: k + 1 });
  });
  const gap = planGap(order, stages);
  if (gap !== 0) {
    const amount = `${order.currency} ${formatAmount(Math.abs(fromRappen(gap)), 'de')}`;
    throw new InvoiceRuleError('stagesSum', gap > 0 ? `Die Stufen ergeben das Total nicht: es fehlen ${amount}.` : `Die Stufen ergeben mehr als das Total: ${amount} zu viel.`, undefined, { gap: fromRappen(gap), amount });
  }
}

/** The documents a plan made of an Auftrag, drafts included: its Teilrechnungen (`role: 'partial'`) and its Schlussrechnung. */
export const partialsOf = (order: { id: string }, docs: readonly Invoice[]): Invoice[] =>
  alive(docs).filter((d) => d.kind === 'invoice' && d.role === 'partial' && d.from?.id === order.id);
/** A Schlussrechnung counts while it is a draft or stands: not cancelled and not credited in full (then it frees its Akontos, decision 115). */
const finalStands = (d: Invoice, docs: readonly Invoice[]): boolean => d.status === 'draft' || (!d.cancelled && creditable(d, docs) > 0);
export const finalOf = (order: { id: string }, docs: readonly Invoice[]): Invoice | undefined =>
  alive(docs).find((d) => d.kind === 'invoice' && d.role === 'final' && d.from?.id === order.id && finalStands(d, docs));

/** A stage as the Auftrag shows it: planned amount (its prices), the document that invoices it and what that one invoiced (gross). */
export interface StageState { k: number; stage: Stage; planned: number; doc?: Invoice; invoiced: number; last: boolean }

export function stageStates(order: Invoice, docs: readonly Invoice[]): StageState[] {
  const stages = order.stages ?? [];
  const amounts = stageAmounts(stages, planBase(order));
  const partials = partialsOf(order, docs).filter((d) => !(d.status === 'issued' && d.cancelled));
  const final = finalOf(order, docs);
  return stages.map((stage, k) => {
    const last = k === stages.length - 1;
    const doc = last ? final ?? partials.find((d) => d.stage === k) : partials.find((d) => d.stage === k);
    // The Schlussrechnung's own amount is the rest: the whole less what the Teilrechnungen invoiced.
    return { k, stage, planned: fromRappen(amounts[k]), ...(doc ? { doc } : {}), invoiced: doc && stands(doc) ? totals(doc).gross : 0, last };
  });
}

/** The issued Teilrechnungen of the Auftrag that stand, with what they invoiced in all (gross): the warning of a changed total names them. */
export function invoicedStages(order: { id: string }, docs: readonly Invoice[]): { numbers: string[]; gross: number } {
  const xs = partialsOf(order, docs).filter(stands);
  return { numbers: xs.map((x) => x.number), gross: fromRappen(xs.reduce((s, x) => s + toRappen(totals(x).gross), 0)) };
}

/** The groups a document's parts book apart (rate, pricing, account, activity), each with its cents: one position per group. */
function groupsOf(parts: readonly Part[]): Array<{ line: ItemLine; gross: boolean; rappen: number }> {
  const by = new Map<string, { line: ItemLine; gross: boolean; rappen: number }>();
  for (const p of parts) {
    const key = `${p.line.vatRate}|${p.gross}|${p.line.account ?? ''}|${p.line.activity ?? 1}`;
    const g = by.get(key);
    by.set(key, { line: g?.line ?? p.line, gross: p.gross, rappen: (g?.rappen ?? 0) + p.rappen });
  }
  return [...by.values()].filter((g) => g.rappen !== 0);
}

/** The line fields a position takes from a group of another document: rate, account, activity, and its pricing where it differs. */
const carried = (g: { line: ItemLine; gross: boolean }, prices: Invoice['prices']): Partial<ItemLine> => ({
  ...(g.line.account ? { account: g.line.account } : {}),
  ...(g.line.activity === 2 ? { activity: 2 as const } : {}),
  ...(g.line.vatRate > 0 && g.gross !== (prices === 'gross') ? { vatIncluded: g.gross } : {}),
});

/**
 * The Teilrechnung of stage `k` of an issued Auftrag (spec 4.4.9): one position «Akonto n gemäss
 * Auftrag AU-…» per rate (and account and activity) of the Auftrag, the stage's amount split over them
 * in proportion to their amounts to the cent, net or gross as the Auftrag. The last stage makes the
 * Schlussrechnung instead (finalDraft). A stage is invoiced once: a second draft of it is refused.
 */
export function stageDraft(order: Invoice, k: number, docs: readonly Invoice[], envelope: Envelope, date: string): Draft {
  assertPlanned(order);
  const stages = order.stages ?? [];
  const stage = stages[k] ?? notAStage(k);
  if (partialsOf(order, docs).some((d) => d.stage === k && !(d.status === 'issued' && d.cancelled))) {
    throw new InvoiceRuleError('stageInvoiced', `Stufe ${k + 1} «${stage.label}» ist schon in Rechnung gestellt.`, undefined, { stage: k + 1, label: stage.label });
  }
  const amount = stageAmounts(stages, planBase(order))[k];
  const groups = groupsOf(priced(order).parts);
  // In proportion to each group's signed amount over the net total: a take-back position stays a take-back.
  const net = groups.reduce((t, g) => t + g.rappen, 0);
  const shares = net === 0 ? apportion(amount, groups.map((g) => g.rappen)) : distribute(amount, groups.map((g) => amount * g.rappen / net));
  const L = TEXTS[order.language];
  const rates = new Set(groups.map((g) => g.line.vatRate));
  const text = `${L.akonto(k + 1, (order as Issued).number)}: ${stage.label}`;
  const lines: InvoiceLine[] = groups.flatMap((g, i) => (shares[i] === 0 ? [] : [{
    text: rates.size > 1 ? `${text} (${g.line.vatRate} %)` : text, quantity: 1, price: fromRappen(shares[i]), vatRate: g.line.vatRate, ...carried(g, order.prices),
  }]));
  return {
    ...base(order, envelope, date),
    subject: `${L.partial} ${k + 1}${order.subject ? ` · ${order.subject}` : ''}`,
    lines,
    role: 'partial',
    stage: k,
  };
}

/** What every document a plan makes takes from its Auftrag: the contact, person, address, currency, language, prices, exemption, order reference and terms. */
function base(order: Invoice, envelope: Envelope, date: string): Draft {
  return {
    ...envelope, status: 'draft', kind: 'invoice', customerId: order.customerId,
    ...(order.personId ? { personId: order.personId } : {}), ...(order.addressId ? { addressId: order.addressId } : {}),
    date, currency: order.currency, language: order.language, lines: [],
    ...(order.prices ? { prices: order.prices } : {}), ...(order.exemption ? { exemption: order.exemption } : {}),
    ...(order.ordered ? { ordered: order.ordered } : {}), ...(order.termsId ? { termsId: order.termsId } : {}),
    from: { id: order.id, kind: order.kind }, comments: [],
  };
}

function assertPlanned(order: Invoice): void {
  if (order.kind !== 'sales-order') throw new InvoiceRuleError('notOrder', 'Teil- und Schlussrechnungen entstehen aus einem Auftrag.');
  if (order.status !== 'issued') throw new InvoiceRuleError('notIssued', 'Erst den Auftrag ausstellen: ein Entwurf hat noch keine Nummer.');
  if (order.cancelled) throw new InvoiceRuleError('cancelled', `${order.number} ist storniert.`, undefined, { number: order.number });
}
const notAStage = (k: number): never => { throw new InvoiceRuleError('stages', `Der Plan hat keine Stufe ${k + 1}.`, undefined, { stage: k + 1 }); };

/**
 * The deduction positions of a Teilrechnung on a Schlussrechnung priced `prices`: one per group of
 * its parts (rate, pricing, account, activity) at what it invoiced, its rate's VAT split over its
 * groups by their amounts, each naming it (`deducts`). Gross or net as it was.
 */
export function deductionLines(partial: Issued, prices: Invoice['prices'], docs: readonly Invoice[] = []): ItemLine[] {
  const L = TEXTS[partial.language];
  const text = L.lessPartial(partial.number, formatDate(partial.date, partial.language));
  // What is left of it: the Teilrechnung, then each Gutschrift of it taken back the same way (invoiced less credited, per rate).
  return [partial, ...creditNotesOf(partial, docs)].flatMap((doc) => linesOf(doc, doc === partial ? text : `${text}, ${L.credit} ${doc.number}`, partial.id, prices));
}

function linesOf(doc: Issued, text: string, id: string, prices: Invoice['prices']): ItemLine[] {
  const parts = priced(doc).parts;
  const rates = [...new Set(parts.map((p) => p.line.vatRate))];
  return rates.flatMap((rate) => {
    const groups = groupsOf(parts.filter((p) => p.line.vatRate === rate));
    const vat = toRappen(totals({ lines: doc.lines, prices: doc.prices }).byRate.find((r) => r.rate === rate)?.vat ?? 0);
    // Each group's net (its amount less its share of the VAT when priced gross) weighs its share of the rate's VAT.
    const nets = groups.map((g) => (g.gross ? g.rappen - Math.round(g.rappen * rate / (100 + rate)) : g.rappen));
    const vats = apportion(vat, nets);
    return groups.map((g, i): ItemLine => ({
      text: rates.length > 1 ? `${text} (${rate} %)` : text, quantity: 1, price: -fromRappen(g.rappen), vatRate: rate,
      ...carried(g, prices), deducts: id, deductedVat: fromRappen(vats[i]),
    }));
  });
}

/** The ids of the Teilrechnungen a live document (a Schlussrechnung, drafts included) deducts already. */
export const deductedBy = (docs: readonly Invoice[], except?: string): Set<string> =>
  new Set(alive(docs).filter((d) => d.id !== except && d.kind === 'invoice' && finalStands(d, docs)).flatMap((d) => d.lines.flatMap((l) => (isItem(l) && l.deducts ? [l.deducts] : []))));

/**
 * The Teilrechnungen «Akontos abziehen» offers a Schlussrechnung draft: the contact's, issued and not
 * cancelled, in its currency, that no other Schlussrechnung deducts and this one does not yet.
 */
export function deductible(draft: Invoice, docs: readonly Invoice[]): Issued[] {
  const taken = deductedBy(docs);
  return alive(docs).filter((d): d is Issued => stands(d) && d.kind === 'invoice' && d.role === 'partial' && d.customerId === draft.customerId && d.currency === draft.currency && d.id !== draft.id && !taken.has(d.id) && creditable(d, docs) > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
}

/** A Schlussrechnung draft with the deductions of `ids` added at its end (each Teilrechnung once). */
export function withDeductions(draft: Invoice, ids: readonly string[], docs: readonly Invoice[]): Draft {
  if (draft.status !== 'draft' || draft.kind !== 'invoice') throw new InvoiceRuleError('notDraft', 'Akontos werden auf einem Rechnungsentwurf abgezogen.');
  if (draft.role !== 'final') throw new InvoiceRuleError('notFinal', 'Akontos zieht eine Schlussrechnung ab: zuerst den Entwurf als Schlussrechnung markieren.');
  const offered = deductible(draft, docs);
  const picked = ids.map((id) => offered.find((d) => d.id === id) ?? notDeductible(id, docs));
  return { ...draft, lines: [...draft.lines, ...picked.flatMap((p) => deductionLines(p, draft.prices, docs))] };
}
const notDeductible = (id: string, docs: readonly Invoice[]): never => {
  const d = docs.find((x) => x.id === id);
  throw new InvoiceRuleError('incomplete', `${d?.number ?? id} ist keine offene Teilrechnung dieses Kontakts, oder eine Schlussrechnung zieht sie schon ab.`);
};

/**
 * The Schlussrechnung of an issued Auftrag (spec 4.4.9): every position of the Auftrag with its whole
 * quantity (the work as finally measured is the person's change on the draft), then one deduction per
 * Teilrechnung of it that is issued and not cancelled, at what it invoiced. `confirmed`: the warnings the
 * person overrode, `partialDrafts` (a Teilrechnung still a draft, which it then does not deduct).
 */
export function finalDraft(order: Invoice, docs: readonly Invoice[], envelope: Envelope, date: string, confirmed: readonly string[] = []): Draft {
  assertPlanned(order);
  const existing = finalOf(order, docs);
  if (existing) throw new InvoiceRuleError('finalExists', `Zum Auftrag gibt es schon die Schlussrechnung${existing.status === 'issued' ? ` ${existing.number}` : ' (Entwurf)'}.`, undefined, { number: existing.status === 'issued' ? existing.number : '' });
  const drafts = partialsOf(order, docs).filter((d) => d.status === 'draft');
  if (drafts.length && !confirmed.includes('partialDrafts')) {
    throw new InvoiceRuleError('partialDrafts', `${drafts.length === 1 ? 'Eine Teilrechnung ist' : `${drafts.length} Teilrechnungen sind`} noch Entwurf: die Schlussrechnung zieht nur ausgestellte ab. Nur mit «Trotzdem erstellen».`, undefined, { n: drafts.length });
  }
  const picks = order.lines.flatMap((l, k) => (isItem(l) && !l.optional ? [{ line: k, quantity: l.quantity }] : []));
  // Every position whole: what a Rechnung of the Auftrag took before is the person's to see on the draft, not a refusal.
  const converted = convertDraft(order, 'invoice', picks, docs, envelope, date, date, ['overOpen', 'expired', 'declined']);
  const partials = partialsOf(order, docs).filter(stands).filter((p) => !deductedBy(docs).has(p.id) && creditable(p, docs) > 0)
    .sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0) || a.date.localeCompare(b.date));
  const L = TEXTS[order.language];
  return {
    ...base(order, envelope, date),
    subject: `${L.final}${order.subject ? ` · ${order.subject}` : ''}`,
    lines: [...converted.lines, ...partials.flatMap((p) => deductionLines(p, order.prices, docs))],
    role: 'final',
  };
}

/**
 * The deductions of a Rechnung checked at its issue (spec 4.4.9): each Teilrechnung a position names
 * is the contact's, in its currency, issued, standing and not credited in full, deducted by no other
 * Schlussrechnung that stands, and at what is left of it (invoiced less credited, per rate, gross and
 * VAT to the cent); otherwise `deduction`, with the number it names.
 */
export function checkDeductions(draft: Invoice, docs: readonly Invoice[]): void {
  // A Gutschrift of a Schlussrechnung takes its deductions back with it: they deduct nothing (deductedBy counts Rechnungen only).
  const ids = draft.kind === 'credit-note' ? [] : [...new Set(draft.lines.flatMap((l) => (isItem(l) && l.deducts ? [l.deducts] : [])))];
  if (!ids.length) return;
  const refuse = (what: string, why: string): never => { throw new InvoiceRuleError('deduction', `Der Abzug von ${what} stimmt nicht: ${why}`, undefined, { number: what }); };
  if (draft.kind !== 'invoice' || draft.role !== 'final') refuse(ids[0], 'nur eine Schlussrechnung zieht Teilrechnungen ab.');
  const taken = deductedBy(docs, draft.id);
  for (const id of ids) {
    const p = alive(docs).find((d) => d.id === id);
    if (!p || p.status !== 'issued' || p.kind !== 'invoice' || p.role !== 'partial' || p.cancelled) refuse(p?.number ?? id, 'keine ausgestellte Teilrechnung, die steht.');
    const partial = p as Issued;
    if (partial.customerId !== draft.customerId || partial.currency !== draft.currency) refuse(partial.number, 'eine Teilrechnung eines anderen Kontakts oder in einer anderen Währung.');
    if (taken.has(id)) refuse(partial.number, 'eine andere Schlussrechnung zieht sie schon ab.');
    if (creditable(partial, docs) === 0) refuse(partial.number, 'sie ist ganz gutgeschrieben.');
    const want = totals({ lines: deductionLines(partial, draft.prices, docs), prices: draft.prices }).byRate;
    const have = totals({ lines: draft.lines.filter((l) => isItem(l) && l.deducts === id), prices: draft.prices }).byRate;
    const key = (rs: typeof want) => JSON.stringify([...rs].sort((a, b) => a.rate - b.rate).map((r) => [r.rate, r.gross, r.vat]));
    if (key(want) !== key(have)) refuse(partial.number, 'nicht zum Betrag, den sie in Rechnung gestellt hat (abzüglich ihrer Gutschriften).');
  }
}
