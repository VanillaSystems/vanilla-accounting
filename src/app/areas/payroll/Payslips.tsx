/**
 * Löhne › Lohnabrechnungen (docs/specs/payroll.md §5.5, §6.2, §6.5, §12.1): the month's Lohnlauf (one
 * row per person, «x von y abgeschlossen», «Alle abschliessen») and one payslip: its lines in the Lohnart
 * groups in print order (base × rate = amount), «+ Arbeitgeber», a line «unvollständig» naming what is
 * missing, «Lohnart hinzufügen», the booking preview, «Abschliessen» with its warnings as a panel in the
 * page, and on a closed one the PDF, «Korrektur erfassen», «Wieder öffnen» where offered, the history.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../../i18n/index.js';
import { errorText } from '../../lib/api.js';
import { getAccountMap } from '../../lib/accounts.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { localToday } from '../../../accounting/periods.js';
import { baseCurrency } from '../../../engines/index.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import { ListHead } from '../../shell/ListHead.js';
import type { CloseWarning } from '../../../payroll/close.js';
import type { PayslipClose, PayslipLine } from '../../../payroll/model.js';
import type { PayslipDraft } from '../../../payroll/compute.js';
import type { WageType } from '../../../payroll/catalogue.js';
import type { AreaProps, Nav } from '../index.js';
import { payrollApi, reloadPayroll, urls, usePayroll, type Payslip, type PayslipMail, type PayslipSent, type SettingsView } from './data.js';
import type { MonthView } from '../../../payroll/views.js';
import { at, Disclaimer, employeeAt, Go, inPeriodOf, MonthSwitch, payslipAt, settingsAt, Tabs, type PayrollRoute } from './common.js';
import { data, factText, labelOf, localWhen, missingText, monthText, pct, warningText } from './words.js';
import { useHandover } from '../../handover/store.js';
import { Fields, numberOf, type FieldDef, type Form } from './Dated.js';

type Props = AreaProps<PayrollRoute>;

/** The month a payslips page shows: the route's, else this month. */
export const monthOfRoute = (route: PayrollRoute): string => (route.view === 'payslips' && route.month) || localToday().slice(0, 7);

/** The rows the list shows, for ↑/↓ and the first row. */
export const listedPayslips: { ids: string[] } = { ids: [] };

// ─── the list: the month's Lohnlauf ────────────────────────────────────────────

export function PayslipList(props: Props) {
  const { route, nav } = props;
  const month = monthOfRoute(route);
  const load = usePayroll<MonthView>(urls.month(month));
  const selected = route.view === 'payslips' ? route.employee : undefined;
  const rows = load.state === 'ready' ? load.data.rows : [];
  listedPayslips.ids = rows.map((r) => r.employee);
  useEffect(() => {
    if (!selected && rows[0]) nav.select({ area: 'payroll', view: 'payslips', month, employee: rows[0].employee });
  }, [selected, rows[0]?.employee, month]);
  return (
    <div className="page">
      <ListHead {...props}>
        <div className="counts"><Tabs on="payslips" nav={nav} /></div>
      </ListHead>
      <div className="plist">
        <MonthSwitch month={month} onMonth={(m) => nav.go(at({ area: 'payroll', view: 'payslips', month: m }))} />
        {load.state !== 'ready' ? <div className="empty"><p>{load.state === 'loading' ? t('app.loading') : errorText(load.error)}</p></div>
          : !rows.length ? <div className="empty"><h2>{t('payroll.month.none')}</h2><p>{t('payroll.month.noneText')}</p><p><Go nav={nav} loc={employeeAt('new')}>{t('payroll.employee.add')}</Go></p></div>
            : <MonthRows {...props} view={load.data} selected={selected} />}
      </div>
    </div>
  );
}

