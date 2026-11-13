/**
 * The Aktionen of one receipt (#216): only what fits it, the most likely one first (likelyReceipt).
 * A receipt without a payment: link it, «Privat oder bar bezahlt», paid by an employee, find its
 * payment, not a receipt, a copy of another; one set aside: «Ist ein Beleg»; and for every one its
 * Angaben, «Löschen» and the AI.
 */
import type { RouteOf } from '../../shell/route.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { askAbout } from '../../assistant/store.js';
import { aiIsOff } from '../../ai/ai-off.js';
import type { ActionSet, ObjAction } from '../../selection/ActionsMenu.js';
import { likelyReceipt } from '../../selection/likely.js';
import { runEach } from '../../selection/batch.js';
import { api } from '../../lib/api.js';
import { paidPrivately } from '../../../accounting/paid-how.js';
import { markLabel, type Ledger, type ReceiptView } from './model.js';
import { openSection, setUi } from './state.js';
import { at, listed } from './view.js';
import { accept, runAct } from './commands.js';
import { answerTwin, setKind } from './actions.js';

type Props = AreaProps<RouteOf<'receipts'>>;

/** Its words say it was paid in cash or privately (src/accounting/paid-how.ts). */
export const readsPaidPrivately = (v: ReceiptView): boolean => !!v.r.extractedText && paidPrivately(v.r.extractedText);

export function receiptActions(p: Props, v: ReceiptView, l: Ledger): ActionSet {
  const { nav, canEdit } = p;
  const { r } = v;
  const name = v.vendor || r.filename;
  // With the AI switched off (#212) nothing offers to ask it.
  const ask: ObjAction | undefined = aiIsOff() ? undefined : { id: 'ask', label: t('actions.ask'), run: () => askAbout({ kind: 'receipt', id: r.id, label: r.filename }) };
  const firstTx = v.links.map((ref) => l.txByRef.get(ref)).find(Boolean);
  const openPayment: ObjAction | undefined = firstTx && { id: 'openPayment', label: t('actions.openPayment'), run: () => nav.go(at({ area: 'bank', payment: firstTx.ref }, firstTx.date)) };
  if (!canEdit) return { primary: openPayment, rest: ask ? [ask] : [] };
  // An order page of the provider way waits for its order's sale, never for a payment (#253).
  const open = !v.none && !v.links.length && !v.locked && !v.orderPage;
  const sug = listed.suggestions.get(r.id);
  const twin = v.twin && !v.links.length && !v.locked ? l.byId.get(v.twin.of) : undefined;
  const all: Record<string, ObjAction | undefined> = {
    mark: v.none ? { id: 'mark', label: t(markLabel(v.r)), run: () => setKind(nav, v, 'invoice') } : undefined,
    accept: open && sug ? { id: 'accept', label: t('actions.accept'), key: '↵', run: () => void accept(p, v, sug) } : undefined,
    private: open ? { id: 'private', label: t('actions.private'), run: () => { openSection('zahlung'); setUi({ overlay: 'link', linkStart: 'private' }); } } : undefined,
    employee: open ? { id: 'employee', label: t('actions.employee'), run: () => { openSection('zahlung'); setUi({ overlay: 'link', linkStart: 'employee' }); } } : undefined,
    link: open ? { id: 'link', label: t('actions.link'), key: 'L', run: () => runAct(p, 'link') } : undefined,
    findPayment: open && v.date ? { id: 'findPayment', label: t('actions.findPayment'), run: () => void runEach(nav, [r.id], async (id) => {
      const found = await api.findPayment(id);
      if (found.outcome === 'linked') return () => api.removeMapping({ receiptId: found.receipt, transactionRef: found.payment });
      if (found.outcome === 'filed') return () => api.setFiledPayment(found.receipt, null);
      return undefined;
    }, { done: () => t('actions.searched'), name: () => name }) } : undefined,
    twin: twin ? { id: 'twin', label: t('actions.twin', { name: twin.vendor || twin.r.filename }), run: () => void answerTwin(nav, v, 'same', twin.r.id, twin.vendor || twin.r.filename) } : undefined,
    notReceipt: open ? { id: 'notReceipt', label: t('actions.notReceipt'), run: () => void setKind(nav, v, 'noise') } : undefined,
    openPayment,
    edit: !v.none ? { id: 'edit', label: t('actions.edit'), key: 'E', run: () => runAct(p, 'edit') } : undefined,
    del: !v.locked ? { id: 'del', label: t('actions.delete'), key: '⌘⌫', run: () => runAct(p, 'del') } : undefined,
    ask,
  };
  const likely = likelyReceipt({ none: v.none, linked: v.links.length > 0, locked: v.locked, suggestion: !!sug, paidPrivately: readsPaidPrivately(v), dated: !!v.date });
  const primary = likely ? all[likely] : undefined;
  const rest = Object.values(all).filter((a): a is ObjAction => !!a && a !== primary);
  return { primary, rest };
}
