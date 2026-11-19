/**
 * The document chain of invoicing phase 2 (docs/specs/invoicing.md 4.4.1): Angebot → Auftrag →
 * Lieferschein → Rechnung → Gutschrift. Which conversions a document offers, what of each position
 * is still open, the draft a conversion makes, and the Belegkette seen from any of its documents.
 * Everything here is derived from `from`, `ofLine` and `creditFor`, never stored twice. Pure functions.
 */
import { addDays, InvoiceRuleError, totals } from './rules.js';
import { isItem, type DocumentKind, type Draft, type Envelope, type Invoice, type InvoiceLine, type Issued, type ItemLine } from './model.js';

/** The conversions each kind offers (4.4.1); a Lieferschein comes only from an Auftrag (decision 21). */
export const CONVERSIONS: Readonly<Partial<Record<DocumentKind, readonly DocumentKind[]>>> = {
  quote: ['sales-order', 'invoice'],
  'sales-order': ['delivery-note', 'invoice'],
};

const alive = (docs: readonly Invoice[]) => docs.filter((d) => !d.deleted);
/** A document that counts as done: issued and not cancelled. */
const stands = (d: Invoice): d is Issued => d.status === 'issued' && !d.cancelled;

/** The documents made from `doc` by a conversion, drafts included. */
export const madeFrom = (doc: { id: string }, docs: readonly Invoice[]): Invoice[] => alive(docs).filter((d) => d.from?.id === doc.id);

/**
 * How much of position `k` of `source` the issued documents of `kinds` made from it took, a credit
 * note of such a Rechnung taking back the quantities of its positions that carry the position (a
 * credit «by amount» names none: a price reduction, the quantities stay).
 */
function taken(source: Invoice, k: number, docs: readonly Invoice[], kinds: readonly DocumentKind[]): number {
  const children = madeFrom(source, docs).filter((d): d is Issued => stands(d) && kinds.includes(d.kind));
  const qty = (d: Invoice) => d.lines.reduce((s, l) => s + (isItem(l) && l.ofLine === k ? l.quantity : 0), 0);
  let sum = children.reduce((s, d) => s + qty(d), 0);
  if (kinds.includes('invoice')) {
    const invoiced = new Set(children.filter((d) => d.kind === 'invoice').map((d) => d.id));
    for (const cn of alive(docs).filter((d): d is Issued => stands(d) && d.kind === 'credit-note' && !!d.creditFor && invoiced.has(d.creditFor))) sum -= qty(cn);
  }
  return Math.round(sum * 1000) / 1000;
}

export interface PositionState {
  /** The position's index in the document. */
  line: number;
  item: ItemLine;
  /** What issued Lieferscheine of the Auftrag delivered of it (an Auftrag only). */
  delivered: number;
  /** What issued Rechnungen of it invoiced, less the quantities its Gutschriften took back. */
  invoiced: number;
}

/** Each item position of `doc` with what was delivered and invoiced of it (spec 4.4.1 «The Auftrag is the hub»). */
export function positions(doc: Invoice, docs: readonly Invoice[]): PositionState[] {
  return doc.lines.flatMap((l, k) => (isItem(l) ? [{ line: k, item: l, delivered: taken(doc, k, docs, ['delivery-note']), invoiced: taken(doc, k, docs, ['invoice']) }] : []));
}

/** What of each item position of `source` is still open for a conversion `to`: quantity less what the documents of that purpose took. */
export function openQuantity(source: Invoice, k: number, to: DocumentKind, docs: readonly Invoice[]): number {
  const l = source.lines[k];
  if (!l || !isItem(l)) return 0;
  // An Auftrag delivers and invoices apart; an Angebot is taken once, into an Auftrag or a Rechnung.
  const kinds: DocumentKind[] = source.kind === 'sales-order' ? [to] : ['sales-order', 'invoice'];
  return Math.round((l.quantity - taken(source, k, docs, kinds)) * 1000) / 1000;
}

/** A position the conversion dialog offers: the position, what is open, and whether it comes ticked (an option comes unticked). */
export interface Offered { line: number; item: ItemLine; open: number; ticked: boolean }

export function offered(source: Invoice, to: DocumentKind, docs: readonly Invoice[]): Offered[] {
  return source.lines.flatMap((l, k) => {
    if (!isItem(l)) return [];
    const open = openQuantity(source, k, to, docs);
    return [{ line: k, item: l, open: Math.max(0, open), ticked: !l.optional && open > 0 }];
  });
}