function MonthRows({ view, selected, nav, canEdit }: Props & { view: MonthView; selected?: string }) {
  // On a Durchsicht copy the payslips are sent by the sharer (her mailbox, her people's passwords).
  const copy = useHandover()?.durchsicht;
  return (
    <>
      <div className="vresult static"><span>{t('payroll.month.closedOf', { closed: view.closed, of: view.of })}</span><b className="mono"><small>{baseCurrency()}</small>{fmt(view.totals.payout)}</b></div>
      <div className="rows" role="listbox" aria-label={t('payroll.tab.payslips')}>
        {view.rows.map((r) => {
          const sel = r.employee === selected;
          return (
            <div key={r.id} className={`row slip st-${r.status}${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={r.id}
              onClick={() => nav.select({ area: 'payroll', view: 'payslips', month: view.month, employee: r.employee })}>
              <span className={`d pstate ${r.status}`}>{t(`payroll.slip.${r.status}`)}</span>
              <span className="t">{r.name}{r.missing ? <small className="neg"> · {t('payroll.slip.missingN', { n: r.missing })}</small> : null}</span>
              <span className="a mono">{fmt(r.payout)}</span>
            </div>
          );
        })}
      </div>
      {canEdit && view.closed < view.of ? <CloseAll view={view} nav={nav} /> : null}
      {canEdit && view.closed > 0 && !copy ? <SendAll view={view} nav={nav} /> : null}
      {canEdit ? <MonthText view={view} nav={nav} /> : null}
    </>
  );
}

/** «Alle abschliessen»: the warnings of every person first, then «Trotzdem abschliessen». */
function CloseAll({ view, nav }: { view: MonthView; nav: Nav }) {
  const [warned, setWarned] = useState<Array<{ id: string; name: string; warnings: CloseWarning[] }> | null>(null);
  const run = async (confirm: boolean) => {
    try {
      const r = await payrollApi.closeMonth(view.month, confirm);
      if (r.warned.length) { setWarned(r.warned); return; }
      setWarned(null);
      nav.toast(t('payroll.closedN', { n: r.closed.length }));
      await reloadPayroll();
    } catch (e) { nav.toast(errorText(e)); }
  };
  return (
    <div className="closeall">
      {warned ? (
        <div className="pcard warnpanel" role="alert">
          <h4>{t('payroll.close.warnTitleAll')}</h4>
          {warned.map((w) => <div key={w.id}><b>{w.name}</b><ul>{w.warnings.map((x, i) => <li key={i}>{warningText(x)}</li>)}</ul></div>)}
          <p className="m">{t('payroll.close.warnRule')}</p>
          <div className="acts">
            <AsyncButton type="button" className="btn primary" onClick={() => run(true)}>{t('payroll.close.anyway')}</AsyncButton>
            <button type="button" className="btn ghost" onClick={() => setWarned(null)}>{t('payroll.close.back')}</button>
          </div>
        </div>
      ) : <AsyncButton type="button" className="btn" onClick={() => run(false)}>{t('payroll.closeAll')}</AsyncButton>}
    </div>
  );
}

/** «An …» and the blind copy, or that there is none: no sender and no mailbox set up. */
const toText = (to: string, copy: string | undefined): string => (copy ? t('payroll.mail.toCopy', { to, copy }) : t('payroll.mail.toNoCopy', { to }));
const copyText = (copy: string | undefined): string => (copy ? t('payroll.mail.bccAll', { copy }) : t('payroll.mail.noCopy'));

/** «Alle per Mail senden»: each closed payslip's recipient shown first, then one mail each; what was refused says why. */
function SendAll({ view, nav }: { view: MonthView; nav: Nav }) {
  const closed = view.rows.filter((r) => r.status === 'closed');
  const [plan, setPlan] = useState<Plan[] | null>(null);
  const [again, setAgain] = useState(false);
  const [done, setDone] = useState<Array<{ id: string; name: string; sent?: PayslipSent; refused?: string }> | null>(null);
  const prepare = async () => {
    setDone(null); setAgain(false);
    setPlan(await Promise.all(closed.map((r) => payrollApi.mailOf(r.id).then((mail) => ({ id: r.id, name: r.name, mail }), (e: unknown) => ({ id: r.id, name: r.name, refused: errorText(e) })))));
  };
  // Sent only what can go: an address and a password; one sent already only when asked to send it again.
  const goes = (p: Plan) => !!p.mail?.to && !!p.mail.password && (again || !p.mail.sent.length);
  const sending = plan?.filter(goes) ?? [];
  const resent = plan?.some((p) => p.mail?.to && p.mail.password && p.mail.sent.length);
  const send = async () => {
    const out: NonNullable<typeof done> = [];
    for (const p of sending) {
      try { out.push({ id: p.id, name: p.name, sent: await payrollApi.send(p.id) }); } catch (e) { out.push({ id: p.id, name: p.name, refused: errorText(e) }); }
    }
    setPlan(null);
    setDone(out);
    nav.toast(t('payroll.mail.sentN', { n: out.filter((o) => o.sent).length }));
    await reloadPayroll();
  };
  const line = (p: Plan) => {
    if (p.refused) return <span className="neg">{t('payroll.mail.notSent', { why: p.refused })}</span>;
    if (!p.mail?.to) return <span className="neg">{t('payroll.mail.notSent', { why: t('payroll.mail.noEmail') })}</span>;
    if (!p.mail.password) return <span className="neg">{t('payroll.mail.notSent', { why: t('payroll.mail.noPassword') })}</span>;
    const last = p.mail.sent.at(-1);
    const to = t('payroll.mail.to', { to: p.mail.to });
    return last ? <>{to} · <span className={again ? '' : 'm'}>{t(again ? 'payroll.mail.sentAgain' : 'payroll.mail.sentAlready', when(last.at))}</span></> : to;
  };
  return (
    <div className="closeall">
      {plan ? (
        <div className="pcard" data-testid="send-all">
          <h4>{t('payroll.mail.allTitle', { month: monthText(view.month) })}</h4>
          <ul>{plan.map((p) => <li key={p.id} data-goes={goes(p)}><b>{p.name}</b> · {line(p)}</li>)}</ul>
          <p className="m">{copyText(plan.find((p) => p.mail)?.mail?.copyTo)}</p>
          {resent ? <label className="pswitch"><input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} /> {t('payroll.mail.includeSent')}</label> : null}
          <p className="m">{t('payroll.mail.lockedText')}</p>
          <div className="acts">
            {sending.length ? <AsyncButton type="button" className="btn primary" onClick={send}>{t('payroll.mail.sendN', { n: sending.length })}</AsyncButton> : <span className="m">{t('payroll.mail.nothingToSend')}</span>}
            <button type="button" className="btn ghost" onClick={() => setPlan(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      ) : <AsyncButton type="button" className="btn ghost" onClick={prepare}>{t('payroll.mail.all')}</AsyncButton>}
      {done ? (
        <div className={`pcard${done.some((d) => d.refused) ? ' warnpanel' : ''}`} role="status" data-testid="send-all-done">
          <ul>{done.map((d) => <li key={d.id}><b>{d.name}</b> · {d.sent ? t('payroll.mail.sentTo', { to: d.sent.to }) : d.refused}</li>)}</ul>
          <button type="button" className="quiet2" onClick={() => setDone(null)}>{t('payroll.mail.dismiss')}</button>
        </div>
      ) : null}
    </div>
  );
}

type Plan = { id: string; name: string; mail?: PayslipMail; refused?: string };

/** A text on every payslip of the month («Frohe Festtage»). */
function MonthText({ view, nav }: { view: MonthView; nav: Nav }) {
  const [text, setText] = useState(view.text ?? '');
  useEffect(() => setText(view.text ?? ''), [view.month, view.text]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try { await payrollApi.monthText(view.month, text); nav.toast(t('payroll.saved')); await reloadPayroll(); } catch (x) { nav.toast(errorText(x)); }
  };
  return (
    <AsyncForm className="form inline monthtext" onSubmit={save}>
      <label className="wide">{t('payroll.month.text')}<input name="text" value={text} onChange={(e) => setText(e.target.value)} /></label>
      {text !== (view.text ?? '') ? <div className="acts"><AsyncButton type="submit" className="btn">{t('common.save')}</AsyncButton></div> : null}
    </AsyncForm>
  );
}

/** The Lohnlauf as a table (Übersicht's detail): one row per person, the totals, «Alle abschliessen». */
export function MonthRun({ month, nav, canEdit }: { month: string; nav: Nav; canEdit: boolean }) {
  const load = usePayroll<MonthView>(urls.month(month));
  if (load.state !== 'ready') return <p className="m">{load.state === 'loading' ? t('app.loading') : errorText(load.error)}</p>;
  const v = load.data;
  if (!v.rows.length) return <p className="m">{t('payroll.month.noneText')}</p>;
  return (
    <>
      <p className="lead">{t('payroll.month.closedOf', { closed: v.closed, of: v.of })}</p>
      <div className="ftab prun">
        <div className="fh"><span>{t('payroll.col.person')}</span><span className="r">{t('payroll.col.gross')}</span><span className="r">{t('payroll.col.deductions')}</span><span className="r">{t('payroll.col.payout')}</span><span className="r">{t('payroll.col.employer')}</span><span>{t('payroll.col.status')}</span></div>
        {v.rows.map((r) => (
          <div key={r.id} className="fr">
            <span><Go nav={nav} loc={payslipAt(r.id)}>{r.name}</Go></span>
            <span className="r mono">{fmt(r.gross)}</span><span className="r mono">{fmt(r.deductions)}</span><span className="r mono">{fmt(r.payout)}</span><span className="r mono">{fmt(r.employer)}</span>
            <span className={`pstate ${r.status}`}>{t(`payroll.slip.${r.status}`)}{r.missing ? <small className="neg"> · {t('payroll.slip.missingN', { n: r.missing })}</small> : null}</span>
          </div>
        ))}
        <div className="fr tot"><span>{t('common.total')}</span><span className="r mono">{fmt(v.totals.gross)}</span><span className="r mono">{fmt(v.totals.deductions)}</span><span className="r mono">{fmt(v.totals.payout)}</span><span className="r mono">{fmt(v.totals.employer)}</span><span /></div>
      </div>
      {canEdit && v.closed < v.of ? <CloseAll view={v} nav={nav} /> : null}
    </>
  );
}

// ─── the detail: one payslip ───────────────────────────────────────────────────

export function PayslipDetail(props: Props) {
  const { route } = props;
  const month = monthOfRoute(route);
  const id = route.view === 'payslips' && route.employee ? `${month}-${route.employee}` : undefined;
  const load = usePayroll<Payslip>(id ? urls.payslip(id) : undefined);
  const settings = usePayroll<SettingsView>(urls.settings);
  if (!id) return <div className="detail-empty"><div>{t('payroll.slip.noneSelected')}</div></div>;
  if (load.state === 'failed') return <div className="detail-empty"><div>{errorText(load.error)}</div></div>;
  if (load.state !== 'ready' || settings.state !== 'ready') return <div className="detail-empty"><div>{t('app.loading')}</div></div>;
  return <SlipView key={id} {...props} v={load.data} types={new Map(settings.data.wageTypes.map((w) => [w.key, w]))} />;
}

type Slip = PayslipDraft | PayslipClose;
const missingOf = (s: Slip) => ('missing' in s ? s.missing : s.left);
const factsOf = (s: Slip) => ('facts' in s ? s.facts : []);
const deductionsOf = (s: Slip) => ('deductions' in s ? s.deductions : Math.round((s.gross - s.net) * 100) / 100);

function SlipView({ v, types, nav, canEdit }: Props & { v: Payslip; types: Map<string, WageType & { used: boolean }> }) {
  const [employer, setEmployer] = useState(false);
  const s = v.slip;
  const closed = v.status === 'closed';
  return (
    <div className="detail-in payslip" data-for={v.id}>
      <div className="head">
        <h2 className="who"><Go nav={nav} loc={employeeAt(v.employee)} className="golink plain">{s.person.name}</Go><small>{t('payroll.slip.title', { month: monthText(v.month) })}</small></h2>
        <div className="amount"><small>{baseCurrency()}</small>{fmt(s.payout)}</div>
      </div>
      <div className="facts">
        <span className={`pstate ${v.status}`}>{closed ? t('payroll.slip.closedOn', { date: formatDate((s as PayslipClose).closedAt.slice(0, 10)) }) : t('payroll.slip.draft')}</span>
        <span>{t('payroll.slip.payday', { date: formatDate(s.payday) })}</span>
        <span>{t('payroll.slip.posting', { date: formatDate(s.postingDate) })}</span>
        <span className="mono">{v.booking.ref}</span>
      </div>
      <SlipFacts v={v} nav={nav} />
      <div className="slipbar">
        <label className="pswitch"><input type="checkbox" checked={employer} onChange={(e) => setEmployer(e.target.checked)} /> {t('payroll.slip.employer')}</label>
        {closed ? <a className="clink" href={`/payroll/payslips/${v.id}.pdf`} target="_blank" rel="noreferrer">{t('payroll.slip.pdf')}</a> : null}
      </div>
      <Lines s={s} types={types} employer={employer} />
      <Disclaimer />
      {!closed && canEdit ? <><MonthLines v={v} types={types} nav={nav} /><AddLine v={v} types={types} nav={nav} /></> : null}
      <Booking v={v} />
      {canEdit ? (closed ? <ClosedActions v={v} types={types} nav={nav} /> : <CloseAction v={v} nav={nav} />) : null}
      {closed ? <Mail v={v} nav={nav} canEdit={canEdit} /> : null}
      <Corrections v={v} nav={nav} types={types} />
      <History v={v} types={types} />
    </div>
  );
}

function SlipFacts({ v, nav }: { v: Payslip; nav: Nav }) {
  const facts = factsOf(v.slip);
  if (!facts.length && !v.drift.length && !v.paidDifference) return null;
  return (
    <div className="pfacts">
      {facts.map((f, i) => (
        <div key={i} className="notice">{factText(f)}{f.key === 'earlierOpen' && f.vars?.month ? <> · <Go nav={nav} loc={payslipAt(`${f.vars.month}-${v.employee}`)}>{monthText(String(f.vars.month))}</Go></> : null}</div>
      ))}
      {v.paidDifference ? (
        <div className="notice warn" data-testid="paid-difference">{t('payroll.slip.paidDifference', { paid: fmt(v.paidDifference.paid), payout: fmt(v.slip.payout), difference: fmt(v.paidDifference.difference), account: v.paidDifference.account })} · <Go nav={nav} loc={inPeriodOf({ area: 'bank', payment: v.paidDifference.ref }, v.paidDifference.date)}>{t('payroll.slip.paidLine')}</Go></div>
      ) : null}
      {v.drift.length ? (
        <div className="notice warn" data-testid="drift">{t('payroll.slip.drift', { lines: v.drift.map((d) => `${d.label} ${fmt(d.before)} → ${fmt(d.after)}`).join(', ') })}</div>
      ) : null}
    </div>
  );
}

/** The lines in their groups, in print order, with the totals after each stage. */
function Lines({ s, types, employer }: { s: Slip; types: Map<string, WageType>; employer: boolean }) {
  const d = data();
  if (!d) return null;
  const groupOf = (wt: string) => types.get(wt)?.group;
  const missing = missingOf(s);
  const totals: Record<string, Array<[string, number]>> = {
    gross: [[labelOf(d.totals.gross), s.gross]],
    deduction: [[labelOf(d.totals.deductions), deductionsOf(s)], [labelOf(d.totals.net), s.net]],
    after: [[labelOf(d.totals.payout), s.payout]],
    employer: [[labelOf(d.totals.employer), s.employer]],
  };
  const stages = ['gross', 'deduction', 'after', 'employer'] as const;
  return (
    <div className="plines" role="table" aria-label={t('payroll.slip.lines')}>
      {stages.filter((st) => st !== 'employer' || employer).map((st) => {
        const groups = d.groups.filter((g) => g.stage === st);
        const body = groups.map((g) => {
          const lines = s.lines.filter((l) => groupOf(l.wageType) === g.key);
          const miss = missing.filter((m) => groupOf(m.wageType) === g.key);
          if (!lines.length && !miss.length) return null;
          return (
            <div key={g.key} className="pgroup" role="rowgroup">
              <div className="pg">{labelOf(g.label)}</div>
              {lines.map((l, i) => <LineRow key={i} l={l} w={types.get(l.wageType)} />)}
              {miss.map((m, i) => (
                <div key={`m${i}`} className="pl miss" role="row">
                  <span className="pt">{m.label}<small>{t('payroll.slip.incomplete')}: {missingText(m.missing, m.wageType)}{m.days ? ` · ${formatDate(m.days.from)}–${formatDate(m.days.to)}` : ''}</small></span>
                  <span className="pb" /><span className="pa mono">—</span>
                </div>
              ))}
            </div>
          );
        });
        if (st === 'after' && body.every((b) => b === null)) return <div key={st} className="ptot">{totals.after.map(([l, x]) => <div key={l} className="pl tot"><span className="pt">{l}</span><span className="pb" /><span className="pa mono">{fmt(x)}</span></div>)}</div>;
        return (
          <div key={st} className={`pstage ${st}`}>
            {body}
            {totals[st].map(([l, x]) => <div key={l} className="pl tot"><span className="pt">{l}</span><span className="pb" /><span className="pa mono">{fmt(x)}</span></div>)}
          </div>
        );
      })}
    </div>
  );
}

function LineRow({ l, w }: { l: PayslipLine; w?: WageType }) {
  const minus = w?.sign === '-' && w.side !== 'employer';
  const calc = l.quantity !== undefined && l.rate !== undefined && l.base === undefined ? `${fmt(l.quantity).replace(/\.00$/, '')} × ${fmt(l.rate)}`
    : l.base !== undefined && l.rate !== undefined ? `${fmt(l.base)} × ${pct(l.rate)}`
    : '';
  const notes = [
    l.corrects ? t('payroll.line.correction', { month: monthText(l.corrects.slice(0, 7)) }) : '',
    l.days ? `${formatDate(l.days.from)}–${formatDate(l.days.to)}` : '',
    l.text ?? '',
  ].filter(Boolean).join(' · ');
  return (
    <div className={`pl${l.corrects ? ' corr' : ''}`} role="row">
      <span className="pt">{l.label}{notes ? <small>{notes}</small> : null}</span>
      <span className="pb mono">{calc}</span>
      <span className="pa mono">{minus ? `−${fmt(l.amount)}` : fmt(l.amount)}</span>
    </div>
  );
}

/** The Lohnarten added to this month, each with «entfernen». */
function MonthLines({ v, types, nav }: { v: Payslip; types: Map<string, WageType>; nav: Nav }) {
  if (!v.monthLines.length) return null;
  const remove = async (id: string) => { try { await payrollApi.removeLine(id); await reloadPayroll(); } catch (e) { nav.toast(errorText(e)); } };
  return (
    <div className="psec">
      <h3>{t('payroll.slip.added')}</h3>
      <ul className="plain">
        {v.monthLines.map((l) => (
          <li key={l.id}>
            {labelOf(types.get(l.wageType)?.label, l.wageType)} · <span className="mono">{l.amount !== undefined ? fmt(l.amount) : `${l.quantity} × ${l.rate ?? '…'}`}</span>{l.text ? ` · ${l.text}` : ''}
            {' '}<AsyncButton type="button" className="quiet2" onClick={() => remove(l.id)}>{t('payroll.slip.removeLine')}</AsyncButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The Lohnarten a person may enter (not those code computes), by group. */
function enterable(types: Map<string, WageType>, withContributions = false): ReadonlyArray<readonly [string, string]> {
  const d = data();
  const order = new Map(d?.groups.map((g, i) => [g.key, i]) ?? []);
  return [...types.values()]
    .filter((w) => (withContributions ? w.computes !== 'monthly' : !w.computes))
    .sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0))
    .map((w) => [w.key, `${labelOf(d?.groups.find((g) => g.key === w.group)?.label)} · ${labelOf(w.label, w.key)}`] as const);
}

/** «Lohnart hinzufügen»: a Lohnart, an amount or quantity × rate, a text. */
function AddLine({ v, types, nav }: { v: Payslip; types: Map<string, WageType>; nav: Nav }) {
  const [open, setOpen] = useState(false);
  const options = enterable(types);
  const [f, setF] = useState<Form>({ wageType: options[0]?.[0] ?? '' });
  const w = types.get(f.wageType);
  const quantity = w?.input === 'quantity';
  const fields: FieldDef[] = [
    { k: 'wageType', label: t('payroll.field.wageType'), type: 'select', options, wide: true },
    ...(quantity ? [{ k: 'quantity', label: t('payroll.field.quantity'), type: 'number' as const }, { k: 'rate', label: t('payroll.field.unitRate'), type: 'number' as const, hint: w?.hours ? t('payroll.field.rateFromEmployment') : undefined }] : [{ k: 'amount', label: t('payroll.field.amount'), type: 'number' as const }]),
    { k: 'text', label: t('payroll.field.text'), wide: true },
  ];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await payrollApi.addLine({
        employee: v.employee, month: v.month, wageType: f.wageType,
        ...(quantity ? { quantity: numberOf(f.quantity), ...(numberOf(f.rate) !== undefined ? { rate: numberOf(f.rate) } : {}) } : { amount: numberOf(f.amount) }),
        ...(f.text?.trim() ? { text: f.text.trim() } : {}),
      });
      setOpen(false); setF({ wageType: f.wageType });
      await reloadPayroll();
    } catch (x) { nav.toast(errorText(x)); }
  };
  if (!open) return <div className="psec"><button type="button" className="btn ghost" onClick={() => setOpen(true)}>{t('payroll.slip.addLine')}</button></div>;
  return (
    <div className="psec">
      <h3>{t('payroll.slip.addLine')}</h3>
      <AsyncForm className="form inline pform" onSubmit={save}>
        <Fields fields={fields} f={f} set={setF} />
        <div className="acts"><AsyncButton type="submit" className="btn primary">{t('payroll.slip.addLineSave')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button></div>
      </AsyncForm>
    </div>
  );
}

/** «Bucht beim Abschliessen» (a draft) or «Gebucht» (a closed one): debit, credit, text, amount, the date and ref. */
function Booking({ v }: { v: Payslip }) {
  const names = getAccountMap();
  const b = v.booking;
  return (
    <div className="psec">
      <h3>{t(v.status === 'closed' ? 'payroll.booking.booked' : 'payroll.booking.preview')}</h3>
      <p className="m">{t('payroll.booking.when', { date: formatDate(b.date), ref: b.ref })}</p>
      <div className="ftab pbook">
        <div className="fh"><span>{t('payroll.booking.debit')}</span><span>{t('payroll.booking.credit')}</span><span>{t('payroll.booking.text')}</span><span className="r">{t('payroll.booking.amount')}</span></div>
        {b.postings.map((p, i) => (
          <div key={i} className="fr">
            <span className="mono" data-tip={names[p.debit]}>{p.debit}</span><span className="mono" data-tip={names[p.credit]}>{p.credit}</span>
            <span className="pt">{p.text}</span><span className="r mono">{fmt(p.amount)}</span>
          </div>
        ))}
      </div>
      {b.withoutAccount.length ? <p className="warnline">{t('payroll.booking.withoutAccount', { list: b.withoutAccount.join(', ') })}</p> : null}
    </div>
  );
}

/** «Abschliessen»: what is off first, as a panel in the page; then «Trotzdem abschliessen» or «Zurück» (§18). */
function CloseAction({ v, nav }: { v: Payslip; nav: Nav }) {
  const [warnings, setWarnings] = useState<CloseWarning[] | null>(null);
  const run = async (confirm: boolean) => {
    try {
      const r = await payrollApi.close(v.id, confirm);
      if (!r.closed) { setWarnings(r.warnings); return; }
      setWarnings(null);
      nav.toast(r.accountsAdded.length ? t('payroll.close.doneAccounts', { accounts: r.accountsAdded.join(', ') }) : t('payroll.close.done'));
      await reloadPayroll();
      nav.refresh();
    } catch (e) { nav.toast(errorText(e)); }
  };
  return (
    <div className="psec pacts">
      {warnings ? (
        <div className="pcard warnpanel" role="alert" data-testid="close-warnings">
          <h4>{t('payroll.close.warnTitle')}</h4>
          <ul>{warnings.map((w, i) => <li key={i}>{warningText(w)}</li>)}</ul>
          <p className="m">{t('payroll.close.warnRule')}</p>
          <div className="acts">
            <AsyncButton type="button" className="btn primary" onClick={() => run(true)}>{t('payroll.close.anyway')}</AsyncButton>
            <button type="button" className="btn ghost" onClick={() => setWarnings(null)}>{t('payroll.close.back')}</button>
          </div>
        </div>
      ) : <AsyncButton type="button" className="btn primary" onClick={() => run(false)}>{t('payroll.close')}</AsyncButton>}
    </div>
  );
}

/** A closed payslip: «Korrektur erfassen» first; «Wieder öffnen» only on the person's latest month in an open period (§6.5). */
function ClosedActions({ v, types, nav }: { v: Payslip; types: Map<string, WageType>; nav: Nav }) {
  const [mode, setMode] = useState<'none' | 'correct' | 'reopen'>('none');
  const options = enterable(types, true);
  const [f, setF] = useState<Form>({ wageType: v.drift[0]?.wageType ?? options[0]?.[0] ?? '', how: 'amount', amount: v.drift[0] ? String(v.drift[0].diff) : '' });
  const fields: FieldDef[] = [
    { k: 'wageType', label: t('payroll.field.wageType'), type: 'select', options, wide: true },
    { k: 'how', label: t('payroll.correction.how'), type: 'select', options: [['amount', t('payroll.correction.byAmount')], ['rate', t('payroll.correction.byRate')]] },
    ...(f.how === 'rate'
      ? [{ k: 'base', label: t('payroll.field.base'), type: 'number' as const }, { k: 'rateDiff', label: t('payroll.correction.rateDiff'), type: 'number' as const, hint: t('payroll.correction.rateDiffHint') }]
      : [{ k: 'amount', label: t('payroll.field.amount'), type: 'number' as const, hint: t('payroll.correction.amountHint') }]),
    { k: 'text', label: t('payroll.field.text'), wide: true },
  ];
  const correct = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await payrollApi.correct(v.id, { wageType: f.wageType, ...(f.how === 'rate' ? { base: numberOf(f.base), rateDiff: numberOf(f.rateDiff) } : { amount: numberOf(f.amount) }), ...(f.text?.trim() ? { text: f.text.trim() } : {}) });
      setMode('none');
      nav.toast(t('payroll.correction.done'));
      await reloadPayroll();
    } catch (x) { nav.toast(errorText(x)); }
  };
  const reopen = async () => {
    try { await payrollApi.reopen(v.id); setMode('none'); nav.toast(t('payroll.reopen.done')); await reloadPayroll(); nav.refresh(); } catch (e) { nav.toast(errorText(e)); }
  };
  const pending = v.corrections.filter((c) => !c.carriedBy);
  return (
    <div className="psec pacts">
      {mode === 'none' ? (
        <div className="acts">
          <button type="button" className="btn primary" onClick={() => setMode('correct')}>{t('payroll.correction.add')}</button>
          {v.reopen.offered ? <button type="button" className="btn" onClick={() => setMode('reopen')}>{t('payroll.reopen')}</button> : null}
        </div>
      ) : null}
      {!v.reopen.offered && v.reopen.why !== 'notClosed' ? <p className="m">{t(v.reopen.why === 'closedPeriod' ? 'payroll.reopen.closedPeriod' : 'payroll.reopen.notLatest')}</p> : null}
      {mode === 'correct' ? (
        <AsyncForm className="form inline pform" onSubmit={correct}>
          <p className="m wide">{t('payroll.correction.lead')}</p>
          <Fields fields={fields} f={f} set={setF} />
          <div className="acts"><AsyncButton type="submit" className="btn primary">{t('payroll.correction.save')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setMode('none')}>{t('common.cancel')}</button></div>
        </AsyncForm>
      ) : null}
      {mode === 'reopen' ? (
        <div className="pcard warnpanel" role="alert" data-testid="reopen-warning">
          <h4>{t('payroll.reopen.title', { month: monthText(v.month) })}</h4>
          <ul>
            <li>{t('payroll.reopen.entries', { ref: v.booking.ref })}</li>
            <li>{t('payroll.reopen.pdf')}</li>
            {pending.length ? <li>{t('payroll.reopen.corrections', { n: pending.length })}</li> : null}
            <li>{t('payroll.reopen.paid')}</li>
          </ul>
          <div className="acts">
            <AsyncButton type="button" className="btn primary" onClick={reopen}>{t('payroll.reopen')}</AsyncButton>
            <button type="button" className="btn ghost" onClick={() => setMode('none')}>{t('common.cancel')}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** «Per Mail senden»: where it goes and the copy, shown before; a refusal in the page; every mail sent, from the log. */
function Mail({ v, nav, canEdit }: { v: Payslip; nav: Nav; canEdit: boolean }) {
  const load = usePayroll<PayslipMail>(urls.mail(v.id));
  const copy = useHandover()?.durchsicht;
  const [refused, setRefused] = useState<string | null>(null);
  if (load.state !== 'ready') return null;
  const m = load.data;
  const person = (key: 'payroll.mail.toPerson' | 'payroll.mail.toPersonPassword') => <Go nav={nav} loc={employeeAt(v.employee)}>{t(key)}</Go>;
  const send = async () => {
    try {
      const r = await payrollApi.send(v.id);
      setRefused(null);
      nav.toast(t('payroll.mail.sentTo', { to: r.to }));
      await reloadPayroll();
    } catch (e) { setRefused(errorText(e)); }
  };
  const ready = !!m.to && m.password;
  return (
    <div className="psec pmail" data-testid="payslip-mail">
      <h3>{t('payroll.mail.title')}</h3>
      {m.to ? <p className="m" data-testid="mail-to">{toText(m.to, m.copyTo)}</p> : <p className="warnline">{t('payroll.mail.noEmailFact')} · {person('payroll.mail.toPerson')}</p>}
      {!m.password ? <p className="warnline">{t('payroll.mail.noPassword')} · {person('payroll.mail.toPersonPassword')}</p> : <p className="m">{t('payroll.mail.lockedText')}</p>}
      {copy ? <p className="m" data-testid="mail-copy">{t('payroll.mail.sharer', { name: copy.sharer.name })}</p>
        : canEdit && ready ? <div className="acts"><AsyncButton type="button" className="btn" onClick={send}>{t(m.sent.length ? 'payroll.mail.again' : 'payroll.mail.send')}</AsyncButton></div> : null}
      {refused ? <div className="pcard warnpanel" role="alert" data-testid="mail-refused"><h4>{t('payroll.mail.refused')}</h4><p>{refused}</p><button type="button" className="quiet2" onClick={() => setRefused(null)}>{t('payroll.mail.dismiss')}</button></div> : null}
      {m.sent.length ? (
        <ul className="plain" data-testid="mail-log">
          {m.sent.map((s) => <li key={s.messageId + s.at} className="m">{t('payroll.mail.logLine', { ...when(s.at), to: s.copyTo ? `${s.to} · ${t('payroll.mail.bcc', { copy: s.copyTo })}` : s.to })}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

/** The corrections entered on this payslip and where each went. */
function Corrections({ v, nav, types }: { v: Payslip; nav: Nav; types: Map<string, WageType> }) {
  if (!v.corrections.length) return null;
  const close = v.status === 'closed' ? v.slip as PayslipClose : undefined;
  return (
    <div className="psec">
      <h3>{t('payroll.correction.list')}</h3>
      <ul className="plain">
        {v.corrections.map((c) => {
          const void_ = !!close && c.at < close.closedAt;
          return (
            <li key={c.id}>
              <b>{labelOf(types.get(c.wageType)?.label, c.wageType)}</b> <span className="mono">{fmt(c.amount)}</span>{c.text ? ` · ${c.text}` : ''} <span className="m">· {formatDate(c.at.slice(0, 10))} · </span>
              {c.carriedBy ? <Go nav={nav} loc={payslipAt(c.carriedBy)}>{t('payroll.correction.carried', { month: monthText(c.carriedBy.slice(0, 7)) })}</Go>
                : void_ ? <span className="m">{t('payroll.correction.void')}</span> : <span className="m">{t('payroll.correction.next')}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** «19.11.2026, 10:03» in the viewer's time. */
const when = localWhen;

function History({ v, types }: { v: Payslip; types: Map<string, WageType> }) {
  if (!v.history.length) return null;
  return (
    <details className="psec phist">
      <summary>{t('payroll.slip.history', { n: v.history.length })}</summary>
      <ul className="plain">
        {v.history.map((e, i) => (
          <li key={i} className="m">
            {e.event === 'close' ? t('payroll.history.close', when(e.closedAt))
              : e.event === 'reopen' ? t('payroll.history.reopen', when(e.at))
              : e.event === 'keep' ? t('payroll.history.keep', { ...when(e.at), from: e.validFrom ? formatDate(e.validFrom) : '–' })
              : t('payroll.history.correction', { at: when(e.at).at, wageType: labelOf(types.get(e.wageType)?.label, e.wageType), amount: fmt(e.amount) })}
          </li>
        ))}
      </ul>
    </details>
  );
}

export const settingsLink = (nav: Nav, section: string, label: string) => <Go nav={nav} loc={settingsAt(section)}>{label}</Go>;
