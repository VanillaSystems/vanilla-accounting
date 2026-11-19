/**
 * Löhne › Mitarbeitende (docs/specs/payroll.md §5.4, §19): the people with Pensum, wage «ab» and status;
 * one person with the Zeitachse of her months and the sections Person, Anstellung, Wiederkehrende
 * Lohnarten, Adresse, Bank, Versicherungen, Quellensteuer, each value dated («ab», «geplant», «Verlauf»,
 * «Ändern» with «gilt ab»); «Person hinzufügen» takes every section at once. The social security number
 * shows masked; in full only after «anzeigen» on the person's own page.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { entryOn } from '../../../core/dated.js';
import { t } from '../../i18n/index.js';
import { errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import { ListHead } from '../../shell/ListHead.js';
import type { Employment, PayrollInsurance, PersonInsurances, TaxAtSource } from '../../../payroll/model.js';
import type { Address } from '../../../invoices/model.js';
import type { AreaProps, Nav } from '../index.js';
import { payrollApi, reloadPayroll, urls, usePayroll, type EmployeeDetail, type Overview, type SettingsView } from './data.js';
import { at, Go, payslipAt, settingsAt, Tabs, type PayrollRoute } from './common.js';
import { DatedField, Fields, numberOf, numText, useBackdated, type FieldDef, type Form, type ValueSpec } from './Dated.js';
import { data, kindLabel, labelOf, monthShort, statusText } from './words.js';

type Props = AreaProps<PayrollRoute>;
export const listedEmployees: { ids: string[] } = { ids: [] };

const LANGS = ['de', 'fr', 'it', 'en'] as const;

// ─── the list ──────────────────────────────────────────────────────────────────

export function EmployeeList(props: Props) {
  const { route, nav } = props;
  const year = localToday().slice(0, 4);
  const load = usePayroll<Overview>(urls.overview(year));
  const selected = route.view === 'employees' ? route.id : undefined;
  const rows = load.state === 'ready' ? load.data.employees : [];
  listedEmployees.ids = rows.map((r) => r.id);
  useEffect(() => {
    if (!selected && rows[0]) nav.select({ area: 'payroll', view: 'employees', id: rows[0].id });
  }, [selected, rows[0]?.id]);
  return (
    <div className="page">
      <ListHead {...props}><div className="counts"><Tabs on="employees" nav={nav} /></div></ListHead>
      {load.state !== 'ready' ? <div className="empty"><p>{load.state === 'loading' ? t('app.loading') : errorText(load.error)}</p></div>
        : !rows.length ? <div className="empty"><h2>{t('payroll.employees.none')}</h2><p>{t('payroll.employees.noneText')}</p></div> : (
          <div className="rows" role="listbox" aria-label={t('payroll.tab.employees')}>
            {rows.map((r) => {
              const sel = r.id === selected;
              return (
                <div key={r.id} className={`row emp${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-id={r.id}
                  onClick={() => nav.select({ area: 'payroll', view: 'employees', id: r.id })}>
                  <span className={`d pstate ${r.status}`}>{statusText(r.status)}</span>
                  <span className="t">{r.name}<small>{[r.isOwner ? t('payroll.employee.owner') : '', t('payroll.employee.pensum', { pensum: r.pensum ?? 100 }), r.since ? t('payroll.dated.from', { date: formatDate(r.since) }) : ''].filter(Boolean).join(' · ')}</small></span>
                  <span className="a mono">{r.amount !== undefined ? fmt(r.amount) : ''}</span>
                </div>
              );
            })}
          </div>
        )}
      {props.canEdit ? <div className="padd"><button type="button" className="btn" onClick={() => nav.select({ area: 'payroll', view: 'employees', id: 'new' })}>{t('payroll.employee.add')}</button></div> : null}
    </div>
  );
}

// ─── the value specs ───────────────────────────────────────────────────────────

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));

const nameSpec = (): ValueSpec<{ first: string; last: string }> => ({
  fields: [{ k: 'first', label: t('payroll.field.first') }, { k: 'last', label: t('payroll.field.last') }],
  from: (v) => ({ first: s(v?.first), last: s(v?.last) }),
  to: (f) => ({ first: f.first, last: f.last }),
  show: (v) => `${v.first} ${v.last}`,
});

const textSpec = (label: string): ValueSpec<string> => ({
  fields: [{ k: 'v', label, wide: true }], from: (v) => ({ v: s(v) }), to: (f) => f.v, show: (v) => v,
});

const addressSpec = (): ValueSpec<Address & { canton?: string; municipality?: string }> => ({
  fields: [
    { k: 'street', label: t('payroll.field.street') }, { k: 'number', label: t('payroll.field.number') },
    { k: 'postcode', label: t('payroll.field.postcode') }, { k: 'town', label: t('payroll.field.town') },
    { k: 'country', label: t('payroll.field.country') }, { k: 'canton', label: t('payroll.field.canton') }, { k: 'municipality', label: t('payroll.field.municipality') },
  ],
  from: (v) => ({ street: s(v?.street), number: s(v?.number), postcode: s(v?.postcode), town: s(v?.town), country: s(v?.country ?? 'CH'), canton: s(v?.canton), municipality: s(v?.municipality) }),
  to: (f) => f,
  show: (v) => [[v.street, v.number].filter(Boolean).join(' '), `${v.postcode} ${v.town}`, v.country !== 'CH' ? v.country : '', v.canton ?? ''].filter(Boolean).join(', '),
});

const bankSpec = (): ValueSpec<{ iban: string; holder?: string }> => ({
  fields: [{ k: 'iban', label: t('payroll.field.iban'), mono: true, wide: true }, { k: 'holder', label: t('payroll.field.holder'), wide: true }],
  from: (v) => ({ iban: s(v?.iban), holder: s(v?.holder) }),
  to: (f) => ({ iban: f.iban, holder: f.holder }),
  show: (v) => <><span className="mono">{v.iban.replace(/(.{4})/g, '$1 ').trim()}</span>{v.holder ? ` · ${v.holder}` : ''}</>,
});

const months13 = (v: string): number[] => v.split(/[,\s]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);

export const employmentFields = (): FieldDef[] => [
  { k: 'kind', label: t('payroll.field.kind'), type: 'select', options: [['monthly', t('payroll.kind.monthly')], ['hourly', t('payroll.kind.hourly')]] },
  { k: 'amount', label: t('payroll.field.salary'), type: 'number', hint: t('payroll.field.salaryHint') },
  { k: 'pensum', label: t('payroll.field.pensum'), type: 'number' },
  { k: 'hoursPerWeek', label: t('payroll.field.hoursPerWeek'), type: 'number' },
  { k: 'holidayDays', label: t('payroll.field.holidayDays'), type: 'number' },
  { k: 'thirteenth', label: t('payroll.field.thirteenth'), hint: t('payroll.field.thirteenthHint') },
];

export const employmentOf = (f: Form): Record<string, unknown> => ({
  kind: f.kind || 'monthly', amount: numberOf(f.amount), pensum: numberOf(f.pensum), hoursPerWeek: numberOf(f.hoursPerWeek), holidayDays: numberOf(f.holidayDays),
  ...(f.thirteenth?.trim() ? { thirteenth: { months: months13(f.thirteenth) } } : {}),
});

const employmentSpec = (): ValueSpec<Employment> => ({
  fields: employmentFields(),
  from: (v) => ({ kind: v?.kind ?? 'monthly', amount: numText(v?.amount), pensum: numText(v?.pensum ?? 100), hoursPerWeek: numText(v?.hoursPerWeek), holidayDays: numText(v?.holidayDays), thirteenth: v?.thirteenth?.months.join(', ') ?? '' }),
  to: employmentOf,
  show: (v) => [
    `${t(v.kind === 'monthly' ? 'payroll.kind.monthly' : 'payroll.kind.hourly')} ${fmt(v.amount)}`,
    t('payroll.employee.pensum', { pensum: v.pensum ?? 100 }),
    v.hoursPerWeek !== undefined ? t('payroll.employee.hours', { n: v.hoursPerWeek }) : '',
    v.holidayDays !== undefined ? t('payroll.employee.holidays', { n: v.holidayDays }) : '',
    v.thirteenth ? t('payroll.employee.thirteenth', { months: v.thirteenth.months.map((m) => monthShort(`2026-${String(m).padStart(2, '0')}`)).join(', ') }) : '',
    v.exitReason ? v.exitReason : '',
  ].filter(Boolean).join(' · '),
});

const taxSpec = (): ValueSpec<TaxAtSource> => ({
  fields: [{ k: 'subject', label: t('payroll.field.taxSubject'), type: 'check' }, { k: 'canton', label: t('payroll.field.canton') }, { k: 'code', label: t('payroll.field.taxCode') }],
  from: (v) => ({ subject: String(!!v?.subject), canton: s(v?.canton), code: s(v?.code) }),
  to: (f) => ({ subject: f.subject === 'true', canton: f.canton, code: f.code }),
  show: (v) => (v.subject ? [t('payroll.employee.taxSubject'), v.canton, v.code].filter(Boolean).join(' · ') : t('payroll.employee.taxNot')),
});

/** The person's insurances: per kind the firm has, the insurance and its solution (a pension certificate: the two monthly figures). */
export function insuranceFields(insurances: readonly PayrollInsurance[]): FieldDef[] {
  const d = data();
  const kinds = [...new Set(insurances.map((i) => i.kind))].filter((k) => d?.insurances[k] && d.insurances[k].computed !== false);
  return [
    ...kinds.flatMap((kind): FieldDef[] => {
      const of = insurances.filter((i) => i.kind === kind);
      if (d?.insurances[kind]?.perPerson) {
        return [
          { k: `${kind}.insurance`, label: kindLabel(kind), type: 'select', options: [['', t('payroll.employee.notInsured')], ...of.map((i) => [i.id, i.name] as const)] },
          { k: `${kind}.employee`, label: t('payroll.field.certEmployee'), type: 'number' },
          { k: `${kind}.employer`, label: t('payroll.field.certEmployer'), type: 'number' },
        ];
      }
      return [{ k: `${kind}.code`, label: kindLabel(kind), type: 'select', options: [['', t('payroll.employee.firstSolution')], ...of.flatMap((i) => i.solutions.map((x) => [`${i.id}:${x.code}`, `${i.name} · ${x.code}`] as const))] }];
    }),
    { k: 'pensioner', label: t('payroll.field.pensioner'), type: 'select', options: [['', '—'], ['allowance', t('payroll.employee.pensionerAllowance')], ['waiver', t('payroll.employee.pensionerWaiver')]] },
  ];
}

