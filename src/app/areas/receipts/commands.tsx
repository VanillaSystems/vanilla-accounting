/** The commands on a receipt that a row's buttons, the detail and the keys share. */
import type { RouteOf } from '../../shell/route.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { lockedRefuses, needsYou, type Candidate, type ReceiptView } from './model.js';
import { openSection, setUi } from './state.js';
import { ledgerFor, listed, txLine } from './view.js';
import { linkPayment, setKind } from './actions.js';

type Props = AreaProps<RouteOf<'receipts'>>;

export function Kbd({ keys, tip }: { keys: string[]; tip: string }) {
  return <span className="k" data-tip={tip}>{keys.map((k) => <span key={k} className="cap">{k}</span>)}</span>;
}

/** An action on the selected receipt, from a row's button or a key; a locked receipt refuses some with the reason. */
export type Act = 'link' | 'edit' | 'del' | 'mark' | 'notreceipt';

export function runAct(p: Props, a: Act, id = p.route.id): void {
  if (!id || !p.canEdit) return;
  const v = ledgerFor(p.books).byId.get(id);
  if (!v) return;
  if (v.locked && lockedRefuses(a)) { p.nav.toast(t('receipts.lockedToast')); return; }
  // An order page of the provider way goes with its sale from the order export (#253).
  if (a === 'link' && v.orderPage) { p.nav.toast(t('receipts.orderPage.none')); return; }
  if (a === 'link') { openSection('zahlung'); setUi({ overlay: 'link', linkStart: undefined }); }
  if (a === 'edit') openSection('angaben', 'date');
  if (a === 'del') setUi({ overlay: 'delete' });
  if (a === 'mark' || a === 'notreceipt') setKind(p.nav, v, a === 'mark' ? 'invoice' : 'noise');
}

/** Takes the suggested payment and moves on to the next receipt that needs you. */
export async function accept(p: Props, v: ReceiptView, c: Candidate) {
  const l = ledgerFor(p.books);
  const i = listed.ids.indexOf(v.r.id);
  const next = [...listed.ids.slice(i + 1), ...listed.ids.slice(0, i)].find((id) => { const x = l.byId.get(id); return !!x && needsYou(x, l); });
  if (await linkPayment(p.nav, v, c.tx.ref, `${v.vendor} → ${txLine(c.tx)}`) && next) p.nav.select({ area: 'receipts', id: next });
}

