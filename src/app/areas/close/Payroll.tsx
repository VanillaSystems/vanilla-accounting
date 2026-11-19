/**
 * The payroll's checks of the year-end (docs/specs/payroll.md §6.7, §10.2 A7) on the Abschluss page: the
 * clearing account against the payouts not paid by 31.12., each insurer's account, the wage account per
 * person, each person's statement of the year and, for wages from other programs' payslips, the
 * deductions account. Facts with links to where each is seen or booked; nothing here blocks the close.
 */
import type { ReactNode } from 'react';
import type { Location } from '../../shell/route.js';
import type { YearCloseView } from '../../lib/api.js';
import type { Nav } from '../index.js';
import type { PayrollYearEnd } from '../../../payroll/year-end.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { localToday, parsePeriod } from '../../../accounting/periods.js';
import { getAccountMap } from '../../lib/accounts.js';
import { t } from '../../i18n/index.js';
import { I } from '../receipts/icons.js';
import { Go } from '../vat/links.js';
import { at } from '../receipts/view.js';
import { documentAt, paymentAt, payslipAt } from '../payroll/common.js';
import { monthText } from '../payroll/words.js';
import { clearingState, insurerState, statementState, wagesState, withheldState, type PayrollState } from './payroll-state.js';

const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;

function Fact({ state, id, title, children }: { state: PayrollState; id: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className={`chk st-${state}`} data-payroll={id}>
      <span className="ic">{state === 'ok' ? I.check : state === 'warn' ? '!' : '○'}</span>
      <span className="cx"><b>{title}</b>{children}</span>
      <span />
    </div>
  );
}

export function PayrollChecks({ d, nav }: { d: YearCloseView; nav: Nav }) {
  const p = d.payroll!;
  const year = d.year;
  const names = getAccountMap();
  const acc = (a: string) => `${a} ${names[a] ?? ''}`.trim();
  const ledger = (a: string): Location => ({ route: { area: 'reports', report: 'trial', account: a }, query: { period: parsePeriod(year, localToday()) ?? undefined } });
  const link = (to: Location, text: ReactNode, key?: string) => <Go key={key} to={to} nav={nav}>{text} →</Go>;
  return (
    <>
      <h3>{t('close.payroll.title')}</h3>
      <p className="m">{t('close.payroll.lead')}</p>
      <div className="checks">
        {p.clearing && <Clearing p={p} acc={acc} link={link} ledger={ledger} />}
        {p.insurers.map((i) => {
          const state = insurerState(i);
          return (
            <Fact key={i.id} id={`insurer-${i.id}`} state={state} title={<>{acc(i.account)} · {i.name}</>}>
              <span>{t('close.payroll.insurer', { accrued: fmt(i.accrued), paid: fmt(i.paid), open: fmt(i.open) })}</span>
              {i.compare?.before ? <span>{t('close.payroll.insurerBefore', { amount: fmt(i.compare.before), until: formatDate(i.compare.beforeUntil ?? `${year}-12-31`) })}</span> : null}
              {i.settlement.length
                ? <span>{t('close.payroll.settled', { refs: i.settlement.map((s) => s.ref).join(', ') })}</span>
                : state === 'open' && <span>{t('close.payroll.noSettlement')}</span>}
              {state === 'open' && <span className="chklinks">{link({ route: { area: 'payroll', view: 'payments', month: `${year}-12`, insurance: i.id }, query: {} }, t('close.payroll.settle'))}</span>}
            </Fact>
          );
        })}
        {p.wages && <Wages p={p} acc={acc} link={link} ledger={ledger} />}
        {p.statements.map((s) => {
          const state = statementState(s);
          const facts: string[] = [];
          if (s.issued && s.issued.value !== s.today) facts.push(t('close.payroll.statementChanged', { date: formatDate(s.issued.issuedAt), field: s.field, issued: fmt(s.issued.value), today: fmt(s.today) }));
          if (s.difference) facts.push(t('close.payroll.statementDiffers', { field: s.field, today: fmt(s.today), gross: fmt(s.gross), difference: signed(s.difference) }));
          if (s.unmapped.length) facts.push(t('close.payroll.unmapped', { field: s.field, wageTypes: s.unmapped.map((u) => `${u.wageType} ${fmt(u.amount)}`).join(', ') }));
          if (s.openMonths.length) facts.push(t('close.payroll.openMonths', { months: s.openMonths.map(monthText).join(', ') }));
          return (
            <Fact key={s.employee} id={`statement-${s.employee}`} state={state} title={t('close.payroll.statement', { name: s.name })}>
              <span>{t('close.payroll.statementFigures', { field: s.field, today: fmt(s.today), gross: fmt(s.gross) })} · {s.issued ? t('close.payroll.issuedOn', { date: formatDate(s.issued.issuedAt) }) : t('close.payroll.notIssued')}</span>
              {facts.map((f) => <span key={f}>{f}</span>)}
              <span className="chklinks">{link(documentAt(year, s.employee), s.issued ? t('close.payroll.toStatement') : t('close.payroll.issue'))}</span>
            </Fact>
          );
        })}
        {p.withheld && <Withheld p={p} acc={acc} link={link} ledger={ledger} />}
      </div>
    </>
  );
}

