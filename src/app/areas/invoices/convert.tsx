/**
 * The dialogs of the document chain (docs/specs/invoicing.md 4.4.1, 4.8 «Conversion dialog», 4.11):
 * a conversion lists the source's positions with what is still open, each ticked and editable, an
 * option unticked, and the total of what is ticked; a warning of the API offers «Trotzdem …».
 */
import { useState } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { unitWord, type DocumentKind, type Invoice, type Issued } from '../../../invoices/model.js';
import { convertWarnings, offered, tickedTotal, groupsLeftBehind } from '../../../invoices/chain.js';
import { formatQuantity } from '../../../invoices/texts.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { language, t } from '../../i18n/index.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import type { RouteOf } from '../../shell/route.js';
import type { AreaProps } from '../index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { I } from '../receipts/icons.js';
import { convert } from './actions.js';
import { parseNumber } from './edit.js';
import { Frame, close } from './frame.js';

type Props = AreaProps<RouteOf<'invoices'>>;

export function ConvertDialog({ inv, to, invoices, nav }: Props & { inv: Issued; to: DocumentKind; invoices: Invoice[] }) {
  const ws = useWorkspace();
  const rows = offered(inv, to, invoices);
  const [ticked, setTicked] = useState<Record<number, boolean>>(() => Object.fromEntries(rows.map((r) => [r.line, r.ticked])));
  const [qty, setQty] = useState<Record<number, string>>(() => Object.fromEntries(rows.map((r) => [r.line, formatQuantity(r.open > 0 ? r.open : r.item.quantity)])));
  const picks = rows.filter((r) => ticked[r.line]).map((r) => ({ line: r.line, quantity: parseNumber(qty[r.line] ?? '') ?? 0 }));
  const warnings = convertWarnings(inv, to, picks, invoices, localToday());
  const behind = groupsLeftBehind(inv, picks);
  const unit = (id: string | undefined) => (id ? unitWord(ws?.invoicing?.units, id, language() as 'de') : '');
  const priced = to !== 'delivery-note';
  const total = tickedTotal(inv, picks);
  const all = rows.length > 0 && rows.every((r) => ticked[r.line]);
  const label = t(`sales.convert.${to}` as 'sales.convert.invoice');
  return (
    <Frame className="iconvert" label={label} title={`${inv.number} · ${inv.customer.name}`} foot={<>
      <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
      <AsyncButton type="button" className="btn primary" data-act="convert-ok" onClick={() => convert(nav, inv, to, picks)}>{label}</AsyncButton>
    </>}>
      <div className="ibody">
        {warnings.filter((w) => w.code !== 'overOpen').map((w) => (
          <p key={w.code} className="warnline" role="note" data-testid={`convert-${w.code}`}>{I.dot}{t(`sales.convertWarn.${w.code}` as 'sales.convertWarn.expired', { date: formatDate(w.date) })}</p>
        ))}
        <table className="ivt ivconv" aria-label={t('sales.convertPositions')}>
          <thead>
            <tr>
              <th className="tick"><input type="checkbox" aria-label={t('sales.convertAll')} checked={all} onChange={() => setTicked(Object.fromEntries(rows.map((r) => [r.line, !all])))} /></th>
              <th>{t('sales.col.position')}</th>
              <th className="num">{t('sales.col.ordered')}</th>
              <th className="num">{t('sales.col.stillOpen')}</th>
              <th className="num">{t('sales.col.take')}</th>
              {priced && <th className="num">{t('sales.col.amount')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const n = parseNumber(qty[r.line] ?? '') ?? 0;
              const over = ticked[r.line] && n > r.open;
              return (
                <tr key={r.line} className={ticked[r.line] ? '' : 'gone'} data-line={r.line}>
                  <td className="tick"><input type="checkbox" aria-label={t('sales.bulk.tick', { what: r.item.text })} checked={!!ticked[r.line]} onChange={() => setTicked({ ...ticked, [r.line]: !ticked[r.line] })} /></td>
                  <td className="c-contact">{r.item.optional && <span className="ivopt">{t('invoices.option')}</span>} {r.item.text}</td>
                  <td className="num mono">{formatQuantity(r.item.quantity)} {unit(r.item.unit)}</td>
                  <td className="num mono">{formatQuantity(r.open)}</td>
                  <td className="num"><input className={`mono ivqty${over ? ' over' : ''}`} inputMode="decimal" aria-label={t('sales.col.take')} value={qty[r.line] ?? ''} disabled={!ticked[r.line]} onChange={(e) => setQty({ ...qty, [r.line]: e.target.value })} /></td>
                  {priced && <td className="num mono">{fmt(Math.round(n * r.item.price * 100) / 100)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
        {warnings.filter((w) => w.code === 'overOpen').map((w) => w.code === 'overOpen' && (
          <p key={w.line} className="warnline" role="note" data-testid="convert-overOpen">{I.dot}{t('sales.convertWarn.overOpen', { quantity: formatQuantity(w.quantity), open: formatQuantity(w.open), unit: unit(w.unit), text: w.text })}</p>
        ))}
        {behind.map((g) => <p key={g.line} className="warnline" role="note" data-testid="convert-group-left">{I.dot}{t('sales.convertGroupLeft', { title: g.text || t('invoices.groupPlaceholder') })}</p>)}
        {picks.length === 0
          ? <p className="warnline" data-testid="convert-nothing">{I.dot}{t('sales.convertNothing')}</p>
          : priced && <div className="isum"><div className="tot"><span>{t('sales.convertTotal', { n: picks.length })}</span><span className="mono" data-testid="convert-total">{inv.currency} {fmt(total)}</span></div></div>}
      </div>
    </Frame>
  );
}

/** A warning of spec 4.11: what is off, the rule, what follows; «Trotzdem …» runs the action again, confirmed. */
export function WarnDialog({ title, text, anyway, run }: { title: string; text: string; anyway: string; run: () => Promise<unknown> }) {
  return (
    <Frame label={title} title={t('sales.warnTitle')} foot={<>
      <button type="button" className="btn ghost" autoFocus onClick={close}>{t('common.cancel')}</button>
      <AsyncButton type="button" className="btn primary" data-act="anyway" onClick={() => run()}>{anyway}</AsyncButton>
    </>}>
      <div className="ibody"><div className="notice warn" role="note" data-testid="warn-text"><span>{text}</span></div></div>
    </Frame>
  );
}
