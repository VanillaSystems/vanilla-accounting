/**
 * The detail column while rows are picked (#216): how many, their sum in the books' currency,
 * the days they span, how many lie in a filed period (a batch leaves those out and names them),
 * the actions for all of them, and each row with its link and a × that takes it out. Selecting
 * never moves the layout: the detail column only shows something else.
 */
import { useState } from 'react';
import type { Index } from '../../types/index.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { BatchPanel, batchOffers, type BatchId } from './BatchPanel.js';
import { baseCurrency } from '../../engines/index.js';
import { fmt, formatDate } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { Kbd } from '../areas/receipts/commands.js';
import { hrefOf } from '../shell/history.js';
import type { Location } from '../shell/route.js';
import type { Nav } from '../areas/index.js';
import { spanOf, type SelectKind } from './model.js';
import { clearSelection, selectionNow, setSelection } from './store.js';
import './selection.css';

/** One picked row as the selection lists it. `chf`: its amount in the books' currency, signed as the list shows it. */
export interface SelRow {
  id: string;
  date?: string;
  title: string;
  sub?: string;
  /** As the row shows it: its own currency, when not the books'. */
  amount?: number;
  currency?: string;
  chf?: number;
  /** Dated in a filed period: a batch leaves it out. */
  closed?: boolean;
  at: Location;
}

/** At most this many rows are listed one by one; the rest are counted. */
export const LISTED = 60;

const TITLE = { receipt: 'selection.receipts', payment: 'selection.payments', entry: 'selection.entries' } as const;

export function SelectionView({ kind, rows, books, nav, canEdit }: { kind: SelectKind; rows: SelRow[]; books: Index; nav: Nav; canEdit: boolean }) {
  const [open, setOpen] = useState<BatchId | null>(null);
  const offers = batchOffers(kind, !!useWorkspace()?.dimensions?.length);
  const span = spanOf(rows.map((r) => r.date));
  const sum = rows.reduce((s, r) => s + (r.chf ?? 0), 0);
  const closed = rows.filter((r) => r.closed).length;
  const unpick = (id: string) => {
    const sel = selectionNow();
    if (!sel) return;
    const ids = sel.ids.filter((x) => x !== id);
    setSelection(ids.length ? { ...sel, ids } : undefined);
  };
  return (
    <div className="detail-in seldetail" data-testid="selection" data-kind={kind} data-n={rows.length}>
      <div className="head">
        <h2 className="who">{t(TITLE[kind], { n: rows.length })}
          <small>{span ? (span.from === span.to ? formatDate(span.from) : `${formatDate(span.from)} – ${formatDate(span.to)}`) : t('selection.noDates')}</small>
        </h2>
        <div className="amount"><small>{baseCurrency()}</small>{fmt(sum)}</div>
      </div>
      <div className="facts">
        {closed > 0 && <span data-testid="selection-closed">{t('selection.closed', { n: closed })}</span>}
        <span>{t('selection.sumTip', { currency: baseCurrency() })}</span>
      </div>
      <div className="bar">
        {canEdit && offers.map((o) => <button key={o.id} type="button" className={`btn${open === o.id ? ' on' : ''}`} data-batch-offer={o.id} onClick={() => setOpen(open === o.id ? null : o.id)}>{o.label}</button>)}
        <button type="button" className="btn ghost" data-act="unselect" onClick={() => clearSelection()}>{t('selection.clear')} <Kbd keys={['Esc']} tip={t('selection.clearTip')} /></button>
      </div>
      {canEdit && <BatchPanel kind={kind} rows={rows} books={books} nav={nav} open={open} onOpen={setOpen} />}
      <ul className="selrows">
        {rows.slice(0, LISTED).map((r) => (
          <li key={r.id} className={r.closed ? 'left' : undefined} data-row={r.id}>
            <span className="d">{r.date ? formatDate(r.date) : '—'}</span>
            <span className="t"><a href={hrefOf(r.at)} onClick={(e) => { e.preventDefault(); clearSelection(); nav.go(r.at); }}>{r.title}</a>{r.sub && <small> {r.sub}</small>}</span>
            <span className="a">{r.amount != null && <>{r.currency && r.currency !== baseCurrency() ? `${r.currency} ` : ''}{fmt(r.amount)}</>}</span>
            <button type="button" className="x" aria-label={t('selection.unpick', { what: r.title })} onClick={() => unpick(r.id)}>×</button>
          </li>
        ))}
      </ul>
      {rows.length > LISTED && <p className="more">{t('selection.more', { n: rows.length - LISTED, shown: LISTED })}</p>}
    </div>
  );
}
