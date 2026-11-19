/**
 * The sheet each record shows, built by src/invoices/documents.ts as the API builds it: a draft
 * with the workspace's layout and texts of now, an issued invoice as it was issued, a reminder
 * from its invoice. The UI adds what only a screen has (src/invoices/sheet.ts ScreenSheet).
 */
import { draftSheet, issuedSheet, reminderSheet, type InvoicingContext } from '../../../invoices/documents.js';
import type { Draft, Invoice, Issued, Reminder } from '../../../invoices/model.js';
import type { ScreenSheet, SheetData } from '../../../invoices/sheet.js';
import type { CompanyInfo } from '../../../books/company.js';
import { api, type InvoiceList } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import { bookOf, contactOf, customerOf, pickerContacts } from './model.js';
import { contactOnDay, invoicingOnDay, letterheadOn } from '../../../invoices/dated-values.js';

/** What a document of `day` reads of the firm (spec 4.12): the settings and the letterhead of that day. */
export const contextOf = (ws: CompanyInfo, day: string): InvoicingContext => ({ company: ws.company, settings: invoicingOnDay(ws.invoicing, day), letterhead: letterheadOn(ws.company, ws.invoicing, day) });

const logo = (path: string | undefined) => (path ? api.logoUrl(path) : undefined);

export const editWords = (): NonNullable<ScreenSheet['edit']>['words'] => ({
  newCustomer: t('invoices.newCustomer'), chooseCustomer: t('invoices.chooseCustomer'), addLine: t('invoices.addLine'), removeLine: t('invoices.removeLine'),
  intro: t('invoices.introPlaceholder'), closing: t('invoices.closingPlaceholder'), desc: t('invoices.descPlaceholder'), noExemption: t('invoices.noExemption'), supplied: t('invoices.suppliedPlaceholder'), activity: t('invoices.activity'),
  addText: t('invoices.addText'), addSubtotal: t('invoices.addSubtotal'), addDiscount: t('invoices.addDiscount'), addPageBreak: t('invoices.addPageBreak'), pageBreak: t('invoices.pageBreak'),
  move: t('invoices.moveLine'), title: t('invoices.textTitle'), plain: t('invoices.textPlain'), percent: t('invoices.discountPercent'), amount: t('invoices.discountAmount'), lineDiscount: t('invoices.lineDiscount'),
  position: t('invoices.position'), option: t('invoices.option'),
  addArticle: t('invoices.addArticle'), addGroup: t('invoices.addGroup'), group: t('invoices.groupPlaceholder'), account: t('invoices.lineAccount'), code: t('invoices.lineCode'),
});

export function screenOf(d: InvoiceList, scope: 'draft' | 'texts' | undefined, customerId?: string, windowGuide?: string, revenueAccount?: string): ScreenSheet {
  return {
    qrPlaceholder: t('invoices.qrPlaceholder'),
    ...(windowGuide ? { windowGuide } : {}),
    ...(scope ? { edit: { scope, customers: pickerContacts(d, customerId), ...(customerId ? { customerId } : {}), ...(revenueAccount ? { revenueAccount } : {}), words: editWords() } } : {}),
  };
}

export function draftData(d: InvoiceList, ws: CompanyInfo, draft: Draft, editing: boolean): SheetData {
  const ctx = contextOf(ws, draft.date);
  const sheet = draftSheet(ctx, bookOf(d), draft, customerOf(d, draft, ctx.settings), logo(ws.invoicing?.layout.logo));
  // A position without an account of its own books on the contact's revenue account of the draft's date, else the settings'.
  const revenue = contactOnDay(contactOf(d, draft), draft.date)?.revenueAccount ?? ws.invoicing?.revenueAccount;
  return { ...sheet, screen: screenOf(d, editing ? 'draft' : undefined, draft.customerId, undefined, revenue) };
}

export function issuedData(d: InvoiceList, inv: Issued): SheetData {
  return { ...issuedSheet(bookOf(d), inv, logo(inv.layout.logo)), screen: screenOf(d, undefined) };
}

/** A Mahnung of `inv` as it will be printed (the draft as written) or was sent. */
export function reminderData(d: InvoiceList, inv: Issued, r: Reminder, editing: boolean): SheetData {
  return { ...reminderSheet(bookOf(d), inv, r, logo(inv.layout.logo)), screen: screenOf(d, editing ? 'texts' : undefined) };
}
