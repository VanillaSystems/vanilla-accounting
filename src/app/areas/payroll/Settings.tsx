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
import { payrollApi, reloadPayroll, urls, usePayroll, type KeptItem, type SettingsView, type SetupCard, type SetupCards } from './data.js';
import { hrefOf } from '../../shell/history.js';
import { at } from '../receipts/view.js';
import { Tabs, type PayrollRoute } from './common.js';
import { DatedField, Fields, numberOf, useBackdated, type FieldDef, type Form, type ValueSpec } from './Dated.js';
import { data, kindLabel, labelOf, lang, pct, rateLabel } from './words.js';
import { TariffFiles } from './TaxAtSource.js';

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
      <DatedField label={t('payroll.company.holidayBasis')} path="company/holidayBasis" history={c.holidayBasis}
        spec={selectSpec(t('payroll.company.holidayBasis'), [['wage', t('payroll.company.holidayWage')], ['wage-with-surcharge', t('payroll.company.holidayWithSurcharge')]] as const)} {...common}
        note={!c.holidayBasis?.length ? t('payroll.company.default', { value: t('payroll.company.holidayWage') }) : t('payroll.company.holidayBasisNote')} />
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
      <DocumentCards nav={nav} canEdit={canEdit} />
      {v.insurances.map((i) => <InsuranceCard key={i.id} i={i} v={v} nav={nav} canEdit={canEdit} />)}
      {canEdit ? (adding ? <NewInsurance v={v} nav={nav} onDone={() => setAdding(false)} /> : <button type="button" className="btn" onClick={() => setAdding(true)}>{t('payroll.insurances.add')}</button>) : null}
      {d?.taxAtSource ? <TariffFiles nav={nav} canEdit={canEdit} /> : null}
    </>
  );
}

/**
 * The funds' and insurers' documents in Belege, each a card of what it proposes (§6.1 step 2, src/payroll/setup-documents.ts):
 * what code read and what the AI added, each field marked so and editable; «Übernehmen» writes it as the forms do, naming the
 * document; nothing counts before. Without an AI the card holds what code read, and the forms below do the rest.
 */
function DocumentCards({ nav, canEdit }: { nav: Nav; canEdit: boolean }) {
  const load = usePayroll<SetupCards>(urls.setupCards);
  if (load.state !== 'ready' || !load.data.cards.length) return null;
  return (
    <div className="psetup" data-testid="setup-cards">
      <h4>{t('payroll.setup.title')}</h4>
      <p className="m">{t('payroll.setup.lead')}</p>
      {load.data.cards.map((c) => <DocumentCard key={`${c.receipt}:${c.asked}`} c={c} ai={load.data.ai} nav={nav} canEdit={canEdit} />)}
    </div>
  );
}

const yearStart = (date: string | undefined) => `${(date ?? localToday()).slice(0, 4)}-01-01`;

