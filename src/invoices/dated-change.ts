/**
 * «Ändern» with «gilt ab» on a dated value of invoicing (docs/specs/invoicing.md 4.12): one change
 * `{ path, value, validFrom }`, the shape a form and the AI's wish both send. Code checks it, finds the
 * issued documents it covers (src/invoices/backdated.ts) and, while some printed another value, answers
 * with the card and saves nothing until the request names a way: `keep` «So lassen», `charge`
 * «Nachbelastung als Entwurf», `notice` «Zahlungsaufforderung mit neuer IBAN». The choice is an
 * ordinary action; the entry carries no mark of the warning. invoices.json and belege.workspace.yaml
 * only: a draft of the difference is a draft, which books nothing until it is issued.
 */
import { readFileSync } from 'node:fs';
import { valueOn, type Dated } from '../core/dated.js';
import { patchManifestText } from '../workspace/manifest-write.js';
import { writeAtomic, loadInvoices, newEnvelope, updateInvoices } from './store.js';
import type { Workspace } from '../workspace/workspace.js';
import { addressCard, contactTermsCard, firmTermsCard, letterheadCard, payToCard, priceCard, type AffectedDocument, type DatedCard, type DatedWay } from './backdated.js';
import { allTerms, contactOn } from './dated-values.js';
import { applyArticle, parseArticle } from './articles.js';
import { applyContactFrom, parseContact } from './contacts.js';
import { CONTACT_DATED, INVOICE_CURRENCIES, type Draft, type InvoiceBook, type InvoiceCurrency, type InvoiceLine, type Issued, type ItemLine, type PaymentTerms, type PayTo } from './model.js';
import { InvoiceRuleError, creditNoteDraft, liveDocuments } from './rules.js';
import { DEFAULT_UNITS } from './model.js';
import { formatDate } from './texts.js';

export interface DatedChange {
  /** `articles/<id>/price`, `contacts/<id>/{addresses,terms,discount,revenueAccount}`, `invoicing/{payTo/<CUR>,paymentTerms,letterhead,writeOffAccount,feeAccount}`. */
  path: string;
  value: unknown;
  /** «gilt ab», YYYY-MM-DD. */
  validFrom: string;
  /** The person's way on over the card; absent: the card comes back when it names a document. */
  way?: DatedWay;
}

export type DatedSaved =
  | { saved: true; path: string; validFrom: string; drafts: Array<{ id: string; kind: 'invoice' | 'credit-note'; customer: string }>; notices: AffectedDocument[] }
  | ({ saved: false } & DatedCard);

const bad = (msg: string): never => { throw new InvoiceRuleError('incomplete', msg); };
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** What a change of the firm's settings writes, and the card of its history. */
interface Planned { card: DatedCard | undefined; save(): void }

/** Saves `change` unless it covers issued documents that printed another value and names no way; then the card. */
export function changeDated(ws: Workspace, change: DatedChange, now = new Date().toISOString()): DatedSaved {
  if (!isDay(change.validFrom)) bad('validFrom ist ein Datum JJJJ-MM-TT.');
  if (change.way !== undefined && !['keep', 'charge', 'notice'].includes(change.way)) bad('way ist keep, charge oder notice.');
  const book = loadInvoices(ws);
  const plan = planOf(ws, book, change, now);
  const card = plan.card;
  if (card?.affected.length && !change.way) return { saved: false, ...card };
  if (change.way && card && !card.ways.includes(change.way)) bad(`Für diese Änderung gibt es ${card.ways.join(', ') || 'keinen Weg'}.`);
  plan.save();
  const drafts = change.way === 'charge' && card?.kind === 'price' ? chargeDrafts(ws, card, change.validFrom, now) : [];
  return { saved: true, path: change.path, validFrom: change.validFrom, drafts, notices: change.way === 'notice' ? card?.affected ?? [] : [] };
}

