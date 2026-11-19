/**
 * Kontakte (spec 4.4.5): the register of firms and persons the firm sells to, in invoices.json
 * `contacts`. Pure: what a document prints of its contact, the defaults a draft takes from it, the
 * customer number series, the validation of a request and the business file code proposes for it.
 * The changes to the file go through src/invoices/service.ts.
 */
import { bareVatId, vatIdError } from '../workspace/uid.js';
import { identify, type Counterparty } from '../knowledge/counterparties.js';
import {
  CONTACT_TYPES, INVOICE_CURRENCIES, INVOICE_LANGUAGES,
  type Address, type Contact, type ContactAddress, type ContactFields, type ContactPerson, type CustomerFields, type Invoice,
  type InvoiceBook, type InvoiceContent, type InvoiceLanguage, type InvoicingSettings,
} from './model.js';
import { InvoiceRuleError, type Missing } from './rules.js';
import { TEXTS } from './texts.js';

/** Contacts not deleted, archived ones included (a document may name one). */
export const liveContacts = (book: Pick<InvoiceBook, 'contacts'>): Contact[] => book.contacts.filter((c) => !c.deleted);
/** The contacts a new document may pick: not archived. */
export const pickableContacts = (book: Pick<InvoiceBook, 'contacts'>): Contact[] => liveContacts(book).filter((c) => !c.archived);

/** The documents that name a contact (drafts too): while one does, the contact is archived, never deleted. */
export const documentsOf = (book: Pick<InvoiceBook, 'invoices'>, contactId: string): Invoice[] =>
  book.invoices.filter((i) => !i.deleted && i.customerId === contactId);

/** The Rechnungsadresse: the address marked billing, else the first. */
export const billingAddress = (c: Pick<ContactFields, 'addresses'>): ContactAddress | undefined => c.addresses.find((a) => a.billing) ?? c.addresses[0];

/** The address a document is sent to: the one it picks, else the billing address. */
export const addressOf = (c: Pick<ContactFields, 'addresses'>, addressId: string | undefined): ContactAddress | undefined =>
  (addressId ? c.addresses.find((a) => a.id === addressId) : undefined) ?? billingAddress(c);

/** The days a contact pays in: the firm's terms it names, else its own days, else the firm's default terms, else the firm's days. */
export function contactDays(c: Pick<ContactFields, 'paymentTerms' | 'paymentDays'> | undefined, s: Pick<InvoicingSettings, 'paymentTerms' | 'defaultTerms' | 'paymentTermsDays'> | undefined): number {
  const firm = s?.paymentTerms.find((x) => x.id === s.defaultTerms) ?? s?.paymentTerms[0];
  const named = c?.paymentTerms ? s?.paymentTerms.find((x) => x.id === c.paymentTerms) : undefined;
  return named?.days ?? c?.paymentDays ?? firm?.days ?? s?.paymentTermsDays ?? 30;
}

/**
 * The terms a new draft for the contact picks: the firm's terms its contact names; for days of its
 * own or none, the firm's default when its days are the contact's, else none (the draft then prints
 * the contact's days net, as a customer with days of its own did before contacts).
 */
export function draftTermsOf(s: Pick<InvoicingSettings, 'paymentTerms' | 'defaultTerms' | 'paymentTermsDays'> | undefined, c: Pick<ContactFields, 'paymentTerms' | 'paymentDays'>): string | undefined {
  const all = s?.paymentTerms ?? [];
  const named = all.find((x) => x.id === c.paymentTerms);
  if (named) return named.id;
  const def = all.find((x) => x.id === s?.defaultTerms) ?? all[0];
  return def && def.days === contactDays(c, s) ? def.id : undefined;
}

/** The name a document prints: a firm's, a person's with the salutation before it. */
export const printedName = (c: Pick<ContactFields, 'type' | 'name' | 'salutation'>): string =>
  c.type === 'person' && c.salutation?.trim() ? `${c.salutation.trim()} ${c.name}` : c.name;

/**
 * The recipient a document of the contact prints and freezes at issue: its name, the picked
 * address (else the billing address) with that address's line, «z. Hd.» the picked contact person,
 * whose e-mail the document goes to (else the contact's first). Undefined: no contact.
 */
