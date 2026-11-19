/**
 * Löhne › Dokumente (docs/specs/payroll.md §5.6, §6.7, §12.1): per year each person's Lohnausweis (its
 * figures by the form's fields, the months still open, «Lohnausweis erstellen», later «ersetzen» or
 * «korrigieren», each issue kept with its PDF), the Lohnkonto of every Lohnart per month, the figures of the
 * annual declarations, the month's Lohnbuchungen, and the CSV of each. The form's words come from the
 * jurisdiction's payroll.yaml in the UI's language; an open month warns in the page, then the person decides.
 */
import { useEffect, useState } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { baseCurrency } from '../../../engines/index.js';
import { t } from '../../i18n/index.js';
import { errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { ListHead } from '../../shell/ListHead.js';
import { PAYROLL_DOCUMENTS, type PayrollDocument } from '../../shell/route.js';
import type { AreaProps, Nav } from '../index.js';
import { files, payrollApi, reloadPayroll, urls, usePayroll, type Documents, type Issued, type LohnausweisData, type SettingsView } from './data.js';
import { Disclaimer, documentAt, employeeAt, Go, payslipAt, Tabs, YearSwitch, type PayrollRoute } from './common.js';
import { data, labelOf, localWhen, monthShort, monthText } from './words.js';

type Props = AreaProps<PayrollRoute>;

export const documentYear = (route: PayrollRoute): string => (route.view === 'documents' && route.year) || localToday().slice(0, 4);
const isDocument = (d: string | undefined): d is PayrollDocument => (PAYROLL_DOCUMENTS as readonly (string | undefined)[]).includes(d);

/** The rows the list shows, in order: each person by her id, then the firm's documents. */
export const listedDocuments: { ids: string[] } = { ids: [] };

/** A file the server hands out: a plain link, opened beside the app. */
const FileLink = ({ href, children }: { href: string; children: string }) => <a className="clink" href={href} target="_blank" rel="noreferrer">{children}</a>;

const KIND = { original: 'payroll.docs.kind.original', replacement: 'payroll.docs.kind.replacement', correction: 'payroll.docs.kind.correction' } as const;

// ─── the list ──────────────────────────────────────────────────────────────────

export function DocumentList(props: Props) {
  const { route, nav } = props;
  const year = documentYear(route);
  const load = usePayroll<Documents>(urls.documents(year));
  const selected = route.view === 'documents' ? route.doc : undefined;
  const d = load.state === 'ready' ? load.data : undefined;
  listedDocuments.ids = d ? [...d.people.map((p) => p.employee), ...PAYROLL_DOCUMENTS] : [];
  const first = listedDocuments.ids[0];
  useEffect(() => { if (!selected && first) nav.select({ area: 'payroll', view: 'documents', year, doc: first }); }, [selected, first, year]);
  const pick = (doc: string) => nav.select({ area: 'payroll', view: 'documents', year, doc });
  const row = (doc: string, state: { cls: string; text: string } | null, title: string, sub: string, side: string) => {
    const sel = doc === selected;
    return (
      <div key={doc} className={`row pdoc${state ? '' : ' firm'}${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-doc={doc} onClick={() => pick(doc)}>
        {state ? <span className={`d pstate ${state.cls}`}>{state.text}</span> : null}
        <span className="t">{title}{sub ? <small>{sub}</small> : null}</span>
        <span className="a mono">{side}</span>
      </div>
    );
  };
  return (
    <div className="page">
      <ListHead {...props}><div className="counts"><Tabs on="documents" nav={nav} /></div></ListHead>
      <div className="plist">
        <YearSwitch year={year} onYear={(y) => nav.go(documentAt(y))} />
        {!d ? <div className="empty"><p>{load.state === 'failed' ? errorText(load.error) : t('app.loading')}</p></div> : (
          <>
            <h3 className="plabel">{t('payroll.docs.lohnausweise')}</h3>
            {!d.people.length ? <p className="m pfact">{t('payroll.docs.nobody', { year })}</p> : (
              <div className="rows" role="listbox" aria-label={t('payroll.docs.lohnausweise')}>
                {d.people.map((p) => {
                  const issued = d.issued.filter((s) => s.employee === p.employee);
                  const state = issued.length ? { cls: 'closed', text: t('payroll.docs.issued') }
                    : p.lohnausweis.openMonths.length ? { cls: 'draft', text: t('payroll.docs.openN', { n: p.lohnausweis.openMonths.length }) }
                    : { cls: 'active', text: t('payroll.docs.ready') };
                  return row(p.employee, state, p.name, t('payroll.docs.field8'), fmt(p.lohnausweis.fields['8'] ?? 0));
                })}
              </div>
            )}
            <h3 className="plabel">{t('payroll.docs.firm')}</h3>
            <div className="rows" role="listbox" aria-label={t('payroll.docs.firm')}>
              {row('lohnkonto', null, t('payroll.docs.lohnkonto'), t('payroll.docs.lohnkontoSub'), fmt(d.lohnkonto.totals.gross.total))}
              {row('declarations', null, t('payroll.docs.declarations'), t('payroll.docs.declarationsSub'), String(d.declarations.length))}
              {row('journal', null, t('payroll.docs.journal'), t('payroll.docs.journalSub'), '')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── the detail ────────────────────────────────────────────────────────────────

export function DocumentDetail(props: Props) {
  const { route } = props;
  const year = documentYear(route);
  const load = usePayroll<Documents>(urls.documents(year));
  const settings = usePayroll<SettingsView>(urls.settings);
  const doc = route.view === 'documents' ? route.doc : undefined;
  if (!doc) return <div className="detail-empty"><div>{t('payroll.docs.noneSelected')}</div></div>;
  if (load.state === 'failed') return <div className="detail-empty"><div>{errorText(load.error)}</div></div>;
  if (settings.state === 'failed') return <div className="detail-empty"><div>{errorText(settings.error)}</div></div>;
  if (load.state !== 'ready' || settings.state !== 'ready') return <div className="detail-empty"><div>{t('app.loading')}</div></div>;
  const d = load.data;
  const labels = new Map(settings.data.wageTypes.map((w) => [w.key, labelOf(w.label, w.key)]));
  if (doc === 'lohnkonto') return <LohnkontoView d={d} labels={labels} />;
  if (doc === 'declarations') return <DeclarationsView d={d} nav={props.nav} />;
  if (doc === 'journal') return <JournalView d={d} />;
  const person = d.people.find((p) => p.employee === doc);
  if (!person || isDocument(doc)) return <div className="detail-empty"><div>{t('payroll.docs.gone', { year })}</div></div>;
  return <LohnausweisView key={`${year}-${doc}`} {...props} d={d} person={person} labels={labels} />;
}

function Head({ title, lead, amount }: { title: string; lead: string; amount?: number }) {
  return (
    <div className="head">
      <h2 className="who">{title}<small>{lead}</small></h2>
      {amount !== undefined ? <div className="amount"><small>{baseCurrency()}</small>{fmt(amount)}</div> : null}
    </div>
  );
}

/** The form's fields with a figure, the sums always, in the module's order and words. */
function FormFields({ l }: { l: LohnausweisData }) {
  const form = data()?.lohnausweis;
  if (!form) return null;
  const shown = form.fields.filter((f) => !f.remark && (f.sum || (l.fields[f.key] ?? 0) !== 0));
  return (
    <div className="ftab pla" role="table" aria-label={labelOf(form.title)}>
      {shown.map((f) => (
        <div key={f.key} className={`fr${f.sum ? ' tot' : ''}`} role="row">
          <span className="mono">{f.key}</span><span>{labelOf(f.label)}</span><span className="r mono">{f.deduction && l.fields[f.key] ? `−${fmt(l.fields[f.key])}` : fmt(l.fields[f.key] ?? 0)}</span>
        </div>
      ))}
      {l.remarks.length ? (
        <div className="fr" role="row">
          <span className="mono">15</span><span>{labelOf(form.fields.find((f) => f.remark)?.label)}: {l.remarks.map((r) => `${r.label} ${fmt(r.amount)}`).join(', ')}</span><span />
        </div>
      ) : null}
    </div>
  );
}

function LohnausweisView({ d, person, labels, nav, canEdit }: Props & { d: Documents; person: Documents['people'][number]; labels: Map<string, string> }) {
  const l = person.lohnausweis;
  const issued = d.issued.filter((s) => s.employee === person.employee);
  const title = labelOf(data()?.lohnausweis?.title, t('payroll.docs.lohnausweis'));
  return (
    <div className="detail-in plohnausweis" data-for={person.employee}>
      <Head title={person.name} lead={`${title} ${d.year}`} amount={l.fields['8'] ?? 0} />
      <div className="facts">
        <span>{l.from && l.to ? t('payroll.docs.span', { from: formatDate(l.from), to: formatDate(l.to) }) : t('payroll.docs.noSpan')}</span>
        <span><Go nav={nav} loc={employeeAt(person.employee)}>{t('payroll.docs.person')}</Go></span>
      </div>
      <div className="pfacts">
        {l.openMonths.length ? (
          <div className="notice warn" data-testid="open-months">
            {t('payroll.docs.openMonths', { months: l.openMonths.map(monthShort).join(', ') })} · <Go nav={nav} loc={payslipAt(`${l.openMonths[0]}-${person.employee}`)}>{monthText(l.openMonths[0])}</Go>
          </div>
        ) : null}
        {l.unmapped?.length ? <div className="notice warn">{t('payroll.docs.unmapped', { list: l.unmapped.map((k) => labels.get(k) ?? k).join(', ') })}</div> : null}
        {d.copyToTaxOffice ? <div className="notice" data-testid="copy-tax-office">{t('payroll.docs.copyToTaxOffice')}</div> : null}
        {l.opening ? (
          <div className="notice" data-testid="lohnausweis-opening">
            {t('payroll.docs.openingFields', { through: l.opening.through ? monthText(l.opening.through) : '—', list: Object.entries(l.opening.fields).map(([k, v]) => `${k}: ${fmt(v)}`).join(', ') || '—' })}
          </div>
        ) : null}
      </div>
      <div className="docbody">
        <FormFields l={l} />
        <Disclaimer year={d.year} />
        {canEdit ? <Issue d={d} person={person} issued={issued} nav={nav} /> : null}
        <div className="psec">
          <h3>{t('payroll.docs.issuedTitle')}</h3>
          {!issued.length ? <p className="m">{t('payroll.docs.issuedNone')}</p> : (
            <ul className="plain" data-testid="issued">
              {[...issued].reverse().map((s) => <IssuedLine key={s.id} s={s} />)}
            </ul>
          )}
        </div>
        <div className="psec">
          <h3>{t('payroll.docs.tables')}</h3>
          <p className="plinks">
            <FileLink href={files.lohnkontoCsv(d.year, person.employee)}>{t('payroll.docs.lohnkontoCsvOf', { name: person.name })}</FileLink>
            <FileLink href={files.lohnausweisCsv(d.year)}>{t('payroll.docs.lohnausweisCsv')}</FileLink>
          </p>
        </div>
      </div>
    </div>
  );
}

function IssuedLine({ s }: { s: Issued }) {
  const { at, time } = localWhen(s.issuedAt);
  return (
    <li>
      <b>{t(KIND[s.kind])}</b> <span className="m">· {t('payroll.docs.issuedAt', { date: at, time })} · </span>
      <FileLink href={files.lohnausweisPdf(s.year, s.id)}>{t('payroll.slip.pdf')}</FileLink>
    </li>
  );
}

/** «Lohnausweis erstellen», later «ersetzen» (all figures again) or «korrigieren»; an open month warns first, as a panel (§18). */
function Issue({ d, person, issued, nav }: { d: Documents; person: Documents['people'][number]; issued: Issued[]; nav: Nav }) {
  const [warned, setWarned] = useState<{ kind?: 'replacement' | 'correction'; openMonths: string[]; noSocialSecurityNumber?: true } | null>(null);
  const run = async (kind: 'replacement' | 'correction' | undefined, confirm: boolean) => {
    try {
      const r = await payrollApi.issueLohnausweis(d.year, { employee: person.employee, ...(kind ? { kind } : {}), ...(confirm ? { confirm } : {}) });
      if ('issued' in r) { setWarned({ ...(kind ? { kind } : {}), openMonths: r.openMonths, ...(r.noSocialSecurityNumber ? { noSocialSecurityNumber: true as const } : {}) }); return; }
      setWarned(null);
      nav.toast(t('payroll.docs.done', { kind: t(KIND[r.kind]) }));
      await reloadPayroll();
    } catch (e) { nav.toast(errorText(e)); }
  };
  if (warned) {
    return (
      <div className="pcard warnpanel" role="alert" data-testid="issue-warning">
        {warned.noSocialSecurityNumber ? <p data-testid="issue-no-ssn">{t('payroll.docs.noSsn')} <Go nav={nav} loc={employeeAt(person.employee)}>{t('payroll.docs.person')}</Go></p> : null}
        {warned.openMonths.length ? (
          <>
            <h4>{t('payroll.docs.warnTitle')}</h4>
            <ul>{warned.openMonths.map((m) => <li key={m}><Go nav={nav} loc={payslipAt(`${m}-${person.employee}`)}>{monthText(m)}</Go></li>)}</ul>
            <p className="m">{t('payroll.docs.warnRule')}</p>
          </>
        ) : null}
        <div className="acts">
          <AsyncButton type="button" className="btn primary" onClick={() => run(warned.kind, true)}>{t('payroll.docs.anyway')}</AsyncButton>
          <button type="button" className="btn ghost" onClick={() => setWarned(null)}>{t('payroll.close.back')}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="psec pacts">
      <div className="acts">
        {!issued.length ? <AsyncButton type="button" className="btn primary" onClick={() => run(undefined, false)}>{t('payroll.docs.issue')}</AsyncButton> : (
          <>
            <AsyncButton type="button" className="btn" onClick={() => run('replacement', false)}>{t('payroll.docs.replace')}</AsyncButton>
            <AsyncButton type="button" className="btn" onClick={() => run('correction', false)}>{t('payroll.docs.correct')}</AsyncButton>
          </>
        )}
      </div>
      {issued.length ? <p className="m">{t('payroll.docs.replaceText')}</p> : null}
    </div>
  );
}

const MONTHS = (year: string) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

/** Every Lohnart of the firm's closed payslips per month, and the totals. */
function LohnkontoView({ d, labels }: { d: Documents; labels: Map<string, string> }) {
  const k = d.lohnkonto;
  const pd = data();
  // The months with a closed payslip; the CSV has all twelve.
  const shownMonths = MONTHS(d.year).map((m, i) => ({ m, i })).filter(({ i }) => k.rows.some((r) => r.months[i] !== 0));
  const totals = (['gross', 'net', 'payout', 'employer'] as const).map((key) => ({ key, label: labelOf(pd?.totals[key], key), ...k.totals[key] }));
  return (
    <div className="detail-in plohnkonto">
      <Head title={t('payroll.docs.lohnkonto')} lead={t('payroll.docs.lohnkontoLead', { year: d.year })} amount={k.totals.gross.total} />
      <div className="docbody wide">
        {!k.rows.length ? <p className="m">{t('payroll.docs.lohnkontoNone', { year: d.year })}</p> : (
          <div className="pscroll">
            <table className="ptable" aria-label={t('payroll.docs.lohnkonto')}>
              <thead><tr><th>{t('payroll.col.wageType')}</th>{shownMonths.map(({ m }) => <th key={m} className="r">{monthShort(m)}</th>)}<th className="r">{t('common.total')}</th></tr></thead>
              <tbody>
                {k.rows.map((r) => <tr key={r.wageType}><td>{labels.get(r.wageType) ?? r.label}</td>{shownMonths.map(({ i }) => <td key={i} className="r mono">{r.months[i] ? fmt(r.months[i]) : ''}</td>)}<td className="r mono">{fmt(r.total)}</td></tr>)}
                {totals.map((x) => <tr key={x.key} className="tot"><td>{x.label}</td>{shownMonths.map(({ i }) => <td key={i} className="r mono">{x.months[i] ? fmt(x.months[i]) : ''}</td>)}<td className="r mono">{fmt(x.total)}</td></tr>)}
              </tbody>
            </table>
          </div>
        )}
        {k.opening ? <OpeningTable bases={k.opening.bases} through={k.opening.people.flatMap((p) => p.through ?? []).sort().at(-1)} /> : null}
        <p className="plinks">
          <FileLink href={files.lohnkontoCsv(d.year)}>{t('payroll.docs.lohnkontoCsv')}</FileLink>
          {d.people.map((p) => <FileLink key={p.employee} href={files.lohnkontoCsv(d.year, p.employee)}>{t('payroll.docs.lohnkontoCsvOf', { name: p.name })}</FileLink>)}
        </p>
      </div>
    </div>
  );
}

/** The opening's bases (§22 decision 43): the months paid before payroll ran here, which have no Lohnart here. */
function OpeningTable({ bases, through }: { bases: Record<string, number>; through?: string }) {
  return (
    <div className="psec" data-testid="lohnkonto-opening">
      <h3>{t('payroll.docs.openingTitle', { through: through ? monthText(through) : '—' })}</h3>
      <p className="m">{t('payroll.docs.openingText')}</p>
      <table className="ptable" aria-label={t('payroll.docs.openingTitle', { through: through ? monthText(through) : '—' })}>
        <tbody>{Object.entries(bases).map(([k, v]) => <tr key={k}><td>{baseLabel(k)}</td><td className="r mono">{fmt(v)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

/** A base key in words: «AHV-Lohn», a capped one «ALV-Lohn (bis Höchstbetrag)». */
function baseLabel(key: string): string {
  const [base, cap] = key.split('|');
  const label = labelOf(data()?.bases.find((b) => b.key === base)?.label, base);
  return cap ? t('payroll.docs.capped', { label }) : label;
}

/** Per person each base of the year as the payslips kept it: what the funds' portals ask. */
function DeclarationsView({ d, nav }: { d: Documents; nav: Nav }) {
  const keys = [...new Set(d.declarations.flatMap((r) => Object.keys(r.bases)))].sort();
  return (
    <div className="detail-in pdeclarations">
      <Head title={t('payroll.docs.declarations')} lead={t('payroll.docs.declarationsLead', { year: d.year })} />
      <div className="docbody wide">
        {!d.declarations.length ? <p className="m">{t('payroll.docs.lohnkontoNone', { year: d.year })}</p> : (
          <div className="pscroll">
            <table className="ptable" aria-label={t('payroll.docs.declarations')}>
              <thead><tr><th>{t('payroll.docs.base')}</th>{d.declarations.map((r) => [<th key={r.employee} className="r"><Go nav={nav} loc={employeeAt(r.employee)}>{r.name}</Go></th>, r.opening ? <th key={`${r.employee}-o`} className="r m">{t('payroll.docs.ofOpening', { through: r.opening.through ? monthShort(r.opening.through) : '—' })}</th> : null])}</tr></thead>
              <tbody>
                <tr><td>{t('payroll.docs.spanCol')}</td>{d.declarations.map((r) => [<td key={r.employee} className="r mono">{r.from && r.to ? `${formatDate(r.from)}–${formatDate(r.to)}` : ''}</td>, r.opening ? <td key={`${r.employee}-o`} /> : null])}</tr>
                {keys.map((k) => <tr key={k}><td>{baseLabel(k)}</td>{d.declarations.map((r) => [<td key={r.employee} className="r mono">{fmt(r.bases[k] ?? 0)}</td>, r.opening ? <td key={`${r.employee}-o`} className="r mono m">{r.opening.bases[k] ? fmt(r.opening.bases[k]) : ''}</td> : null])}</tr>)}
              </tbody>
            </table>
          </div>
        )}
        <p className="m">{t('payroll.docs.declarationsText')}</p>
        <p className="plinks"><FileLink href={files.declarationsCsv(d.year)}>{t('payroll.docs.declarationsCsv')}</FileLink></p>
      </div>
    </div>
  );
}

/** The Lohnbuchungen of each month with closed payslips, as a CSV for a fiduciary who keeps the ledger elsewhere. */
function JournalView({ d }: { d: Documents }) {
  // Every month a closed payslip booked something in, a gross of zero too (an employer line, a correction).
  const ms = MONTHS(d.year).filter((_, i) => d.lohnkonto.rows.some((r) => r.months[i] !== 0) || Object.values(d.lohnkonto.totals).some((x) => x.months[i] !== 0));
  return (
    <div className="detail-in pjournal">
      <Head title={t('payroll.docs.journal')} lead={t('payroll.docs.journalLead', { year: d.year })} />
      <div className="docbody">
        {!ms.length ? <p className="m">{t('payroll.docs.lohnkontoNone', { year: d.year })}</p> : (
          <ul className="plain">
            {ms.map((m) => <li key={m}><FileLink href={files.journalCsv(m)}>{t('payroll.docs.journalCsv', { month: monthText(m) })}</FileLink></li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