function planOf(ws: Workspace, book: InvoiceBook, change: DatedChange, now: string): Planned {
  const [area, id, key, more] = change.path.split('/');
  const from = change.validFrom;
  if (area === 'articles' && key === 'price' && !more) {
    const i = book.articles.findIndex((a) => a.id === id && !a.deleted);
    if (i < 0) throw new InvoiceRuleError('articleGone', 'Diesen Artikel gibt es nicht (mehr).');
    const patch = parseArticle({ price: change.value }, (ws.invoicing?.units ?? DEFAULT_UNITS).map((u) => u.id), book.articles[i]);
    const next = applyArticle(book.articles[i], patch, from, now);
    return { card: priceCard(book, book.articles[i], next.price, from), save: () => updateInvoices(ws, (b) => { b.articles[b.articles.findIndex((a) => a.id === id)] = next; }) };
  }
  if (area === 'contacts' && key && !more) {
    const i = book.contacts.findIndex((c) => c.id === id && !c.deleted);
    if (i < 0) throw new InvoiceRuleError('contactGone', 'Diesen Kontakt gibt es nicht (mehr).');
    const stored = book.contacts[i];
    const body = contactBody(key, change.value);
    const terms = ws.invoicing ? allTerms(ws.invoicing) : [];
    const next = applyContactFrom(stored, parseContact(body, contactOn(stored, from), terms.map((x) => x.id)), from, now);
    const card = key === 'addresses' ? addressCard(book, stored.id, next.addresses, from)
      : key === 'terms' ? contactTermsCard(book, stored.id, next.terms, from, terms, ws.invoicing?.paymentTermsDays ?? 30)
        : undefined;
    return { card, save: () => updateInvoices(ws, (b) => { b.contacts[b.contacts.findIndex((c) => c.id === id)] = next; }) };
  }
  if (area === 'invoicing') {
    const keyPath = change.path.split('/').slice(1);
    const known = (keyPath[0] === 'payTo' && keyPath.length === 2 && INVOICE_CURRENCIES.includes(keyPath[1] as InvoiceCurrency))
      || (['paymentTerms', 'letterhead', 'writeOffAccount', 'feeAccount'].includes(keyPath[0]) && keyPath.length === 1);
    if (!known) bad(`Unbekannter Pfad ${change.path}.`);
    if (!ws.invoicing) bad('Die Rechnungsstellung ist nicht eingerichtet.');
    const path = ws.paths.manifest;
    const text = readFileSync(path, 'utf8');
    const value = keyPath[0] === 'payTo' ? payToValue(change.value) : change.value;
    const { text: out, manifest } = patchManifestText(text, { invoicing: { dated: [{ key: keyPath, value, validFrom: from, enteredAt: now }] } }, path);
    const inv = manifest.invoicing!;
    const card = keyPath[0] === 'payTo' ? payToCard(book, keyPath[1] as InvoiceCurrency, inv.payTo[keyPath[1] as InvoiceCurrency] as Dated<PayTo>, from)
      : keyPath[0] === 'paymentTerms' ? firmTermsCard(book, inv.paymentTerms as Dated<PaymentTerms[]>, from)
        : keyPath[0] === 'letterhead' ? letterheadCard(book, inv.letterhead, from)
          : undefined;
    return { card, save: () => writeAtomic(path, out) };
  }
  return bad(`Unbekannter Pfad ${change.path}.`);
}

/**
 * The card of a contact's change from `validFrom` (the form's «gilt ab»): its issued documents that
 * printed another address or other terms for a day it covers; undefined when none did.
 */
export function contactChangeCard(ws: Workspace, id: string, body: unknown, validFrom: string, now = new Date().toISOString()): DatedCard | undefined {
  if (!isDay(validFrom)) bad('validFrom ist ein Datum JJJJ-MM-TT.');
  const book = loadInvoices(ws);
  const stored = book.contacts.find((c) => c.id === id && !c.deleted);
  if (!stored) return undefined;
  const terms = ws.invoicing ? allTerms(ws.invoicing) : [];
  const next = applyContactFrom(stored, parseContact(body, contactOn(stored, validFrom), terms.map((x) => x.id)), validFrom, now);
  const cards = [addressCard(book, id, next.addresses, validFrom), contactTermsCard(book, id, next.terms, validFrom, terms, ws.invoicing?.paymentTermsDays ?? 30)].filter((c) => c.affected.length);
  return cards.length ? { ...cards[0], affected: cards.flatMap((c) => c.affected) } : undefined;
}

/** A dated value of a contact as the PATCH of a contact names it. */
function contactBody(key: string, value: unknown): Record<string, unknown> {
  if (key === 'addresses') return { addresses: value };
  if (key === 'discount') return { discount: value ?? 0 };
  if (key === 'revenueAccount') return { revenueAccount: value ?? null };
  if (key === 'terms') {
    const t = (value ?? {}) as { paymentTerms?: unknown; paymentDays?: unknown };
    return t.paymentTerms ? { paymentTerms: t.paymentTerms, paymentDays: null } : t.paymentDays !== undefined ? { paymentDays: t.paymentDays, paymentTerms: null } : { paymentTerms: null, paymentDays: null };
  }
  return bad(`Unbekannter Wert ${key}.`);
}

/** Where customers pay: the ledger account and what its bank gave beside its IBAN, each a text the manifest checks; the IBAN is the account's of bankAccounts. */
function payToValue(v: unknown): Record<string, unknown> {
  const { account, ...rest } = (v ?? {}) as Record<string, unknown>;
  if (typeof account !== 'string' || !/^\d{4}$/.test(account)) bad('account ist ein vierstelliges Bankkonto.');
  return { account, ...Object.fromEntries(Object.entries(rest).flatMap(([k, x]) => (typeof x === 'string' && x.trim() ? [[k, x.replace(/\s/g, '')]] : []))) };
}

/**
 * «Nachbelastung als Entwurf» (4.12): one Rechnung draft per contact with the difference of each
 * position (quantity × the price's difference, the position's rate and account), or for a lower price
 * one Gutschrift draft per Rechnung (a Gutschrift names its Rechnung). Drafts only: the person reads,
 * changes and issues them.
 */