type Parts = { p: PayrollYearEnd; acc(a: string): ReactNode; link(to: Location, text: ReactNode, key?: string): ReactNode; ledger(a: string): Location };

function Clearing({ p, acc, link, ledger }: Parts) {
  const c = p.clearing!;
  const state = clearingState(p)!;
  const text = c.difference
    ? t('close.payroll.clearingDiffers', { balance: fmt(c.balance), expected: fmt(c.expected), difference: signed(c.difference) })
    : c.unpaid.length ? t('close.payroll.clearingUnpaid', { balance: fmt(c.balance) }) : t('close.payroll.clearingZero');
  return (
    <Fact id="clearing" state={state} title={<>{acc(c.account)} {t('close.payroll.atYearEnd')}</>}>
      <span>{text}</span>
      <span className="chklinks">
        {c.unpaid.map((u) => link(paymentAt(u.id), t('close.payroll.unpaid', { month: monthText(u.month), name: u.name, amount: fmt(u.open) }), u.id))}
        {c.difference !== 0 && link(ledger(c.account), t('close.payroll.ledger', { account: c.account }))}
      </span>
    </Fact>
  );
}

function Wages({ p, acc, link, ledger }: Parts) {
  const w = p.wages!;
  const expected = w.persons.reduce((s, x) => s + x.expected, 0);
  return (
    <>
      <Fact id="wages" state={wagesState(p)!} title={<>{acc(w.account)} {t('close.payroll.ofYear')}</>}>
        <span>{t('close.payroll.wages', { booked: fmt(w.booked), payslips: fmt(expected) })}</span>
        {w.opening && <span>{t(w.opening.difference ? 'close.payroll.openingDiffers' : 'close.payroll.openingAgrees', { month: monthText(w.opening.through), booked: fmt(w.opening.booked), expected: fmt(w.opening.expected), difference: signed(w.opening.difference) })}</span>}
        {w.other !== 0 && <span>{t('close.payroll.wagesOther', { amount: fmt(w.other) })}</span>}
        {w.other !== 0 && <span className="chklinks">{link(ledger(w.account), t('close.payroll.ledger', { account: w.account }))}</span>}
      </Fact>
      {w.persons.map((x) => (
        <Fact key={x.employee} id={`wages-${x.employee}`} state={x.difference ? 'warn' : 'ok'} title={x.name}>
          <span>{x.difference
            ? t('close.payroll.personDiffers', { booked: fmt(x.booked), expected: fmt(x.expected), difference: signed(x.difference) })
            : t('close.payroll.personAgrees', { gross: fmt(x.gross), booked: fmt(x.booked) })}</span>
          {x.months.length > 0 && <span className="chklinks">{x.months.map((m) => link(payslipAt(m.id), t('close.payroll.month', { month: monthText(m.month), difference: signed(m.difference) }), m.id))}</span>}
        </Fact>
      ))}
    </>
  );
}

function Withheld({ p, acc, link }: Parts) {
  const w = p.withheld!;
  return (
    <Fact id="withheld" state={withheldState(p)!} title={<>{acc(w.account)} {t('close.payroll.atYearEnd')}</>}>
      <span>{t('close.payroll.withheld', { opening: fmt(w.opening), withheld: fmt(w.withheld), paid: fmt(w.paid), balance: fmt(w.balance) })}</span>
      {w.other !== 0 && <span>{t('close.payroll.withheldOther', { amount: signed(w.other) })}</span>}
      {w.uncleared.length > 0 && <span>{t('close.payroll.uncleared', { n: w.uncleared.length, account: w.account })}</span>}
      {w.uncleared.length > 0 && <span className="chklinks">{w.uncleared.map((u) => link(at({ area: 'bank', payment: u.ref }, u.date), `${u.ref} ${fmt(u.open)}`, u.ref))}</span>}
    </Fact>
  );
}
