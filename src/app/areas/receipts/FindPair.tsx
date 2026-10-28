/**
 * «Zahlung suchen» on a receipt without a payment, «Beleg suchen» on a payment without a receipt
 * (#187): the matching chain for that one record, and its outcome in place: linked (and who
 * decided), the receipt pointed at a filed payment, the code's candidates to pick, or nothing
 * within the bounds, which it names. Works without a model: then code alone decides or offers.
 */
import { useState } from 'react';
import type { BankTransaction, Index, Mapping, Receipt } from '../../../types/index.js';
import { BOUNDS, WEIGHTS, makerOf, signalsOf, type Found, type LinkMaker, type Signal } from '../../../intake/pairing.js';
import { api, errorText } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { baseCurrency } from '../../../engines/index.js';
import type { Nav } from '../index.js';
import { amountOf, at, bankOf, txLine } from './view.js';
import { useAiOff } from '../../ai/ai-off.js';

type On = { receipt: string } | { payment: string };

/** Who made a link, said plainly, and for code what matched: the code, the code checked by the model, the model, a person. */
export const madeBy = (m: Pick<Mapping, 'by' | 'rule'>): string | undefined => byText(makerOf(m), signalsOf(m));

function byText(k: LinkMaker, signals: readonly Signal[]): string | undefined {
  if (k === 'unknown') return undefined;
  if (k !== 'code' && k !== 'checked') return t(`pair.by.${k}`);
  if (!signals.length) return t(k === 'code' ? 'pair.by.codeBare' : 'pair.by.checkedBare');
  return t(`pair.by.${k}`, { signals: signals.map((x) => t(`pair.signal.${x}`)).join(', ') });
}

const paymentText = (tx: BankTransaction) => `${formatDate(tx.date)} · ${bankOf(tx)} · ${amountOf(tx)} · ${tx.description}`;
const receiptText = (r: Receipt) => `${r.title?.vendor ?? r.description ?? r.filename} · ${r.date ? formatDate(r.date) : '—'} · ${r.currency || baseCurrency()} ${fmt(Math.abs(r.amount ?? 0))}`;

export function FindPair({ on, books, nav, compact }: { on: On; books: Index; nav: Nav; compact?: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | Found>('idle');
  const aiOff = useAiOff();
  const forReceipt = 'receipt' in on;
  const txOf = (ref: string) => books.transactions.find((x) => x.ref === ref);
  const receiptOf = (id: string) => books.receipts.find((x) => x.id === id);

  async function search(): Promise<void> {
    setState('busy');
    try {
      const found = forReceipt ? await api.findPayment(on.receipt) : await api.findReceipt(on.payment);
      setState(found);
      if (found.outcome === 'linked' || found.outcome === 'filed') nav.refresh();
    } catch (e) {
      setState('idle');
      nav.toast(errorText(e));
    }
  }

  async function pick(receipt: string, payment: string): Promise<void> {
    try {
      await api.addMapping({ receiptId: receipt, transactionRef: payment });
    } catch (e) {
      nav.toast(errorText(e));
      return;
    }
    const tx = txOf(payment);
    nav.refresh();
    nav.toast(t('pair.linkedToast', { what: tx ? txLine(tx) : payment }), () => { api.removeMapping({ receiptId: receipt, transactionRef: payment }).then(nav.refresh, (e) => nav.toast(errorText(e))); });
    setState('idle');
  }

  const button = (
    <button type="button" className="golink findpair-go" data-testid={forReceipt ? 'find-payment' : 'find-receipt'} disabled={state === 'busy'} onClick={() => void search()}>
      {state === 'busy' ? t('pair.searching') : t(forReceipt ? 'pair.findPayment' : 'pair.findReceipt')}
    </button>
  );
  if (state === 'idle' || state === 'busy') return button;

  const noModel = !state.model ? <span className="findpair-note" data-testid="pair-no-model">{t(aiOff ? 'pair.aiOff' : 'pair.noModel')}</span> : null;
  const cls = `findpair${compact ? ' compact' : ''}`;
  if (state.outcome === 'linked' || state.outcome === 'filed') {
    const tx = txOf(state.payment);
    const r = receiptOf(state.receipt);
    const what = forReceipt ? (tx ? paymentText(tx) : state.payment) : (r ? receiptText(r) : state.receipt);
    return (
      <div className={cls} data-testid="find-result" data-outcome={state.outcome} role="status">
        <span className={state.outcome === 'linked' ? 'findpair-ok' : ''}>{t(state.outcome === 'filed' ? 'pair.filed' : forReceipt ? 'pair.linked.payment' : 'pair.linked.receipt', { what })}</span>
        <span className="findpair-note">{byText(state.by, state.signals)}</span>
        {state.outcome === 'linked' ? <button type="button" className="golink" onClick={() => { api.removeMapping({ receiptId: state.receipt, transactionRef: state.payment }).then(() => { setState('idle'); nav.refresh(); }, (e) => nav.toast(errorText(e))); }}>{t('pair.unlink')}</button> : null}
      </div>
    );
  }
  if (state.outcome === 'none') {
    const vars = { share: String(BOUNDS.crossCurrency * 100), before: String(BOUNDS.daysBefore), after: String(BOUNDS.daysAfter) };
    return (
      <div className={cls} data-testid="find-result" data-outcome="none" role="status">
        <span>{t(forReceipt ? 'pair.none.payment' : 'pair.none.receipt', vars)}</span>{noModel}
        {button}
      </div>
    );
  }
  if (state.outcome !== 'candidates') return null;
  return (
    <div className={cls} data-testid="find-result" data-outcome="candidates" role="status">
      <span>{t(forReceipt ? 'pair.candidates.payment' : 'pair.candidates.receipt')}</span>
      {state.total > state.candidates.length ? <span className="findpair-note" data-testid="find-cut">{t('pair.cut', { shown: state.candidates.length, total: state.total })}</span> : null}
      {noModel}
      <ul className="findpair-list">
        {state.candidates.map((c) => {
          const tx = txOf(c.payment);
          const r = receiptOf(c.receipt);
          const text = forReceipt ? (tx ? paymentText(tx) : c.payment) : (r ? receiptText(r) : c.receipt);
          const open = () => (forReceipt ? tx && nav.go(at({ area: 'bank', payment: tx.ref }, tx.date)) : r && nav.go(at({ area: 'receipts', id: r.id }, r.date)));
          return (
            <li key={`${c.receipt}|${c.payment}`}>
              <button type="button" className="golink" onClick={open}>{text}</button>
              <span className="findpair-score" data-tip={t('pair.scoreTip', { max: WEIGHTS.amount.same + WEIGHTS.day[0].points + WEIGHTS.name.more + WEIGHTS.number })}>{c.score}</span>
              {c.filed
                ? <span className="findpair-note">{t('pair.filedMark')}</span>
                : <button type="button" className="btn ghost" data-testid="find-pick" onClick={() => void pick(c.receipt, c.payment)}>{t('pair.pick')}</button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