export function insurancesOf(f: Form, insurances: readonly PayrollInsurance[]): Record<string, unknown> {
  const d = data();
  const out: Record<string, unknown> = {};
  for (const kind of new Set(insurances.map((i) => i.kind))) {
    if (d?.insurances[kind]?.perPerson) {
      if (f[`${kind}.insurance`]) out[kind] = { insurance: f[`${kind}.insurance`], employee: numberOf(f[`${kind}.employee`]) ?? 0, employer: numberOf(f[`${kind}.employer`]) ?? 0 };
    } else if (f[`${kind}.code`]) {
      const [insurance, code] = f[`${kind}.code`].split(':');
      out[kind] = { insurance, code };
    }
  }
  if (f.pensioner) out.pensioner = f.pensioner;
  return out;
}

const insuranceSpec = (insurances: readonly PayrollInsurance[]): ValueSpec<PersonInsurances> => ({
  fields: insuranceFields(insurances),
  from: (v) => {
    const f: Form = { pensioner: s(v?.pensioner) };
    for (const [kind, x] of Object.entries(v ?? {})) {
      if (!x || typeof x !== 'object') continue;
      const o = x as { insurance: string; code?: string; employee?: number; employer?: number };
      if (o.code) f[`${kind}.code`] = `${o.insurance}:${o.code}`;
      else { f[`${kind}.insurance`] = o.insurance; f[`${kind}.employee`] = numText(o.employee); f[`${kind}.employer`] = numText(o.employer); }
    }
    return f;
  },
  to: (f) => insurancesOf(f, insurances),
  show: (v) => {
    const parts = Object.entries(v).flatMap(([kind, x]) => {
      if (kind === 'pensioner') return [x === 'waiver' ? t('payroll.employee.pensionerWaiver') : t('payroll.employee.pensionerAllowance')];
      if (!x || typeof x !== 'object') return [];
      const o = x as { insurance: string; code?: string; employee?: number; employer?: number };
      const name = insurances.find((i) => i.id === o.insurance)?.name ?? o.insurance;
      return [o.code ? `${kindLabel(kind)}: ${name} ${o.code}` : `${kindLabel(kind)}: ${name} ${t('payroll.employee.cert', { employee: fmt(o.employee ?? 0), employer: fmt(o.employer ?? 0) })}`];
    });
    return parts.length ? <span className="plist2">{parts.map((p) => <span key={p}>{p}</span>)}</span> : <span className="m">{t('payroll.employee.noInsurances')}</span>;
  },
});