function chargeDrafts(ws: Workspace, card: DatedCard, validFrom: string, now: string): Array<{ id: string; kind: 'invoice' | 'credit-note'; customer: string }> {
  return updateInvoices(ws, (book) => {
    const made: Array<{ id: string; kind: 'invoice' | 'credit-note'; customer: string }> = [];
    const day = now.slice(0, 10);
    const docOf = (id: string) => book.invoices.find((i): i is Issued => i.id === id && i.status === 'issued')!;
    // The difference per piece: positive on a Rechnung, negative on a Gutschrift (whose positions carry negative prices).
    const diffLine = (d: Issued, l: { line: number; text: string; quantity: number; price: number; now: number }): InvoiceLine => {
      const was = d.lines[l.line] as ItemLine;
      const { ofLine: _o, optional: _op, inGroup: _g, ...rest } = was;
      return { ...rest, text: `${l.text} (${d.number}, ab ${formatDate(validFrom, d.language)})`, price: Math.round((l.now - l.price) * 100) / 100 };
    };
    const up = new Map<string, AffectedDocument[]>();
    for (const a of card.affected) {
      const ups = (a.lines ?? []).filter((l) => l.now > l.price);
      const downs = (a.lines ?? []).filter((l) => l.now < l.price);
      if (ups.length) up.set(a.customerId, [...(up.get(a.customerId) ?? []), { ...a, lines: ups }]);
      if (downs.length) {
        const d = docOf(a.id);
        const base = creditNoteDraft(d, { reason: '' }, newEnvelope('in', now), day);
        const credit: Draft = { ...base, lines: downs.map((l) => diffLine(d, l)) };
        book.invoices.push(credit);
        made.push({ id: credit.id, kind: 'credit-note', customer: a.customer });
      }
    }
    for (const [customerId, docs] of up) {
      const first = docOf(docs[0].id);
      const draft: Draft = {
        ...newEnvelope('in', now), status: 'draft', kind: 'invoice', customerId, date: day,
        currency: first.currency, language: first.language, ...(first.prices ? { prices: first.prices } : {}),
        ...(first.personId ? { personId: first.personId } : {}), ...(first.addressId ? { addressId: first.addressId } : {}),
        ...(first.termsId ? { termsId: first.termsId } : {}),
        lines: docs.flatMap((a) => (a.lines ?? []).map((l) => diffLine(docOf(a.id), l))),
        comments: [],
      };
      book.invoices.push(draft);
      made.push({ id: draft.id, kind: 'invoice', customer: docs[0].customer });
    }
    return made;
  });
}

/**
 * The entry `{ validFrom, enteredAt }` of `path` taken out again (the undo of the AI's change): only
 * while no issued document dated in what it covers was issued after it was entered, so none used it.
 */
export function withdrawDated(ws: Workspace, path: string, validFrom: string, enteredAt: string): void {
  const book = loadInvoices(ws);
  const used = liveDocuments(book).some((i) => i.status === 'issued' && i.date >= validFrom && i.issuedAt >= enteredAt);
  if (used) throw new InvoiceRuleError('changed', `Ein Dokument ab ${validFrom} ist seither ausgestellt: der Wert bleibt; ein neuer Eintrag ändert ihn.`);
  const drop = <T>(h: Dated<T>): Dated<T> => h.filter((e) => !(e.validFrom === validFrom && e.enteredAt === enteredAt));
  const [area, id, key] = path.split('/');
  if (area === 'invoicing') {
    const file = ws.paths.manifest;
    const { text } = patchManifestText(readFileSync(file, 'utf8'), { invoicing: { withdraw: [{ key: path.split('/').slice(1), validFrom, enteredAt }] } }, file);
    writeAtomic(file, text);
    return;
  }
  updateInvoices(ws, (b) => {
    if (area === 'articles') { const i = b.articles.findIndex((a) => a.id === id); if (i >= 0) b.articles[i] = { ...b.articles[i], price: drop(b.articles[i].price) }; return; }
    const i = b.contacts.findIndex((c) => c.id === id);
    if (i >= 0 && (CONTACT_DATED as readonly string[]).includes(key)) b.contacts[i] = { ...b.contacts[i], [key]: drop((b.contacts[i] as unknown as Record<string, Dated<unknown>>)[key]) } as typeof b.contacts[number];
  });
}

/** The value of `path` today and from when, for the AI's card («bisher» beside the new one). */
export function datedValueNow(ws: Workspace, path: string, day: string): unknown {
  const [area, id, key, cur] = path.split('/');
  const book = loadInvoices(ws);
  if (area === 'articles') return valueOn(book.articles.find((a) => a.id === id)?.price, day);
  if (area === 'contacts') { const c = book.contacts.find((x) => x.id === id); return c && key ? valueOn((c as unknown as Record<string, Dated<unknown>>)[key], day) : undefined; }
  if (area === 'invoicing' && ws.invoicing) {
    const inv = ws.invoicing as unknown as Record<string, unknown>;
    const h = id === 'payTo' ? (inv.payTo as Record<string, Dated<unknown>>)[key ?? cur] : inv[id] as Dated<unknown>;
    return valueOn(h, day);
  }
  return undefined;
}
