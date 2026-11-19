/**
 * Invoicing (ADR 0010): customers, invoices and credit notes, reminders, sent documents and
 * comments, stored in the workspace's invoices.json (src/invoices/store.ts). Every record carries
 * the envelope of ADR 0004. An invoice is a draft until it is issued; issuing gives it its number,
 * its payment reference and its PDF, and freezes what it says.
 */

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

export interface CustomerFields {
  name: string;
  /** z.H., Abteilung: the second line of the address. */
  attn?: string;
  address: Address;
  language: InvoiceLanguage;
  /** CHE-…-MWST in Switzerland, the VAT number of an EU customer. */
  vatId?: string;
  email?: string;
  paymentTermsDays: number;
}
export interface Customer extends Envelope, CustomerFields {}

/**
 * A position of a document (spec docs/specs/invoicing.md 4.4.3). Absent `kind` is an item: every
 * line written before the kinds is one.
 */
export type InvoiceLine = ItemLine | TextLine | SubtotalLine | DiscountLine | PageBreakLine;
export const LINE_KINDS = ['item', 'text', 'subtotal', 'discount', 'pagebreak'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/** A priced position (Standard): quantity × price, less its own discount. */
export interface ItemLine {
  kind?: 'item';
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

export const isItem = (l: InvoiceLine): l is ItemLine => l.kind === undefined || l.kind === 'item';

export interface Comment extends Envelope {
  author: string;
  text: string;
}

/** What a draft holds and an issued invoice keeps, frozen. */
export interface InvoiceContent {
  kind: 'invoice' | 'credit-note';
  customerId: string;
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
}

export interface Draft extends Envelope, InvoiceContent {
  status: 'draft';
  comments: Comment[];
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

export interface Reminder {
  level: number;
  date: string;
  dueDate: string;
  /** A reminder fee: damages for late payment, not a supply, so it carries no VAT. */
  fee?: number;
  intro: string;
  closing: string;
  /** The sent document that holds the reminder's PDF. */
  documentId: string;
}

export interface Issued extends Envelope, InvoiceContent {
  status: 'issued';
  number: string;
  issuedAt: string;
  dueDate: string;
  /** QRR (27 digits, with a QR-IBAN) or SCOR (RF…, with a plain IBAN), without spaces. */
  reference: string;
  customer: CustomerFields;
  sender: Sender;
  layout: InvoiceLayout;
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
}

export type Invoice = Draft | Issued;

export const SENT_KINDS = ['invoice', 'resend', 'reminder', 'credit-note', 'cancellation'] as const;
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
}

/**
 * Where the app serves an issued invoice's PDF and a sent document (src/server/routes/invoices.ts).
 * The stored `file` is a path under the workspace, never a URL.
 */
export const issuedPdfUrl = (number: string) => `/invoices/${encodeURIComponent(number)}.pdf`;
export const sentPdfUrl = (id: string) => `/invoices/sent/${encodeURIComponent(id)}.pdf`;

/** invoices.json. */
export interface InvoiceBook {
  schema: number;
  customers: Customer[];
  invoices: Invoice[];
  sent: SentDocument[];
}

// ─── Layout (belege.workspace.yaml invoicing.layout) ─────────────────────────

/** The fonts an invoice can be set in; each is a font file the app ships (src/invoices/fonts.ts). */
export const INVOICE_FONTS = ['Inter', 'Helvetica'] as const;
export type InvoiceFont = (typeof INVOICE_FONTS)[number];

export const LAYOUT_ELEMENTS = ['logo', 'senderLine', 'customerVatId', 'intro', 'quantity', 'vatColumn', 'closing', 'footer', 'qrBill'] as const;
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
  layout: InvoiceLayout;
  /** The texts above and below the table and of the e-mail that sends a document, per language; absent: the app's own (src/invoices/texts.ts). */
  texts: Partial<Record<InvoiceLanguage, InvoiceOwnTexts>>;
  /** The units a position may be counted in; absent in the file: DEFAULT_UNITS. */
  units: UnitDef[];
  /** Whether a new document of a kind is priced net or gross; absent in the file: net. */
  prices: Record<InvoiceContent['kind'], Prices>;
  /** Named payment terms (phase 1, read only yet); absent in the file: one of `paymentTermsDays` days net. */
  paymentTerms: PaymentTerms[];
  /** The id of the terms a new document takes; absent: the first. */
  defaultTerms?: string;
  /** Where a Skonto and a loss are written off; absent: the jurisdiction's (modules/<j>/invoicing.yaml writeOff). */
  writeOffAccount?: { skonto: string; loss: string };
  /** A payment short by at most this much (the books' currency) may be closed as fees; absent in the file: 5. */
  shortfallLimit: number;
}

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