const recurringSpec = (quantity: boolean): ValueSpec<{ amount?: number; quantity?: number; rate?: number; text?: string }> => ({
  fields: quantity
    ? [{ k: 'quantity', label: t('payroll.field.quantity'), type: 'number' }, { k: 'rate', label: t('payroll.field.unitRate'), type: 'number' }, { k: 'text', label: t('payroll.field.text'), wide: true }]
    : [{ k: 'amount', label: t('payroll.field.amount'), type: 'number', hint: t('payroll.field.recurringEnd') }, { k: 'text', label: t('payroll.field.text'), wide: true }],
  from: (v) => ({ amount: numText(v?.amount), quantity: numText(v?.quantity), rate: numText(v?.rate), text: s(v?.text) }),
  to: (f) => (quantity ? { quantity: numberOf(f.quantity), rate: numberOf(f.rate), text: f.text } : { amount: numberOf(f.amount), text: f.text }),
  show: (v) => <><span className="mono">{v.amount !== undefined ? fmt(v.amount) : `${v.quantity} × ${fmt(v.rate ?? 0)}`}</span>{v.text ? ` · ${v.text}` : ''}{v.amount === 0 ? <span className="m"> · {t('payroll.employee.recurringEnded')}</span> : null}</>,
});

// ─── the detail ────────────────────────────────────────────────────────────────

