/**
 * What a person does to a receipt, each one write through the API and then the books loaded
 * again. Every change says what it did in the toast and can be taken back there (or with ⌘Z);
 * the undo is the opposite write, for a delete the receipt back from the trash.
 */
import type { BankTransaction, Index, ReceiptKind, ReceiptPatch, VatFacts } from '../../../types/index.js';
import { ApiError, api, errorText } from '../../lib/api.js';
import type { PrivatePart } from '../../../types/assistant.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { together, type AmountFit, type Ledger, type ReceiptView, type Saves } from './model.js';
import { at } from './view.js';
import { correct } from '../journal/commands.js';
import { correctionKinds } from '../../../accounting/correction.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { baseCurrency } from '../../../engines/index.js';

/** `message`: the toast, or a function for one that depends on what the call made. `refused`: a refusal the caller shows itself (true: no toast). */
async function run(nav: Nav, call: () => Promise<unknown>, message: string | (() => string), undo?: () => Promise<unknown>, refused?: (e: unknown) => boolean): Promise<boolean> {
  try {
    await call();
  } catch (e) {
    if (!refused?.(e)) nav.toast(errorText(e));
    return false;
  }
  nav.refresh();
  nav.toast(typeof message === 'string' ? message : message(), undo && (() => { undo().then(nav.refresh, (e) => nav.toast(errorText(e))); }));
  return true;
}

const pair = (receiptId: string, transactionRef: string) => ({ receiptId, transactionRef });

/**
 * A link whose payment is off the receipt's amount says so in its toast. `second`: the person
 * confirmed a second payment for the receipt (r8h-21). Without a model the payment's booking stays
 * as it is (`kept`): the toast says so, and that its VAT code is the person's to check (r8f-41).
 */
export function linkPayment(nav: Nav, v: ReceiptView, ref: string, what: string, fit?: AmountFit, second = false) {
  let kept = false;
  const said = () => (kept ? t('receipts.linkedKept', { what })
    : fit?.kind === 'off' ? t('receipts.linkedOff', { what, amount: `${fit.currency} ${fmt(Math.abs(fit.diff))}` }) : t('receipts.linkedTo', { what }));
  return run(nav, async () => { kept = !!(await api.addMapping({ ...pair(v.r.id, ref), ...(second ? { confirm: true } : {}) })).kept?.length; }, said,
    () => api.removeMapping(pair(v.r.id, ref)));
}

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

/** The undo puts a link back that the person had: a second payment of the receipt included. */
export const unlinkPayment = (nav: Nav, v: ReceiptView, ref: string, what: string) =>
  run(nav, () => api.removeMapping(pair(v.r.id, ref)), t('receipts.unlinked', { what }), () => api.addMapping({ ...pair(v.r.id, ref), confirm: true }));

/** A booking by hand that books the receipt already (409 bookedByHand): the dialog offers to replace it when it names the receipt. */
export interface HeldByHand { entry: string; date: string; amount: number; currency: string; replaceable: boolean }

/**
 * Paid privately or in cash: one write makes the owner's payment on the receipt's date, for its
 * amount or for the business part `part.amount` (#87), and links it; the books refuse a receipt a
 * payment already pays (r7h-23); classify books it against the owner's account. A booking by hand
 * of the receipt holds it (`onHeld`), until the person replaces it (`part.replace`). Undo deletes
 * the payment, which takes its booking and link with it, and puts the replaced booking back.
 */
export async function privateOutlay(nav: Nav, v: ReceiptView, part: PrivatePart = {}, onHeld?: (held: HeldByHand) => void): Promise<boolean> {
  const { r } = v;
  if (!v.date || r.amount == null) {
    nav.toast(t('receipts.privateNeeds'));
    return false;
  }
  let made = { ref: '', date: '' } as Awaited<ReturnType<typeof api.privatePayment>>;
  const currency = r.currency || baseCurrency();
  const amount = `${currency} ${fmt(part.amount ?? Math.abs(r.amount))}`;
  // A foreign receipt: the toast names the amount in the books' currency at the official daily rate of the receipt's day (ADR 0001).
  const rate = () => (made.exchangeRate ? ` · ${t('receipts.privateRate', { chf: `${baseCurrency()} ${fmt((part.amount ?? Math.abs(r.amount!)) * made.exchangeRate)}`, rate: String(made.exchangeRate), date: formatDate(made.date) })}` : '');
  // A receipt of a filed period: the toast says the payment is dated the first open day and corrects that period (r8k-10).
  const said = () => (made.corrects ? t('receipts.privateDoneCorrection', { date: formatDate(made.date), period: made.corrects })
    : part.amount !== undefined && part.amount < Math.abs(r.amount!) ? t('receipts.privatePartDone', { amount, what: part.part || t('receipts.privatePartUnnamed') }) : t('receipts.privateDone')) + rate();
  const undo = () => api.deleteTransaction(made.ref);
  const held = (e: unknown) => {
    if (!onHeld || !(e instanceof ApiError) || e.body.code !== 'bookedByHand') return false;
    onHeld(e.body.params);
    return true;
  };
  return run(nav, async () => { made = await api.privatePayment(r.id, part); }, said, undo, held);
}

/** A private payment made by mistake goes with its booking and its link, and a booking by hand it replaced comes back; undo pays the receipt privately again, as it was. */
export function undoPrivate(nav: Nav, v: ReceiptView, tx: BankTransaction, what: string) {
  const part: PrivatePart = {
    ...(tx.businessPart && { amount: tx.amount, ...(tx.businessPart.what && { part: tx.businessPart.what }), ...(tx.businessPart.rate !== undefined && { rate: tx.businessPart.rate }) }),
    ...(tx.replaced?.length && { replace: tx.replaced[0].transactionRef }),
  };
  return run(nav, () => api.deleteTransaction(tx.ref), t('receipts.privateUndone', { what }), () => api.privatePayment(v.r.id, part));
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
