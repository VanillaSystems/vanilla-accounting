/**
 * Löhne › Einstellungen (docs/specs/payroll.md §5.1–§5.3, §6.1): the Stammdaten (dated), the
 * Sozialversicherungen with their solutions and dated rates (a rate outside its range is a warning), the
 * Lohnarten (rename, other accounts or Lohnausweis field, a copy; a copy no closed payslip used can go),
 * and the accounts the payroll books on with «Konto anlegen». Every form works without the AI.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { t } from '../../i18n/index.js';
import { errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import { ListHead } from '../../shell/ListHead.js';
import { PAYROLL_SECTIONS, type PayrollSection } from '../../shell/route.js';
import type { PayrollAccountRef } from '../../../core/modules/schema.js';
import type { PayrollInsurance } from '../../../payroll/model.js';
import type { AreaProps, Nav } from '../index.js';
import { payrollApi, reloadPayroll, urls, usePayroll, type SettingsView } from './data.js';
import { Tabs, type PayrollRoute } from './common.js';
import { DatedField, Fields, numberOf, useBackdated, type FieldDef, type Form, type ValueSpec } from './Dated.js';
import { data, kindLabel, labelOf, lang, pct, rateLabel } from './words.js';

type Props = AreaProps<PayrollRoute>;
export const listedSections: { ids: string[] } = { ids: [...PAYROLL_SECTIONS] };
const isSection = (s: string | undefined): s is PayrollSection => (PAYROLL_SECTIONS as readonly (string | undefined)[]).includes(s);

export function SettingsList(props: Props) {
  const { route, nav } = props;
  const load = usePayroll<SettingsView>(urls.settings);
  const selected = route.view === 'settings' ? route.section : undefined;
  useEffect(() => { if (!selected) nav.select({ area: 'payroll', view: 'settings', section: PAYROLL_SECTIONS[0] }); }, [selected]);
  const v = load.state === 'ready' ? load.data : undefined;
  const missing = v?.accounts.filter((a) => !a.exists).length ?? 0;
  const side: Record<PayrollSection, string> = {
    company: v?.company.canton.at(-1)?.value ?? '',
    insurances: v ? String(v.insurances.length) : '',
    'wage-types': v ? String(v.wageTypes.length) : '',
    accounts: missing ? t('payroll.accounts.missingN', { n: missing }) : v ? String(v.accounts.length) : '',
  };
  return (
    <div className="page">
      <ListHead {...props}><div className="counts"><Tabs on="settings" nav={nav} /></div></ListHead>
      <div className="rows" role="listbox" aria-label={t('payroll.tab.settings')}>
        {PAYROLL_SECTIONS.map((s) => {
          const sel = s === selected;
          return (
            <div key={s} className={`row fset${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-section={s}
              onClick={() => nav.select({ area: 'payroll', view: 'settings', section: s })}>
              <span className="t">{t(`payroll.settings.${s}`)}</span>
              <span className={`a mono${s === 'accounts' && missing ? ' warn' : ''}`}>{side[s]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SettingsDetail(props: Props) {
  const section = props.route.view === 'settings' ? props.route.section : undefined;
  const load = usePayroll<SettingsView>(urls.settings);
  if (!isSection(section)) return <div className="detail-empty"><div>{section ? t('payroll.settings.gone') : ''}</div></div>;
  if (load.state === 'failed') return <div className="detail-empty"><div>{errorText(load.error)}</div></div>;
  if (load.state !== 'ready') return <div className="detail-empty"><div>{t('app.loading')}</div></div>;
  const v = load.data;
  return (
    <div className="detail-in psettings" key={section}>
      <div className="head"><h2 className="who">{t(`payroll.settings.${section}`)}<small>{t(`payroll.settings.${section}Lead`)}</small></h2></div>
      <div className="docbody">
        {section === 'company' ? <Company v={v} {...props} />
          : section === 'insurances' ? <Insurances v={v} {...props} />
          : section === 'wage-types' ? <WageTypes v={v} {...props} />
          : <Accounts v={v} {...props} />}
      </div>
    </div>
  );
}

// ─── Stammdaten ────────────────────────────────────────────────────────────────

const selectSpec = <T extends string | number>(label: string, options: ReadonlyArray<readonly [T, string]>, show = (v: T) => options.find(([o]) => o === v)?.[1] ?? String(v)): ValueSpec<T> => ({
  fields: [{ k: 'v', label, type: 'select', options: options.map(([o, l]) => [String(o), l] as const) }],
  from: (v) => ({ v: v === undefined ? String(options[0][0]) : String(v) }),
  to: (f) => (typeof options[0][0] === 'number' || /^\d+(\.\d+)?$/.test(f.v) ? Number(f.v) : f.v),
  show,
});

function Company({ v, nav, canEdit }: Props & { v: SettingsView }) {
  const d = data();
  const today = localToday();
  const common = { today, defaultFrom: `${today.slice(0, 4)}-01-01`, used: new Set(v.used), canEdit, nav };
  const c = v.company;
  const days = Array.from({ length: 31 }, (_, i) => [i + 1, String(i + 1)] as const);
  const payday: ValueSpec<number | 'last-working-day'> = {
    fields: [{ k: 'v', label: t('payroll.company.payday'), type: 'select', options: [['last-working-day', t('payroll.company.lastWorkingDay')], ...days.map(([n, l]) => [String(n), l] as const)] }],
    from: (x) => ({ v: String(x ?? 25) }), to: (f) => (f.v === 'last-working-day' ? f.v : Number(f.v)),
    show: (x) => (x === 'last-working-day' ? t('payroll.company.lastWorkingDay') : t('payroll.company.dayOf', { day: x })),
  };
  const canton: ValueSpec<string> = { fields: [{ k: 'v', label: t('payroll.company.canton') }], from: (x) => ({ v: x ?? '' }), to: (f) => f.v, show: (x) => x };
  return (
    <>
      <p className="lead">{t('payroll.company.lead')}</p>
      <DatedField label={t('payroll.company.canton')} path="company/canton" history={c.canton} spec={canton} {...common} />
      <DatedField label={t('payroll.company.payday')} path="company/payday" history={c.payday} spec={payday} {...common} note={!c.payday.length ? t('payroll.company.default', { value: t('payroll.company.dayOf', { day: 25 }) }) : undefined} />
      <DatedField label={t('payroll.company.postingDate')} path="company/postingDate" history={c.postingDate}
        spec={selectSpec(t('payroll.company.postingDate'), [['month-end', t('payroll.company.monthEnd')], ['payday', t('payroll.company.onPayday')]] as const)} {...common}
        note={!c.postingDate.length ? t('payroll.company.default', { value: t('payroll.company.monthEnd') }) : undefined} />
      <DatedField label={t('payroll.company.rounding')} path="company/rounding" history={c.rounding}
        spec={selectSpec(t('payroll.company.rounding'), (d?.rounding ?? [0.05, 0.01]).map((r) => [r, fmt(r)] as const))} {...common}
        note={!c.rounding.length ? t('payroll.company.default', { value: fmt(d?.rounding[0] ?? 0.05) }) : undefined} />
      <DatedField label={t('payroll.company.proration')} path="company/proration" history={c.proration}
        spec={selectSpec(t('payroll.company.proration'), [['calendar-days', t('payroll.company.calendarDays')], ['thirty-days', t('payroll.company.thirtyDays')]] as const)} {...common}
        note={!c.proration.length ? t('payroll.company.default', { value: t('payroll.company.calendarDays') }) : undefined} />
      <DatedField label={t('payroll.company.thirteenth')} path="company/thirteenth" history={c.thirteenth}
        spec={selectSpec(t('payroll.company.thirteenth'), [['twelfth', t('payroll.company.twelfth')], ['percent', t('payroll.company.percent')]] as const)} {...common}
        note={!c.thirteenth.length ? t('payroll.company.default', { value: t('payroll.company.twelfth') }) : undefined} />
    </>
  );
}

// ─── Sozialversicherungen ──────────────────────────────────────────────────────

const ratesSpec = (kind: string): ValueSpec<Record<string, number>> => {
  const keys = Object.keys(data()?.insurances[kind]?.rates ?? {});
  return {
    fields: keys.map((k) => ({ k, label: `${rateLabel(kind, k)} (%)`, type: 'number' as const, hint: rangeHint(kind, k) })),
    from: (v) => Object.fromEntries(keys.map((k) => [k, v?.[k] === undefined ? '' : String(v[k])])),
    to: (f) => Object.fromEntries(keys.flatMap((k) => (numberOf(f[k]) === undefined ? [] : [[k, numberOf(f[k])]]))),
    show: (v) => <span className="plist2">{keys.map((k) => <span key={k}>{rateLabel(kind, k)} {v[k] === undefined ? '—' : pct(v[k])}</span>)}</span>,
  };
};

const rangeHint = (kind: string, k: string): string => {
  const r = data()?.insurances[kind]?.rates?.[k]?.range;
  return r ? t('payroll.settings.range', { from: r[0], to: r[1] }) : '';
};

function Insurances({ v, nav, canEdit }: Props & { v: SettingsView }) {
  const d = data();
  const missing = Object.entries(d?.insurances ?? {}).filter(([kind, k]) => k.required && !v.insurances.some((i) => i.kind === kind));
  const [adding, setAdding] = useState(!v.insurances.length);
  return (
    <>
      <p className="lead">{t('payroll.insurances.lead')}</p>
      {missing.length ? <div className="notice warn" role="note">{t('payroll.insurances.missing', { list: missing.map(([k]) => kindLabel(k)).join(', ') })}</div> : null}
      {v.insurances.map((i) => <InsuranceCard key={i.id} i={i} v={v} nav={nav} canEdit={canEdit} />)}
      {canEdit ? (adding ? <NewInsurance v={v} nav={nav} onDone={() => setAdding(false)} /> : <button type="button" className="btn" onClick={() => setAdding(true)}>{t('payroll.insurances.add')}</button>) : null}
    </>
  );
}

function InsuranceCard({ i, v, nav, canEdit }: { i: PayrollInsurance; v: SettingsView; nav: Nav; canEdit: boolean }) {
  const d = data();
  const def = d?.insurances[i.kind];
  const today = localToday();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState<Form>({});
  const [solution, setSolution] = useState(false);
  const [sf, setSf] = useState<Form>({ validFrom: i.validFrom });
  const card = useBackdated(nav, i.kind);
  const fields: FieldDef[] = [
    { k: 'name', label: t('payroll.insurances.name'), wide: true }, { k: 'memberNumber', label: t('payroll.insurances.memberNumber'), mono: true },
    { k: 'contractNumber', label: t('payroll.insurances.contractNumber'), mono: true }, { k: 'customerNumber', label: t('payroll.insurances.customerNumber'), mono: true },
    { k: 'account', label: t('payroll.insurances.account'), mono: true, hint: t('payroll.insurances.accountHint', { account: def?.account ?? '' }) },
    { k: 'validUntil', label: t('payroll.insurances.validUntil'), type: 'date' },
  ];
  const begin = () => { setF({ name: i.name, memberNumber: i.memberNumber ?? '', contractNumber: i.contractNumber ?? '', customerNumber: i.customerNumber ?? '', account: i.account ?? '', validUntil: i.validUntil ?? '' }); setEdit(true); };
  const save = async (e: FormEvent) => { e.preventDefault(); await card.send(() => payrollApi.patchInsurance(i.id, f), () => setEdit(false)); };
  const keys = Object.keys(def?.rates ?? {});
  const addSolution = async (e: FormEvent) => {
    e.preventDefault();
    const rates = Object.fromEntries(keys.flatMap((k) => (numberOf(sf[k]) === undefined ? [] : [[k, numberOf(sf[k])]])));
    await card.send((how) => payrollApi.addSolution(i.id, { code: sf.code, label: sf.label, validFrom: sf.validFrom, rates }, how), () => setSolution(false));
  };
  return (
    <div className="pcard ins" data-insurance={i.id}>
      <div className="inshead"><b>{i.name}</b><span className="m">{kindLabel(i.kind)}</span></div>
      <dl className="kv2">
        {i.memberNumber ? <><dt>{t('payroll.insurances.memberNumber')}</dt><dd className="mono">{i.memberNumber}</dd></> : null}
        {i.contractNumber ? <><dt>{t('payroll.insurances.contractNumber')}</dt><dd className="mono">{i.contractNumber}</dd></> : null}
        {i.customerNumber ? <><dt>{t('payroll.insurances.customerNumber')}</dt><dd className="mono">{i.customerNumber}</dd></> : null}
        <dt>{t('payroll.insurances.account')}</dt><dd className="mono">{i.account ?? def?.account}</dd>
        <dt>{t('payroll.insurances.since')}</dt><dd>{formatDate(i.validFrom)}{i.validUntil ? ` – ${formatDate(i.validUntil)}` : ''}</dd>
      </dl>
      {canEdit && !edit ? <button type="button" className="quiet2" onClick={begin}>{t('payroll.dated.change')}</button> : null}
      {edit ? (
        <AsyncForm className="form inline pform" onSubmit={save}>
          <Fields fields={fields} f={f} set={setF} />
          <div className="acts"><AsyncButton type="submit" className="btn primary">{t('common.save')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setEdit(false)}>{t('common.cancel')}</button></div>
        </AsyncForm>
      ) : null}
      {def?.perPerson ? <p className="m">{t('payroll.insurances.perPerson')}</p> : i.solutions.map((s) => (
        <DatedField key={s.code} label={t('payroll.insurances.solution', { code: s.code })} path={`insurances/${i.id}/solutions/${s.code}/rates`} history={s.rates} spec={ratesSpec(i.kind)}
          today={today} defaultFrom={`${today.slice(0, 4)}-01-01`} used={new Set(v.used)} canEdit={canEdit} nav={nav} kind={i.kind} />
      ))}
      {canEdit && keys.length ? (solution ? (
        <AsyncForm className="form inline pform" onSubmit={addSolution}>
          <Fields fields={[{ k: 'code', label: t('payroll.insurances.code'), mono: true }, { k: 'label', label: t('payroll.insurances.solutionLabel') }, ...ratesSpec(i.kind).fields, { k: 'validFrom', label: t('payroll.dated.validFrom'), type: 'date' }]} f={sf} set={setSf} />
          <div className="acts"><AsyncButton type="submit" className="btn primary">{t('common.save')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setSolution(false)}>{t('common.cancel')}</button></div>
        </AsyncForm>
      ) : <button type="button" className="quiet2" onClick={() => setSolution(true)}>{t('payroll.insurances.addSolution')}</button>) : null}
      {card.node}
    </div>
  );
}

function NewInsurance({ v, nav, onDone }: { v: SettingsView; nav: Nav; onDone(): void }) {
  const d = data();
  const kinds = Object.entries(d?.insurances ?? {}).filter(([, k]) => k.computed !== false);
  const first = kinds.find(([k]) => !v.insurances.some((i) => i.kind === k))?.[0] ?? kinds[0]?.[0] ?? '';
  const [f, setF] = useState<Form>({ kind: first, validFrom: `${localToday().slice(0, 4)}-01-01`, code: 'A' });
  const kind = f.kind;
  const card = useBackdated(nav, kind);
  const fields: FieldDef[] = [
    { k: 'kind', label: t('payroll.insurances.kind'), type: 'select', options: kinds.map(([k, x]) => [k, labelOf(x.label, k)] as const), wide: true },
    { k: 'name', label: t('payroll.insurances.nameOf', { fund: labelOf(d?.insurances[kind]?.fund) }), wide: true },
    { k: 'memberNumber', label: t('payroll.insurances.memberNumber'), mono: true }, { k: 'contractNumber', label: t('payroll.insurances.contractNumber'), mono: true },
    { k: 'account', label: t('payroll.insurances.account'), mono: true, hint: t('payroll.insurances.accountHint', { account: d?.insurances[kind]?.account ?? '' }) },
    { k: 'validFrom', label: t('payroll.dated.validFrom'), type: 'date' },
    ...(d?.insurances[kind]?.perPerson ? [] : [{ k: 'code', label: t('payroll.insurances.code'), mono: true }, ...ratesSpec(kind).fields]),
  ];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const rates = ratesSpec(kind).to(f);
    await card.send((how) => payrollApi.createInsurance({ kind, name: f.name, memberNumber: f.memberNumber, contractNumber: f.contractNumber, account: f.account, validFrom: f.validFrom, code: f.code, rates }, how), onDone);
  };
  return (
    <div className="pcard">
      <h4>{t('payroll.insurances.add')}</h4>
      <AsyncForm className="form inline pform" onSubmit={save}>
        <Fields fields={fields} f={f} set={setF} />
        <div className="acts"><AsyncButton type="submit" className="btn primary">{t('payroll.insurances.save')}</AsyncButton><button type="button" className="btn ghost" onClick={onDone}>{t('common.cancel')}</button></div>
      </AsyncForm>
      {card.node}
    </div>
  );
}

// ─── Lohnarten ─────────────────────────────────────────────────────────────────

function accountOf(ref: PayrollAccountRef | undefined, v: SettingsView): string {
  if (ref === undefined) return '—';
  if (typeof ref === 'string') return ref;
  return v.insurances.find((i) => i.kind === ref.insurance)?.account ?? data()?.insurances[ref.insurance]?.account ?? '—';
}

function WageTypes({ v, nav, canEdit }: Props & { v: SettingsView }) {
  const d = data();
  const [edit, setEdit] = useState<{ key: string; copy: boolean } | null>(null);
  const [f, setF] = useState<Form>({});
  const begin = (key: string, copy: boolean) => {
    const w = v.wageTypes.find((x) => x.key === key)!;
    setF({ label: copy ? '' : labelOf(w.label), debit: copy ? '' : typeof w.debit === 'string' ? w.debit : '', credit: copy ? '' : typeof w.credit === 'string' ? w.credit : '', lohnausweis: copy ? '' : w.lohnausweis ?? '' });
    setEdit({ key, copy });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    const label = f.label.trim() ? { [lang()]: f.label.trim(), ...(edit.copy ? { de: f.label.trim() } : {}) } : undefined;
    const body = { label, debit: f.debit, credit: f.credit, lohnausweis: f.lohnausweis };
    try {
      if (edit.copy) await payrollApi.copyWageType({ copyOf: edit.key, ...body });
      else await payrollApi.setWageType(edit.key, body);
      setEdit(null); nav.toast(t('payroll.saved')); await reloadPayroll();
    } catch (x) { nav.toast(errorText(x)); }
  };
  const remove = async (key: string) => { try { await payrollApi.removeWageType(key); nav.toast(t('payroll.saved')); await reloadPayroll(); } catch (x) { nav.toast(errorText(x)); } };
  const fields: FieldDef[] = [
    { k: 'label', label: t('payroll.wageTypes.label'), wide: true },
    { k: 'debit', label: t('payroll.booking.debit'), mono: true }, { k: 'credit', label: t('payroll.booking.credit'), mono: true },
    { k: 'lohnausweis', label: t('payroll.wageTypes.field'), mono: true },
  ];
  return (
    <>
      <p className="lead">{t('payroll.wageTypes.lead')}</p>
      <div className="ftab pwt">
        <div className="fh"><span>{t('payroll.wageTypes.label')}</span><span>{t('payroll.wageTypes.field')}</span><span>{t('payroll.booking.debit')}</span><span>{t('payroll.booking.credit')}</span><span /></div>
        {d?.groups.map((g) => {
          const rows = v.wageTypes.filter((w) => w.group === g.key);
          if (!rows.length) return null;
          return (
            <div key={g.key}>
              <div className="fg">{labelOf(g.label)}</div>
              {rows.map((w) => (
                <div key={w.key}>
                  <div className={`fr${w.origin !== 'catalogue' ? ' own' : ''}`}>
                    <span>{labelOf(w.label, w.key)}{w.origin !== 'catalogue' ? <small className="m"> · {t(`payroll.wageTypes.origin.${w.origin}`)}</small> : null}{w.computes ? <small className="m"> · {t('payroll.wageTypes.computed')}</small> : null}</span>
                    <span className="mono">{w.lohnausweis ?? '—'}</span>
                    <span className="mono">{accountOf(w.debit, v)}</span><span className="mono">{accountOf(w.credit, v)}</span>
                    <span className="wtacts">
                      {canEdit ? <button type="button" className="quiet2" onClick={() => begin(w.key, false)}>{t('payroll.dated.change')}</button> : null}
                      {canEdit && !w.computes ? <button type="button" className="quiet2" onClick={() => begin(w.key, true)}>{t('payroll.wageTypes.copy')}</button> : null}
                      {canEdit && w.origin === 'copy' && !w.used ? <AsyncButton type="button" className="quiet2" onClick={() => remove(w.key)}>{t('payroll.wageTypes.remove')}</AsyncButton> : null}
                    </span>
                  </div>
                  {edit?.key === w.key ? (
                    <AsyncForm className="form inline pform" onSubmit={save}>
                      <p className="m wide">{t(edit.copy ? 'payroll.wageTypes.copyLead' : 'payroll.wageTypes.editLead')}</p>
                      <Fields fields={fields} f={f} set={setF} />
                      <div className="acts"><AsyncButton type="submit" className="btn primary">{t('common.save')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setEdit(null)}>{t('common.cancel')}</button></div>
                    </AsyncForm>
                  ) : null}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ─── Konten ────────────────────────────────────────────────────────────────────

function Accounts({ v, nav, canEdit }: Props & { v: SettingsView }) {
  const types = new Map(v.wageTypes.map((w) => [w.key, w]));
  const add = async (number: string) => {
    try { const r = await payrollApi.addAccount(number); nav.toast(t('payroll.accounts.added', { number: r.number, name: r.name })); await reloadPayroll(); nav.refresh(); } catch (e) { nav.toast(errorText(e)); }
  };
  return (
    <>
      <p className="lead">{t('payroll.accounts.lead')}</p>
      <div className="ftab pacc">
        <div className="fh"><span>{t('payroll.accounts.number')}</span><span>{t('payroll.accounts.name')}</span><span>{t('payroll.accounts.usedBy')}</span><span /></div>
        {v.accounts.map((a) => (
          <div key={a.number} className={`fr${a.exists ? '' : ' missing'}`}>
            <span className="mono">{a.number}</span>
            <span>{a.name ?? '—'}</span>
            <span className="m">{a.wageTypes.slice(0, 3).map((k) => labelOf(types.get(k)?.label, k)).join(', ')}{a.wageTypes.length > 3 ? ` ${t('payroll.accounts.more', { n: a.wageTypes.length - 3 })}` : ''}</span>
            <span>{a.exists ? <span className="pos">{t('payroll.accounts.exists')}</span> : canEdit ? <AsyncButton type="button" className="btn" onClick={() => add(a.number)}>{t('payroll.accounts.add')}</AsyncButton> : <span className="warn">{t('payroll.accounts.missing')}</span>}</span>
          </div>
        ))}
      </div>
    </>
  );
}

