/**
 * The sheet each record shows, built by src/invoices/documents.ts as the API builds it: a draft
 * with the workspace's layout and texts of now, an issued invoice as it was issued, a reminder
 * from its invoice. The UI adds what only a screen has (src/invoices/sheet.ts ScreenSheet).
 */
import { draftSheet, issuedSheet, reminderSheet, type InvoicingContext } from '../../../invoices/documents.js';
import type { Draft, Invoice, Issued } from '../../../invoices/model.js';
import { reminderDraft } from '../../../invoices/rules.js';
import type { ScreenSheet, SheetData } from '../../../invoices/sheet.js';
import type { CompanyInfo } from '../../../books/company.js';
import { api, type InvoiceList } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import { bookOf } from './model.js';
import type { ReminderEdit } from './state.js';

export const contextOf = (ws: CompanyInfo): InvoicingContext => ({ company: ws.company, settings: ws.invoicing });

const logo = (path: string | undefined) => (path ? api.logoUrl(path) : undefined);

export const editWords = (): NonNullable<ScreenSheet['edit']>['words'] => ({
  newCustomer: t('invoices.newCustomer'), chooseCustomer: t('invoices.chooseCustomer'), addLine: t('invoices.addLine'), removeLine: t('invoices.removeLine'),
  intro: t('invoices.introPlaceholder'), closing: t('invoices.closingPlaceholder'), desc: t('invoices.descPlaceholder'), noExemption: t('invoices.noExemption'),
});

export function screenOf(d: InvoiceList, scope: 'draft' | 'texts' | undefined, customerId?: string, windowGuide?: string): ScreenSheet {
  return {
    qrPlaceholder: t('invoices.qrPlaceholder'),
    ...(windowGuide ? { windowGuide } : {}),
    ...(scope ? { edit: { scope, customers: [...d.customers].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, name: c.name })), ...(customerId ? { customerId } : {}), words: editWords() } } : {}),
  };
}

export function draftData(d: InvoiceList, ws: CompanyInfo, draft: Draft, editing: boolean): SheetData {
  const sheet = draftSheet(contextOf(ws), bookOf(d), draft, d.customers.find((c) => c.id === draft.customerId), logo(ws.invoicing?.layout.logo));
  return { ...sheet, screen: screenOf(d, editing ? 'draft' : undefined, draft.customerId) };
}

export function issuedData(d: InvoiceList, inv: Issued): SheetData {
  return { ...issuedSheet(bookOf(d), inv, logo(inv.layout.logo)), screen: screenOf(d, undefined) };
}

/** The next reminder of `inv` as it will be printed, with what the person changed. */
export function reminderData(d: InvoiceList, inv: Issued, edit: ReminderEdit, today: string, editing: boolean): SheetData {
  const drafted = reminderDraft(inv, d.invoices, today, edit.fee);
  const r = { ...drafted, ...(edit.intro !== undefined ? { intro: edit.intro } : {}), ...(edit.closing !== undefined ? { closing: edit.closing } : {}) };
  return { ...reminderSheet(bookOf(d), inv, r, logo(inv.layout.logo)), screen: screenOf(d, editing ? 'texts' : undefined) };
}