export function EmployeeDetailView(props: Props) {
  const { route } = props;
  const id = route.view === 'employees' ? route.id : undefined;
  const year = localToday().slice(0, 4);
  const load = usePayroll<EmployeeDetail>(id && id !== 'new' ? urls.employee(id, year) : undefined);
  const settings = usePayroll<SettingsView>(urls.settings);
  if (id === 'new') return settings.state === 'ready' ? <NewEmployee {...props} settings={settings.data} /> : <div className="detail-empty"><div>{t('app.loading')}</div></div>;
  if (!id) return <div className="detail-empty"><div>{t('payroll.employees.noneSelected')}</div></div>;
  if (load.state === 'failed') return <div className="detail-empty"><div>{errorText(load.error)}</div></div>;
  if (load.state !== 'ready' || settings.state !== 'ready') return <div className="detail-empty"><div>{t('app.loading')}</div></div>;
  return <Person key={id} {...props} d={load.data} settings={settings.data} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="psect"><h3>{title}</h3>{children}</section>;
}

function Person({ d, settings, nav, canEdit }: Props & { d: EmployeeDetail; settings: SettingsView }) {
  const e = d.employee;
  const today = localToday();
  const used = new Set(d.used);
  const base = `employees/${e.id}`;
  const common = { today, defaultFrom: d.defaultFrom, used, canEdit, nav };
  const types = new Map(settings.wageTypes.map((w) => [w.key, w]));
  const name = entryOn(e.name, today)?.value ?? e.name.at(-1)?.value;
  const job = entryOn(e.employment, today)?.value;
  return (
    <div className="detail-in person" data-for={e.id}>
      <div className="head">
        <h2 className="who">{name ? `${name.first} ${name.last}` : e.id}<small>{[e.isOwner ? t('payroll.employee.owner') : '', job ? t('payroll.employee.pensum', { pensum: job.pensum ?? 100 }) : ''].filter(Boolean).join(' · ')}</small></h2>
      </div>
      <Zeitachse d={d} nav={nav} />
      <Section title={t('payroll.sec.person')}>
        <DatedField label={t('payroll.field.name')} path={`${base}/name`} history={e.name} spec={nameSpec()} {...common} />
        <PersonFacts e={e} nav={nav} canEdit={canEdit} />
        <DatedField label={t('payroll.field.email')} path={`${base}/email`} history={e.email} spec={textSpec(t('payroll.field.email'))} {...common} />
        <DatedField label={t('payroll.field.permit')} path={`${base}/permit`} history={e.permit} spec={textSpec(t('payroll.field.permit'))} {...common} />
      </Section>
      <Section title={t('payroll.sec.employment')}>
        <DatedField label={t('payroll.sec.employment')} path={`${base}/employment`} history={e.employment} spec={employmentSpec()} {...common} />
        {canEdit ? <Exit e={e} nav={nav} /> : null}
      </Section>
      <Section title={t('payroll.sec.recurring')}>
        {e.recurring.length ? e.recurring.map((r) => {
          const w = types.get(r.wageType);
          return <DatedField key={r.wageType} label={labelOf(w?.label, r.wageType)} path={`${base}/recurring/${r.wageType}`} history={r.value} spec={recurringSpec(w?.input === 'quantity')} {...common} />;
        }) : <p className="m">{t('payroll.employee.noRecurring')}</p>}
        {canEdit ? <AddRecurring e={e} settings={settings} defaultFrom={d.defaultFrom} nav={nav} /> : null}
      </Section>
      <Section title={t('payroll.sec.address')}>
        <DatedField label={t('payroll.sec.address')} path={`${base}/address`} history={e.address} spec={addressSpec()} {...common} />
      </Section>
      <Section title={t('payroll.sec.bank')}>
        <DatedField label={t('payroll.field.iban')} path={`${base}/bank`} history={e.bank} spec={bankSpec()} {...common} />
      </Section>
      <Section title={t('payroll.sec.insurances')}>
        <DatedField label={t('payroll.sec.insurances')} path={`${base}/insurances`} history={e.insurances} spec={insuranceSpec(settings.insurances)} {...common}
          note={!settings.insurances.length ? <Go nav={nav} loc={settingsAt('insurances')}>{t('payroll.overview.addInsurances')}</Go> : undefined} />
      </Section>
      <Section title={t('payroll.sec.tax')}>
        <DatedField label={t('payroll.sec.tax')} path={`${base}/taxAtSource`} history={e.taxAtSource} spec={taxSpec()} {...common} note={t('payroll.employee.taxNote')} />
      </Section>
    </div>
  );
}

