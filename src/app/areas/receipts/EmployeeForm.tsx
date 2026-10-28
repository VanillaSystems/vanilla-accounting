/**
 * «Von Mitarbeitenden bezahlt» in the link dialog (#216): who paid, from the firm's employee money
 * accounts (Firma › Geldkonten, role `employee`). A firm without one asks once: the person's name
 * and the account of the chart that holds what the firm owes them; the app keeps it as a money
 * account of the firm, so the next receipt only asks whom. The app never makes up the account.
 * The payment is that person's outlay on the receipt's date, linked, booked like the owner's.
 */
import { useState } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { reloadWorkspace, useWorkspace } from '../../hooks/use-workspace.js';
import { baseCurrency } from '../../../engines/index.js';
import { fmt } from '../../lib/utils.js';
import type { Nav } from '../index.js';
import { AccountField } from '../journal/AccountField.js';
import type { ReceiptView } from './model.js';
import { privateOutlay } from './actions.js';

export function EmployeeForm({ v, nav, onBack, onDone }: { v: ReceiptView; nav: Nav; onBack(): void; onDone(): void }) {
  const ws = useWorkspace();
  const currency = v.r.currency || baseCurrency();
  const staff = (ws?.bankAccounts ?? []).filter((a) => a.role === 'employee');
  const [pick, setPick] = useState(staff.find((a) => a.currency === currency)?.account ?? '');
  const [adding, setAdding] = useState(!staff.length);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function book(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError('');
    let account = pick;
    if (adding) {
      account = String(new FormData(e.currentTarget).get('account') ?? '').trim();
      if (!name.trim() || !account) { setError(t('receipts.employeeNeeds')); return; }
      setBusy(true);
      try {
        // Kept as the firm's money account of this person: asked once.
        await api.patchWorkspace({ addBank: { bank: name.trim(), currency, account, label: name.trim(), role: 'employee' } });
        reloadWorkspace();
      } catch (x) {
        setError(errorText(x));
        setBusy(false);
        return;
      }
    }
    if (!account) { setError(t('receipts.employeeNeeds')); return; }
    setBusy(true);
    const ok = await privateOutlay(nav, v, { by: account });
    setBusy(false);
    if (ok) onDone();
  }

  return (
    <form className="privform" aria-label={t('actions.employee')} onSubmit={book} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onBack(); } }}>
      <div className="lbl">{t('actions.employee')} · <span className="mono">{currency} {fmt(Math.abs(v.r.amount ?? 0))}</span></div>
      {!adding ? (
        <>
          {staff.map((a) => (
            <label key={a.account} className="opt">
              <input type="radio" name="employee" checked={pick === a.account} disabled={a.currency !== currency} onChange={() => setPick(a.account)} />
              <span>{a.label}</span>
              <b className="mono">{a.account}{a.currency !== currency ? ` · ${a.currency}` : ''}</b>
            </label>
          ))}
          <button type="button" className="linkbtn" onClick={() => setAdding(true)}>{t('receipts.employeeAdd')}</button>
        </>
      ) : (
        <>
          <p className="hint">{t(staff.length ? 'receipts.employeeAddHint' : 'receipts.employeeFirst')}</p>
          <label className="opt"><span>{t('receipts.employeeName')}</span><input className="what" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} /></label>
          <div className="opt"><AccountField name="account" label={t('receipts.employeeAccount')} defaultValue="" /></div>
        </>
      )}
      {error && <p className="warnline">{error}</p>}
      <div className="acts">
        <button type="button" className="btn ghost" onClick={onBack}>{t('receipts.privateBack')} <span className="k">{t('receipts.escKey')}</span></button>
        <button type="submit" className="btn primary" disabled={busy} data-testid="employee-book">{t('receipts.employeeBook')} <span className="k">↵</span></button>
      </div>
    </form>
  );
}
