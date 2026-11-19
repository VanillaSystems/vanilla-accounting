/**
 * A dated value changed with a «gilt ab» before documents already issued (docs/specs/invoicing.md
 * 4.11, 4.12; docs/specs/domain-model.md §5.5): which issued documents printed another value for a
 * day the change now covers, and the ways on the card names. Pure: src/invoices/dated-change.ts
 * saves the change and carries out the way the person picks.
 */
import { valueOn, type Dated } from '../core/dated.js';
import { addressLines } from './sheet.js';
import { articlePositionPrice } from './articles.js';
import { isItem, type Address, type Article, type ContactAddress, type ContactTerms, type DocumentKind, type InvoiceBook, type InvoiceCurrency, type Issued, type Letterhead, type PaymentTerms, type PayTo } from './model.js';
import { accountOnPaper, liveDocuments, liveInvoices, openAmount, samePaidTo } from './rules.js';

/** What a card names a change for: an Artikel's price, where customers pay, terms, an address, the letterhead. */
export type DatedCardKind = 'price' | 'payTo' | 'terms' | 'address' | 'letterhead';
/**
 * The ways on (4.11): `keep` «So lassen» (the change is saved, every issued document stays as it is);
 * `charge` «Nachbelastung als Entwurf» (a price: a draft of the difference per contact, a Gutschrift
 * draft for a lower price); `notice` «Zahlungsaufforderung mit neuer IBAN» (each open Rechnung).
 */
export type DatedWay = 'keep' | 'charge' | 'notice';

/** A position of an issued Rechnung whose price the change would now give otherwise. */
export interface AffectedLine { line: number; text: string; quantity: number; price: number; now: number }

/** An issued document the change covers: what it printed, and what holds for its day now. */
export interface AffectedDocument {
  id: string;
  number: string;
  kind: DocumentKind;
  date: string;
  customerId: string;
  customer: string;
  /** What it printed and what now holds, as one line each (an IBAN, an address, terms). */
  printed?: string;
  now?: string;
  /** An open Rechnung: what is still open (a new IBAN). */
  open?: number;
  /** A price: its positions from the Artikel with their price and the new one. */
  lines?: AffectedLine[];
}

export interface DatedCard { kind: DatedCardKind; validFrom: string; affected: AffectedDocument[]; ways: DatedWay[] }

const issuedOf = (book: InvoiceBook): Issued[] => liveDocuments(book).filter((i): i is Issued => i.status === 'issued' && !i.cancelled);
const head = (d: Issued) => ({ id: d.id, number: d.number, kind: d.kind, date: d.date, customerId: d.customerId, customer: d.customer.name });
const lineOf = (a: Address | undefined): string => (a ? addressLines(a, 'de').join(', ') : '');

/**
 * A new price of the Artikel from `validFrom`: the issued Rechnungen dated in what the change covers
 * whose positions from the Artikel carry the price the history gave for their day as it stood when
 * they were issued, and now another. A position whose price a person changed on it is hers and stays out.
 */
export function priceCard(book: InvoiceBook, a: Article, next: Dated<number>, validFrom: string): DatedCard {
  const affected: AffectedDocument[] = [];
  for (const d of issuedOf(book)) {
    if (d.kind !== 'invoice' || d.date < validFrom) continue;
    const lines: AffectedLine[] = [];
    d.lines.forEach((l, k) => {
      if (!isItem(l) || l.kind !== 'article' || l.articleId !== a.id) return;
      const was = articlePositionPrice({ ...a, price: a.price.filter((e) => e.enteredAt <= d.issuedAt) }, d, l.vatRate);
      const now = articlePositionPrice({ ...a, price: next }, d, l.vatRate);
      if (l.price === was && now !== was) lines.push({ line: k, text: l.text, quantity: l.quantity, price: l.price, now });
    });
    if (lines.length) affected.push({ ...head(d), lines });
  }
  return { kind: 'price', validFrom, affected, ways: affected.length ? ['charge', 'keep'] : [] };
}


/**
 * A new account to pay to in `currency` from `validFrom` (P3.8): every open Rechnung in that currency
 * that printed another account, whatever its date, since its customer pays to what it printed. They
 * keep the payment part they printed, and their payments are still matched by their reference.
 */
