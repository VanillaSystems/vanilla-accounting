/**
 * A receipt that seems to repeat another (src/intake/duplicates.ts): which one, why, and the two
 * answers; or the invoice an order confirmation belongs to. The other receipt is a link.
 */
import { t } from '../../i18n/index.js';
import type { RouteOf } from '../../shell/route.js';
import type { AreaProps } from '../index.js';
import type { Ledger, ReceiptView } from './model.js';
import { answerTwin } from './actions.js';
import { at } from './view.js';

type Props = AreaProps<RouteOf<'receipts'>> & { v: ReceiptView; l: Ledger };

export function TwinNotice(props: Props) {
  const { v, l, nav, canEdit } = props;
  const twin = v.twin;
  const other = twin && l.byId.get(twin.of);
  if (!twin || !other || v.r.kind === 'duplicate') return null;
  const name = other.r.filename;
  const link = <a href="#" onClick={(e) => { e.preventDefault(); nav.go(at({ area: 'receipts', id: other.r.id }, other.day)); }}>{name}</a>;
  if (twin.relation === 'companion') {
    const [before, after] = t('receipts.twin.companion', { name: '\u0000' }).split('\u0000');
    return <div className="notice">{before}{link}{after}</div>;
  }
  const [before, after] = t('receipts.twin.duplicate', { name: '\u0000', why: t(`drop.twin.why.${twin.why}`) }).split('\u0000');
  return (
    <div className="notice warn" data-testid="twin">
      <span>{before}{link}{after}</span>
      {canEdit && !v.locked && (
        <>
          <button type="button" className="btn" onClick={() => void answerTwin(nav, v, 'same', other.r.id, name)}>{t('receipts.twin.same')}</button>
          <button type="button" className="btn ghost" onClick={() => void answerTwin(nav, v, 'distinct', other.r.id, name)}>{t('receipts.twin.distinct')}</button>
        </>
      )}
    </div>
  );
}