/** The person's months of the year: closed or open, each a link to its payslip. */
function Zeitachse({ d, nav }: { d: EmployeeDetail; nav: Nav }) {
  if (!d.months.length) return null;
  return (
    <div className="zeitachse" aria-label={t('payroll.employee.timeline')}>
      {d.months.map((m) => (
        <Go key={m.month} nav={nav} loc={payslipAt(m.payslip)} className={`zm ${m.status}`}>
          <span>{monthShort(m.month)}</span><small>{t(`payroll.slip.${m.status}`)}</small>
        </Go>
      ))}
    </div>
  );
}

/** The undated facts of a person: birth date, sex, language, nationality, the number, «Inhaber/in». */
function PersonFacts({ e, nav, canEdit }: { e: EmployeeDetail['employee']; nav: Nav; canEdit: boolean }) {
  const [full, setFull] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const was: Form = { birthDate: e.birthDate ?? '', sex: e.sex ?? '', language: e.language, nationality: e.nationality ?? '', isOwner: String(!!e.isOwner), socialSecurityNumber: '' };
  const [f, setF] = useState<Form>(was);
  const card = useBackdated(nav);
  const show = async () => { try { setFull((await payrollApi.socialSecurityNumber(e.id)).socialSecurityNumber); } catch (x) { nav.toast(errorText(x)); } };
  const fields: FieldDef[] = [
    { k: 'birthDate', label: t('payroll.field.birthDate'), type: 'date' },
    { k: 'sex', label: t('payroll.field.sex'), type: 'select', options: [['', '—'], ['f', t('payroll.sex.f')], ['m', t('payroll.sex.m')]] },
    { k: 'language', label: t('payroll.field.language'), type: 'select', options: LANGS.map((l) => [l, t(`payroll.lang.${l}`)] as const) },
    { k: 'nationality', label: t('payroll.field.nationality') },
    { k: 'socialSecurityNumber', label: t('payroll.field.ssn'), mono: true, hint: e.hasSocialSecurityNumber ? t('payroll.field.ssnKeep') : undefined },
    { k: 'isOwner', label: t('payroll.employee.owner'), type: 'check' },
  ];
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const patch: Record<string, unknown> = {};
    for (const k of ['birthDate', 'sex', 'language', 'nationality'] as const) if (f[k] !== was[k]) patch[k] = f[k];
    if (f.isOwner !== was.isOwner) patch.isOwner = f.isOwner === 'true';
    if (f.socialSecurityNumber.trim()) patch.socialSecurityNumber = f.socialSecurityNumber.trim();
    if (!Object.keys(patch).length) { setEdit(false); return; }
    await card.send((how) => payrollApi.patchEmployee(e.id, patch, how), () => { setEdit(false); setFull(null); });
  };
  return (
    <div className="dated">
      <div className="dlabel">{t('payroll.sec.facts')}</div>
      <div className="dbody">
        <dl className="kv2">
          <dt>{t('payroll.field.birthDate')}</dt><dd>{formatDate(e.birthDate)}</dd>
          <dt>{t('payroll.field.sex')}</dt><dd>{e.sex ? t(`payroll.sex.${e.sex}`) : <span className="m">{t('payroll.employee.sexMissing')}</span>}</dd>
          <dt>{t('payroll.field.language')}</dt><dd>{t(`payroll.lang.${e.language}`)}</dd>
          {e.nationality ? <><dt>{t('payroll.field.nationality')}</dt><dd>{e.nationality}</dd></> : null}
          <dt>{t('payroll.field.ssn')}</dt>
          <dd>{e.hasSocialSecurityNumber ? <><span className="mono" data-testid="ssn">{full ?? e.socialSecurityNumber}</span> {full ? <button type="button" className="quiet2" onClick={() => setFull(null)}>{t('payroll.employee.ssnHide')}</button> : <AsyncButton type="button" className="quiet2" onClick={show}>{t('payroll.employee.ssnShow')}</AsyncButton>}</> : <span className="m">{t('payroll.employee.ssnUnknown')}</span>}</dd>
        </dl>
        {canEdit && !edit ? <button type="button" className="quiet2" onClick={() => { setF(was); setEdit(true); }}>{t('payroll.dated.change')}</button> : null}
        {edit ? (
          <AsyncForm className="form inline pform" onSubmit={save}>
            <Fields fields={fields} f={f} set={setF} />
            <div className="acts"><AsyncButton type="submit" className="btn primary">{t('common.save')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setEdit(false)}>{t('common.cancel')}</button></div>
          </AsyncForm>
        ) : null}
        {card.node}
      </div>
    </div>
  );
}