export function payToCard(book: InvoiceBook, currency: InvoiceCurrency, next: Dated<PayTo>, validFrom: string): DatedCard {
  const invoices = liveInvoices(book);
  const affected: AffectedDocument[] = [];
  const now = valueOn(next, validFrom);
  for (const d of issuedOf(book)) {
    if (d.kind !== 'invoice' || d.currency !== currency) continue;
    const open = openAmount(d, invoices);
    if (open <= 0 || !now || samePaidTo(now, d.sender.payTo)) continue;
    affected.push({ ...head(d), printed: accountOnPaper(d.sender.payTo), now: accountOnPaper(now), open });
  }
  return { kind: 'payTo', validFrom, affected, ways: affected.length ? ['notice', 'keep'] : [] };
}

/** A contact's new addresses from `validFrom`: its issued documents dated in what it covers that printed another address. */
export function addressCard(book: InvoiceBook, contactId: string, next: Dated<ContactAddress[]>, validFrom: string): DatedCard {
  const affected = issuedOf(book).filter((d) => d.customerId === contactId && d.date >= validFrom).flatMap((d) => {
    const list = valueOn(next, d.date) ?? [];
    const a = (d.addressId ? list.find((x) => x.id === d.addressId) : undefined) ?? list.find((x) => x.billing) ?? list[0];
    const { id: _i, label: _l, attn: _a, billing: _b, delivery: _d, ...now } = a ?? { id: '', postcode: '', town: '', country: '' };
    return lineOf(now) && lineOf(now) !== lineOf(d.customer.address) ? [{ ...head(d), printed: lineOf(d.customer.address), now: lineOf(now) }] : [];
  });
  return { kind: 'address', validFrom, affected, ways: affected.length ? ['keep'] : [] };
}

/** A contact's new terms from `validFrom`: its issued Rechnungen dated in what it covers that printed other days. */
export function contactTermsCard(book: InvoiceBook, contactId: string, next: Dated<ContactTerms>, validFrom: string, firm: readonly PaymentTerms[], firmDays: number): DatedCard {
  const daysOf = (t: ContactTerms | undefined) => (t?.paymentTerms ? firm.find((x) => x.id === t.paymentTerms)?.days : t?.paymentDays) ?? firmDays;
  const affected = issuedOf(book).filter((d) => d.kind === 'invoice' && d.customerId === contactId && d.date >= validFrom).flatMap((d) => {
    const printed = d.terms?.days ?? d.customer.paymentTermsDays;
    const now = daysOf(valueOn(next, d.date));
    return printed !== now ? [{ ...head(d), printed: d.terms?.name ?? String(printed), now: String(now) }] : [];
  });
  return { kind: 'terms', validFrom, affected, ways: affected.length ? ['keep'] : [] };
}

/** The firm's terms from `validFrom`: the issued Rechnungen dated in what it covers whose printed terms now read otherwise. */
export function firmTermsCard(book: InvoiceBook, next: Dated<PaymentTerms[]>, validFrom: string): DatedCard {
  const affected = issuedOf(book).filter((d) => d.kind === 'invoice' && d.terms && d.date >= validFrom).flatMap((d) => {
    const now = valueOn(next, d.date)?.find((x) => x.id === d.terms!.id);
    const same = now && now.days === d.terms!.days && now.skonto?.percent === d.terms!.skonto?.percent && now.skonto?.days === d.terms!.skonto?.days;
    return same || !now ? [] : [{ ...head(d), printed: d.terms!.name, now: now.name }];
  });
  return { kind: 'terms', validFrom, affected, ways: affected.length ? ['keep'] : [] };
}

/** The letterhead from `validFrom`: the issued documents dated in what it covers that printed another name, address or UID. */
export function letterheadCard(book: InvoiceBook, next: Dated<Letterhead>, validFrom: string): DatedCard {
  const text = (l: Pick<Letterhead, 'name' | 'address' | 'uid'>) => [l.name, lineOf(l.address), l.uid ?? ''].filter(Boolean).join(', ');
  const affected = issuedOf(book).filter((d) => d.date >= validFrom).flatMap((d) => {
    const now = valueOn(next, d.date);
    return now && text(now) !== text(d.sender) ? [{ ...head(d), printed: text(d.sender), now: text(now) }] : [];
  });
  return { kind: 'letterhead', validFrom, affected, ways: affected.length ? ['keep'] : [] };
}