function DocumentCard({ c, ai, nav, canEdit }: { c: SetupCard; ai: boolean; nav: Nav; canEdit: boolean }) {
  const d = data();
  const start: Form = {};
  c.items.forEach((p, n) => {
    for (const k of ['name', 'memberNumber', 'contractNumber', 'code'] as const) start[`${n}.${k}`] = p[k] ?? '';
    for (const k of Object.keys(d?.insurances[p.kind]?.rates ?? {})) start[`${n}.rates.${k}`] = p.rates[k] === undefined ? '' : String(p.rates[k]);
    if (d?.insurances[p.kind]?.perPerson) { start[`${n}.person`] = p.person?.name ?? ''; start[`${n}.employee`] = p.person?.employee === undefined ? '' : String(p.person.employee); start[`${n}.employer`] = p.person?.employer === undefined ? '' : String(p.person.employer); }
    start[`${n}.validFrom`] = yearStart(c.date);
  });
  const [f, setF] = useState<Form>(start);
  const card = useBackdated(nav);
  const by = (p: SetupCard['items'][number], k: string) => (p.by[k] === 'code' ? t('payroll.setup.byCode') : p.by[k] === 'ai' ? t('payroll.setup.byAi') : '');
  const fieldsOf = (p: SetupCard['items'][number], n: number): FieldDef[] => [
    { k: `${n}.name`, label: labelOf(d?.insurances[p.kind]?.nameOf, t('payroll.insurances.name')), wide: true, hint: by(p, 'name') },
    { k: `${n}.memberNumber`, label: t('payroll.insurances.memberNumber'), mono: true, hint: by(p, 'memberNumber') },
    { k: `${n}.contractNumber`, label: t('payroll.insurances.contractNumber'), mono: true, hint: by(p, 'contractNumber') },
    ...(d?.insurances[p.kind]?.perPerson ? [
      { k: `${n}.person`, label: t('payroll.setup.person'), hint: by(p, 'person') },
      { k: `${n}.employee`, label: t('payroll.setup.employee'), type: 'number' as const },
      { k: `${n}.employer`, label: t('payroll.setup.employer'), type: 'number' as const },
    ] : [
      { k: `${n}.code`, label: t('payroll.insurances.code'), mono: true, hint: by(p, 'code') },
      ...Object.keys(d?.insurances[p.kind]?.rates ?? {}).map((k) => ({ k: `${n}.rates.${k}`, label: `${rateLabel(p.kind, k)} (%)`, type: 'number' as const, hint: [by(p, `rates.${k}`), rangeHint(p.kind, k)].filter(Boolean).join(' · ') })),
    ]),
    { k: `${n}.validFrom`, label: t('payroll.dated.validFrom'), type: 'date' },
  ];
  const itemsOf = (): KeptItem[] => c.items.map((p, n) => {
    const v = (k: string) => f[`${n}.${k}`]?.trim() || undefined;
    const rates = Object.fromEntries(Object.keys(d?.insurances[p.kind]?.rates ?? {}).flatMap((k) => (numberOf(f[`${n}.rates.${k}`]) === undefined ? [] : [[k, numberOf(f[`${n}.rates.${k}`])!]])));
    const person = v('person') ? { name: v('person')!, ...(numberOf(f[`${n}.employee`]) !== undefined ? { employee: numberOf(f[`${n}.employee`]) } : {}), ...(numberOf(f[`${n}.employer`]) !== undefined ? { employer: numberOf(f[`${n}.employer`]) } : {}) } : undefined;
    return { kind: p.kind, name: v('name'), memberNumber: v('memberNumber'), contractNumber: v('contractNumber'), code: v('code'), rates, validFrom: f[`${n}.validFrom`] || yearStart(c.date), ...(person ? { person } : {}) };
  });
  const keep = async (e: FormEvent) => {
    e.preventDefault();
    await card.send(async (how) => {
      const r = await payrollApi.keepSetupCard(c.receipt, itemsOf(), how);
      if (r.saved && r.persons.length) nav.toast(t('payroll.setup.personMissing', { list: r.persons.join(', ') }));
      return r;
    });
  };
  const act = async (call: () => Promise<unknown>) => { try { await call(); await reloadPayroll(); } catch (err) { nav.toast(errorText(err)); } };
  const missing = c.items.flatMap((p) => p.missing);
  const doc = at({ area: 'receipts', id: c.receipt }, c.date);
  return (
    <div className="pcard setupcard" data-receipt={c.receipt}>
      <div className="inshead">
        <a className="golink" href={hrefOf(doc)} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); nav.go(doc); }}>{c.filename}</a>
        <span className="m">{c.items.map((p) => kindLabel(p.kind)).join(' · ')}{c.date ? ` · ${formatDate(c.date)}` : ''}</span>
      </div>
      {c.items.some((p) => p.exists) ? <p className="m">{t('payroll.setup.exists')}</p> : null}
      <AsyncForm className="form inline pform" onSubmit={keep}>
        {c.items.map((p, n) => (
          <div key={`${p.kind}-${n}`} className="wide setupitem">
            {c.items.length > 1 ? <b>{kindLabel(p.kind)}</b> : null}
            <Fields fields={fieldsOf(p, n)} f={f} set={setF} />
          </div>
        ))}
        {missing.length ? <p className="m wide">{ai ? (c.asked ? t('payroll.setup.missingAsked') : t('payroll.setup.missingAi')) : t('payroll.setup.missingNoAi')}</p> : null}
        {canEdit ? (
          <div className="acts">
            <AsyncButton type="submit" className="btn primary">{t('payroll.setup.keep')}</AsyncButton>
            {ai && missing.length && !c.asked ? <AsyncButton type="button" className="btn" onClick={() => act(() => payrollApi.readSetupCard(c.receipt))}>{t('payroll.setup.askAi')}</AsyncButton> : null}
            <AsyncButton type="button" className="btn ghost" onClick={() => act(() => payrollApi.dismissSetupCard(c.receipt))}>{t('payroll.setup.dismiss')}</AsyncButton>
          </div>
        ) : null}
      </AsyncForm>
      {card.node}
    </div>
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
  const save = async (e: FormEvent) => { e.preventDefault(); await card.send((how) => payrollApi.patchInsurance(i.id, f, how), () => setEdit(false)); };
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
      <KindAccounts kind={i.kind} v={v} nav={nav} canEdit={canEdit} />
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