/** «Austritt»: the Anstellung ends on a day, with its reason (the last entry's validUntil). */
function Exit({ e, nav }: { e: EmployeeDetail['employee']; nav: Nav }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Form>({ until: '', reason: '' });
  const card = useBackdated(nav);
  const current = [...e.employment].sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.enteredAt.localeCompare(b.enteredAt)).at(-1);
  if (!current) return null;
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    // Without a last day there is no exit: nothing is saved (an entry without its end would only repeat the current one).
    if (!f.until) { nav.toast(t('payroll.employee.exitDateMissing')); return; }
    await card.send((how) => payrollApi.addEntry({ path: `employees/${e.id}/employment`, validFrom: current.validFrom, validUntil: f.until, value: { ...current.value, ...(f.reason.trim() ? { exitReason: f.reason.trim() } : {}) } }, how), () => setOpen(false));
  };
  return (
    <div className="pexit">
      {!open ? <button type="button" className="quiet2" onClick={() => setOpen(true)}>{current.validUntil ? t('payroll.employee.exitOn', { date: formatDate(current.validUntil) }) : t('payroll.employee.exit')}</button> : (
        <AsyncForm className="form inline pform" onSubmit={save}>
          <Fields fields={[{ k: 'until', label: t('payroll.field.exitDate'), type: 'date' }, { k: 'reason', label: t('payroll.field.exitReason'), wide: true }]} f={f} set={setF} />
          <div className="acts"><AsyncButton type="submit" className="btn primary">{t('common.save')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button></div>
        </AsyncForm>
      )}
      {card.node}
    </div>
  );
}

