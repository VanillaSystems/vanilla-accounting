/**
 * The Aktionen of one payment (#216): book it by hand (the form below its line), find its receipt,
 * add one, «Braucht keinen Beleg», a rule from it, its entry and receipt, the AI. The most likely
 * one first (likelyPayment).
 */
import type { BankTransaction } from '../../../types/index.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { askAbout } from '../../assistant/store.js';
import { aiIsOff } from '../../ai/ai-off.js';
import type { ActionSet, ObjAction } from '../../selection/ActionsMenu.js';
import { likelyPayment } from '../../selection/likely.js';
import { runEach } from '../../selection/batch.js';
import { api } from '../../lib/api.js';
import { at } from '../receipts/view.js';
import { intakeAdd } from '../receipts/intake.js';
import { payText, type Bank } from './model.js';
import { setNoReceipt } from './actions.js';

/** The booking form under the payment's line, in view with its first field focused. */
function focusBooking(): void {
  const form = document.querySelector<HTMLFormElement>('.detail [data-testid=payment-booking]');
  form?.scrollIntoView({ block: 'nearest' });
  form?.querySelector<HTMLInputElement>('input:not([type=hidden])')?.focus();
}

export function paymentActions(p: AreaProps, b: Bank, tx: BankTransaction, closed: boolean): ActionSet {
  const { nav, canEdit } = p;
  const name = payText(tx).name;
  const entry = b.entriesOf(tx.ref)[0];
  const receipt = b.receiptsOf(tx.ref)[0];
  const r = receipt ? b.receiptOf(receipt) : undefined;
  const edit = canEdit && !closed;
  const unbooked = !!tx.amount && b.unbooked(tx);
  const needs = b.needsReceipt(tx);
  const all: Record<string, ObjAction | undefined> = {
    book: edit && unbooked ? { id: 'book', label: t('actions.book'), run: focusBooking } : undefined,
    findReceipt: edit && needs ? { id: 'findReceipt', label: t('actions.findReceipt'), run: () => void runEach(nav, [tx.ref], async (ref) => {
      const found = await api.findReceipt(ref);
      if (found.outcome === 'linked') return () => api.removeMapping({ receiptId: found.receipt, transactionRef: found.payment });
      return undefined;
    }, { done: () => t('actions.searched'), name: () => name }) } : undefined,
    addReceipt: edit && needs ? { id: 'addReceipt', label: t('actions.addReceipt'), run: () => intakeAdd.run(p) } : undefined,
    noReceipt: edit && needs ? { id: 'noReceipt', label: t('bank.noReceiptNeeded'), run: () => void setNoReceipt(nav, tx, true) } : undefined,
    rule: edit ? { id: 'rule', label: t('actions.rule'), run: () => nav.go({ route: { area: 'company', section: 'rules' }, query: { payment: tx.ref } }) } : undefined,
    openEntry: entry ? { id: 'openEntry', label: t('actions.openEntry'), run: () => nav.go(at({ area: 'journal', id: entry.id }, entry.date)) } : undefined,
    openReceipt: receipt ? { id: 'openReceipt', label: t('actions.openReceipt'), run: () => nav.go(at({ area: 'receipts', id: receipt }, r?.date ?? tx.date)) } : undefined,
    ask: aiIsOff() ? undefined : { id: 'ask', label: t('actions.ask'), run: () => askAbout({ kind: 'payment', id: tx.ref, label: tx.description ?? tx.ref }) },
  };
  const likely = likelyPayment({ unbooked, needsReceipt: needs && edit, locked: closed || !canEdit, booked: !!entry });
  const primary = likely ? all[likely] : undefined;
  return { primary, rest: Object.values(all).filter((a): a is ObjAction => !!a && a !== primary) };
}
