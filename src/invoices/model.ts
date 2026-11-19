/**
 * Invoicing (ADR 0010): contacts, invoices and credit notes, reminders, sent documents and
 * comments, stored in the workspace's invoices.json (src/invoices/store.ts). Every record carries
 * the envelope of ADR 0004. An invoice is a draft until it is issued; issuing gives it its number,
 * its payment reference and its PDF, and freezes what it says.
 */

import type { Numbering } from '../workspace/numbering.js';

export const INVOICE_LANGUAGES = ['de', 'fr', 'it', 'en'] as const;
export type InvoiceLanguage = (typeof INVOICE_LANGUAGES)[number];

/** The two currencies a Swiss QR-bill carries. */
export const INVOICE_CURRENCIES = ['CHF', 'EUR'] as const;
export type InvoiceCurrency = (typeof INVOICE_CURRENCIES)[number];

/** A line's VAT rate in percent: one of the jurisdiction's (modules/ch/invoicing.yaml), 0 for an exempt supply. */
export type VatRate = number;

/** A unit a position is counted in: an id the firm's list names (`invoicing.units`), with its word in each document language. */
export type Unit = string;
export interface UnitDef extends Record<InvoiceLanguage, string> { id: Unit }

/**
 * The units a firm has while its settings list none. The ids h, day, pcs, flat and km are those of
 * every line written before the list (invoices.json schema 2), so an old line keeps its meaning.
 */
export const DEFAULT_UNITS: readonly UnitDef[] = [
  { id: 'h', de: 'Std.', fr: 'h', it: 'h', en: 'h' },
  { id: 'day', de: 'Tag', fr: 'jour', it: 'giorno', en: 'day' },
  { id: 'pcs', de: 'Stk.', fr: 'pce', it: 'pz.', en: 'pcs' },
  { id: 'flat', de: 'pauschal', fr: 'forfait', it: 'forfait', en: 'flat rate' },
  { id: 'km', de: 'km', fr: 'km', it: 'km', en: 'km' },
  { id: 'm2', de: 'm²', fr: 'm²', it: 'm²', en: 'm²' },
  { id: 'm', de: 'm', fr: 'm', it: 'm', en: 'm' },
  { id: 'm3', de: 'm³', fr: 'm³', it: 'm³', en: 'm³' },
  { id: 'l', de: 'l', fr: 'l', it: 'l', en: 'l' },
  { id: 'kg', de: 'kg', fr: 'kg', it: 'kg', en: 'kg' },
  { id: 'month', de: 'Mt.', fr: 'mois', it: 'mese', en: 'month' },
];

/** The word a unit prints as in `lang`: the firm's list, else the app's defaults, else its id (a unit removed from the list since). */
export const unitWord = (units: readonly UnitDef[] | undefined, id: Unit, lang: InvoiceLanguage): string =>
  (units ?? DEFAULT_UNITS).find((u) => u.id === id)?.[lang] ?? DEFAULT_UNITS.find((u) => u.id === id)?.[lang] ?? id;

/**
 * Whether a document's prices are net (VAT added on top) or gross (VAT included, derived from each
 * rate's total). One choice per document; the firm sets the default per kind (`invoicing.prices`).
 */
export const PRICES = ['net', 'gross'] as const;
export type Prices = (typeof PRICES)[number];

/**
 * Why a line at 0 % carries no Swiss VAT: a service whose place of supply is abroad (Art. 8
 * MWSTG, Ziffer 221) or an export of goods (Art. 23 MWSTG, Ziffer 220). The invoice prints the
 * matching note and its revenue is booked with V0-E or V0.
 */
export type Exemption = 'abroad' | 'export';

/** ADR 0004: a random id, when it came into the books, how, and deletion as a flag. */
export interface Envelope {
  id: string;
  createdAt: string;
  origin: 'manual' | 'import';
  deleted: boolean;
}

/** A postal address. `country` is ISO 3166 alpha-2. */
export interface Address {
  street?: string;
  number?: string;
  line2?: string;
  postcode: string;
  town: string;
  /** US state, Canadian province: printed after the town. */
  state?: string;
  country: string;
}

/**
 * The recipient as a document prints it: what an issued document freezes (`Issued.customer`), made
 * from its contact, the picked contact person and the picked address at issue (src/invoices/contacts.ts
 * recipientOf). A document issued before contacts froze its customer so; nothing printed changes.
 */
export interface CustomerFields {
  name: string;
  /** z. Hd., Abteilung: the line under the name. */
  attn?: string;
  /** The contact person's name, the {person} of a Vorlage's texts; absent: none picked. */
  person?: string;
  address: Address;
  language: InvoiceLanguage;
  /** CHE-…-MWST in Switzerland, the VAT number of an EU customer. */
  vatId?: string;
  email?: string;
  paymentTermsDays: number;
}

