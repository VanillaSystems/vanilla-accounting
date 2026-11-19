/**
 * «Zurück zum Entwurf» and «Konten ändern» (docs/specs/invoicing.md 4.4.2): the first says what the
 * draft keeps (its number) and what goes (the PDF, marked as replaced; on the agreed basis the
 * booking of its issue); the second lists the positions with their revenue accounts and, as the
 * person picks, what will be booked, read from the server's plan.
 */
import { useEffect, useState } from 'react';
import { isItem, type Issued } from '../../../invoices/model.js';
import { lineAmounts, totals } from '../../../invoices/rules.js';
import type { AccountChangePlan } from '../../../invoices/revise.js';
import { eventRef } from '../../../books/refs.js';
import { baseCurrency, chart } from '../../../engines/index.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { localToday } from '../../../accounting/periods.js';
import { api, errorText } from '../../lib/api.js';
import { getAccounts } from '../../lib/accounts.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { RouteOf } from '../../shell/route.js';
import type { AreaProps } from '../index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { Frame, close } from './frame.js';
import { backToDraft, changeAccounts } from './actions.js';

type Props = AreaProps<RouteOf<'invoices'>>;

export function BackToDraftDialog({ inv, nav, books }: Props & { inv: Issued }) {
  const ref = eventRef(inv, 'issue');
  const event = books.journalEntries?.find((e) => e.transactionRef === ref);
  return (
    <Frame label={t('invoices.backTitle', { number: inv.number })} title={`${inv.customer.name} · ${inv.currency} ${fmt(totals(inv).gross)}`}
      foot={<>
        <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <AsyncButton type="button" className="btn primary" data-act="back-ok" autoFocus onClick={async () => { if (await backToDraft(nav, inv)) close(); }}>{t('invoices.backOk')}</AsyncButton>
      </>}>
      <div className="ibody lkf" data-testid="back-to-draft">
        <p>{t('invoices.backText', { number: inv.number, date: formatDate(inv.issuedAt.slice(0, 10)) })}</p>
        {event && <p>{t('invoices.backBooked', { ref, date: formatDate(event.date) })}</p>}
        <p className="m ivhint">{t('invoices.backUnsent')}</p>
      </div>
    </Frame>
  );
}

/** The revenue accounts of the chart, and any a position names already (one outside the chart since stays pickable). */
const revenueAccounts = (named: readonly string[]) =>
  [...new Map([...getAccounts().filter((a) => chart().typeOf(a.number) === 'revenue').map((a) => [a.number, a.name] as const), ...named.filter(Boolean).map((n) => [n, getAccounts().find((a) => a.number === n)?.name ?? ''] as const)])]
    .sort(([a], [b]) => a.localeCompare(b));

export function AccountsDialog({ inv, nav }: Props & { inv: Issued }) {
  const fallback = useWorkspace()?.invoicing?.revenueAccount ?? '';
  const items = inv.lines.flatMap((l, line) => (isItem(l) ? [{ line, l }] : []));
  const amounts = lineAmounts(inv);
  const [picked, setPicked] = useState<Record<number, string>>(() => Object.fromEntries(items.map(({ line, l }) => [line, l.account ?? fallback])));
  const [date, setDate] = useState(localToday());
  const [plan, setPlan] = useState<AccountChangePlan>();
  const [error, setError] = useState('');
  const lines = items.filter(({ line, l }) => picked[line] !== (l.account ?? fallback)).map(({ line }) => ({ line, account: picked[line] }));
  const input = { lines, date };
  const key = JSON.stringify(input);
  useEffect(() => {
    let live = true;
    setError('');
    api.accountsPlan(inv.id, input).then((p) => { if (live) setPlan(p); }, (e) => { if (live) { setPlan(undefined); setError(errorText(e)); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inv.id, key]);
  const options = revenueAccounts(items.map(({ l }) => l.account ?? fallback));
  const money = (n: number, currency: string) => `${currency} ${fmt(n)}`;
  return (
    <Frame className="iaccounts" label={t('invoices.accountsTitle', { number: inv.number })} title={`${inv.customer.name} · ${inv.currency} ${fmt(totals(inv).gross)}`}
      foot={<>
        <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <AsyncButton type="button" className="btn primary" data-act="accounts-ok" disabled={!lines.length || !!error} onClick={async () => { if (await changeAccounts(nav, inv, input)) close(); }}>{t('invoices.accountsOk')}</AsyncButton>
      </>}>
      <div className="ibody lkf" data-testid="accounts">
        <p className="m ivhint">{t('invoices.accountsIntro')}</p>
        <div className="ftab iacc">
          <div className="fr head"><span>{t('invoices.accountsPosition')}</span><span className="r">{inv.currency}</span><span>{t('invoices.accountsAccount')}</span></div>
          {items.map(({ line, l }) => (
            <label key={line} className="fr" data-line={line}>
              <span className="tt">{line + 1}. {l.text}</span>
              <span className="r mono">{fmt(amounts[line] ?? 0)}</span>
              <select value={picked[line]} aria-label={t('invoices.accountsAccount')} onChange={(e) => setPicked({ ...picked, [line]: e.target.value })}>
                {options.map(([n, name]) => <option key={n} value={n}>{n} {name}</option>)}
              </select>
            </label>
          ))}
        </div>
        {plan?.reclass && <label className="lkr"><span>{t('invoices.accountsDate')}</span><span className="iin"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></span></label>}
        <div className="iwhat" data-testid="accounts-plan">
          <b>{t('invoices.accountsWhat')}</b>
          {error ? <p className="warnline">{error}</p>
            : !plan || !plan.lines.length ? <p className="m">{t('invoices.accountsNothing')}</p>
            : (
              <ul>
                {!plan.rebook.length && !plan.kept.length && <li>{t('invoices.accountsUnbooked')}</li>}
                {plan.rebook.flatMap((r) => (r.filed
                  ? [<li key={r.ref} data-filed>{t('invoices.accountsFiled', { ref: r.ref, date: formatDate(r.date) })}</li>]
                  : r.moves.map((m, k) => <li key={`${r.ref}${k}`}>{t('invoices.accountsRebook', { ref: r.ref, date: formatDate(r.date), amount: money(m.amount, r.currency), from: m.from, to: m.to })}</li>)))}
                {plan.reclass?.moves.map((m, k) => <li key={`kk${k}`} data-reclass>{t('invoices.accountsReclass', { ref: plan.reclass!.ref, date: formatDate(plan.reclass!.date), amount: money(m.amount, baseCurrency()), from: m.from, to: m.to })}</li>)}
                {plan.kept.map((ref) => <li key={ref}>{t('invoices.accountsKept', { ref })}</li>)}
              </ul>
            )}
        </div>
      </div>
    </Frame>
  );
}