/** A ticked position of a conversion request: the source's position index and the quantity to take. */
export interface Ticked { line: number; quantity: number }

/** The warnings of a conversion the person may override (spec 4.11), each with the facts it names. */
export type ConvertWarning =
  | { code: 'expired'; date: string }
  | { code: 'declined'; date: string }
  | { code: 'overOpen'; line: number; text: string; quantity: number; open: number; unit?: string };

/** What a conversion of `source` into `to` with `picks` warns of on `today`. */
export function convertWarnings(source: Invoice, to: DocumentKind, picks: readonly Ticked[], docs: readonly Invoice[], today: string): ConvertWarning[] {
  const out: ConvertWarning[] = [];
  if (source.kind === 'quote' && source.declined && !accepted(source, docs)) out.push({ code: 'declined', date: source.declined.date });
  else if (source.kind === 'quote' && source.validUntil && source.validUntil < today && !accepted(source, docs)) out.push({ code: 'expired', date: source.validUntil });
  for (const p of picks) {
    const l = source.lines[p.line];
    const open = openQuantity(source, p.line, to, docs);
    if (l && isItem(l) && p.quantity > Math.max(0, open)) out.push({ code: 'overOpen', line: p.line, text: l.text, quantity: p.quantity, open: Math.max(0, open), ...(l.unit ? { unit: l.unit } : {}) });
  }
  return out;
}

/** An Angebot is accepted by the person's click or as a fact: an Auftrag or Rechnung made from it. */
export const accepted = (quote: Invoice, docs: readonly Invoice[]): boolean =>
  !!quote.accepted || madeFrom(quote, docs).some((d) => d.kind === 'sales-order' || d.kind === 'invoice');

/**
 * The draft a conversion makes: the ticked positions with their text, quantity (as picked), unit,
 * price, rate, account and activity, an option ticked becoming an ordinary position, each with
 * `ofLine`; texts, Zwischentotale, Rabatte and page breaks stay where they stood; the customer,
 * currency, language, prices, exemption, subject and the customer's order reference come along,
 * and `from` names the source. `confirmed`: the warnings the person overrode («Trotzdem …»).
 */
export function convertDraft(source: Invoice, to: DocumentKind, picks: readonly Ticked[], docs: readonly Invoice[], envelope: Envelope, date: string, today: string, confirmed: readonly string[] = []): Draft {
  if (!CONVERSIONS[source.kind]?.includes(to)) throw new InvoiceRuleError('convert', `Aus einem Dokument dieser Art (${source.kind}) entsteht kein ${to}.`, undefined, { from: source.kind, to });
  if (source.status !== 'issued') throw new InvoiceRuleError('notIssued', 'Erst ausstellen, dann weiterführen: ein Entwurf hat noch keine Nummer.');
  if (source.cancelled) throw new InvoiceRuleError('cancelled', `${source.number} ist storniert.`, undefined, { number: source.number });
  const valid = picks.filter((p) => p.quantity !== 0);
  for (const p of valid) {
    const l = source.lines[p.line];
    if (!l || !isItem(l) || !Number.isFinite(p.quantity)) throw new InvoiceRuleError('incomplete', `Position ${p.line + 1} ist keine Position mit Menge.`);
    // What is taken back is a Gutschrift's, never a negative quantity of a conversion.
    if (p.quantity < 0) throw new InvoiceRuleError('incomplete', `Position ${p.line + 1}: eine Menge unter null wird nicht übernommen.`);
  }
  if (!valid.length) throw new InvoiceRuleError('nothingTicked', 'Keine Position angekreuzt: es wird nichts übernommen, kein Entwurf angelegt.');
  for (const w of convertWarnings(source, to, valid, docs, today)) {
    if (confirmed.includes(w.code)) continue;
    if (w.code === 'overOpen') throw new InvoiceRuleError('overOpen', `Mehr als offen: ${w.quantity} von ${w.open} (${w.text}). Die Position zeigte dann mehr verrechnet oder geliefert als bestellt; nur mit «Trotzdem übernehmen».`, undefined, { quantity: w.quantity, open: w.open, text: w.text, unit: w.unit ?? '' });
    const what = w.code === 'expired' ? `abgelaufen am ${w.date}` : `abgelehnt am ${w.date}`;
    throw new InvoiceRuleError(w.code, `Das Angebot ${source.number} ist ${what}: seine Preise kommen in den Entwurf, und es gilt dann als angenommen. Nur mit «Trotzdem erstellen».`, undefined, { number: source.number, date: w.date });
  }
  const byLine = new Map(valid.map((p) => [p.line, p.quantity]));
  const lines: InvoiceLine[] = source.lines.flatMap((l, k): InvoiceLine[] => {
    if (!isItem(l)) return [{ ...l }];
    const quantity = byLine.get(k);
    if (quantity === undefined) return [];
    const { optional: _o, ofLine: _f, ...rest } = l;
    return [{ ...rest, quantity, ofLine: k }];
  });
  // A structure left with no position above or below it says nothing: leading and trailing page breaks go.
  while (lines.length && lines.at(-1)!.kind === 'pagebreak') lines.pop();
  return {
    ...envelope,
    status: 'draft',
    kind: to,
    customerId: source.customerId,
    date,
    currency: source.currency,
    language: source.language,
    ...(source.subject ? { subject: source.subject } : {}),
    lines,
    ...(source.prices ? { prices: source.prices } : {}),
    ...(source.exemption ? { exemption: source.exemption } : {}),
    ...(source.ordered ? { ordered: source.ordered } : {}),
    ...(to === 'invoice' && source.termsId ? { termsId: source.termsId } : {}),
    ...(to === 'sales-order' && source.printAs ? { printAs: source.printAs } : {}),
    from: { id: source.id, kind: source.kind },
    comments: [],
  };
}

