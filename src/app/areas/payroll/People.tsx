/**
 * Löhne › Mitarbeitende, the sections of phase B1 (docs/specs/payroll.md §5.4, §6.6, §11): Kinder (each child with
 * the allowance the family compensation fund decided, dated), Abwesenheiten (days, kind, incapacity, continued pay,
 * the insurer's daily allowance; never a diagnosis), and «Nachzahlung» for a person who left this or last year (a
 * payslip of the month with only the Lohnarten added). Every change goes through the card of §19.3 first.
 */
import { useState, type FormEvent } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { t } from '../../i18n/index.js';
import { errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import type { Absence, Child } from '../../../payroll/model.js';
import type { WageType } from '../../../payroll/catalogue.js';
import type { Nav } from '../index.js';
import { payrollApi, reloadPayroll, type EmployeeDetail, type SettingsView } from './data.js';
import { payslipAt } from './common.js';
import { DatedField, Fields, numberOf, numText, useBackdated, type FieldDef, type Form, type ValueSpec } from './Dated.js';
import { data, labelOf, monthText } from './words.js';

type Employee = EmployeeDetail['employee'];
type Common = { today: string; defaultFrom: string; used: ReadonlySet<string>; canEdit: boolean; nav: Nav };

/** The Lohnarten a fund pays per child: those the catalogue marks as allowances, and copies of them. */
const allowanceTypes = (settings: SettingsView): Array<WageType & { used: boolean }> => settings.wageTypes.filter((w) => w.allowance);
/** The one-off allowances (at the birth or the adoption): apart from the monthly history. */
const birthTypes = (settings: SettingsView): Array<WageType & { used: boolean }> => settings.wageTypes.filter((w) => w.once);

const allowanceSpec = (types: ReadonlyArray<WageType>): ValueSpec<{ wageType: string; amount: number }> => ({
  fields: [
    { k: 'wageType', label: t('payroll.field.allowanceKind'), type: 'select', options: types.map((w) => [w.key, labelOf(w.label, w.key)] as const) },
    { k: 'amount', label: t('payroll.field.allowanceAmount'), type: 'number', hint: t('payroll.field.allowanceHint') },
  ],
  from: (v) => ({ wageType: v?.wageType ?? types[0]?.key ?? '', amount: numText(v?.amount) }),
  to: (f) => ({ wageType: f.wageType, amount: numberOf(f.amount) }),
  show: (v) => <>{labelOf(types.find((w) => w.key === v.wageType)?.label, v.wageType)} <span className="mono">{fmt(v.amount)}</span></>,
});

// ─── Kinder ─────────────────────────────────────────────────────────────────────

export function Children({ e, settings, common }: { e: Employee; settings: SettingsView; common: Common }) {
  const types = allowanceTypes(settings);
  const children = e.children ?? [];
  return (
    <div className="psub" data-testid="children">
      {!children.length ? <p className="m">{t('payroll.children.none')}</p> : children.map((c) => <ChildRow key={c.id} e={e} c={c} types={types} common={common} />)}
      {common.canEdit ? <AddChild e={e} types={types} births={birthTypes(settings)} nav={common.nav} defaultFrom={common.defaultFrom} /> : null}
      <p className="m">{t('payroll.children.lead')}</p>
    </div>
  );
}

function ChildRow({ e, c, types, common }: { e: Employee; c: Child; types: ReadonlyArray<WageType>; common: Common }) {
  const card = useBackdated(common.nav);
  const paid = [...common.used].some((u) => u.startsWith(`employees/${e.id}/children/${c.id}/allowance|`));
  return (
    <div className="pchild">
      <DatedField label={`${c.name} · ${formatDate(c.birthDate)}`} path={`employees/${e.id}/children/${c.id}/allowance`} history={c.allowance} spec={allowanceSpec(types)} {...common} />
      {c.birth ? <p className="m">{t('payroll.children.birth', { amount: fmt(c.birth.amount), month: monthText(c.birth.month) })}</p> : null}
      {common.canEdit && !paid ? <AsyncButton type="button" className="quiet2" onClick={() => card.send((how) => payrollApi.removeChild(e.id, c.id, how))}>{t('payroll.children.remove')}</AsyncButton> : null}
      {card.node}
    </div>
  );
}

function AddChild({ e, types, births, nav, defaultFrom }: { e: Employee; types: ReadonlyArray<WageType>; births: ReadonlyArray<WageType>; nav: Nav; defaultFrom: string }) {
  const [open, setOpen] = useState(false);
  const empty = (): Form => ({ wageType: types[0]?.key ?? '', validFrom: defaultFrom, birthType: births[0]?.key ?? '' });
  const [f, setF] = useState<Form>(empty());
  const card = useBackdated(nav);
  // A child born after the person's first open day: the allowance runs from the month of the birth (FamZG Art. 3), the
  // birth allowance is paid in it; the form proposes both, the person keeps or changes them.
  const set = (next: Form) => {
    const born = next.birthDate && next.birthDate !== f.birthDate && next.birthDate.slice(0, 7) >= defaultFrom.slice(0, 7);
    setF(born ? { ...next, validFrom: `${next.birthDate.slice(0, 7)}-01`, birthMonth: next.birthDate.slice(0, 7) } : next);
  };
  const fields: FieldDef[] = [
    { k: 'name', label: t('payroll.field.childName') }, { k: 'birthDate', label: t('payroll.field.birthDate'), type: 'date' },
    ...allowanceSpec(types).fields,
    { k: 'validFrom', label: t('payroll.dated.validFrom'), type: 'date', hint: t('payroll.children.fromHint') }, { k: 'validUntil', label: t('payroll.field.validUntil'), type: 'date', hint: t('payroll.children.untilHint') },
    ...(births.length ? [
      { k: 'birthType', label: t('payroll.field.birthAllowance'), type: 'select' as const, options: births.map((w) => [w.key, labelOf(w.label, w.key)] as const) },
      { k: 'birthAmount', label: t('payroll.field.birthAmount'), type: 'number' as const, hint: t('payroll.field.birthAmountHint') },
      { k: 'birthMonth', label: t('payroll.field.birthMonth'), hint: t('payroll.afterExit.monthHint') },
    ] : []),
  ];
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const birth = f.birthAmount?.trim() ? { birth: { wageType: f.birthType, amount: numberOf(f.birthAmount), month: f.birthMonth || f.birthDate?.slice(0, 7) } } : {};
    const body = { name: f.name, birthDate: f.birthDate, wageType: f.wageType, amount: numberOf(f.amount), validFrom: f.validFrom, ...(f.validUntil ? { validUntil: f.validUntil } : {}), ...birth };
    await card.send((how) => payrollApi.addChild(e.id, body, how), () => { setOpen(false); setF(empty()); });
  };
  if (!open) return <button type="button" className="btn ghost" onClick={() => setOpen(true)}>{t('payroll.children.add')}</button>;
  return (
    <>
      <AsyncForm className="form inline pform" onSubmit={save}>
        <Fields fields={fields} f={f} set={set} />
        <div className="acts"><AsyncButton type="submit" className="btn primary">{t('common.save')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button></div>
      </AsyncForm>
      {card.node}
    </>
  );
}

// ─── Abwesenheiten ──────────────────────────────────────────────────────────────

const kindOf = (key: string) => data()?.absences?.[key];

function absenceText(a: Absence): string {
  const k = kindOf(a.kind);
  return [
    a.incapacity !== undefined && a.incapacity !== 100 ? t('payroll.absence.incapacity', { n: a.incapacity }) : '',
    k && !k.unpaid && !k.holiday ? t('payroll.absence.continued', { n: a.continuedPay ?? 100 }) : '',
    a.dailyAllowance !== undefined ? t('payroll.absence.allowance', { amount: fmt(a.dailyAllowance), from: formatDate(a.allowanceFrom ?? a.from) }) : '',
  ].filter(Boolean).join(' · ');
}

export function Absences({ e, common }: { e: Employee; common: Common }) {
  const list = e.absences ?? [];
  return (
    <div className="psub" data-testid="absences">
      {!list.length ? <p className="m">{t('payroll.absence.none')}</p> : (
        <ul className="plain pabsences">
          {list.map((a) => <AbsenceRow key={a.id} e={e} a={a} common={common} />)}
        </ul>
      )}
      {common.canEdit ? <AddAbsence e={e} nav={common.nav} /> : null}
      <p className="m">{t('payroll.absence.lead')}</p>
    </div>
  );
}

function AbsenceRow({ e, a, common }: { e: Employee; a: Absence; common: Common }) {
  const card = useBackdated(common.nav);
  const detail = absenceText(a);
  return (
    <li>
      <b>{labelOf(kindOf(a.kind)?.label, a.kind)}</b> <span className="mono">{formatDate(a.from)}–{formatDate(a.to)}</span>{detail ? <span className="m"> · {detail}</span> : null}
      {' '}{common.canEdit ? <AsyncButton type="button" className="quiet2" onClick={() => card.send((how) => payrollApi.removeAbsence(e.id, a.id, how))}>{t('payroll.absence.remove')}</AsyncButton> : null}
      {card.node}
    </li>
  );
}

function AddAbsence({ e, nav }: { e: Employee; nav: Nav }) {
  const kinds = Object.entries(data()?.absences ?? {});
  const [open, setOpen] = useState(false);
  const today = localToday();
  const [f, setF] = useState<Form>({ kind: kinds[0]?.[0] ?? '', from: today, to: today, incapacity: '100', continuedPay: '100' });
  const card = useBackdated(nav);
  const k = kindOf(f.kind);
  const fields: FieldDef[] = [
    { k: 'kind', label: t('payroll.field.absenceKind'), type: 'select', options: kinds.map(([key, x]) => [key, labelOf(x.label, key)] as const) },
    { k: 'from', label: t('payroll.field.from'), type: 'date' }, { k: 'to', label: t('payroll.field.to'), type: 'date' },
    { k: 'incapacity', label: t(k?.holiday ? 'payroll.field.dayShare' : 'payroll.field.incapacity'), type: 'number' },
    ...(k && !k.unpaid && !k.holiday ? [{ k: 'continuedPay', label: t('payroll.field.continuedPay'), type: 'number' as const, hint: t('payroll.field.continuedPayHint') }] : []),
    ...(k?.allowance ? [
      { k: 'dailyAllowance', label: t('payroll.field.dailyAllowance'), type: 'number' as const, hint: t('payroll.field.dailyAllowanceHint') },
      { k: 'allowanceFrom', label: t('payroll.field.allowanceFrom'), type: 'date' as const, hint: t('payroll.field.allowanceFromHint') },
    ] : []),
  ];
  const [overlap, setOverlap] = useState<Absence[] | null>(null);
  const send = async () => {
    const body: Record<string, unknown> = { kind: f.kind, from: f.from, to: f.to, incapacity: numberOf(f.incapacity) };
    if (k && !k.unpaid && !k.holiday) body.continuedPay = numberOf(f.continuedPay);
    if (k?.allowance && f.dailyAllowance) { body.dailyAllowance = numberOf(f.dailyAllowance); if (f.allowanceFrom) body.allowanceFrom = f.allowanceFrom; }
    await card.send((how) => payrollApi.addAbsence(e.id, body, how), () => { setOpen(false); setOverlap(null); });
  };
  // An absence over days another holds already is said first (warn, then the person decides); a day's wage is taken off once.
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const over = (e.absences ?? []).filter((a) => a.from <= f.to && a.to >= f.from && !kindOf(a.kind)?.holiday === !k?.holiday);
    if (over.length && !overlap) { setOverlap(over); return; }
    await send();
  };
  if (!open) return <button type="button" className="btn ghost" onClick={() => setOpen(true)}>{t('payroll.absence.add')}</button>;
  return (
    <>
      <AsyncForm className="form inline pform" onSubmit={save}>
        <Fields fields={fields} f={f} set={setF} />
        <p className="m wide">{t('payroll.absence.noDiagnosis')}</p>
        {overlap ? (
          <div className="pcard warnpanel wide" role="alert" data-testid="absence-overlap">
            <h4>{t('payroll.absence.overlapTitle')}</h4>
            <ul>{overlap.map((a) => <li key={a.id}>{labelOf(kindOf(a.kind)?.label, a.kind)} {formatDate(a.from)}–{formatDate(a.to)}</li>)}</ul>
            <p className="m">{t('payroll.absence.overlapRule')}</p>
            <div className="acts"><AsyncButton type="button" className="btn primary" onClick={send}>{t('payroll.absence.overlapAnyway')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setOverlap(null)}>{t('payroll.close.back')}</button></div>
          </div>
        ) : null}
        <div className="acts"><AsyncButton type="submit" className="btn primary">{t('common.save')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button></div>
      </AsyncForm>
      {card.node}
    </>
  );
}

// ─── «Nachzahlung» ──────────────────────────────────────────────────────────────

/** A payment after the exit (§6.6): only for a person who left this or last year; a payslip of the month with the Lohnart added. */
export function AfterExit({ e, settings, nav }: { e: Employee; settings: SettingsView; nav: Nav }) {
  const exit = [...e.employment].sort((a, b) => a.validFrom.localeCompare(b.validFrom)).at(-1)?.validUntil;
  const today = localToday();
  const [open, setOpen] = useState(false);
  const options = settings.wageTypes.filter((w) => !w.computes && (w.stage === 'gross' || w.stage === 'after') && !w.allowance && !w.once)
    .map((w) => [w.key, labelOf(w.label, w.key)] as const);
  // The first one-off payment the catalogue offers (its group of irregular payments), else the first Lohnart.
  const oneOff = settings.wageTypes.find((w) => !w.computes && w.stage === 'gross' && w.group === data()?.wageTypes.find((x) => x.computes === 'thirteenth')?.group)?.key;
  const [f, setF] = useState<Form>({ month: today.slice(0, 7), wageType: oneOff ?? options[0]?.[0] ?? '' });
  if (!exit || exit >= today || Number(exit.slice(0, 4)) < Number(today.slice(0, 4)) - 1) return null;
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.month)) { nav.toast(t('payroll.afterExit.badMonth')); return; }
    try {
      await payrollApi.addLine({ employee: e.id, month: f.month, wageType: f.wageType, amount: numberOf(f.amount), ...(f.text?.trim() ? { text: f.text.trim() } : {}) });
      await reloadPayroll();
      nav.go(payslipAt(`${f.month}-${e.id}`));
    } catch (x) { nav.toast(errorText(x)); }
  };
  return (
    <div className="pexit" data-testid="after-exit">
      {!open ? <button type="button" className="btn ghost" onClick={() => setOpen(true)}>{t('payroll.afterExit.add')}</button> : (
        <AsyncForm className="form inline pform" onSubmit={save}>
          <p className="m wide">{t('payroll.afterExit.lead', { date: formatDate(exit) })}</p>
          <Fields fields={[{ k: 'month', label: t('payroll.afterExit.month'), hint: t('payroll.afterExit.monthHint') }, { k: 'wageType', label: t('payroll.field.wageType'), type: 'select', options, wide: true }, { k: 'amount', label: t('payroll.field.amount'), type: 'number' }, { k: 'text', label: t('payroll.field.text'), wide: true }]} f={f} set={setF} />
          <div className="acts"><AsyncButton type="submit" className="btn primary">{t('payroll.afterExit.save')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button></div>
        </AsyncForm>
      )}
    </div>
  );
}
