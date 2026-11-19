/**
 * Contacts from a table (spec 4.4.5, 4.7: the switch from another tool). The app reads any CSV with
 * a mapping of its columns to the contact's fields; code proposes the mapping from the header, the
 * person may change it. A preview names each row's problems and the rows that look like a contact
 * already there (same name or same UID) or like an earlier row: those are proposed as the same
 * contact and not imported again unless the person says `new`. Pure; src/invoices/service.ts
 * addContacts saves what it returns.
 */
import { csvLines } from '../core/files.js';
import { countryOf } from '../core/countries.js';
import { vatIdError } from '../workspace/uid.js';
import { INVOICE_LANGUAGES, type Contact, type ContactFields, type InvoiceLanguage } from './model.js';
import { languageFor } from './contacts.js';
import { InvoiceRuleError } from './rules.js';

/** The fields a column may fill. */
export const IMPORT_FIELDS = [
  'number', 'type', 'name', 'salutation', 'firstName', 'lastName', 'street', 'houseNumber', 'line2', 'postcode', 'town', 'country',
  'email', 'phone', 'vatId', 'language', 'person', 'personEmail', 'paymentDays', 'tags', 'notes',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
/** Field → the column's header text, as the person mapped it. */
export type ImportMapping = Partial<Record<ImportField, string>>;

/** The most rows one import reads; the preview names those it leaves out. */
export const IMPORT_LIMIT = 2000;

/**
 * What is wrong with a row. `name`, `uid`: the row is not imported. The others are imported all the
 * same: `address` without an address (one is needed only to issue), `country` read as CH,
 * `language` as the address's region says, `email`, `personEmail`, `paymentDays` and a `number`
 * longer than 20 characters left out.
 */
export const IMPORT_PROBLEMS = ['name', 'uid', 'address', 'country', 'language', 'email', 'personEmail', 'paymentDays', 'number'] as const;
export type ImportProblem = (typeof IMPORT_PROBLEMS)[number];
const BLOCKING: readonly ImportProblem[] = ['name', 'uid'];

/** `new`: imported; `same`: the contact it matches stands, not imported again; `skip`: left out. */
export type ImportChoice = 'new' | 'same' | 'skip';

export interface ImportRow {
  /** The line of the file the row starts on, the header's being 1 (empty lines and lines inside a quoted cell count). */
  line: number;
  contact?: ContactFields;
  problems: ImportProblem[];
  /** The contact already there, or the earlier row, it looks like; `by`: what matched. */
  same?: { contactId: string; name: string; by: 'name' | 'uid' } | { line: number; name: string; by: 'name' | 'uid' };
  /** What the import does with it unless the person changes it. */
  choice: ImportChoice;
}

export interface ImportPreview {
  header: string[];
  mapping: ImportMapping;
  rows: ImportRow[];
  /** Rows beyond IMPORT_LIMIT, not read. */
  leftOut: number;
}

/** Header words per field, in the four languages and as other tools name them; compared without case, spaces and punctuation. */
const HEADERS: Record<ImportField, string[]> = {
  number: ['kundennummer', 'kundennr', 'kontaktnr', 'kontaktnummer', 'nr', 'nummer', 'customernumber', 'customerno', 'number', 'numéro', 'numeroclient', 'numero'],
  type: ['typ', 'type', 'kontaktart', 'art', 'tipo'],
  name: ['firma', 'name', 'firmenname', 'company', 'companyname', 'organisation', 'organization', 'société', 'societe', 'raisonsociale', 'ditta', 'azienda', 'nom'],
  salutation: ['anrede', 'salutation', 'civilité', 'civilite', 'titolo', 'title'],
  firstName: ['vorname', 'firstname', 'givenname', 'prénom', 'prenom', 'nome'],
  lastName: ['nachname', 'lastname', 'surname', 'familyname', 'nomdefamille', 'cognome'],
  street: ['strasse', 'straße', 'street', 'adresse', 'address', 'rue', 'via', 'indirizzo'],
  houseNumber: ['hausnr', 'hausnummer', 'housenumber', 'streetnumber', 'numérorue', 'numerocivico', 'nciv'],
  line2: ['adresszusatz', 'zusatz', 'addressline2', 'address2', 'complément', 'complement'],
  postcode: ['plz', 'postleitzahl', 'zip', 'zipcode', 'postcode', 'postalcode', 'npa', 'codepostal', 'cap'],
  town: ['ort', 'stadt', 'city', 'town', 'localité', 'localite', 'ville', 'località', 'localita', 'città', 'citta'],
  country: ['land', 'country', 'pays', 'paese', 'nazione'],
  email: ['email', 'e-mail', 'mail', 'emailadresse', 'courriel'],
  phone: ['telefon', 'tel', 'phone', 'telephone', 'téléphone', 'telefono', 'mobile', 'natel'],
  vatId: ['uid', 'mwstnr', 'mwstnummer', 'mwst', 'uidnummer', 'vat', 'vatid', 'vatnumber', 'ustid', 'ustidnr', 'tva', 'notva', 'iva', 'partitaiva'],
  language: ['sprache', 'language', 'langue', 'lingua'],
  person: ['kontaktperson', 'ansprechpartner', 'contactperson', 'contact', 'personnedecontact', 'personadicontatto'],
  personEmail: ['emailkontaktperson', 'emailderkontaktperson', 'kontaktpersonemail', 'contactemail', 'contactpersonemail', 'emailcontactperson', 'ansprechpartneremail', 'emaildelapersonnedecontact', 'emaildellapersonadicontatto'],
  paymentDays: ['zahlungsfrist', 'zahlungsziel', 'zahlungsbedingungen', 'paymentterms', 'paymentdays', 'termsdays', 'délaidepaiement', 'termine'],
  tags: ['tags', 'kategorie', 'kategorien', 'category', 'categories', 'catégorie', 'categoria', 'gruppe'],
  notes: ['notizen', 'bemerkungen', 'notes', 'remarks', 'note', 'remarques', 'osservazioni'],
};

const norm = (s: string) => s.toLowerCase().normalize('NFC').replace(/[\s_\-:./()]+/g, '');

/** The mapping code proposes for a header: each field to the first column whose header names it. */
export function proposeMapping(header: readonly string[]): ImportMapping {
  const out: ImportMapping = {};
  const used = new Set<string>();
  for (const f of IMPORT_FIELDS) {
    const words = HEADERS[f].map(norm);
    const col = header.find((h) => !used.has(h) && words.includes(norm(h)));
    if (col) { out[f] = col; used.add(col); }
  }
  return out;
}

const LANGUAGE_WORDS: Record<string, InvoiceLanguage> = {
  de: 'de', deutsch: 'de', german: 'de', allemand: 'de', tedesco: 'de',
  fr: 'fr', französisch: 'fr', franzoesisch: 'fr', french: 'fr', français: 'fr', francais: 'fr', francese: 'fr',
  it: 'it', italienisch: 'it', italian: 'it', italien: 'it', italiano: 'it',
  en: 'en', englisch: 'en', english: 'en', anglais: 'en', inglese: 'en',
};
const PERSON_WORDS = ['person', 'privat', 'privatperson', 'private', 'particulier', 'privato', 'p'];

/** One row of the table as a contact, with what is wrong with it. */
function rowContact(cell: (f: ImportField) => string): { contact?: ContactFields; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  const first = cell('firstName'), last = cell('lastName');
  const type = PERSON_WORDS.includes(norm(cell('type'))) || (!cell('name') && (first || last)) ? 'person' : 'firm';
  const name = type === 'person' ? [first, last].filter(Boolean).join(' ') || cell('name') : cell('name');
  if (!name) return { problems: ['name'] };

  const vatId = cell('vatId');
  if (vatIdError(vatId)) problems.push('uid');

  const countryText = cell('country');
  let country = 'CH';
  if (countryText) {
    const code = /^[A-Za-z]{2}$/.test(countryText) ? countryText.toUpperCase() : countryOf(countryText);
    if (code) country = code; else problems.push('country');
  }
  const postcode = cell('postcode'), town = cell('town');
  const hasAddress = !!(postcode && town);
  if (!hasAddress) problems.push('address');

  const langText = cell('language');
  const language = langText ? LANGUAGE_WORDS[norm(langText)] ?? (INVOICE_LANGUAGES.includes(langText as never) ? langText as InvoiceLanguage : undefined) : undefined;
  if (langText && !language) problems.push('language');

  const emails = cell('email').split(/[;,\s]+/).filter(Boolean);
  const goodEmails = emails.filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (goodEmails.length < emails.length) problems.push('email');

  const daysText = cell('paymentDays');
  const days = /^\d{1,3}$/.test(daysText) ? Number(daysText) : /^(\d{1,3})\s*(tage|days|jours|giorni|t\.?)\b/i.exec(daysText)?.[1];
  if (daysText && days === undefined) problems.push('paymentDays');

  const personName = cell('person'), personEmail = cell('personEmail');
  const personEmailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(personEmail);
  if (personEmail && !personEmailOk) problems.push('personEmail');
  const number = cell('number');
  if (number.length > 20) problems.push('number');
  const tags = [...new Set(cell('tags').split(/[;,]/).map((x) => x.trim()).filter(Boolean))];
  const optional = (k: keyof ContactFields, v: string | undefined) => (v ? { [k]: v } : {});
  const street = cell('street'), houseNumber = cell('houseNumber');
  const contact: ContactFields = {
    type,
    name,
    ...(type === 'person' ? { ...optional('salutation', cell('salutation')), ...optional('firstName', first), ...optional('lastName', last) } : {}),
    ...(number.length <= 20 ? optional('number', number) : {}),
    persons: personName ? [{ id: 'p-1', name: personName, ...(personEmailOk ? { email: personEmail } : {}) }] : [],
    addresses: hasAddress ? [{
      id: 'a-1', ...(street ? { street } : {}), ...(houseNumber ? { number: houseNumber } : {}), ...(cell('line2') ? { line2: cell('line2') } : {}),
      postcode, town, country, billing: true,
    }] : [],
    language: language ?? languageFor(country, postcode),
    emails: goodEmails,
    ...optional('phone', cell('phone')),
    ...(vatId && !problems.includes('uid') ? { vatId } : {}),
    ...(days !== undefined ? { paymentDays: Number(days) } : {}),
    ...(tags.length ? { tags } : {}),
    ...optional('notes', cell('notes')),
  };
  return { contact, problems };
}

const nameKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const uidKey = (s: string | undefined) => (s && /^CHE/i.test(s) ? s.replace(/\D/g, '') : s?.replace(/\s+/g, '').toUpperCase()) || undefined;

/** Pure. The rows of `csv` read with `mapping` (absent: the proposed one), each with its problems, its duplicate and its choice. */
export function previewContactImport(csv: string, mapping: ImportMapping | undefined, existing: readonly Contact[]): ImportPreview {
  const [first, ...all] = csvLines(csv);
  const cols = (first?.cells ?? []).map((h) => h.trim());
  const map = mapping ?? proposeMapping(cols);
  const unknown = Object.entries(map).filter(([f, col]) => !IMPORT_FIELDS.includes(f as ImportField) || (col !== undefined && !cols.includes(col)));
  if (unknown.length) throw new InvoiceRuleError('incomplete', `Die Zuordnung nennt, was die Tabelle nicht hat: ${unknown.map(([f, c]) => `${f} → ${c}`).join(', ')}.`);
  const data = all.slice(0, IMPORT_LIMIT);
  const byName = new Map<string, { contactId: string; name: string } | { line: number; name: string }>();
  const byUid = new Map<string, { contactId: string; name: string } | { line: number; name: string }>();
  for (const c of existing) {
    byName.set(nameKey(c.name), { contactId: c.id, name: c.name });
    const u = uidKey(c.vatId);
    if (u) byUid.set(u, { contactId: c.id, name: c.name });
  }
  const rows = data.map(({ cells: r, line }): ImportRow => {
    const cell = (f: ImportField) => { const col = map[f]; const at = col === undefined ? -1 : cols.indexOf(col); return at < 0 ? '' : (r[at] ?? '').trim(); };
    const { contact, problems } = rowContact(cell);
    if (!contact || problems.some((p) => BLOCKING.includes(p))) return { line, ...(contact ? { contact } : {}), problems, choice: 'skip' };
    const u = uidKey(contact.vatId);
    const byU = u ? byUid.get(u) : undefined;
    const byN = byName.get(nameKey(contact.name));
    const same = byU ? { ...byU, by: 'uid' as const } : byN ? { ...byN, by: 'name' as const } : undefined;
    if (!same) {
      byName.set(nameKey(contact.name), { line, name: contact.name });
      if (u) byUid.set(u, { line, name: contact.name });
    }
    return { line, contact, problems, ...(same ? { same } : {}), choice: same ? 'same' : 'new' };
  });
  return { header: cols, mapping: map, rows, leftOut: Math.max(0, all.length - IMPORT_LIMIT) };
}

/** Pure. The contacts to add: each row the preview reads, as the person's choice for its line says (else the proposed one). */
export function importContacts(csv: string, mapping: ImportMapping | undefined, choices: Record<string, ImportChoice>, existing: readonly Contact[]): { contacts: ContactFields[]; skipped: number } {
  const preview = previewContactImport(csv, mapping, existing);
  const taken = new Set(existing.flatMap((c) => (c.number ? [c.number] : [])));
  const contacts: ContactFields[] = [];
  for (const row of preview.rows) {
    const choice = choices[String(row.line)] ?? row.choice;
    if (choice !== 'new' || !row.contact || row.problems.some((p) => BLOCKING.includes(p))) continue;
    // A customer number another contact has already stays with that one.
    const { number, ...rest } = row.contact;
    const keep = number && !taken.has(number);
    if (keep) taken.add(number);
    contacts.push(keep ? row.contact : rest);
  }
  return { contacts, skipped: preview.rows.length - contacts.length };
}