export function recipientOf(c: Contact | undefined, doc: Pick<InvoiceContent, 'personId' | 'addressId' | 'language'>, s: Pick<InvoicingSettings, 'paymentTerms' | 'defaultTerms' | 'paymentTermsDays'> | undefined): CustomerFields | undefined {
  if (!c) return undefined;
  const a = addressOf(c, doc.addressId);
  const person = doc.personId ? c.persons.find((p) => p.id === doc.personId) : undefined;
  const address: Address = a ? addressPart(a) : { postcode: '', town: '', country: 'CH' };
  const attn = [a?.attn?.trim(), person ? `${TEXTS[doc.language].attn} ${person.name}` : undefined].filter(Boolean).join(', ');
  const email = person?.email ?? c.emails[0];
  return {
    name: printedName(c),
    ...(attn ? { attn } : {}),
    address,
    language: c.language,
    ...(c.vatId ? { vatId: c.vatId } : {}),
    ...(email ? { email } : {}),
    paymentTermsDays: contactDays(c, s),
  };
}

/** The postal part of a contact's address, as a document prints it. */
function addressPart(a: ContactAddress): Address {
  const { id: _i, label: _l, attn: _a, billing: _b, delivery: _d, ...address } = a;
  return address;
}

/**
 * What a draft names of its contact that the contact no longer has: the contact person (`customer.person`)
 * or the picked address (`customer.addressGone`). Issuing warns of it («Trotzdem ausstellen»): the
 * document then goes without «z. Hd.», or to the billing address.
 */
export function goneRefs(c: Pick<ContactFields, 'persons' | 'addresses'> | undefined, doc: Pick<InvoiceContent, 'personId' | 'addressId'>): Missing[] {
  if (!c) return [];
  return [
    ...(doc.personId && !c.persons.some((p) => p.id === doc.personId) ? [{ field: 'customer.person' as const }] : []),
    ...(doc.addressId && !c.addresses.some((a) => a.id === doc.addressId) ? [{ field: 'customer.addressGone' as const }] : []),
  ];
}

/** What a new position of a document for the contact starts with: its revenue account and standing discount. */
export function lineDefaults(c: Pick<ContactFields, 'revenueAccount' | 'discount'> | undefined): { account?: string; discount?: number } {
  return { ...(c?.revenueAccount ? { account: c.revenueAccount } : {}), ...(c?.discount ? { discount: c.discount } : {}) };
}

// ─── the customer number series ─────────────────────────────────────────────────

/** The customer numbers' format: K- and five digits (spec 7, decisions in the build). */
export const CONTACT_NUMBER = /^K-(\d+)$/;

/** The next customer number: one above the highest K-number given, K-00001 for the first. */
export function nextContactNumber(contacts: readonly Pick<Contact, 'number'>[]): string {
  const top = contacts.reduce((n, c) => Math.max(n, Number(CONTACT_NUMBER.exec(c.number ?? '')?.[1] ?? 0)), 0);
  return `K-${String(top + 1).padStart(5, '0')}`;
}

/** The book with the contact numbered, if it has no number yet (its first issued document). */
export function numberContact(book: InvoiceBook, contactId: string): void {
  const i = book.contacts.findIndex((c) => c.id === contactId);
  if (i < 0 || book.contacts[i].number) return;
  book.contacts[i] = { ...book.contacts[i], number: nextContactNumber(book.contacts) };
}

// ─── validation at the boundary ─────────────────────────────────────────────────

const isText = (v: unknown): v is string => typeof v === 'string';
const bad = (msg: string, missing?: Missing[]): never => { throw new InvoiceRuleError('incomplete', msg, missing); };
const trimmed = (v: unknown, k: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!isText(v)) bad(`${k} ist ein Text.`);
  return (v as string).trim() || undefined;
};

/** A Swiss UID carries a check digit (r8c-18): a typo is caught; a foreign VAT number is any text. */
export function checkVatId(vatId: string | undefined): void {
  const error = vatIdError(vatId);
  if (error) throw new InvoiceRuleError('uid', error);
}