/** A Lohnart every payslip of the person gets from a day (flat expenses, a car, an allowance). */
function AddRecurring({ e, settings, defaultFrom, nav }: { e: EmployeeDetail['employee']; settings: SettingsView; defaultFrom: string; nav: Nav }) {
  const d = data();
  const [open, setOpen] = useState(false);
  const options = settings.wageTypes.filter((w) => !w.computes && !e.recurring.some((r) => r.wageType === w.key))
    .map((w) => [w.key, `${labelOf(d?.groups.find((g) => g.key === w.group)?.label)} · ${labelOf(w.label, w.key)}`] as const);
  const [f, setF] = useState<Form>({ wageType: options[0]?.[0] ?? '', validFrom: defaultFrom });
  const w = settings.wageTypes.find((x) => x.key === f.wageType);
  const spec = recurringSpec(w?.input === 'quantity');
  const card = useBackdated(nav);
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    await card.send((how) => payrollApi.addEntry({ path: `employees/${e.id}/recurring/${f.wageType}`, validFrom: f.validFrom, value: spec.to(f) }, how), () => setOpen(false));
  };
  if (!open) return <button type="button" className="btn ghost" onClick={() => setOpen(true)}>{t('payroll.employee.addRecurring')}</button>;
  return (
    <>
      <AsyncForm className="form inline pform" onSubmit={save}>
        <Fields fields={[{ k: 'wageType', label: t('payroll.field.wageType'), type: 'select', options, wide: true }, ...spec.fields, { k: 'validFrom', label: t('payroll.dated.validFrom'), type: 'date' }]} f={f} set={setF} />
        <div className="acts"><AsyncButton type="submit" className="btn primary">{t('common.save')}</AsyncButton><button type="button" className="btn ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button></div>
      </AsyncForm>
      {card.node}
    </>
  );
}

