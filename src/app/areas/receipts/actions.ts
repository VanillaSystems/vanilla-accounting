/**
 * What a person does to a receipt, each one write through the API and then the books loaded
 * again. Every change says what it did in the toast and can be taken back there (or with ⌘Z);
 * the undo is the opposite write, for a delete the receipt back from the trash.
 */
import type { BankTransaction, ReceiptKind, ReceiptPatch } from '../../../types/index.js';
import { api, errorText } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import type { ReceiptView } from './model.js';
import { baseCurrency } from '../../../engines/index.js';

async function run(nav: Nav, call: () => Promise<unknown>, message: string, undo?: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
  } catch (e) {
    nav.toast(errorText(e));
    return false;
  }
  nav.refresh();
  nav.toast(message, undo && (() => { undo().then(nav.refresh, (e) => nav.toast(errorText(e))); }));
  return true;
}

const pair = (receiptId: string, transactionRef: string) => ({ receiptId, transactionRef });

export const linkPayment = (nav: Nav, v: ReceiptView, ref: string, what: string) =>
  run(nav, () => api.addMapping(pair(v.r.id, ref)), t('receipts.linkedTo', { what }), () => api.removeMapping(pair(v.r.id, ref)));

export const unlinkPayment = (nav: Nav, v: ReceiptView, ref: string, what: string) =>
  run(nav, () => api.removeMapping(pair(v.r.id, ref)), t('receipts.unlinked', { what }), () => api.addMapping(pair(v.r.id, ref)));

/**
 * Paid privately or in cash: a manual payment on the receipt's date and amount, linked to it;
 * classify books it against the owner's account. Undo deletes the payment and its link.
 */
export async function privateOutlay(nav: Nav, v: ReceiptView): Promise<boolean> {
  const { r } = v;
  if (!v.date || r.amount == null) {
    nav.toast(t('receipts.privateNeeds'));
    return false;
  }
  let ref = '';
  return run(nav, async () => {
    ref = await api.createManualTransaction({ date: v.date!, description: r.description || r.filename, amount: Math.abs(r.amount!), currency: r.currency || baseCurrency() });
    await api.addMapping(pair(r.id, ref));
  }, t('receipts.privateDone'), () => api.deleteTransaction(ref));
}

/** A private payment made by mistake goes with its link; undo pays the receipt privately again. */
export function undoPrivate(nav: Nav, v: ReceiptView, tx: BankTransaction, what: string) {
  return run(nav, () => api.deleteTransaction(tx.ref), t('receipts.privateUndone', { what }), async () => {
    const ref = await api.createManualTransaction({ date: tx.date, description: tx.description, amount: tx.amount, currency: tx.currency });
    await api.addMapping(pair(v.r.id, ref));
  });
}

export function setKind(nav: Nav, v: ReceiptView, kind: ReceiptKind) {
  const before = v.r.kind ?? null;
  const message = kind === 'invoice' ? t('receipts.isReceiptDone', { name: v.vendor }) : t('receipts.notReceiptDone', { file: v.r.filename });
  return run(nav, () => api.patchReceipt(v.r.id, { kind }), message, () => api.patchReceipt(v.r.id, { kind: before }));
}

export type Field = 'filename' | 'date' | 'amount' | 'currency' | 'description' | 'remarks';

/** Saves the fields that changed; undo writes back what they were. */
export function saveFields(nav: Nav, v: ReceiptView, patch: ReceiptPatch, changed: Field[]) {
  const { r } = v;
  const back: ReceiptPatch = {};
  if ('filename' in patch) back.filename = r.filename;
  if ('date' in patch) back.date = r.date ?? null;
  if ('amount' in patch) {
    if (r.amount == null) back.amount = null;
    else { back.amount = r.amount; back.currency = r.currency || baseCurrency(); }
  }
  if ('description' in patch) back.description = r.description ?? '';
  if ('remarks' in patch) back.remarks = r.remarks ?? '';
  const names = changed.map((f) => t(`receipts.field.${f}`)).join(', ');
  return run(nav, () => api.patchReceipt(r.id, patch), t('receipts.saved', { fields: names }), () => api.patchReceipt(r.id, back));
}

export const deleteReceipt = (nav: Nav, v: ReceiptView) =>
  run(nav, () => api.deleteReceipt(v.r.id), t('receipts.deleted', { file: v.r.filename }), () => api.restoreReceipt(v.r.id));

/** The text read again by the model, from the PDF's image (sends the page to Claude). */
export const readAgain = (nav: Nav, v: ReceiptView) =>
  run(nav, () => api.visionExtract(v.r.id), t('receipts.readAgainDone'));
