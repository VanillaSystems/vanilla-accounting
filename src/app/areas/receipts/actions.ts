/**
 * What a person does to a receipt, each one write through the API and then the books loaded
 * again. Every change says what it did in the toast and can be taken back there (or with ⌘Z);
 * the undo is the opposite write, for a delete the receipt back from the trash.
 */
import type { BankTransaction, Index, ReceiptKind, ReceiptPatch, VatFacts } from '../../../types/index.js';
import { api, errorText } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { together, type AmountFit, type Ledger, type ReceiptView, type Saves } from './model.js';
import { at } from './view.js';
import { correct } from '../journal/commands.js';
import { correctionKinds } from '../../../accounting/correction.js';
import { fmt } from '../../lib/utils.js';
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

/** A link whose payment is off the receipt's amount says so in its toast. */
export const linkPayment = (nav: Nav, v: ReceiptView, ref: string, what: string, fit?: AmountFit) =>
  run(nav, () => api.addMapping(pair(v.r.id, ref)),
    fit?.kind === 'off' ? t('receipts.linkedOff', { what, amount: `${fit.currency} ${fmt(Math.abs(fit.diff))}` }) : t('receipts.linkedTo', { what }),
    () => api.removeMapping(pair(v.r.id, ref)));

/**
 * A payment of a filed quarter the receipt pays: never a link (golden rule 1). Its entry opens with
 * the correction in the open quarter started, its input tax read from the receipt `from` too; a
 * payment without an entry opens itself (corner-33).
 */
export function correctFiled(nav: Nav, books: Index, l: Ledger, ref: string, from?: string): void {
  const tx = l.txByRef.get(ref);
  const entry = l.entriesByRef.get(ref)?.[0];
  if (!entry) { if (tx) nav.go(at({ area: 'bank', payment: ref }, tx.date)); return; }
  nav.go(at({ area: 'journal', id: entry.id }, entry.date));
  correct(books, entry, correctionKinds(entry)[0], from);
}

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

/** The fields saved on one receipt in a row (each field left saves on its own): one toast names them all, its undo takes them all back. */
let saving: Saves<Field> | undefined;

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
  saving = together(saving, { id: r.id, fields: changed, back, at: Date.now() });
  const all = saving;
  const names = all.fields.map((f) => t(`receipts.field.${f}`)).join(', ');
  return run(nav, () => api.patchReceipt(r.id, patch), t('receipts.saved', { fields: names }), () => { saving = undefined; return api.patchReceipt(r.id, all.back); });
}

/**
 * The receipt's VAT facts as the owner sets them (a person's: the AI never reads them over); a
 * payment booked with the old ones is booked again. Undo puts back what was there: facts the AI
 * read as the AI's, none as none.
 */
export function saveVat(nav: Nav, v: ReceiptView, vat: VatFacts) {
  const { r } = v;
  const back: ReceiptPatch = r.hasSwissVat === undefined ? { vat: null }
    : { vat: { hasSwissVat: r.hasSwissVat, vatSummary: r.vatSummary ?? [], ...(r.vatId && { vatId: r.vatId }) }, ...(r.vatBy ? {} : { vatBy: null }) };
  const message = v.links.length ? t('receipts.vatSavedRebook') : t('receipts.saved', { fields: t('receipts.field.vat') });
  return run(nav, () => api.patchReceipt(r.id, { vat }), message, () => api.patchReceipt(r.id, back));
}

/** Undo restores this deletion; a later deletion of the same file makes it refuse, plainly. */
export function deleteReceipt(nav: Nav, v: ReceiptView) {
  let deletion = '';
  return run(nav, async () => { deletion = await api.deleteReceipt(v.r.id); }, t('receipts.deleted', { file: v.r.filename }), () => api.restoreReceipt(v.r.id, deletion));
}

/** The text read again by the model, from the PDF's image (sends the page to Claude). */
export const readAgain = (nav: Nav, v: ReceiptView) =>
  run(nav, () => api.visionExtract(v.r.id), t('receipts.readAgainDone'));

/** «ist dasselbe»: the receipt becomes a copy of `of` (no link, no input tax); undo makes it a receipt again. «verschieden»: never asked again. */
export const answerTwin = (nav: Nav, v: ReceiptView, answer: 'same' | 'distinct', of: string, name: string) =>
  run(nav, () => api.answerTwin(v.r.id, answer, of),
    answer === 'same' ? t('receipts.twin.sameDone', { name }) : t('receipts.twin.distinctDone', { name }),
    answer === 'same' ? () => api.patchReceipt(v.r.id, { kind: v.r.kind ?? null }) : undefined);
