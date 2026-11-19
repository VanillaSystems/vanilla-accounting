/**
 * The tax at source in Löhne (docs/specs/payroll.md §3f, phase B2): the tariff files in Einstellungen ›
 * Sozialversicherungen (each canton and year the workspace has, the version and its date, «Tarif laden»
 * for each canton a person needs, or any canton and year, or a file the person downloaded herself), the
 * button «Tarif laden» beside a payslip's line «unvollständig», and the settlement lists per canton and
 * month in Dokumente with their CSV. A new file a closed payslip would compute otherwise shows the card of
 * §19.3 first («Rückwirkende Korrektur», «So lassen»). No AI: every action is a form.
 */
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { baseCurrency } from '../../../engines/index.js';
import { t } from '../../i18n/index.js';
import { apiFetch, ApiError, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import type { ApiErrorBody } from '../../../types/api-error.js';
import type { Nav } from '../index.js';
import { files, payrollApi, urls, usePayroll, type Backdated, type Settlements, type TariffLoaded, type Tariffs } from './data.js';
import { Disclaimer, Go, payslipAt } from './common.js';
import { Fields, useBackdated, type Form } from './Dated.js';
import { localWhen, monthText, pct } from './words.js';

/** Sends a file the person picked as the region's tariff of a year. */
async function uploadTariff(region: string, year: string, file: File, backdated?: Backdated): Promise<TariffLoaded> {
  const res = await apiFetch(`/api/payroll/tariffs/${region}/${year}/file${backdated ? `?backdated=${backdated}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(err?.error ? err : { error: `HTTP ${res.status}` });
  }
  return res.json() as Promise<TariffLoaded>;
}

/** What a load did, in a sentence. */
const loadedText = (r: Extract<TariffLoaded, { saved: true }>): string =>
  r.unchanged ? t('payroll.tax.unchanged', { region: r.region, year: r.year, date: formatDate(r.version.created) })
    : t('payroll.tax.loaded', { region: r.region, year: r.year, date: formatDate(r.version.created) });

/** «Tarif laden» for one canton and year: the card of §19.3 first when a closed payslip would change. */
export function LoadTariff({ region, year, nav, label, primary }: { region: string; year: string; nav: Nav; label?: string; primary?: boolean }) {
  const card = useBackdated(nav);
  // The answer's own words after the save's («Tarif ZH 2026 vom 08.12.2025 geladen»).
  let last: TariffLoaded | undefined;
  const load = () => card.send(async (how) => (last = await payrollApi.loadTariff(region, year, how)), () => { if (last?.saved) nav.toast(loadedText(last)); });
  return (
    <>
      <AsyncButton type="button" className={`btn${primary ? ' primary' : ''}`} data-testid="load-tariff" onClick={load}>{label ?? t('payroll.tax.load', { region, year })}</AsyncButton>
      {card.node}
    </>
  );
}

/** Einstellungen › Sozialversicherungen: the tariff files, and loading one. */
export function TariffFiles({ nav, canEdit }: { nav: Nav; canEdit: boolean }) {
  const load = usePayroll<Tariffs>(urls.tariffs);
  const [f, setF] = useState<Form>({ region: '', year: localToday().slice(0, 4) });
  const [file, setFile] = useState<File | null>(null);
  const card = useBackdated(nav);
  if (load.state !== 'ready') return load.state === 'failed' ? <p className="m">{errorText(load.error)}</p> : null;
  const v = load.data;
  const current = (region: string, year: string) => v.files.find((x) => x.region === region && x.year === year);
  const missing = v.needed.filter((r) => !current(r, v.year));
  const annual = new Set(v.regions.filter((r) => r.model === 'annual').map((r) => r.region));
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const region = f.region.trim().toUpperCase(); const year = f.year.trim();
    let last: TariffLoaded | undefined;
    await card.send(async (how) => (last = file ? await uploadTariff(region, year, file, how) : await payrollApi.loadTariff(region, year, how)),
      () => { if (last?.saved) { nav.toast(loadedText(last)); setFile(null); } });
  };
  return (
    <div className="pcard ptax" data-testid="tariff-files">
      <div className="inshead"><b>{t('payroll.tax.title')}</b><span className="m">{t('payroll.tax.lead')}</span></div>
      {missing.length ? (
        <div className="notice warn" role="note">
          {t('payroll.tax.missing', { list: missing.join(', '), year: v.year })}
          {canEdit ? <div className="acts">{missing.map((r) => <LoadTariff key={r} region={r} year={v.year} nav={nav} primary />)}</div> : null}
        </div>
      ) : null}
      {v.needed.filter((r) => annual.has(r)).length ? <p className="notice" role="note">{t('payroll.tax.annual', { list: v.needed.filter((r) => annual.has(r)).join(', ') })}</p> : null}
      {v.files.length ? (
        <div className="ftab ptariffs" role="table" aria-label={t('payroll.tax.title')}>
          <div className="fh" role="row"><span>{t('payroll.tax.region')}</span><span>{t('payroll.tax.year')}</span><span>{t('payroll.tax.created')}</span><span>{t('payroll.tax.fetched')}</span><span>{t('payroll.tax.version')}</span><span /></div>
          {v.files.map((x) => {
            const cur = x.versions.find((y) => y.sha256 === x.current);
            const older = x.versions.filter((y) => y.sha256 !== x.current);
            return (
              <div key={`${x.region}-${x.year}`} className="fr" role="row" data-tariff={`${x.region}-${x.year}`}>
                <span className="mono">{x.region}</span>
                <span className="mono">{x.year}</span>
                <span>{cur ? formatDate(cur.created) : t('payroll.tax.notCurrent')}</span>
                <span>{cur ? localWhen(cur.fetchedAt).at : ''}</span>
                <span className="mono" data-tip={cur?.sha256}>{cur ? cur.sha256.slice(0, 12) : ''}{older.length ? <small className="m"> · {t('payroll.tax.olderN', { n: older.length })}</small> : null}</span>
                <span>{canEdit ? <LoadTariff region={x.region} year={x.year} nav={nav} label={t('payroll.tax.reload')} /> : null}</span>
              </div>
            );
          })}
        </div>
      ) : <p className="m">{t('payroll.tax.none')}</p>}
      {canEdit ? (
        <AsyncForm className="form inline pform" onSubmit={send}>
          <Fields fields={[
            { k: 'region', label: t('payroll.tax.region'), type: 'select', options: [['', '—'], ...v.regions.map((r) => [r.region, r.region] as const)] },
            { k: 'year', label: t('payroll.tax.year'), mono: true },
          ]} f={f} set={setF} />
          <label className="wide">{t('payroll.tax.file')}
            <input type="file" accept=".txt,.zip" onChange={(e: ChangeEvent<HTMLInputElement>) => setFile(e.target.files?.[0] ?? null)} />
            <span className="fhint">{t('payroll.tax.fileHint')}</span>
          </label>
          <div className="acts"><AsyncButton type="submit" className="btn">{file ? t('payroll.tax.upload') : t('payroll.tax.fetch')}</AsyncButton></div>
        </AsyncForm>
      ) : null}
      {card.node}
      <p className="m">{t('payroll.tax.source')}{v.page ? <> · <a className="clink" href={v.page} target="_blank" rel="noreferrer">{t('payroll.tax.page')}</a></> : null}</p>
    </div>
  );
}

