/**
 * The invoicing values that change over time (docs/specs/invoicing.md 4.12, docs/specs/domain-model.md
 * §5): an Artikel's price; a contact's addresses, terms, discount and revenue account; the firm's
 * letterhead, `payTo` per currency, Zahlungskonditionen, write-off and fee accounts. Each is a dated
 * history (src/core/dated.ts), and a document reads the value valid on its own date. Pure and
 * browser-safe: the server, the CLI and the UI read through the same functions.
 */
import { entryOn, fromStart, valueOn, withEntry, SINCE_START, START_ENTERED, type Dated } from '../core/dated.js';

export { SINCE_START, START_ENTERED, fromStart, historyOf, isHistory, same, withEntry } from '../core/dated.js';
export { articleWithHistory, contactWithHistories } from '../workspace/schema.js';
import type { Company } from '../workspace/workspace.js';
import { DEFAULT_DUNNING } from '../workspace/dunning.js';
import {
  CONTACT_DATED, NET_TERMS, type Article, type Contact, type ContactFields, type ContactHistories, type ContactOnDay, type ContactTerms, type InvoiceCurrency, type InvoicingConfig, type InvoicingSettings,
  type Letterhead, type PaymentTerms,
} from './model.js';

/** The entry that holds on `day` and when it began, for «ab TT.MM.JJJJ». */
export const sinceOn = <T>(h: Dated<T> | undefined, day: string): string | undefined => entryOn(h, day)?.validFrom;

// ─── contacts ──────────────────────────────────────────────────────────────────

/** The contact as it stands on `day`: every dated value read on that day (none holds: none, the firm's default). */
export function contactOn(c: Contact, day: string): ContactOnDay {
  const { addresses, terms, discount, revenueAccount, ...plain } = c;
  const t = valueOn(terms, day) ?? {};
  const d = valueOn(discount, day);
  const acc = valueOn(revenueAccount, day);
  return {
    ...plain,
    addresses: valueOn(addresses, day) ?? [],
    ...(t.paymentTerms ? { paymentTerms: t.paymentTerms } : {}),
    ...(t.paymentDays !== undefined ? { paymentDays: t.paymentDays } : {}),
    ...(d ? { discount: d } : {}),
    ...(acc ? { revenueAccount: acc } : {}),
  };
}
/** A contact looked up and read on `day`. */
export const contactOnDay = (c: Contact | undefined, day: string): ContactOnDay | undefined => (c ? contactOn(c, day) : undefined);

/**
 * The contact as invoices.json holds it, from its values on `validFrom` (`v`, a form's or an import's):
 * the plain fields as given; each dated value a new entry from `validFrom` where it differs from what
 * `was` holds on that day. A new contact (`was` absent) holds its first values from the start (4.12).
 */
export function contactRecord<T extends ContactFields>(v: T, was: Contact | undefined, validFrom: string, enteredAt: string): Omit<T, 'addresses' | 'paymentTerms' | 'paymentDays' | 'discount' | 'revenueAccount'> & ContactHistories {
  const { addresses, paymentTerms, paymentDays, discount, revenueAccount, ...plain } = v;
  const from = was ? validFrom : SINCE_START;
  const at = was ? enteredAt : START_ENTERED;
  const terms: ContactTerms | null = paymentTerms ? { paymentTerms } : paymentDays !== undefined ? { paymentDays } : null;
  return {
    ...plain,
    addresses: withEntry(was?.addresses, addresses, from, at),
    terms: withEntry(was?.terms, terms as ContactTerms, from, at),
    discount: withEntry(was?.discount, discount || null, from, at),
    revenueAccount: withEntry(was?.revenueAccount, revenueAccount || null, from, at),
  };
}

export type ContactDatedKey = (typeof CONTACT_DATED)[number];
/** The dated value of a contact a form shows and changes, on `day`: the plain shape of the history's value. */
export function contactValueOn(c: Contact, key: ContactDatedKey, day: string): unknown {
  return valueOn(c[key] as Dated<unknown>, day);
}

// ─── articles ──────────────────────────────────────────────────────────────────

/** The Artikel's price on `day`; none holds (every price begins later): undefined, a fact the reader names. */
export const articlePriceOn = (a: Pick<Article, 'price'>, day: string): number | undefined => valueOn(a.price, day);

// ─── the firm's settings ───────────────────────────────────────────────────────

/** The terms a firm has on a day it names none: `paymentTermsDays` days net. */
export const netTerms = (days: number): PaymentTerms[] => [{ id: `net${days}`, name: NET_TERMS.de(days), days }];

/** Every terms any entry of the history names (a document of any date may name one). */
export const allTerms = (c: Pick<InvoicingConfig, 'paymentTerms' | 'paymentTermsDays'> | undefined): PaymentTerms[] =>
  !c ? [] : c.paymentTerms.length ? [...new Map(c.paymentTerms.flatMap((e) => e.value.map((x) => [x.id, x] as const))).values()] : netTerms(c.paymentTermsDays);

/** The plain settings valid on `day`: what a document of that date reads (4.12). */
export function invoicingOn(c: InvoicingConfig, day: string): InvoicingSettings {
  const { payTo, paymentTerms, writeOffAccount, feeAccount, letterhead: _l, dunning, ...plain } = c;
  const to: InvoicingSettings['payTo'] = {};
  for (const [cur, h] of Object.entries(payTo) as Array<[InvoiceCurrency, Dated<InvoicingSettings['payTo'][InvoiceCurrency] & object>]>) {
    const v = valueOn(h, day);
    if (v) to[cur] = v;
  }
  const terms = valueOn(paymentTerms, day) ?? netTerms(c.paymentTermsDays);
  const wo = valueOn(writeOffAccount, day);
  const fee = valueOn(feeAccount, day);
  return {
    ...plain,
    payTo: to,
    paymentTerms: terms,
    // The Mahnwesen of that day; none entered: a new firm's levels.
    dunning: valueOn(dunning, day) ?? structuredClone(DEFAULT_DUNNING),
    ...(plain.defaultTerms && !terms.some((x) => x.id === plain.defaultTerms) ? { defaultTerms: undefined } : {}),
    ...(wo ? { writeOffAccount: wo } : {}),
    ...(fee ? { feeAccount: fee } : {}),
  };
}
/** The settings on `day`, or undefined for a workspace without invoicing. */
export const invoicingOnDay = (c: InvoicingConfig | undefined, day: string): InvoicingSettings | undefined => (c ? invoicingOn(c, day) : undefined);

/** The firm as a document of `day` prints it: the letterhead's entry of that day, else the company's own. */
export function letterheadOn(company: Pick<Company, 'name' | 'address' | 'uid'>, c: Pick<InvoicingConfig, 'letterhead'> | undefined, day: string): Letterhead {
  return valueOn(c?.letterhead, day) ?? { name: company.name, ...(company.address ? { address: company.address } : {}), ...(company.uid ? { uid: company.uid } : {}) };
}