/** Kontaktperson of a firm (spec 4.4.5): a document's «z. Hd.» and the mail's recipient. */
export interface ContactPerson {
  /** `p-<k>`, unique within its contact. */
  id: string;
  name: string;
  role?: string;
  email?: string;
  phone?: string;
}

/**
 * An address of a contact. The first is the main one; `billing` marks the Rechnungsadresse (at most
 * one; none: the first), `delivery` a Lieferadresse (a firm with branches has several).
 */
export interface ContactAddress extends Address {
  /** `a-<k>`, unique within its contact. */
  id: string;
  /** An internal name («Filiale Bern»), never printed. */
  label?: string;
  /** A line printed under the name: a department, «Küche». */
  attn?: string;
  billing?: boolean;
  delivery?: boolean;
}

export const CONTACT_TYPES = ['firm', 'person'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

/**
 * Kontakt (spec 4.4.5): a firm or a person the firm sells to. `name` is what lists and documents
 * show: a firm's name, a person's salutation, first and last name (derived on every save).
 */
export interface ContactFields {
  type: ContactType;
  name: string;
  /** A person's: Frau, Herr, … (free text). */
  salutation?: string;
  firstName?: string;
  lastName?: string;
  /** The customer number, K-00001 from its own series (src/invoices/contacts.ts nextContactNumber), given at the first issued document or by hand. */
  number?: string;
  persons: ContactPerson[];
  addresses: ContactAddress[];
  language: InvoiceLanguage;
  /** The first is where documents go when no contact person is picked. */
  emails: string[];
  phone?: string;
  /** CHE-…-MWST, or an EU VAT number. */
  vatId?: string;
  /** The id of the firm's terms it pays in (invoicing.paymentTerms). Absent, and no `paymentDays`: the firm's default. */
  paymentTerms?: string;
  /** Days net of its own (what a customer's `paymentTermsDays` became); a contact names these or `paymentTerms`, never both. */
  paymentDays?: number;
  currency?: InvoiceCurrency;
  /** The revenue account a new position takes; absent: the settings'. */
  revenueAccount?: string;
  /** A standing discount in percent: every new position takes it; the person may remove it. */
  discount?: number;
  /** Left out of reminders (phase 3 reads it). */
  noReminders?: boolean;
  notes?: string;
  tags?: string[];
  /** Named by a document, so kept: out of the pickers, restored by hand. */
  archived?: boolean;
  /** The id of its business file (knowledge/customers/<id>.yaml): booking rules stay there. */
  business?: string;
}
export interface Contact extends Envelope, ContactFields {}

/**
 * A position of a document (spec docs/specs/invoicing.md 4.4.3). Absent `kind` is an item: every
 * line written before the kinds is one.
 */
export type InvoiceLine = ItemLine | TextLine | SubtotalLine | DiscountLine | PageBreakLine | GroupLine;
export const LINE_KINDS = ['item', 'article', 'text', 'subtotal', 'discount', 'pagebreak', 'group'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/**
 * A priced position: quantity × price, less its own discount. A Standard position (`item`), or an
 * Artikel position (`article`, spec 4.4.3): filled from the Artikel `articleId` when it was added,
 * every field editable since; it prints its `code` where the layout shows article codes.
 */
export interface ItemLine {
  kind?: 'item' | 'article';
  /** An Artikel position: the Artikel it was filled from (articles[].id). */
  articleId?: string;
  /** An Artikel position: the Artikel's code as it was when added, printed where the layout shows it. */
  code?: string;
  /**
   * A sub-position of the Gruppe above it (spec 4.4.3): the group is the nearest `group` position
   * above and holds every position marked so that follows it without a gap. It counts in the totals
   * as any position (once), and the group prints its sum.
   */
  inGroup?: true;
  text: string;
  quantity: number;
  unit?: Unit;
  /** Unit price in the invoice's currency, net or gross as the document's `prices` says. */
  price: number;
  vatRate: VatRate;
  /** A discount on this position in percent, printed beside it; its amount is the line's less this share, to the Rappen. */
  discount?: number;
  /**
   * Only on a line whose pricing differs from its document's `prices`, as a line of schema 2 could
   * (one line «500 VAT included» among net ones): true prices it gross, false net. A gross line
   * stays at exactly its amount, its rate's VAT is derived from it (gross × rate / (100 + rate), to
   * the Rappen) and its net is the rest. New lines never carry it.
   */
  vatIncluded?: boolean;
  /** The revenue account; absent: invoicing.revenueAccount of the workspace. */
  account?: string;
  /**
   * On a firm approved for two net tax rates, the activity the line's revenue belongs to: 2 books
   * it at the second rate (#504). Absent: the first. Shown on screen only, never printed.
   */
  activity?: 1 | 2;
  /**
   * An option of an Angebot or Auftrag (spec 4.4.1): priced and printed with «Option», never in a
   * total, a VAT figure or a QR amount. A conversion lists it unticked; ticked it becomes an ordinary position.
   */
  optional?: true;
  /**
   * The position of the document this one was made from (`from`), by its index there: what a
   * conversion copied, so the Auftrag counts what of each position was delivered and invoiced (src/invoices/chain.ts).
   */
  ofLine?: number;
  /**
   * A deduction of a Schlussrechnung (spec 4.4.9): the id of the Teilrechnung whose part at this
   * line's rate, account and activity it takes off, at what that one invoiced, not what was paid.
   * `price` is that part's amount, negative, net or gross as the Teilrechnung was (`vatIncluded`
   * where it differs from this document), and `deductedVat` the VAT the part carried: the
   * Schlussrechnung's VAT per rate is the whole's less what the Teilrechnungen charged (rules.ts
   * totalsOf), so the documents' VAT adds up to the whole's to the Rappen (MWSTG Art. 40 Abs. 1 lit. b).
   */
  deducts?: string;
  deductedVat?: number;
}

/** A text between positions: a title (bold) or plain; no amount. */
export interface TextLine { kind: 'text'; text: string; style?: 'title' }

/** Zwischentotal: prints the sum of the item positions since the last Zwischentotal or the start. A display, never in a total. */
export interface SubtotalLine { kind: 'subtotal'; text: string }

/**
 * Rabatt on the total of the positions above it (after the Rabatte above it): a percent or an
 * amount in the document's prices; a minus makes it a surcharge (Zuschlag). It is split over the
 * rates and revenue accounts above it in proportion to their amounts (rules.ts `priced`).
 */
export interface DiscountLine { kind: 'discount'; text: string; percent?: number; amount?: number }

/** Seitenumbruch: the next position starts a new sheet of the PDF, under the repeated table header. */
export interface PageBreakLine { kind: 'pagebreak' }

/**
 * Gruppe (spec 4.4.3): a title over the positions marked `inGroup` right below it, printed with
 * their sum. The title itself has no amount of its own: its sub-positions are in the totals once.
 */
export interface GroupLine { kind: 'group'; text: string }

/** A priced position, Standard or Artikel. */
export const isItem = (l: InvoiceLine): l is ItemLine => l.kind === undefined || l.kind === 'item' || l.kind === 'article';

/**
 * The sub-positions of the Gruppe at `k`: the positions marked `inGroup` that follow it without a
 * gap (indices). Empty for any other position.
 */
export function groupMembers(lines: readonly InvoiceLine[], k: number): number[] {
  if (lines[k]?.kind !== 'group') return [];
  const out: number[] = [];
  for (let i = k + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!isItem(l) || !l.inGroup) break;
    out.push(i);
  }
  return out;
}

/**
 * The positions with every `inGroup` mark that has no Gruppe above it dropped: a sub-position
 * belongs to the group whose title or sub-position stands right above it. What a move or a removal
 * leaves behind is so an ordinary position again, never a member of a group it does not stand in.
 */
export function withGroups(lines: readonly InvoiceLine[]): InvoiceLine[] {
  let open = false;
  return lines.map((l) => {
    if (l.kind === 'group') { open = true; return l; }
    if (isItem(l) && l.inGroup) {
      if (open) return l;
      const { inGroup: _, ...rest } = l;
      return rest;
    }
    open = false;
    return l;
  });
}

/** An Artikel's kind: goods (Ware) or a service (Dienstleistung). */
export const ARTICLE_TYPES = ['goods', 'service'] as const;
export type ArticleType = (typeof ARTICLE_TYPES)[number];

/**
 * The VAT kind of an Artikel (spec 4.4.3): the percent comes from the jurisdiction for the
 * supply's day (modules/<j>/invoicing.yaml rateKinds), never from the Artikel; `none` is 0 %.
 */
export const VAT_KINDS = ['normal', 'reduced', 'accommodation', 'none'] as const;
export type VatKind = (typeof VAT_KINDS)[number];

/** Artikel (spec 4.3, 4.4.3): a product or service a position is filled from. */
export interface ArticleFields {
  /** Produktcode: unique among the live Artikel when given. */
  code?: string;
  type: ArticleType;
  name: string;
  /** The text a position prints; absent: the name. */
  text?: string;
  unit?: Unit;
  /** The unit price in the books' currency, net or gross as `prices` says. */
  price: number;
  /** Absent: net. A position on a document of the other pricing converts it at its rate, to the cent. */
  prices?: Prices;
  vatKind: VatKind;
  /** The revenue account; absent: the contact's, else the settings'. */
  account?: string;
  /** On a firm with two net tax rates: the second (#504). Absent: the first. */
  activity?: 1 | 2;
  /** A group of the Artikel list (Produktgruppe), a free text; never printed. */
  group?: string;
  /** Named by a document, so kept: out of the picker, restored by hand. */
  archived?: boolean;
}
export interface Article extends Envelope, ArticleFields {}

export interface Comment extends Envelope {
  author: string;
  text: string;
}

/**
 * The kinds of document (spec 4.3 «Terms»): Angebot, Auftrag and Lieferschein book nothing; Rechnung
 * and Gutschrift are booked (BOOKED_KINDS). One record shape for all.
 */
export { DOCUMENT_KINDS, type DocumentKind } from '../workspace/numbering.js';
import type { DocumentKind } from '../workspace/numbering.js';
/** The kinds that are a claim of the firm or against it: numbered with a payment reference, booked, paid. */
export type BookedKind = 'invoice' | 'credit-note';
export const BOOKED_KINDS: readonly DocumentKind[] = ['invoice', 'credit-note'];
export const isBooked = (d: { kind: DocumentKind }): d is { kind: BookedKind } => d.kind === 'invoice' || d.kind === 'credit-note';

/** A person's click on an Angebot: the customer accepted or declined it, on `date`, as `by` recorded. */
export interface Answer { date: string; by: string }

/**
 * A stage of an Auftrag's Teilrechnungsplan (spec 4.4.9): «30 % bei Auftrag», «40 % nach Rohbau»,
 * «Rest». A percent or an amount of the Auftrag's total in its prices (net or gross as its
 * positions); neither on the last stage: the rest. `date` is when it is planned, a fact for the list.
 */
export interface Stage { label: string; percent?: number; amount?: number; date?: string }

/** Rückbehalt (spec 4.4.9): a share of a Rechnung held back until a day; its QR-bill asks for the rest. */
export interface Retention { percent: number; until: string }

/** How a Rechnung is paid beyond its due date: its retention (phase 3); instalments may join it. */
export interface Schedule { retention?: Retention }

/** A Rechnung's place in a plan: a Teilrechnung (Akonto) or the Schlussrechnung that deducts them. */
export type InvoiceRole = 'partial' | 'final';

/** What a draft holds and an issued invoice keeps, frozen. */
export interface InvoiceContent {
  kind: DocumentKind;
  /** The contact (`contacts[].id`); the name stays from before contacts, so every record keeps it. */
  customerId: string;
  /** The contact person the document goes to: its «z. Hd.» and the mail's recipient. */
  personId?: string;
  /** The contact's address it is sent to; absent: the billing address. */
  addressId?: string;
  /** The invoice date. */
  date: string;
  /**
   * When the supply was made, a day or a period (Art. 26 Abs. 2 lit. c MWSTG), printed when it
   * differs from the invoice date; absent: the invoice date.
   */
  supplied?: { from: string; to?: string };
  /** Absent on a draft: the invoice date plus the customer's payment terms. */
  dueDate?: string;
  currency: InvoiceCurrency;
  language: InvoiceLanguage;
  /** A short title for lists ("Teamporträts"); not printed. */
  subject?: string;
  /** A credit note's lines carry negative prices (older ones negative quantities), so its totals are negative. */
  lines: InvoiceLine[];
  /** Net or gross prices; absent: net. Every document of invoices.json schema 3 names it. */
  prices?: Prices;
  /** The text above the table and below the totals; absent: the layout's default for the language. */
  intro?: string;
  closing?: string;
  exemption?: Exemption;
  /** A credit note: the id of the invoice it credits. */
  creditFor?: string;
  /** A credit note larger than what is still open: the rest is paid back or set off against the next invoice. */
  settlement?: 'refund' | 'offset';
  /** The id of the firm's payment terms (invoicing.paymentTerms) an invoice prints; absent: the customer's own days net. */
  termsId?: string;
  /** An Angebot: the last day it holds; after it an open Angebot is Abgelaufen (derived). */
  validUntil?: string;
  /** An Angebot the customer accepted (by phone, by mail): the person's click; a document made from it accepts it as a fact. */
  accepted?: Answer;
  /** An Angebot the customer declined: the person's click. */
  declined?: Answer;
  /** The document this one was made from by a conversion (spec 4.4.1); the Belegkette follows it. «Als Entwurf kopieren» sets none. */
  from?: { id: string; kind: DocumentKind };
  /** The customer's own order reference («Ihre Bestellung»), printed. */
  ordered?: string;
  /** An Auftrag prints as Auftragsbestätigung (absent) or Proformarechnung: a print variant, no number of the invoice series, no booking. */
  printAs?: 'confirmation' | 'proforma';
  /** A Rechnung that is a Teilrechnung or a Schlussrechnung (spec 4.4.9); absent: an ordinary one. */
  role?: InvoiceRole;
  /** A Teilrechnung made from a stage of its Auftrag's plan: the stage's index (`stages`). */
  stage?: number;
  /** An Auftrag's Teilrechnungsplan; changed on an issued Auftrag too (it prints nothing of it). */
  stages?: Stage[];
  /** A Rechnung's retention. */
  schedule?: Schedule;
  /** The Vorlage it is laid out with (`invoicing.templates[].id`); absent: its kind's default (`invoicing.templateFor`). */
  templateId?: string;
  /** The title printed above the positions; absent: its Vorlage's for the kind and language, else the kind's word («Rechnung»). */
  title?: string;
  /**
   * Further PDFs that go with it when it is sent (a Rapport), each stored once under invoices/files/
   * (src/invoices/attachments.ts). An issued document also keeps its Vorlage's fixed attachment here,
   * frozen at issue, first.
   */
  attachments?: Attachment[];
}

/** At most this many own attachments per document, and this many bytes per file (src/invoices/attachments.ts); each named when hit. */
export const ATTACHMENT_LIMIT = { count: 10, bytes: 10 * 1024 * 1024 } as const;

/** A PDF that goes with a document: the name it is sent under, the file under the workspace, its SHA-256. */
export interface Attachment { name: string; file: string; sha256: string }

export interface Draft extends Envelope, InvoiceContent {
  status: 'draft';
  comments: Comment[];
  /**
   * The number an issued document kept when it went back to draft («Zurück zum Entwurf», spec
   * 4.4.2), whatever its kind (a Rechnung, a Gutschrift, an Angebot, an Auftrag): issued again, it
   * takes this number, never a new one, and no other document takes it (numbering.ts nextNumberFor).
   */
  number?: string;
  /** The PDFs it was issued with before it went back to draft, oldest first. */
  replaced?: ReplacedPdf[];
}

/**
 * A PDF a document was issued with and that was replaced: it went back to draft before it was ever
 * sent. The file stays under its replaced name (invoices/<number>.replaced-<k>.pdf), byte for byte.
 */
export interface ReplacedPdf { file: string; sha256: string; issuedAt: string; replacedAt: string }

/**
 * «Konten ändern» on an issued invoice (spec 4.4.2): the revenue accounts of positions changed,
 * never an amount, a rate or a code. `refs` are the bookings it changed in an open period, `reclass`
 * the ref of the reclassification it booked in the open period for bookings of a filed one.
 */
export interface AccountChange {
  at: string;
  lines: Array<{ line: number; from: string; to: string }>;
  refs: string[];
  reclass?: string;
}

/** The company as an issued invoice names it, frozen at issue. */
export interface Sender {
  name: string;
  address: Address;
  /** CHE-###.###.###, printed with the MWST/TVA/IVA/VAT suffix of the invoice's language. */
  uid: string;
  /** Where the money goes: the IBAN of the ledger account, and the QR-IBAN that routes QR references to it. */
  payTo: { account: string; iban: string; qrIban?: string; bank?: string };
}

/**
 * Money that arrived for an invoice, or went back for a credit note: found by its reference, by
 * the document's number in its text (and the amount), or confirmed by a person.
 */
export interface PaymentAllocation {
  transactionRef: string;
  date: string;
  /** In the invoice's currency, the reminder fee not included; a credit note's refund as a positive amount. */
  amount: number;
  /** The part of the payment that paid reminder fees. */
  fee?: number;
  /** The part of the payment that paid default interest (Verzugszins) a reminder charged. */
  interest?: number;
  by: 'reference' | 'number' | 'confirmed';
  /**
   * `hand`: a Zahlungseingang a person entered on the invoice (cash at the door, another account):
   * its movement is a hand movement of the books (BankTransaction `source: 'manual'`), which a
   * statement imported later confirms (`statement` on it). Absent: a payment of a statement.
   */
  source?: 'hand';
}

export const WRITE_OFF_REASONS = ['skonto', 'discount', 'loss', 'fee', 'rounding'] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

/**
 * Ausbuchung: the rest of an invoice closed as Skonto, Rabatt, Verlust, Spesen or Rundung (spec
 * 4.4.6). On the cash basis it books nothing (what was never received was never taxed); on the
 * agreed basis its ref is `RE-<number>-<id>` on the write-off account against the receivable, with
 * the minus sale codes (MWSTG Art. 41 Abs. 1).
 */
export interface WriteOff {
  /** `wo-<k>`, k from 1 per invoice: the last part of its ref. */
  id: string;
  date: string;
  /** In the invoice's currency. */
  amount: number;
  reason: WriteOffReason;
  note?: string;
  /** `code`: a Skonto the printed terms offered, recognised on the payment; `person`: Rest ausbuchen or Ausziffern. */
  by: 'code' | 'person';
  /** The payment whose rest it closes, when it came with one. */
  transactionRef?: string;
}

/** The payment terms an issued document printed (spec 4.12): its due date and its Skonto are read from them. */
export interface IssuedTerms { id: string; name: string; days: number; skonto?: { percent: number; days: number }; text: string }

/** Default interest a reminder charges: `rate` percent a year on what was open, from the printed due date `from` to the reminder's date `to`. */
export interface ReminderInterest { rate: number; from: string; to: string; days: number; amount: number }

/**
 * A Mahnung of an invoice at a Mahnstufe (src/invoices/dunning.ts). Without `documentId` it is a
 * draft (Entwurf): written, editable, not sent, and deleting it takes the level back; once sent it
 * names the sent document that holds its PDF and is kept as sent.
 */
export interface Reminder {
  level: number;
  /** The level's title as the paper prints it, in the invoice's language; absent on a reminder of before the levels: the app's word for the level. */
  title?: string;
  date: string;
  dueDate: string;
  /** A reminder fee: damages for late payment, not a supply, so it carries no VAT. */
  fee?: number;
  /** Default interest up to its date, printed as a position without VAT; it replaces what an earlier reminder charged. */
  interest?: ReminderInterest;
  intro: string;
  closing: string;
  /** The sent document that holds the reminder's PDF; absent: a draft. */
  documentId?: string;
  /** Sent without a click by its level's automatic reminder (`auto`), or by a Mahnlauf (`run`); absent: from the invoice. */
  by?: 'auto' | 'run';
}

export interface Issued extends Envelope, InvoiceContent {
  status: 'issued';
  number: string;
  issuedAt: string;
  dueDate: string;
  /** QRR (27 digits, with a QR-IBAN) or SCOR (RF…, with a plain IBAN), without spaces; empty on a kind that is not paid (Angebot, Auftrag, Lieferschein). */
  reference: string;
  customer: CustomerFields;
  sender: Sender;
  layout: InvoiceLayout;
  /** The letterhead its Vorlage printed it on, frozen: a reminder prints on the same paper. */
  letterhead?: { file: string; sha256: string };
  /** The units its positions name, with their words as issued, so a reminder prints them as the invoice did; absent: the app's defaults. */
  units?: UnitDef[];
  /** The PDF as issued, under the workspace, and its SHA-256. Never rendered again. */
  pdf: { file: string; sha256: string };
  cancelled?: { date: string; reason: string };
  payments: PaymentAllocation[];
  /** The rests closed (Ausbuchung); absent: none. */
  writeOffs?: WriteOff[];
  /** The terms printed (Zahlungskondition); absent on a document issued before them: no Skonto. */
  terms?: IssuedTerms;
  reminders: Reminder[];
  comments: Comment[];
  /** The PDFs it was issued with before it last went back to draft (Draft.replaced), oldest first. */
  replaced?: ReplacedPdf[];
  /** Its «Konten ändern», oldest first. */
  accountChanges?: AccountChange[];
}

export type Invoice = Draft | Issued;

/**
 * `quote`, `sales-order`, `delivery-note`: the document itself going out, as `invoice` and
 * `credit-note` are; `instalment` a Zahlungsaufforderung of a retention due (spec 4.4.9), `statement`
 * a contact's Kontoauszug (4.4.5): its `invoiceId` empty, `contactId` and `period` name what it covers.
 */
export const SENT_KINDS = ['invoice', 'resend', 'reminder', 'credit-note', 'cancellation', 'quote', 'sales-order', 'delivery-note', 'instalment', 'statement'] as const;
export type SentKind = (typeof SENT_KINDS)[number];

/** A document as it went out: its PDF, byte-exact, with checksum, time and recipient. */
export interface SentDocument extends Envelope {
  invoiceId: string;
  kind: SentKind;
  title: string;
  /** Under the workspace: invoices/<number>.pdf for the invoice itself, invoices/sent/<id>.pdf for a reminder or notice. */
  file: string;
  sha256: string;
  sentAt: string;
  /** An e-mail address, or `download` when the PDF was saved to be sent by other means. */
  to: string;
  /** How it went out; absent on documents recorded before the app sent e-mail (`to` tells). */
  channel?: 'email' | 'download';
  /** The Message-ID of the e-mail, as the company's mail server took it. */
  messageId?: string;
  /** Copies (CC) of the e-mail; `to` lists every recipient, comma-separated. */
  cc?: string[];
  /** Blind copies, the firm's own address among them («Kopie an mich»). */
  bcc?: string[];
  /** The further PDFs that went with it (a Vorlage's fixed attachment, a Rapport), each with its checksum as sent. */
  attachments?: Attachment[];
  /** A Kontoauszug (`statement`): the contact it went to, and the period it covers. */
  contactId?: string;
  period?: { from: string; to: string };
}

/**
 * Where the app serves an issued invoice's PDF and a sent document (src/server/routes/invoices.ts).
 * The stored `file` is a path under the workspace, never a URL.
 */
export const issuedPdfUrl = (number: string) => `/invoices/${encodeURIComponent(number)}.pdf`;
export const sentPdfUrl = (id: string) => `/invoices/sent/${encodeURIComponent(id)}.pdf`;
/** A PDF the document was issued with and that was replaced, `k` from 1 (Draft.replaced). */
export const replacedPdfUrl = (id: string, k: number) => `/api/invoices/${encodeURIComponent(id)}/replaced/${k}.pdf`;

/** invoices.json. */
export interface InvoiceBook {
  schema: number;
  contacts: Contact[];
  articles: Article[];
  invoices: Invoice[];
  sent: SentDocument[];
}

// ─── Layout (belege.workspace.yaml invoicing.layout) ─────────────────────────

/** The fonts an invoice can be set in; each is a font file the app ships (src/invoices/fonts.ts). */
export const INVOICE_FONTS = ['Inter', 'Helvetica'] as const;
export type InvoiceFont = (typeof INVOICE_FONTS)[number];

/** `articleCode`: an Artikel position prints its code before its text. */
export const LAYOUT_ELEMENTS = ['logo', 'senderLine', 'customerVatId', 'intro', 'quantity', 'vatColumn', 'articleCode', 'closing', 'footer', 'qrBill'] as const;
export type LayoutElement = (typeof LAYOUT_ELEMENTS)[number];

export interface InvoiceLayout {
  font: InvoiceFont;
  /** The colour of the title and the rules, #rrggbb. */
  accent: string;
  /** The envelope window the address shows through: Swiss C5, right or left. */
  window: 'left' | 'right';
  /** A path under the workspace (svg, png, jpg); absent: the company name as a wordmark. */
  logo?: string;
  logoPosition: 'left' | 'center' | 'right';
  logoSize: 's' | 'm' | 'l';
  show: Record<LayoutElement, boolean>;
}

export const DEFAULT_LAYOUT: InvoiceLayout = {
  font: 'Inter',
  accent: '#141a26',
  window: 'right',
  logoPosition: 'left',
  logoSize: 'm',
  show: Object.fromEntries(LAYOUT_ELEMENTS.map((k) => [k, true])) as Record<LayoutElement, boolean>,
};

/** The texts of a Vorlage for one kind in one language: the title, the texts above and below the positions, the e-mail. */
export const TEMPLATE_TEXTS = ['title', 'intro', 'closing', 'mailSubject', 'mailBody'] as const;
export type TemplateTextKey = (typeof TEMPLATE_TEXTS)[number];
export type TemplateTexts = Partial<Record<TemplateTextKey, string>>;

/**
 * A Vorlage (spec 4.4.11): a named layout with an optional letterhead PDF printed as each sheet's
 * background, texts per kind and language, and a fixed attachment (the firm's terms) that goes with
 * every document of the kinds it names (absent `kinds`: every kind). Not dated (spec 4.12): an
 * issued document keeps the layout, texts and attachment it was issued with.
 */
export interface InvoiceTemplate {
  id: string;
  name: string;
  layout: InvoiceLayout;
  /** A PDF under the workspace (invoices/files/…): its first page is the background of every sheet. */
  letterhead?: string;
  texts?: Partial<Record<DocumentKind, Partial<Record<InvoiceLanguage, TemplateTexts>>>>;
  attachment?: { name: string; file: string; kinds?: DocumentKind[] };
}

/** The id of the Vorlage a manifest without `templates` has: its `invoicing.layout`. */
export const STANDARD_TEMPLATE = 'standard';

/**
 * A change to where customers pay in one currency (Firma › Rechnungslayout › Zahlungskonten): the
 * ledger account, and the QR-IBAN its bank gave for it (null takes it out; absent: kept while the
 * account stays the same).
 */
export interface PayToPatch { account: string; qrIban?: string | null }

/** The company's invoicing settings, read from belege.workspace.yaml (src/workspace/manifest.ts). */
export interface InvoicingSettings {
  /** Per currency, the ledger account the customer pays to, with its IBAN, and a QR-IBAN if the bank gave one. */
  payTo: Partial<Record<InvoiceCurrency, { account: string; iban: string; qrIban?: string; bank?: string }>>;
  revenueAccount: string;
  /** Where paid reminder fees are booked; absent: revenueAccount. */
  feeAccount?: string;
  paymentTermsDays: number;
  /** The layout of the first Vorlage («Standard»): what every place that knows one layout reads. */
  layout: InvoiceLayout;
  /** The Vorlagen, at least one; a manifest without `templates` has one, «Standard», of `invoicing.layout`. */
  templates: InvoiceTemplate[];
  /** The Vorlage a new document of a kind takes; a kind it names not takes the first. */
  templateFor: Partial<Record<DocumentKind, string>>;
  /** The texts above and below the table and of the e-mail that sends a document, per language; absent: the app's own (src/invoices/texts.ts). */
  texts: Partial<Record<InvoiceLanguage, InvoiceOwnTexts>>;
  /** The units a position may be counted in; absent in the file: DEFAULT_UNITS. */
  units: UnitDef[];
  /** Whether a new document of a kind is priced net or gross; absent in the file: net. */
  prices: Record<DocumentKind, Prices>;
  /** The number series per kind (spec 4.4.4); absent in the file: DEFAULT_NUMBERING (src/invoices/numbering.ts). */
  numbering: Numbering;
  /** Named payment terms (phase 1, read only yet); absent in the file: one of `paymentTermsDays` days net. */
  paymentTerms: PaymentTerms[];
  /** The id of the terms a new document takes; absent: the first. */
  defaultTerms?: string;
  /** Where a Skonto and a loss are written off; absent: the jurisdiction's (modules/<j>/invoicing.yaml writeOff). */
  writeOffAccount?: { skonto: string; loss: string };
  /** A payment short by at most this much (the books' currency) may be closed as fees; absent in the file: 5. */
  shortfallLimit: number;
  /** Mahnstufen and default interest (src/invoices/dunning.ts); absent in the file: a new firm's three levels, no interest. */
  dunning: DunningSettings;
}

export type { DunningLevel, DunningSettings, DunningTexts } from '../workspace/dunning.js';
import type { DunningSettings } from '../workspace/dunning.js';

/** Zahlungskondition: days to pay, an optional Skonto within fewer days, and a text for the paper. */
export interface PaymentTerms {
  id: string;
  name: string;
  days: number;
  skonto?: { percent: number; days: number };
  text?: string;
}

/** The name of the terms a firm has while it names none: `paymentTermsDays` days net, in each document language. */
export const NET_TERMS: Record<InvoiceLanguage, (days: number) => string> = {
  de: (d) => `${d} Tage netto`,
  fr: (d) => `${d} jours net`,
  it: (d) => `${d} giorni netto`,
  en: (d) => `${d} days net`,
};

/** The shortfall a firm may close as fees while its settings name no limit. */
export const DEFAULT_SHORTFALL_LIMIT = 5;

/** `salutation`: a greeting line above the intro («Grüezi»); the app's own has none. */
export const OWN_TEXTS = ['salutation', 'intro', 'closing', 'mailSubject', 'mailBody'] as const;
export type InvoiceOwnTexts = Partial<Record<(typeof OWN_TEXTS)[number], string>>;

export const MAIL_SECURITY = ['tls', 'starttls', 'none'] as const;
export type MailSecurity = (typeof MAIL_SECURITY)[number];

/**
 * The company's own mailbox that sends invoices, reminders and notices (belege.workspace.yaml
 * `outgoingMail`, ADR 0010). The password is no part of it: src/secrets/ has it.
 */
export interface OutgoingMail {
  host: string;
  port: number;
  /** tls: TLS from the first byte (port 465); starttls: plain, then upgraded (587); none: neither. */
  security: MailSecurity;
  /** Absent: the server takes mail without a login. */
  user?: string;
  fromName?: string;
  fromAddress: string;
  replyTo?: string;
}
