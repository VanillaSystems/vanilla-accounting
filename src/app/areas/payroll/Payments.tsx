/**
 * Löhne › Lohnzahlungen (docs/specs/payroll.md §6.3, §6.4, §12.1): the month's payouts (person, IBAN,
 * payout, purpose «Lohn MM/YYYY», value date), each «bezahlt» with the bank line that paid it once the
 * statement brought it and code booked it (never a click); and per insurer of the month's year what the
 * payslips accrued, what was paid, what is open, with the final statement (Schlussabrechnung) the person
 * enters off the insurer's statement. The person pays in e-banking; no payment file in B0 (§21 decision 5).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { baseCurrency } from '../../../engines/index.js';
import { t } from '../../i18n/index.js';
import { errorText } from '../../lib/api.js';
import { getAccountMap } from '../../lib/accounts.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import { ListHead } from '../../shell/ListHead.js';
import type { JournalEntry } from '../../../types/index.js';
import type { SettlementCompare } from '../../../payroll/insurers.js';
import type { AreaProps, Nav } from '../index.js';
import { payrollApi, reloadPayroll, urls, usePayroll, type InsurerRow, type Insurers, type PaymentRow, type Payments } from './data.js';
import { at, Go, inPeriodOf, MonthSwitch, payslipAt, Tabs, type PayrollRoute } from './common.js';
import { Fields, numberOf, type Form } from './Dated.js';
import { kindLabel, monthText } from './words.js';

type Props = AreaProps<PayrollRoute>;

/** The month the page shows: the route's, else this month. */
export const paymentMonth = (route: PayrollRoute): string => (route.view === 'payments' && route.month) || localToday().slice(0, 7);

/** The rows the list shows, in order: a payment by its person, an insurer as `insurance:<id>`. */
export const listedPayments: { ids: string[] } = { ids: [] };

export const selectionOf = (route: PayrollRoute): string | undefined =>
  route.view !== 'payments' ? undefined : route.insurance ? `insurance:${route.insurance}` : route.employee;

export const routeOfSelection = (month: string, id: string): PayrollRoute =>
  id.startsWith('insurance:') ? { area: 'payroll', view: 'payments', month, insurance: id.slice(10) } : { area: 'payroll', view: 'payments', month, employee: id };

const iban = (s: string | undefined) => (s ?? '').replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();

// ─── the list ──────────────────────────────────────────────────────────────────

