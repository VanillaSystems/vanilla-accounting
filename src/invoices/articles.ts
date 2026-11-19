/**
 * Artikel (spec 4.3, 4.4.3): the products and services of invoices.json `articles`, and the
 * position a document gets from one. Pure: the validation of a request, archive or delete, the
 * search of the picker and of the AI, and the Artikel position with code, text, unit, price, rate,
 * account and activity filled from the Artikel (every field editable on the position since). The
 * changes to the file go through src/invoices/service.ts.
 */
import { invoiceActivities, rateOfKind } from '../engines/index.js';
import {
  ARTICLE_TYPES, PRICES, VAT_KINDS,
  type Article, type ArticleFields, type Contact, type Invoice, type InvoiceBook, type InvoiceContent, type ItemLine, type Prices, type UnitDef,
} from './model.js';
import { lineDefaults } from './contacts.js';
import { InvoiceRuleError } from './rules.js';

/** Artikel not deleted, archived ones included (a document may name one). */
export const liveArticles = (book: Pick<InvoiceBook, 'articles'>): Article[] => book.articles.filter((a) => !a.deleted);
/** The Artikel a new position may take: not archived. */
export const pickableArticles = (book: Pick<InvoiceBook, 'articles'>): Article[] => liveArticles(book).filter((a) => !a.archived);

/** The documents (drafts too) with a position from the Artikel: while one does, the Artikel is archived, never deleted. */
export const documentsNaming = (book: Pick<InvoiceBook, 'invoices'>, articleId: string): Invoice[] =>
  book.invoices.filter((i) => !i.deleted && i.lines.some((l) => l.kind === 'article' && l.articleId === articleId));

const bad = (msg: string): never => { throw new InvoiceRuleError('incomplete', msg); };
const isText = (v: unknown): v is string => typeof v === 'string';

const FIELDS = ['code', 'type', 'name', 'text', 'unit', 'price', 'prices', 'vatKind', 'account', 'activity', 'group', 'archived'] as const;

/**
 * An Artikel's fields from a request: all of them (`was` absent, a new Artikel) or the ones it
 * changes (`null` clears an optional one). `units`: the unit ids the firm's list names (and the one
 * the Artikel holds already, removed from the list since).
 */
export function parseArticle(body: unknown, units: readonly string[], was?: Article): Partial<ArticleFields> & { clear: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('JSON-Objekt erwartet.');
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !FIELDS.includes(k as never));
  if (unknown.length) bad(`Unbekannte Felder: ${unknown.join(', ')}`);
  const out: Partial<ArticleFields> & { clear: string[] } = { clear: [] };
  const optional = ['code', 'text', 'unit', 'prices', 'account', 'activity', 'group', 'archived'];
  for (const [k, v] of Object.entries(b)) if (v === null && optional.includes(k)) out.clear.push(k);
  const given = (k: string) => b[k] !== undefined && b[k] !== null;
  const trimmed = (k: string): string | undefined => { if (!isText(b[k])) bad(`${k} ist ein Text.`); return (b[k] as string).trim() || undefined; };

  if (given('name') || !was) { const v = given('name') ? trimmed('name') : undefined; if (!v) bad('name fehlt.'); out.name = v!; }
  if (given('type') || !was) { const v = b.type ?? 'service'; if (!ARTICLE_TYPES.includes(v as never)) bad(`type ist ${ARTICLE_TYPES.join(' oder ')}.`); out.type = v as ArticleFields['type']; }
  if (given('vatKind') || !was) { const v = b.vatKind ?? 'normal'; if (!VAT_KINDS.includes(v as never)) bad(`vatKind ist eine von ${VAT_KINDS.join(', ')}.`); out.vatKind = v as ArticleFields['vatKind']; }
  if (given('price') || !was) {
    const v = b.price ?? 0;
    if (typeof v !== 'number' || !Number.isFinite(v)) bad('price ist eine Zahl.');
    out.price = v as number;
  }
  for (const k of ['code', 'text', 'group'] as const) if (given(k)) { const v = trimmed(k); if (v) out[k] = v; else out.clear.push(k); }
  if (out.code && out.code.length > 30) bad('code hat höchstens 30 Zeichen.');
  if (given('unit')) { if (!units.includes(b.unit as string) && b.unit !== was?.unit) bad(`unit ist eine von ${units.join(', ')}.`); out.unit = b.unit as string; }
  if (given('prices')) { if (!PRICES.includes(b.prices as never)) bad(`prices ist ${PRICES.join(' oder ')}.`); if (b.prices === 'gross') out.prices = 'gross'; else out.clear.push('prices'); }
  if (given('account')) { if (!/^\d{4}$/.test(String(b.account))) bad('account ist ein vierstelliges Konto.'); out.account = String(b.account); }
  if (given('activity')) { if (b.activity !== 1 && b.activity !== 2) bad('activity ist 1 oder 2.'); if (b.activity === 2) out.activity = 2; else out.clear.push('activity'); }
  if (given('archived')) { if (typeof b.archived !== 'boolean') bad('archived ist true oder false.'); if (b.archived) out.archived = true; else out.clear.push('archived'); }
  return out;
}

