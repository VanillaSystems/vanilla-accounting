/**
 * An account's reconciliation that waits for the person (#254, src/books/reconcile.ts): the movements
 * read from statement PDFs beside the bank's export or CSV of the same days. Each read movement is the
 * same as one bank movement (code's proposal preselected) or a payment of its own; nothing is left to a
 * default. One «Abgleich bestätigen» applies all (src/server/reconcile.ts). A filed pair keeps its filed
 * side and books only a difference, to an account of the chart.
 */
import { useState } from 'react';
import type { BankTransaction, Index, Reconciliation } from '../../../types/index.js';
import { api, errorText } from '../../lib/api.js';
import { getAccounts } from '../../lib/accounts.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { payText, signed } from './model.js';

const OWN = 'own';
const cents = (t: BankTransaction) => Math.round(signed(t) * 100);
const line = (p: BankTransaction) => `${formatDate(p.date)} · ${payText(p).name} · ${fmt(signed(p))}`;

export function ReconcilePanel({ r, books, label, closedThrough, edit, nav }: { r: Reconciliation; books: Pick<Index, 'transactions' | 'journalEntries'>; label: string; closedThrough?: string; edit: boolean; nav: Nav }) {
  const byRef = new Map(books.transactions.map((x) => [x.ref, x]));
  const of = (refs: readonly string[]) => refs.map((ref) => byRef.get(ref)).filter((x): x is BankTransaction => !!x).sort((a, b) => a.date.localeCompare(b.date));
  const reads = of(r.read), banks = of(r.bank), same = of(r.same ?? []);
  const filed = (x: BankTransaction) => !!closedThrough && x.date <= closedThrough;
  const booked = new Set((books.journalEntries ?? []).map((e) => e.transactionRef.split('~')[0]));
  const [choice, setChoice] = useState<Record<string, string>>(() => Object.fromEntries(r.pairs.map((p) => [p.read, p.bank])));
  const [account, setAccount] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const chosen = new Set(Object.values(choice).filter((v) => v && v !== OWN));
  const differenceOf = (x: BankTransaction) => {
    const b = choice[x.ref] && choice[x.ref] !== OWN ? byRef.get(choice[x.ref]) : undefined;
    return b && filed(x) && booked.has(x.ref) ? cents(b) - cents(x) : 0;
  };
  // A read movement not named yet, or a filed pair's difference without an account.
  const undecided = reads.filter((x) => !choice[x.ref] || (differenceOf(x) && !(account[x.ref] ?? r.differenceTo))).length;
  const bankOnly = banks.filter((b) => !chosen.has(b.ref));
  const accounts = getAccounts();
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const pairs = reads.flatMap((x) => (choice[x.ref] && choice[x.ref] !== OWN ? [{ read: x.ref, bank: choice[x.ref], ...(account[x.ref] ? { account: account[x.ref] } : {}) }] : []));
      await api.confirmReconciliation(r.account, { pairs, own: reads.filter((x) => choice[x.ref] === OWN).map((x) => x.ref) });
      nav.toast(t('reconcile.done'));
      nav.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="reconcile" data-testid="reconcile">
      <h3>{t('reconcile.title')}</h3>
      <p className="notice" style={{ margin: 0 }}>{t('reconcile.intro', { account: label, from: formatDate(r.from), to: formatDate(r.to) })}</p>
      <table className="reconcile-table">
        <thead><tr><th>{t('reconcile.read')}</th><th>{t('reconcile.bank')}</th></tr></thead>
        <tbody>
          {reads.map((x) => {
            const pick = choice[x.ref] ?? '';
            const b = pick && pick !== OWN ? byRef.get(pick) : undefined;
            const diff = b ? cents(b) - cents(x) : 0;
            const filedBooked = filed(x) && booked.has(x.ref);
            return (
              <tr key={x.ref} data-read={x.ref} className={pick ? undefined : 'open'}>
                <td>
                  <span className="mono">{line(x)}</span>
                  {filed(x) ? <small className="m"> · {t(filedBooked ? 'reconcile.filedBooked' : 'reconcile.filed')}</small> : null}
                </td>
                <td>
                  <select value={pick} disabled={!edit || busy} data-testid="reconcile-choice" onChange={(e) => setChoice({ ...choice, [x.ref]: e.target.value })}>
                    <option value="">{t('reconcile.choose')}</option>
                    <option value={OWN}>{t('reconcile.own')}</option>
                    {banks.filter((o) => o.direction === x.direction && o.currency === x.currency).map((o) => <option key={o.ref} value={o.ref} disabled={chosen.has(o.ref) && pick !== o.ref}>{t('reconcile.sameAs', { line: line(o) })}</option>)}
                  </select>
                  {b && filedBooked ? <small className="m"> {t('reconcile.filedSame')}</small> : null}
                  {b && diff && filedBooked ? (
                    <label className="reconcile-diff">{t('reconcile.difference', { amount: `${b.currency} ${fmt(diff / 100)}` })}{' '}
                      <input className="mono" list="reconcile-accounts" size={6} value={account[x.ref] ?? r.differenceTo ?? ''} disabled={!edit || busy} data-testid="reconcile-account" placeholder={t('reconcile.accountPick')} onChange={(e) => setAccount({ ...account, [x.ref]: e.target.value })} />
                    </label>
                  ) : b && diff && !filed(x) ? <small className="m"> {t('reconcile.bankWins', { amount: `${b.currency} ${fmt(signed(b))}` })}</small> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <datalist id="reconcile-accounts">{accounts.map((a) => <option key={a.number} value={a.number}>{a.name}</option>)}</datalist>
      {bankOnly.length ? <p className="notice" style={{ margin: 0 }} data-testid="reconcile-bank-only">{t('reconcile.bankOnly', { n: bankOnly.length })} {bankOnly.map(line).join('; ')}</p> : null}
      {same.length ? <p className="notice" style={{ margin: 0 }} data-testid="reconcile-same">{t('reconcile.same', { n: same.length })} {same.map(line).join('; ')}</p> : null}
      {error ? <p className="notice warn" style={{ margin: 0 }} data-testid="reconcile-error">{error}</p> : null}
      {edit ? (
        <div className="reconcile-acts">
          {undecided ? <span className="m">{t('reconcile.undecided', { n: undecided })}</span> : null}
          <button type="button" className="btn primary" disabled={busy || undecided > 0} data-testid="reconcile-confirm" onClick={() => void go()}>{t('reconcile.confirm')}</button>
        </div>
      ) : null}
    </div>
  );
}