function parseAddress(raw: unknown, at: string, id: string): ContactAddress {
  const a = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) bad(`${at} ist ein Objekt.`);
  const known = ['id', 'street', 'number', 'line2', 'postcode', 'town', 'state', 'country', 'label', 'attn', 'billing', 'delivery'];
  const extra = Object.keys(a).filter((k) => !known.includes(k));
  if (extra.length) bad(`${at}: unbekannte Felder ${extra.join(', ')}.`);
  if (!isText(a.postcode) || !isText(a.town) || !isText(a.country) || !/^[A-Z]{2}$/.test(a.country)) bad(`${at} braucht postcode, town und country (zwei Buchstaben, CH, DE, …).`, [{ field: 'customer.address' }]);
  const out: ContactAddress = { id, postcode: (a.postcode as string).trim(), town: (a.town as string).trim(), country: a.country as string };
  for (const k of ['street', 'number', 'line2', 'state', 'label', 'attn'] as const) { const v = trimmed(a[k], `${at}.${k}`); if (v) out[k] = v; }
  for (const k of ['billing', 'delivery'] as const) {
    if (a[k] === undefined) continue;
    if (typeof a[k] !== 'boolean') bad(`${at}.${k} ist true oder false.`);
    if (a[k]) out[k] = true;
  }
  return out;
}

function parsePerson(raw: unknown, at: string, id: string): ContactPerson {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) bad(`${at} ist ein Objekt.`);
  const extra = Object.keys(p).filter((k) => !['id', 'name', 'role', 'email', 'phone'].includes(k));
  if (extra.length) bad(`${at}: unbekannte Felder ${extra.join(', ')}.`);
  const name = trimmed(p.name, `${at}.name`);
  if (!name) bad(`${at}: name fehlt.`, [{ field: 'customer.name' }]);
  const out: ContactPerson = { id, name: name! };
  for (const k of ['role', 'email', 'phone'] as const) { const v = trimmed(p[k], `${at}.${k}`); if (v) out[k] = v; }
  return out;
}

/** A random id part: never one given before, so a document that named a removed person or address never names another. */
const randomPart = (): string => [...globalThis.crypto.getRandomValues(new Uint8Array(6))].map((b) => (b % 36).toString(36)).join('');

/**
 * Ids of a list: kept where the request names one the contact has, else a new random `<prefix><x>`.
 * An id the contact no longer has is never given again (a draft's `personId` of a removed person
 * stays a person who is gone, never becomes the next one added).
 */
function withIds<T>(items: unknown[], prefix: string, had: readonly { id: string }[], parse: (raw: unknown, at: string, id: string) => T, what: string): T[] {
  const taken = new Set(had.map((x) => x.id));
  const seen = new Set<string>();
  const fresh = () => { let id: string; do id = `${prefix}${randomPart()}`; while (taken.has(id) || seen.has(id)); return id; };
  return items.map((raw, i) => {
    const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    const own = typeof id === 'string' && taken.has(id) && !seen.has(id) ? id : fresh();
    seen.add(own);
    return parse(raw, `${what} ${i + 1}`, own);
  });
}

const FIELDS = ['type', 'name', 'salutation', 'firstName', 'lastName', 'number', 'persons', 'addresses', 'language', 'emails', 'phone', 'vatId',
  'paymentTerms', 'paymentDays', 'currency', 'revenueAccount', 'discount', 'noReminders', 'notes', 'tags', 'archived', 'business'] as const;

/**
 * A contact's fields from a request: all of them (`was` absent, a new contact) or the ones it
 * changes (`null` clears an optional one). A person's `name` is derived from its first and last
 * name; a firm needs a name. `terms`: the firm's terms ids a contact may name.
 */