// ─── «Person hinzufügen» ───────────────────────────────────────────────────────

function NewEmployee({ settings, nav }: Props & { settings: SettingsView }) {
  const [f, setF] = useState<Form>({ language: 'de', kind: 'monthly', pensum: '100', country: 'CH', validFrom: `${localToday().slice(0, 4)}-01-01`, isOwner: 'false' });
  const card = useBackdated(nav);
  const person: FieldDef[] = [
    { k: 'first', label: t('payroll.field.first') }, { k: 'last', label: t('payroll.field.last') },
    { k: 'birthDate', label: t('payroll.field.birthDate'), type: 'date' },
    { k: 'sex', label: t('payroll.field.sex'), type: 'select', options: [['', '—'], ['f', t('payroll.sex.f')], ['m', t('payroll.sex.m')]] },
    { k: 'language', label: t('payroll.field.language'), type: 'select', options: LANGS.map((l) => [l, t(`payroll.lang.${l}`)] as const) },
    { k: 'nationality', label: t('payroll.field.nationality') },
    { k: 'socialSecurityNumber', label: t('payroll.field.ssn'), mono: true, hint: t('payroll.field.ssnHint') },
    { k: 'email', label: t('payroll.field.email') },
    { k: 'isOwner', label: t('payroll.employee.owner'), type: 'check' },
  ];
  const address = addressSpec().fields;
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const body = {
      first: f.first, last: f.last, birthDate: f.birthDate, sex: f.sex || undefined, language: f.language, nationality: f.nationality, email: f.email,
      socialSecurityNumber: f.socialSecurityNumber, isOwner: f.isOwner === 'true', validFrom: f.validFrom,
      employment: employmentOf(f),
      address: { street: f.street, number: f.number, postcode: f.postcode, town: f.town, country: f.country, canton: f.canton, municipality: f.municipality },
      bank: { iban: f.iban, holder: f.holder },
      insurances: insurancesOf(f, settings.insurances),
    };
    let id = '';
    const ok = await card.send(async (how) => { const r = await payrollApi.createEmployee(body, how); if (r.saved) id = r.id; return r; });
    if (ok && id) nav.go(at({ area: 'payroll', view: 'employees', id }));
  };
  return (
    <div className="detail-in person">
      <div className="head"><h2 className="who">{t('payroll.employee.add')}<small>{t('payroll.employee.addLead')}</small></h2></div>
      <AsyncForm className="form pnew" onSubmit={save}>
        <Section title={t('payroll.sec.person')}><div className="form inline pform"><Fields fields={person} f={f} set={setF} /></div></Section>
        <Section title={t('payroll.sec.employment')}><div className="form inline pform"><Fields fields={[{ k: 'validFrom', label: t('payroll.field.entry'), type: 'date' }, ...employmentFields()]} f={f} set={setF} /></div></Section>
        <Section title={t('payroll.sec.address')}><div className="form inline pform"><Fields fields={address} f={f} set={setF} /></div></Section>
        <Section title={t('payroll.sec.bank')}><div className="form inline pform"><Fields fields={bankSpec().fields} f={f} set={setF} /></div></Section>
        <Section title={t('payroll.sec.insurances')}>
          {settings.insurances.length ? <div className="form inline pform"><Fields fields={insuranceFields(settings.insurances)} f={f} set={setF} /></div>
            : <p className="m">{t('payroll.employee.insurancesLater')}</p>}
        </Section>
        <div className="acts"><AsyncButton type="submit" className="btn primary">{t('payroll.employee.create')}</AsyncButton><button type="button" className="btn ghost" onClick={() => nav.go(at({ area: 'payroll', view: 'employees' }))}>{t('common.cancel')}</button></div>
      </AsyncForm>
      {card.node}
    </div>
  );
}