/** The Artikel with a request's fields applied: those it names set, those it clears gone. */
export function applyArticle<T extends ArticleFields>(a: T, patch: Partial<ArticleFields> & { clear?: string[] }): T {
  const { clear = [], ...fields } = patch;
  const next = { ...a, ...fields } as T;
  for (const k of clear) delete (next as Record<string, unknown>)[k];
  return next;
}

const codeKey = (s: string) => s.trim().toUpperCase();

/** A code another live Artikel holds already: refused, a code names one Artikel (as the market leader's «Produktcode bereits in Gebrauch»). */
export function assertCodeFree(book: Pick<InvoiceBook, 'articles'>, code: string | undefined, self?: string): void {
  if (!code) return;
  const other = liveArticles(book).find((a) => a.id !== self && a.code && codeKey(a.code) === codeKey(code));
  if (other) throw new InvoiceRuleError('codeTaken', `Den Code ${code} hat schon ${other.name}.`);
}

/**
 * The Artikel a request names, by code (exact, without case) else by name (exact, then the one
 * whose name contains it): what the AI's draft and a typed search find. Only pickable ones; a name
 * two Artikel share names none.
 */
export function findArticle(book: Pick<InvoiceBook, 'articles'>, codeOrName: string): Article | undefined {
  const q = codeOrName.trim().toLowerCase();
  if (!q) return undefined;
  const all = pickableArticles(book);
  const byCode = all.find((a) => a.code?.toLowerCase() === q);
  if (byCode) return byCode;
  const exact = all.filter((a) => a.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const part = all.filter((a) => a.name.toLowerCase().includes(q));
  return exact.length === 0 && part.length === 1 ? part[0] : undefined;
}

/** The picker's search: by code or name (each word of `query` in either), code matches first, at most `limit`. */
export function searchArticles(articles: readonly Article[], query: string, limit = 50): Article[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = articles.filter((a) => !a.archived && !a.deleted && words.every((w) => `${a.code ?? ''} ${a.name} ${a.group ?? ''}`.toLowerCase().includes(w)));
  const starts = (a: Article) => (words[0] && a.code?.toLowerCase().startsWith(words[0]) ? 0 : 1);
  return hit.sort((a, b) => starts(a) - starts(b) || (a.code ?? '￿').localeCompare(b.code ?? '￿') || a.name.localeCompare(b.name)).slice(0, limit);
}

/**
 * The unit price of an Artikel on a document priced `prices`: as it is when they agree; else
 * converted at the position's rate, to the cent (net × (100 + rate) / 100, or back). A position
 * keeps what it got: the person may change it.
 */
export function priceOn(a: Pick<ArticleFields, 'price' | 'prices'>, prices: Prices, rate: number): number {
  const own = a.prices ?? 'net';
  if (own === prices || rate === 0) return a.price;
  const cents = Math.round(a.price * 100);
  return Math.round(own === 'net' ? cents * (100 + rate) / 100 : cents * 100 / (100 + rate)) / 100;
}

/** The day a position's rate is read for: the document's supply day, else its date (Art. 115 MWSTG: the rate of the supply). */
export const supplyDay = (doc: Pick<InvoiceContent, 'date' | 'supplied'>): string => doc.supplied?.to ?? doc.supplied?.from ?? doc.date;

/**
 * The Artikel position (spec 4.4.3): code, text (the Artikel's text, else its name), unit, price
 * (in the document's pricing), the rate of its VAT kind on the supply day, and the account: the
 * Artikel's, else the contact's revenue account, else none (the settings'); the contact's standing
 * discount; the activity on a firm with two net rates. Quantity 1.
 */
export function articleLine(a: Article, doc: Pick<InvoiceContent, 'date' | 'supplied' | 'prices'>, contact?: Pick<Contact, 'revenueAccount' | 'discount'>, units?: readonly UnitDef[]): ItemLine {
  const rate = rateOfKind(a.vatKind, supplyDay(doc));
  const defaults = lineDefaults(contact);
  const unit = a.unit && (!units || units.some((u) => u.id === a.unit)) ? a.unit : undefined;
  return {
    kind: 'article',
    articleId: a.id,
    ...(a.code ? { code: a.code } : {}),
    text: a.text ?? a.name,
    quantity: 1,
    ...(unit ? { unit } : {}),
    price: priceOn(a, doc.prices ?? 'net', rate),
    vatRate: rate,
    ...(defaults.discount ? { discount: defaults.discount } : {}),
    ...(a.account ?? defaults.account ? { account: a.account ?? defaults.account } : {}),
    ...(a.activity === 2 && invoiceActivities().length && rate > 0 ? { activity: 2 as const } : {}),
  };
}