export function parseContact(body: unknown, was?: Contact, terms: readonly string[] = []): Partial<ContactFields> & { clear: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('JSON-Objekt erwartet.');
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !FIELDS.includes(k as never));
  if (unknown.length) bad(`Unbekannte Felder: ${unknown.join(', ')}`);
  const out: Partial<ContactFields> & { clear: string[] } = { clear: [] };
  const optional = ['salutation', 'firstName', 'lastName', 'number', 'phone', 'vatId', 'paymentTerms', 'paymentDays', 'currency', 'revenueAccount', 'discount', 'noReminders', 'notes', 'tags', 'business'];
  for (const [k, v] of Object.entries(b)) if (v === null && optional.includes(k)) out.clear.push(k);
  const given = (k: string) => b[k] !== undefined && b[k] !== null;

  const type = given('type') ? b.type : was?.type ?? 'firm';
  if (!CONTACT_TYPES.includes(type as never)) bad(`type ist ${CONTACT_TYPES.join(' oder ')}.`);
  if (given('type') || !was) out.type = type as ContactFields['type'];
  for (const k of ['salutation', 'firstName', 'lastName', 'phone', 'notes', 'business'] as const) if (given(k)) { const v = trimmed(b[k], k); if (v) out[k] = v; else out.clear.push(k); }
  if (given('number')) {
    const v = trimmed(b.number, 'number');
    if (v && v.length > 20) bad('number hat höchstens 20 Zeichen.');
    if (v) out.number = v; else out.clear.push('number');
  }
  if (type === 'person') {
    const first = 'firstName' in b ? out.firstName : was?.firstName;
    const last = 'lastName' in b ? out.lastName : was?.lastName;
    const name = [first, last].filter(Boolean).join(' ');
    if (!name) bad('Vor- oder Nachname fehlt.', [{ field: 'customer.name' }]);
    out.name = name;
  } else if (given('name') || !was || was.type !== 'firm') {
    const name = trimmed(b.name, 'name');
    if (!name) bad('name fehlt.', [{ field: 'customer.name' }]);
    out.name = name!;
  }
  if (given('language') || !was) {
    if (!INVOICE_LANGUAGES.includes(b.language as never)) bad(`language ist eine von ${INVOICE_LANGUAGES.join(', ')}.`);
    out.language = b.language as InvoiceLanguage;
  }
  if (given('emails') || !was) {
    const list = b.emails ?? [];
    if (!Array.isArray(list) || list.some((e) => !isText(e))) bad('emails ist eine Liste von Texten.');
    out.emails = (list as string[]).map((e) => e.trim()).filter(Boolean);
  }
  if (given('vatId')) { const v = trimmed(b.vatId, 'vatId'); checkVatId(v); if (v) out.vatId = v; else out.clear.push('vatId'); }
  if (given('paymentTerms') && given('paymentDays')) bad('paymentTerms oder paymentDays, nicht beides.');
  // The firm's terms or days of its own: one replaces the other.
  if (given('paymentTerms')) {
    if (!isText(b.paymentTerms) || !terms.includes(b.paymentTerms)) bad(`paymentTerms ist eine von ${terms.join(', ')}.`);
    out.paymentTerms = b.paymentTerms as string;
    out.clear.push('paymentDays');
  }
  if (given('paymentDays')) {
    if (!Number.isInteger(b.paymentDays) || (b.paymentDays as number) < 0 || (b.paymentDays as number) > 999) bad('paymentDays ist eine ganze Zahl von 0 bis 999.');
    out.paymentDays = b.paymentDays as number;
    out.clear.push('paymentTerms');
  }
  if (given('currency')) { if (!INVOICE_CURRENCIES.includes(b.currency as never)) bad(`currency ist ${INVOICE_CURRENCIES.join(' oder ')}.`); out.currency = b.currency as ContactFields['currency']; }
  if (given('revenueAccount')) { if (!/^\d{4}$/.test(String(b.revenueAccount))) bad('revenueAccount ist ein vierstelliges Konto.'); out.revenueAccount = String(b.revenueAccount); }
  if (given('discount')) {
    if (typeof b.discount !== 'number' || !(b.discount >= 0 && b.discount <= 100)) bad('discount ist ein Prozentsatz von 0 bis 100.');
    if (b.discount) out.discount = b.discount as number; else out.clear.push('discount');
  }
  for (const k of ['noReminders', 'archived'] as const) if (given(k)) {
    if (typeof b[k] !== 'boolean') bad(`${k} ist true oder false.`);
    if (b[k]) out[k] = true; else out.clear.push(k);
  }
  if (given('tags')) {
    if (!Array.isArray(b.tags) || b.tags.some((x) => !isText(x))) bad('tags ist eine Liste von Texten.');
    const tags = [...new Set((b.tags as string[]).map((x) => x.trim()).filter(Boolean))];
    if (tags.length) out.tags = tags; else out.clear.push('tags');
  }
  if (given('addresses') || !was) {
    const list = b.addresses ?? [];
    if (!Array.isArray(list)) bad('addresses ist eine Liste.');
    const addresses = withIds(list as unknown[], 'a-', was?.addresses ?? [], parseAddress, 'Adresse');
    if (addresses.filter((a) => a.billing).length > 1) bad('Nur eine Adresse ist die Rechnungsadresse.');
    out.addresses = addresses;
  }
  if (given('persons') || !was) {
    const list = b.persons ?? [];
    if (!Array.isArray(list)) bad('persons ist eine Liste.');
    out.persons = withIds(list as unknown[], 'p-', was?.persons ?? [], parsePerson, 'Kontaktperson');
  }
  return out;
}

