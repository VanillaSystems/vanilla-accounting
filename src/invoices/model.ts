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

/** The Swiss VAT rates since 2024: normal, reduced, accommodation, and 0 for an exempt supply. */
export const VAT_RATES = [8.1, 2.6, 3.8, 0] as const;
export type VatRate = (typeof VAT_RATES)[number];

export const UNITS = ['h', 'day', 'pcs', 'flat', 'km'] as const;
export type Unit = (typeof UNITS)[number];

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

export interface InvoiceLine {
  text: string;
  quantity: number;
  unit?: Unit;
  /** Net unit price in the invoice's currency. */
  price: number;
  vatRate: VatRate;
  /** The revenue account; absent: invoicing.revenueAccount of the workspace. */
  account?: string;
}

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
  /** Absent on a draft: the invoice date plus the customer's payment terms. */
  dueDate?: string;
  currency: InvoiceCurrency;
  language: InvoiceLanguage;
  /** A short title for lists ("Teamporträts"); not printed. */
  subject?: string;
  /** A credit note's lines carry negative quantities, so its totals are negative. */
  lines: InvoiceLine[];
  /** The text above the table and below the totals; absent: the layout's default for the language. */
  intro?: string;
  closing?: string;
  exemption?: Exemption;
  /** A credit note: the id of the invoice it credits. */
  creditFor?: string;
  /** A credit note larger than what is still open: the rest is paid back or set off against the next invoice. */
  settlement?: 'refund' | 'offset';
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

/** Money that arrived for an invoice: found by its reference, or confirmed by a person. */
export interface PaymentAllocation {
  transactionRef: string;
  date: string;
  /** In the invoice's currency, the reminder fee not included. */
  amount: number;
  /** The part of the payment that paid reminder fees. */
  fee?: number;
  by: 'reference' | 'confirmed';
}

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
  /** The PDF as issued, under the workspace, and its SHA-256. Never rendered again. */
  pdf: { file: string; sha256: string };
  cancelled?: { date: string; reason: string };
  payments: PaymentAllocation[];
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
}

export const OWN_TEXTS = ['intro', 'closing', 'mailSubject', 'mailBody'] as const;
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
