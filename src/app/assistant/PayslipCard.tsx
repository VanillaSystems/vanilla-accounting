/**
 * The card under an answer that carried a payslip wish (docs/specs/payroll.md §22 decisions 130–134): the
 * payslip code found, read live from Löhne (its state, the lines «unvollständig», the facts), a link into
 * Löhne, and for a close the person's own «Abschliessen» with its warnings first, through the same API
 * as Löhne's button. Without a person, the month's Lohnlauf and «Alle abschliessen».
 */
import { useState } from 'react';
import { t } from '../i18n/index.js';
import { hrefOf } from '../shell/history.js';
import type { Location } from '../shell/route.js';
import { at } from '../areas/receipts/view.js';
import { AsyncButton } from '../shell/AsyncButton.js';
import { payrollApi, reloadPayroll, urls, usePayroll, type Payslip } from '../areas/payroll/data.js';
import { factText, missingText, monthText, warningText, wageTypeLabel } from '../areas/payroll/words.js';
import { useRefusal } from '../areas/payroll/common.js';
import type { CloseWarning } from '../../payroll/close.js';
import type { MonthView } from '../../payroll/views.js';

interface Props { month: string; employee?: string; close: boolean; onGo(loc: Location): void }

function Link({ loc, onGo, children }: { loc: Location; onGo(loc: Location): void; children: string }) {
  return <a className="linkbtn" href={hrefOf(loc)} onClick={(e) => { e.preventDefault(); onGo(loc); }}>{children}</a>;
}

/** «Abschliessen» or «Alle abschliessen»: the warnings first as a panel, then «Trotzdem abschliessen» (§18). */
function Close({ run, label }: { run(confirm: boolean): Promise<CloseWarning[][] | null>; label: string }) {
  const [warned, setWarned] = useState<CloseWarning[][] | null>(null);
  const refusal = useRefusal();
  const go = async (confirm: boolean) => {
    try { refusal.clear(); setWarned(await run(confirm)); } catch (e) { refusal.refuse(e); }
  };
  return (
    <div className="acts">
      {refusal.node}
      {warned ? (
        <div className="pcard warnpanel" role="alert" data-testid="payslip-card-warnings">
          <ul>{warned.flat().map((w, i) => <li key={i}>{warningText(w)}</li>)}</ul>
          <p className="m">{t('payroll.close.warnRule')}</p>
          <AsyncButton type="button" className="btn primary" onClick={() => go(true)}>{t('payroll.close.anyway')}</AsyncButton>
          <button type="button" className="btn ghost" onClick={() => setWarned(null)}>{t('payroll.close.back')}</button>
        </div>
      ) : <AsyncButton type="button" className="btn primary" onClick={() => go(false)}>{label}</AsyncButton>}
    </div>
  );
}

function OnePayslip({ month, employee, close, onGo }: Props & { employee: string }) {
  const id = `${month}-${employee}`;
  const load = usePayroll<Payslip>(urls.payslip(id));
  const loc = at({ area: 'payroll', view: 'payslips', month, employee }, `${month}-01`);
  if (load.state === 'loading') return null;
  if (load.state === 'failed') return <div className="aipayslip" data-testid="payslip-card"><p>{t('assistant.payslip.gone')}</p></div>;
  const v = load.data;
  const missing = v.status === 'draft' && 'missing' in v.slip ? v.slip.missing : 'left' in v.slip ? v.slip.left : [];
  const facts = 'facts' in v.slip ? v.slip.facts : [];
  return (
    <div className="aipayslip" data-testid="payslip-card" data-status={v.status}>
      <p><b>{v.slip.person.name}</b> · {t('assistant.payslip.of', { month: monthText(month) })} · {t(v.status === 'closed' ? 'assistant.payslip.closed' : 'assistant.payslip.draft')}</p>
      {missing.length ? (
        <>
          <p className="m">{t('assistant.payslip.incomplete')}</p>
          <ul className="neg">{missing.map((m, i) => <li key={i}>{wageTypeLabel(m.wageType, m.label)}: {missingText(m.missing, m.wageType)}</li>)}</ul>
        </>
      ) : v.status === 'draft' ? <p className="m">{t('assistant.payslip.complete')}</p> : null}
      {facts.length ? <ul className="m">{facts.map((f, i) => <li key={i}>{factText(f)}</li>)}</ul> : null}
      <Link loc={loc} onGo={onGo}>{t('assistant.payslip.open')}</Link>
      {close && v.status === 'draft' ? (
        <Close label={t('payroll.close')} run={async (confirm) => {
          const r = await payrollApi.close(id, confirm);
          if (!r.closed) return [r.warnings];
          await reloadPayroll();
          return null;
        }} />
      ) : null}
    </div>
  );
}

function OneMonth({ month, close, onGo }: Props) {
  const load = usePayroll<MonthView>(urls.month(month));
  const loc = at({ area: 'payroll', view: 'payslips', month }, `${month}-01`);
  if (load.state !== 'ready') return null;
  const v = load.data;
  return (
    <div className="aipayslip" data-testid="payslip-card" data-closed={v.closed} data-of={v.of}>
      <p>{t('assistant.payslip.monthOf', { month: monthText(month), closed: v.closed, of: v.of })}</p>
      {v.rows.filter((r) => r.status === 'draft' && r.missing).map((r) => <p key={r.id} className="m">{r.name} · {t('assistant.payslip.incomplete')}</p>)}
      <Link loc={loc} onGo={onGo}>{t('assistant.payslip.open')}</Link>
      {close && v.closed < v.of ? (
        <Close label={t('payroll.closeAll')} run={async (confirm) => {
          const r = await payrollApi.closeMonth(month, confirm);
          if (r.warned.length) return r.warned.map((w) => w.warnings);
          await reloadPayroll();
          return null;
        }} />
      ) : null}
    </div>
  );
}

export function PayslipCard(p: Props) {
  return p.employee ? <OnePayslip {...p} employee={p.employee} /> : <OneMonth {...p} />;
}