/**
 * The accounts an insurance's contributions book on that the chart lacks (its liability account, its expense
 * account), offered beside it: «Konten anlegen» adds them at once, as Konten does for each.
 */
function KindAccounts({ kind, v, nav, canEdit }: { kind: string; v: SettingsView; nav: Nav; canEdit: boolean }) {
  const own = new Set((data()?.contributions ?? []).filter((c) => c.insurance === kind).map((c) => c.wageType));
  const missing = v.accounts.filter((a) => !a.exists && a.wageTypes.some((k) => own.has(k)));
  if (!missing.length) return null;
  const add = async () => {
    try {
      for (const a of missing) await payrollApi.addAccount(a.number);
      nav.toast(t('payroll.accounts.addedN', { list: missing.map((a) => a.number).join(', ') }));
      await reloadPayroll(); nav.refresh();
    } catch (e) { nav.toast(errorText(e)); }
  };
  return (
    <div className="notice warn" data-testid="kind-accounts">
      {t('payroll.insurances.accountsMissing', { list: missing.map((a) => `${a.number}${a.name ? ` ${a.name}` : ''}`).join(', ') })}
      {canEdit ? <> <AsyncButton type="button" className="btn" onClick={add}>{t('payroll.insurances.addAccounts')}</AsyncButton></> : null}
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
    { k: 'name', label: labelOf(d?.insurances[kind]?.nameOf, t('payroll.insurances.name')), wide: true },
    { k: 'memberNumber', label: t('payroll.insurances.memberNumber'), mono: true }, { k: 'contractNumber', label: t('payroll.insurances.contractNumber'), mono: true },
    { k: 'account', label: t('payroll.insurances.account'), mono: true, hint: t('payroll.insurances.accountHint', { account: d?.insurances[kind]?.account ?? '' }) },
    { k: 'validFrom', label: t('payroll.dated.validFrom'), type: 'date' },
    // A tariff kind's solution is a canton (its code: ZH), its rate the commission where the firm's differs from the file's.
    ...(d?.insurances[kind]?.perPerson ? [] : [{ k: 'code', label: t(d?.insurances[kind]?.tariff ? 'payroll.tax.regionCode' : 'payroll.insurances.code'), mono: true }, ...ratesSpec(kind).fields]),
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
  const card = useBackdated(nav);
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
    const copy = edit.copy; const key = edit.key;
    await card.send((how) => (copy ? payrollApi.copyWageType({ copyOf: key, ...body }, how) : payrollApi.setWageType(key, body, how)), () => setEdit(null));
  };
  const remove = (key: string) => card.send((how) => payrollApi.removeWageType(key, how));
  const fields: FieldDef[] = [
    { k: 'label', label: t('payroll.wageTypes.label'), wide: true },
    { k: 'debit', label: t('payroll.booking.debit'), mono: true }, { k: 'credit', label: t('payroll.booking.credit'), mono: true },
    { k: 'lohnausweis', label: t('payroll.wageTypes.field'), mono: true },
  ];
  return (
    <>
      <p className="lead">{t('payroll.wageTypes.lead')}</p>
      {card.node}
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