/** The contact with a request's fields applied: those it names set, those it clears gone. */
export function applyContact<T extends ContactFields>(c: T, patch: Partial<ContactFields> & { clear?: string[] }): T {
  const { clear = [], ...fields } = patch;
  const next = { ...c, ...fields } as T;
  for (const k of clear) delete (next as Record<string, unknown>)[k];
  // A firm keeps no person's name parts; a person's name is its parts.
  if (next.type === 'firm') { delete next.salutation; delete next.firstName; delete next.lastName; }
  return next;
}

/** A customer number another live contact holds already: refused, the number names one contact. */
export function assertNumberFree(book: Pick<InvoiceBook, 'contacts'>, number: string | undefined, self?: string): void {
  if (!number) return;
  const other = liveContacts(book).find((c) => c.id !== self && c.number === number);
  if (other) throw new InvoiceRuleError('numberTaken', `Die Kundennummer ${number} hat schon ${other.name}.`);
}

/** A firm contact of a customer as phase 1 wrote one (the AI's «newCustomer», the demo's customers): its address the billing address. */
export function contactOfCustomer(f: Partial<CustomerFields> & Pick<CustomerFields, 'name' | 'language'>): ContactFields {
  return {
    type: 'firm',
    name: f.name,
    persons: [],
    addresses: f.address ? [{ id: 'a-1', ...f.address, ...(f.attn ? { attn: f.attn } : {}), billing: true }] : [],
    language: f.language,
    emails: f.email ? [f.email] : [],
    ...(f.vatId ? { vatId: f.vatId } : {}),
    ...(f.paymentTermsDays !== undefined ? { paymentDays: f.paymentTermsDays } : {}),
  };
}

// ─── the business file ────────────────────────────────────────────────────────

/**
 * The business file code proposes for a contact (spec 4.4.5): the one the books' routing names by
 * its UID, the IBANs of the payments of its invoices, or its name, when exactly one does. The
 * person keeps it (`business`); a contact that names one already gets no proposal.
 */
export function proposeBusiness(c: Contact, counterparties: readonly Counterparty[], ibans: readonly string[] = []): { id: string; name: string; by: string } | undefined {
  if (c.business) return undefined;
  const uid = c.vatId ? bareVatId(c.vatId) : undefined;
  // Only a customer's file: a supplier of the same name is another business to the books.
  const customers = counterparties.filter((x) => x.role === 'customer' || x.roles.includes('customer'));
  const r = identify({ uids: uid ? [uid] : [], ibans: [...ibans], domains: [], names: [c.name], filenames: [] }, customers);
  if (r.kind !== 'known') return undefined;
  const cp = customers.find((x) => x.id === r.counterparty);
  return cp ? { id: cp.id, name: cp.name, by: r.tier } : undefined;
}

/** The IBANs that paid a contact's invoices, as the statement rows name them. */
export function payerIbans(book: Pick<InvoiceBook, 'invoices'>, contactId: string, transactions: readonly { ref: string; counterpartyIban?: string }[]): string[] {
  const refs = new Set(documentsOf(book, contactId).flatMap((i) => (i.status === 'issued' ? i.payments.map((p) => p.transactionRef) : [])));
  return [...new Set(transactions.flatMap((t) => (refs.has(t.ref) && t.counterpartyIban ? [t.counterpartyIban.replace(/\s+/g, '').toUpperCase()] : [])))];
}

/** The language a contact's documents are likely in: Swiss postcodes by region, else by country. */
export function languageFor(country: string, postcode: string): InvoiceLanguage {
  if (country === 'CH') return !postcode ? 'de' : /^(1|2[0-8])/.test(postcode) ? 'fr' : /^6[5-9]/.test(postcode) ? 'it' : 'de';
  if (['DE', 'AT', 'LI'].includes(country)) return 'de';
  if (['FR', 'LU', 'MC', 'BE'].includes(country)) return 'fr';
  return country === 'IT' || country === 'SM' ? 'it' : 'en';
}