/** The days an Angebot holds by default from its date: a new one's `validUntil`. */
export const QUOTE_DAYS = 30;
export const defaultValidUntil = (date: string): string => addDays(date, QUOTE_DAYS);

/** A step of the Belegkette: the document, how deep it hangs below the first, and whether it is the one looked at. */
export interface ChainStep { doc: Invoice; depth: number; current: boolean }

/**
 * The Belegkette of `doc`: from the first document (followed up by `from` and a Gutschrift's
 * `creditFor`) every document made from it, depth first in date order, so each document of the chain
 * shows the same steps. A document alone has a chain of one.
 */
export function chainOf(doc: Invoice, docs: readonly Invoice[]): ChainStep[] {
  const all = alive(docs);
  const byId = new Map(all.map((d) => [d.id, d]));
  const parentOf = (d: Invoice): Invoice | undefined => byId.get(d.from?.id ?? d.creditFor ?? '');
  let root = doc;
  for (const seen = new Set<string>([doc.id]); ;) {
    const p = parentOf(root);
    if (!p || seen.has(p.id)) break;
    seen.add(p.id);
    root = p;
  }
  const children = (d: Invoice) => all.filter((c) => c.id !== d.id && (c.from?.id === d.id || (c.kind === 'credit-note' && c.creditFor === d.id)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const out: ChainStep[] = [];
  const walk = (d: Invoice, depth: number) => {
    if (out.some((s) => s.doc.id === d.id)) return;
    out.push({ doc: d, depth, current: d.id === doc.id });
    for (const c of children(d)) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

/**
 * The share of an Auftrag's value done by `pick` (delivered or invoiced), 0 to 1: each position's
 * quantity done, at most its quantity, weighted by its amount; options left out. For the columns
 * «geliefert» and «verrechnet».
 */
export function doneShare(order: Invoice, docs: readonly Invoice[], pick: 'delivered' | 'invoiced'): number {
  const ps = positions(order, docs).filter((p) => !p.item.optional && p.item.quantity > 0);
  const weight = (p: PositionState) => Math.abs(p.item.quantity * p.item.price) || 1;
  const whole = ps.reduce((s, p) => s + weight(p), 0);
  if (!whole) return 0;
  return ps.reduce((s, p) => s + weight(p) * Math.min(1, Math.max(0, p[pick] / p.item.quantity)), 0) / whole;
}

/** The total of the ticked positions of a conversion, in the source's prices: what the dialog shows. */
export function tickedTotal(source: Invoice, picks: readonly Ticked[]): number {
  const lines = picks.flatMap((p) => { const l = source.lines[p.line]; if (!l || !isItem(l)) return []; const { optional: _o, ...rest } = l; return [{ ...rest, quantity: p.quantity }]; });
  return totals({ lines, prices: source.prices }).gross;
}
