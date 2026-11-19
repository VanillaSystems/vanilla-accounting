/**
 * Vorlagen (docs/specs/invoicing.md 4.4.11): which Vorlage a document is laid out with, the texts it
 * gives a kind in a language, and the placeholders those texts carry. Pure: the manifest's reader
 * (src/workspace/manifest.ts) checks the Vorlagen, src/invoices/documents.ts prints with them.
 */
import { DEFAULT_LAYOUT, STANDARD_TEMPLATE, type DocumentKind, type InvoiceContent, type InvoiceLanguage, type InvoiceTemplate, type InvoicingSettings, type TemplateTextKey } from './model.js';
import { formatAmount, formatDate } from './texts.js';

/** The Vorlage of a firm without settings: «Standard» with the app's layout. */
export const BUILT_IN_TEMPLATE: InvoiceTemplate = { id: STANDARD_TEMPLATE, name: 'Standard', layout: DEFAULT_LAYOUT };

/**
 * The Vorlage a document is laid out with: the one it picks, else its kind's default
 * (`templateFor`), else the first. A Vorlage removed since falls back the same way, so a draft
 * never loses its layout; an issued document keeps the layout it froze.
 */
export function templateOf(settings: Pick<InvoicingSettings, 'templates' | 'templateFor'> | undefined, doc: Pick<InvoiceContent, 'kind' | 'templateId'>): InvoiceTemplate {
  const list = settings?.templates ?? [];
  const byId = (id: string | undefined) => (id === undefined ? undefined : list.find((t) => t.id === id));
  return byId(doc.templateId) ?? byId(settings?.templateFor[doc.kind]) ?? list[0] ?? BUILT_IN_TEMPLATE;
}

/** The Vorlage's own text for a kind in a language; undefined where it names none (the firm's or the app's then). */
export function templateText(t: InvoiceTemplate, kind: DocumentKind, lang: InvoiceLanguage, key: TemplateTextKey): string | undefined {
  const v = t.texts?.[kind]?.[lang]?.[key];
  return v === undefined || v === '' ? undefined : v;
}

/** The fixed attachment of a Vorlage for a kind: the firm's terms on every Rechnung, say. */
export const fixedAttachment = (t: InvoiceTemplate, kind: DocumentKind): InvoiceTemplate['attachment'] =>
  t.attachment && (!t.attachment.kinds || t.attachment.kinds.includes(kind)) ? t.attachment : undefined;

/**
 * The placeholders a Vorlage's text may carry (spec 4.4.11), each filled where the value is known:
 * {person} the contact person (else the contact), {number}, {dueDate}, {total} with its currency,
 * and as before {days}, {document} and {company}. One not known yet (the number of a draft) stays
 * as written, so the preview shows where it goes.
 */
export const PLACEHOLDERS = ['person', 'number', 'dueDate', 'total', 'days', 'document', 'company'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface PlaceholderValues {
  person?: string; number?: string; dueDate?: string; total?: { amount: number; currency: string }; days?: number; document?: string; company?: string;
}

/** `text` with each known placeholder filled, dates and amounts written as `lang` writes them. */
export function fillPlaceholders(text: string, v: PlaceholderValues, lang: InvoiceLanguage): string {
  const value: Record<Placeholder, string | undefined> = {
    person: v.person?.trim() || undefined,
    number: v.number || undefined,
    dueDate: v.dueDate ? formatDate(v.dueDate, lang) : undefined,
    total: v.total ? `${v.total.currency} ${formatAmount(v.total.amount, lang)}` : undefined,
    days: v.days === undefined ? undefined : String(v.days),
    document: v.document,
    company: v.company,
  };
  return text.replace(/\{(\w+)\}/g, (all, key: string) => value[key as Placeholder] ?? all);
}