export function PaymentList(props: Props) {
  const { route, nav } = props;
  const month = paymentMonth(route);
  const year = month.slice(0, 4);
  const load = usePayroll<Payments>(urls.payments(month));
  const insurers = usePayroll<Insurers>(urls.insurers(year));
  const rows = load.state === 'ready' ? load.data.rows : [];
  const ins = insurers.state === 'ready' ? insurers.data.rows : [];
  const selected = selectionOf(route);
  listedPayments.ids = [...rows.map((r) => r.employee), ...ins.map((i) => `insurance:${i.id}`)];
  const first = listedPayments.ids[0];
  useEffect(() => { if (!selected && first) nav.select(routeOfSelection(month, first)); }, [selected, first, month]);
  const paid = rows.filter((r) => r.paid).length;
  const total = Math.round(rows.reduce((s, r) => s + r.payout, 0) * 100) / 100;
  const pick = (id: string) => nav.select(routeOfSelection(month, id));
  return (
    <div className="page">
      <ListHead {...props}><div className="counts"><Tabs on="payments" nav={nav} /></div></ListHead>
      <div className="plist">
        <MonthSwitch month={month} onMonth={(m) => nav.go(at({ area: 'payroll', view: 'payments', month: m }))} />
        {load.state !== 'ready' ? <div className="empty"><p>{load.state === 'loading' ? t('app.loading') : errorText(load.error)}</p></div> : (
          <>
            {!rows.length ? <p className="m pfact" data-testid="payments-none">{t('payroll.payments.none')} <Go nav={nav} loc={at({ area: 'payroll', view: 'payslips', month })}>{t('payroll.payments.toPayslips')}</Go></p> : (
              <>
                <div className="vresult static"><span>{t('payroll.payments.paidOf', { paid, of: rows.length })}</span><b className="mono"><small>{baseCurrency()}</small>{fmt(total)}</b></div>
                <div className="rows" role="listbox" aria-label={t('payroll.tab.payments')}>
                  {rows.map((r) => {
                    const sel = r.employee === selected;
                    return (
                      <div key={r.id} className={`row slip ppay${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={r.id} onClick={() => pick(r.employee)}>
                        <span className={`d pstate ${r.paid ? 'closed' : 'draft'}`}>{t(r.paid ? 'payroll.payments.paid' : 'payroll.payments.unpaid')}</span>
                        <span className="t">{r.name}<small className="mono">{iban(r.iban) || t('payroll.payments.noIban')}</small></span>
                        <span className="a mono">{fmt(r.payout)}{r.difference ? <small className="pdiff" data-tip={t('payroll.payments.differenceTip', { difference: fmt(r.difference), account: r.account ?? '' })}>{t('payroll.payments.differenceShort', { difference: fmt(r.difference) })}</small> : null}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            <h3 className="plabel">{t('payroll.insurers.title', { year })}</h3>
            {insurers.state !== 'ready' ? <p className="m">{insurers.state === 'loading' ? t('app.loading') : errorText(insurers.error)}</p>
              : !ins.length ? <p className="m pfact">{t('payroll.insurers.none')}</p> : (
                <div className="rows" role="listbox" aria-label={t('payroll.insurers.title', { year })}>
                  {ins.map((i) => {
                    const id = `insurance:${i.id}`;
                    const sel = id === selected;
                    return (
                      <div key={i.id} className={`row ins${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={id} onClick={() => pick(id)}>
                        <span className="t">{i.name}<small>{kindLabel(i.kind)} · {i.account}</small></span>
                        <span className={`a mono${i.open < 0 ? ' neg' : ''}`} data-tip={t('payroll.insurers.open')}>{fmt(i.open)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── the detail ────────────────────────────────────────────────────────────────

export function PaymentDetail(props: Props) {
  const { route } = props;
  const month = paymentMonth(route);
  const load = usePayroll<Payments>(urls.payments(month));
  const insurers = usePayroll<Insurers>(urls.insurers(month.slice(0, 4)));
  if (route.view !== 'payments') return null;
  if (route.insurance) {
    if (insurers.state === 'failed') return <div className="detail-empty"><div>{errorText(insurers.error)}</div></div>;
    if (insurers.state !== 'ready') return <div className="detail-empty"><div>{t('app.loading')}</div></div>;
    const row = insurers.data.rows.find((i) => i.id === route.insurance);
    return row ? <Insurer key={row.id} {...props} row={row} year={insurers.data.year} /> : <div className="detail-empty"><div>{t('payroll.insurers.gone')}</div></div>;
  }
  if (!route.employee) return <div className="detail-empty"><div>{t('payroll.payments.noneSelected')}</div></div>;
  if (load.state === 'failed') return <div className="detail-empty"><div>{errorText(load.error)}</div></div>;
  if (load.state !== 'ready') return <div className="detail-empty"><div>{t('app.loading')}</div></div>;
  const row = load.data.rows.find((r) => r.employee === route.employee);
  return row ? <Payment key={row.id} {...props} row={row} /> : <div className="detail-empty"><div>{t('payroll.payments.gone')}</div></div>;
}

/** The entries of the books on one bank line or ref, each with its link. */
function Entries({ entries, nav }: { entries: JournalEntry[]; nav: Nav }) {
  const names = getAccountMap();
  return (
    <div className="ftab pbook">
      <div className="fh"><span>{t('payroll.booking.debit')}</span><span>{t('payroll.booking.credit')}</span><span>{t('payroll.booking.text')}</span><span className="r">{t('payroll.booking.amount')}</span></div>
      {entries.map((e) => (
        <div key={e.id} className="fr">
          <span className="mono" data-tip={names[e.accountDebit]}>{e.accountDebit || '—'}</span><span className="mono" data-tip={names[e.accountCredit]}>{e.accountCredit || '—'}</span>
          <span className="pt"><Go nav={nav} loc={inPeriodOf({ area: 'journal', id: e.id }, e.date)}>{e.description}</Go></span><span className="r mono">{fmt(e.amount)}</span>
        </div>
      ))}
    </div>
  );
}

function Payment({ row, books, nav }: Props & { row: PaymentRow }) {
  const entries = row.paid ? (books.journalEntries ?? []).filter((e) => e.transactionRef === row.paid!.ref) : [];
  return (
    <div className="detail-in ppayment" data-for={row.id}>
      <div className="head">
        <h2 className="who">{row.name}<small>{t('payroll.payments.title', { month: monthText(row.id.slice(0, 7)) })}</small></h2>
        <div className="amount"><small>{baseCurrency()}</small>{fmt(row.payout)}</div>
      </div>
      <div className="facts">
        <span className={`pstate ${row.paid ? 'closed' : 'draft'}`}>{t(row.paid ? 'payroll.payments.paid' : 'payroll.payments.unpaid')}</span>
        <span>{t('payroll.payments.valueDate', { date: formatDate(row.valueDate) })}</span>
        <span><Go nav={nav} loc={payslipAt(row.id)}>{t('payroll.payments.payslip')}</Go></span>
      </div>
      <div className="docbody">
        <dl className="pkv">
          <dt>{t('payroll.payments.to')}</dt><dd>{row.name}</dd>
          <dt>{t('payroll.field.iban')}</dt><dd className="mono">{iban(row.iban) || <span className="neg">{t('payroll.payments.noIban')}</span>}</dd>
          <dt>{t('payroll.booking.amount')}</dt><dd className="mono">{baseCurrency()} {fmt(row.payout)}</dd>
          <dt>{t('payroll.payments.purpose')}</dt><dd className="mono">{row.purpose}</dd>
          <dt>{t('payroll.payments.valueDateLabel')}</dt><dd>{formatDate(row.valueDate)}</dd>
        </dl>
        {row.paid ? (
          <div className="psec" data-testid="paid">
            <h3>{t('payroll.payments.bankLine')}</h3>
            <p><Go nav={nav} loc={inPeriodOf({ area: 'bank', payment: row.paid.ref }, row.paid.date)}>{t('payroll.payments.paidOn', { date: formatDate(row.paid.date), amount: fmt(row.paid.amount) })}</Go></p>
            {row.paid.together ? <p className="m">{t('payroll.payments.together', { amount: fmt(row.paid.amount) })}</p> : null}
            {row.difference && row.paid.forThis !== undefined ? <div className="notice warn" data-testid="paid-difference">{t('payroll.slip.paidDifference', { paid: fmt(row.paid.forThis), payout: fmt(row.payout), difference: fmt(row.difference), account: row.account ?? '' })}</div> : null}
            {entries.length ? <Entries entries={entries} nav={nav} /> : null}
          </div>
        ) : (
          <div className="psec">
            <h3>{t('payroll.payments.bankLine')}</h3>
            <p className="m" data-testid="unpaid">{t('payroll.payments.unpaidText')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Insurer({ row, year, books, nav, canEdit }: Props & { row: InsurerRow; year: string }) {
  const ref = `LS-${year}-${row.id}`;
  const settled = (books.journalEntries ?? []).filter((e) => e.transactionRef === ref);
  return (
    <div className="detail-in pinsurer" data-for={row.id}>
      <div className="head">
        <h2 className="who">{row.name}<small>{t('payroll.insurers.lead', { kind: kindLabel(row.kind), year })}</small></h2>
        <div className="amount"><small>{baseCurrency()}</small>{fmt(row.open)}</div>
      </div>
      <div className="facts"><span className="mono">{row.account}</span><span>{t('payroll.insurers.openFact')}</span></div>
      <div className="docbody">
        <dl className="pkv">
          <dt>{t('payroll.insurers.accrued')}</dt><dd className="mono">{fmt(row.accrued)}</dd>
          <dt>{t('payroll.insurers.paid')}</dt><dd className="mono">{fmt(row.paid)}</dd>
          <dt>{t('payroll.insurers.open')}</dt><dd className={`mono${row.open < 0 ? ' neg' : ''}`}>{fmt(row.open)}{row.open < 0 ? <small className="m"> · {t('payroll.insurers.ahead')}</small> : null}</dd>
        </dl>
        <p className="m">{t('payroll.insurers.how', { account: row.account })}</p>
        {settled.length ? (
          <div className="psec" data-testid="settled">
            <h3>{t('payroll.insurers.settled')}</h3>
            <Entries entries={settled} nav={nav} />
          </div>
        ) : null}
        {canEdit ? <Settle row={row} year={year} nav={nav} again={settled.length > 0} /> : null}
      </div>
    </div>
  );
}

/**
 * The final statement: its total and its day; code books the difference to the year's contributions in the books
 * (the payslips' and, for the months before payroll ran here, the payments booked otherwise), once. A large
 * difference is shown with its figures in the page first, then «Trotzdem buchen» (§18).
 */
function Settle({ row, year, nav, again }: { row: InsurerRow; year: string; nav: Nav; again: boolean }) {
  const today = localToday();
  const [f, setF] = useState<Form>({ total: '', date: today });
  const [result, setResult] = useState<string | null>(null);
  const [warned, setWarned] = useState<SettlementCompare | null>(null);
  const total = numberOf(f.total);
  const run = async (confirm: boolean) => {
    if (total === undefined) return;
    try {
      const r = await payrollApi.settle(row.id, { year, total, date: f.date, ...(confirm ? { confirm } : {}) });
      if (!r.booked && 'warning' in r && r.warning) { setWarned(r.compare); setResult(null); return; }
      setWarned(null);
      setResult(r.booked ? `${t('payroll.settle.booked', { amount: fmt(r.amount), debit: r.debit, credit: r.credit })} ${compareText(r.compare)}` : t('payroll.settle.agrees'));
      setF({ ...f, total: '' });
      await reloadPayroll();
      nav.refresh();
    } catch (x) { setResult(null); nav.toast(errorText(x)); }
  };
  const save = async (e: FormEvent) => { e.preventDefault(); await run(false); };
  return (
    <div className="psec">
      <h3>{t('payroll.settle.title', { year })}</h3>
      {again ? <p className="m">{t('payroll.settle.again')}</p> : <p className="m">{t('payroll.settle.lead')}</p>}
      <AsyncForm className="form inline pform" onSubmit={save}>
        <Fields fields={[{ k: 'total', label: t('payroll.settle.total', { year }), type: 'number' }, { k: 'date', label: t('payroll.settle.date'), type: 'date' }]} f={f} set={(x) => { setWarned(null); setF(x); }} />
        <div className="acts"><AsyncButton type="submit" className="btn primary" disabled={total === undefined || !f.date}>{t('payroll.settle.save')}</AsyncButton></div>
      </AsyncForm>
      {warned ? (
        <div className="pcard warnpanel" role="alert" data-testid="settle-warning">
          <h4>{t('payroll.settle.warnTitle', { diff: fmt(warned.difference), pct: Math.round(Math.abs(warned.difference) / Math.max(warned.total, warned.books, 1) * 100) })}</h4>
          <dl className="kv2">
            <dt>{t('payroll.settle.accrued')}</dt><dd className="mono">{fmt(warned.accrued)}</dd>
            <dt>{warned.openingThrough ? t('payroll.settle.beforeOpening', { through: monthText(warned.openingThrough) }) : t('payroll.settle.before')}</dt><dd className="mono">{fmt(warned.before)}</dd>
            <dt>{t('payroll.settle.inBooks')}</dt><dd className="mono">{fmt(warned.books)}</dd>
            <dt>{t('payroll.settle.statement')}</dt><dd className="mono">{fmt(warned.total)}</dd>
          </dl>
          {warned.openingThrough && warned.before === 0 ? <p>{t('payroll.settle.noBefore', { through: monthText(warned.openingThrough) })}</p> : null}
          <p className="m">{t('payroll.settle.warnRule')}</p>
          <div className="acts">
            <AsyncButton type="button" className="btn primary" onClick={() => run(true)}>{t('payroll.settle.anyway')}</AsyncButton>
            <button type="button" className="btn ghost" onClick={() => setWarned(null)}>{t('payroll.close.back')}</button>
          </div>
        </div>
      ) : null}
      {result ? <p className="notice" role="status" data-testid="settle-result">{result}</p> : null}
    </div>
  );
}

/** The comparison a booked difference rests on, in one line. */
const compareText = (c: SettlementCompare): string => t('payroll.settle.compare', { accrued: fmt(c.accrued), before: fmt(c.before), books: fmt(c.books), total: fmt(c.total) });