/** Dokumente › Quellensteuer: the settlement list per month and canton, from the closed payslips. */
export function SettlementsView({ year, nav }: { year: string; nav: Nav }) {
  const load = usePayroll<Settlements>(urls.settlements(year));
  if (load.state === 'failed') return <div className="detail-empty"><div>{errorText(load.error)}</div></div>;
  if (load.state !== 'ready') return <div className="detail-empty"><div>{t('app.loading')}</div></div>;
  const lists = load.data.settlements;
  return (
    <div className="detail-in pdocv" data-testid="settlements">
      <div className="head"><h2 className="who">{t('payroll.docs.taxAtSource')}<small>{t('payroll.docs.taxAtSourceLead', { year })}</small></h2></div>
      <div className="docbody">
        {!lists.length ? <p className="m pfact">{t('payroll.tax.noSettlement', { year })}</p> : (
          <p className="acts"><a className="clink" href={files.settlementCsv(year)} target="_blank" rel="noreferrer">{t('payroll.tax.yearCsv', { year })}</a></p>
        )}
        {lists.map((s) => (
          <div key={`${s.month}-${s.region}`} className="psec" data-settlement={`${s.month}-${s.region}`}>
            <h3>{t('payroll.tax.listTitle', { month: monthText(s.month), region: s.region })}</h3>
            <p className="m">{[s.insurer ? `${s.insurer.name}${s.insurer.customerNumber ? ` · ${t('payroll.insurances.customerNumber')} ${s.insurer.customerNumber}` : ''}` : '', s.files.length ? t('payroll.tax.files', { list: s.files.map(formatDate).join(', ') }) : ''].filter(Boolean).join(' · ')}</p>
            <div className="ftab psettle" role="table" aria-label={t('payroll.tax.listTitle', { month: monthText(s.month), region: s.region })}>
              <div className="fh" role="row">
                <span>{t('payroll.tax.person')}</span><span>{t('payroll.tax.code')}</span><span className="r">{t('payroll.tax.wage')}</span><span className="r" data-tip={t('payroll.tax.rateIncomeLong')}>{t('payroll.tax.rateIncome')}</span><span className="r">{t('payroll.tax.rate')}</span><span className="r">{t('payroll.tax.tax')}</span><span className="r">{t('payroll.tax.commission')}</span>
              </div>
              {s.rows.map((r) => (
                <div key={`${r.payslip}-${r.corrects ?? ''}`} className={`fr${r.corrects ? ' corr' : ''}`} role="row" data-corrects={r.corrects}>
                  <span><Go loc={payslipAt(r.payslip)} nav={nav}>{r.name}</Go>{r.corrects ? <small className="m"> · {t('payroll.tax.corrects', { list: monthText(r.corrects) })}</small> : null}</span>
                  <span className="mono">{r.code ?? ''}</span>
                  <span className="r mono">{r.wage !== undefined && (r.wage || r.corrects) ? fmt(r.wage) : ''}</span>
                  <span className="r mono">{r.income !== undefined ? fmt(r.income) : ''}</span>
                  <span className="r mono">{r.rate !== undefined ? pct(r.rate) : ''}</span>
                  <span className="r mono">{fmt(r.tax)}</span>
                  <span className="r mono">{fmt(r.commission)}</span>
                </div>
              ))}
              <div className="fr tot" role="row">
                <span>{t('payroll.tax.total')}</span><span /><span className="r mono">{fmt(s.totals.wage)}</span><span /><span />
                <span className="r mono">{fmt(s.totals.tax)}</span><span className="r mono">{fmt(s.totals.commission)}</span>
              </div>
            </div>
            {s.rows.some((r) => r.corrects) ? <p className="m">{t('payroll.tax.correctionRows')}</p> : null}
            <p className="ppay"><b>{t('payroll.tax.payable', { currency: baseCurrency(), amount: fmt(s.totals.payable) })}</b> · <a className="clink" href={files.settlementCsv(year, s.month, s.region)} target="_blank" rel="noreferrer">{t('export.fmt.csv')}</a></p>
          </div>
        ))}
        <Disclaimer year={year} />
      </div>
    </div>
  );
}
