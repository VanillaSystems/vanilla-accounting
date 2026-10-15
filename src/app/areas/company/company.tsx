/**
 * Firma: what the workspace says about the company, one section per row. The profile, the bank
 * accounts and the chart of accounts can be changed here (belege.workspace.yaml, accounts.json);
 * periods and seals are read only (a quarter closes with the seal CLI, the year with Abschluss);
 * Darstellung is this browser's own.
 */
import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import './company.css';
import { COMPANY_SECTIONS, companySection, type CompanySection, type RouteOf } from '../../shell/route.js';
import { reloadWorkspace, useWorkspace } from '../../hooks/use-workspace.js';
import { LOCALES, t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { getAccountMap } from '../../lib/accounts.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { dispatchBar, useBar, type BarId } from '../../shell/bars.js';
import { useShellUi } from '../../shell/ui.js';
import { moveKey } from '../../shell/keyboard.js';
import type { Theme } from '../../shell/prefs.js';
import { addDays, localToday, booksOpenPeriod, parsePeriod } from '../../../accounting/periods.js';
import type { Address } from '../../../invoices/model.js';
import type { CompanyInfo } from '../../../books/company.js';
import type { ManifestPatch } from '../../../workspace/manifest-write.js';
import { ICONS } from '../icons.js';
import { I } from '../receipts/icons.js';
import type { Area, AreaProps, LegendItem, Nav } from '../index.js';
import { InvoiceLayoutSection } from './InvoiceLayout.js';
import { MailSection } from './MailSection.js';
import { SourcesSection } from './SourcesSection.js';
import { baseCurrency, filing } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'company'>>;

const GROUPS: Array<['company.groupMaster' | 'company.groupBooks' | 'company.groupApp', CompanySection[]]> = [
  ['company.groupMaster', ['profile', 'vat', 'banks', 'invoice-layout', 'mail', 'sources']],
  ['company.groupBooks', ['accounts', 'periods', 'opening']],
  ['company.groupApp', ['display']],
];

const THEMES: Theme[] = ['light', 'dark', 'system'];
const themeLabel = (th: Theme) => t(th === 'light' ? 'app.themeLight' : th === 'dark' ? 'app.themeDark' : 'app.themeSystem');

/** The year the books are in: the open quarter's. */
const bookYear = (books: Props['books']) => booksOpenPeriod(books, localToday(), filing().length).from.slice(0, 4);

function sectionLabel(s: CompanySection, books: Props['books']): string {
  return s === 'opening' ? t('company.openingYear', { year: bookYear(books) }) : t(`company.${s}`);
}

/** A change to the manifest: the page reads it again; the toast can take it back with the opposite patch. */
async function patch(nav: Nav, change: ManifestPatch, message: string, undo?: ManifestPatch): Promise<boolean> {
  try {
    await api.patchWorkspace(change);
  } catch (e) {
    nav.toast(errorText(e));
    return false;
  }
  reloadWorkspace();
  nav.toast(message, undo && (() => { api.patchWorkspace(undo).then(reloadWorkspace, (e) => nav.toast(errorText(e))); }));
  return true;
}

function List({ route, books, nav }: Props) {
  const ws = useWorkspace();
  const ui = useShellUi();
  const closed = books.config?.closedThrough;
  const opening = books.config?.openingBalances?.[bookYear(books)];
  const side: Partial<Record<CompanySection, string>> = {
    profile: ws?.company.uid,
    vat: t('company.vatEffective'),
    banks: ws ? String(ws.bankAccounts.filter((b) => b.bank !== 'manual').length) : undefined,
    'invoice-layout': ws?.invoicing?.layout.font,
    mail: ws?.outgoingMail?.host,
    accounts: String(Object.keys(getAccountMap()).length),
    periods: closed ? t('company.through', { date: formatDate(closed) }) : undefined,
    opening: opening ? t('company.nAccounts', { n: Object.keys(opening).length }) : undefined,
    display: themeLabel(ui.theme),
  };
  return (
    <>
      <h1>{ws?.company.name ?? t('area.company')}</h1>
      <div className="counts"><span>{ws?.company.owner}</span></div>
      <div className="rows" role="listbox" aria-label={t('company.list')}>
        {GROUPS.map(([group, sections]) => (
          <Fragment key={group}>
            <div className="group"><span>{t(group)}</span></div>
            {sections.map((s) => {
              const sel = s === route.section;
              return (
                <div
                  key={s}
                  className={`row fset${sel ? ' sel' : ''}`}
                  role="option"
                  aria-selected={sel}
                  tabIndex={sel ? 0 : -1}
                  data-section={s}
                  onClick={() => nav.select({ area: 'company', section: s })}
                >
                  <span className="t">{sectionLabel(s, books)}</span>
                  <span className="a mono">{side[s] ?? ''}</span>
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
      {ws ? (
        <div className="appver mono">
          <div>{t('company.appVersion', { version: ws.appVersion })}</div>
          {ws.appTime ? <div>{t(ws.appTime.kind === 'built' ? 'company.appBuilt' : 'company.appCommitted', { at: localTime(ws.appTime.at) })}</div> : null}
        </div>
      ) : null}
    </>
  );
}

/** 15.10.2026 11:32, in the viewer's time zone. */
function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Detail(props: Props) {
  const { route, books } = props;
  const ws = useWorkspace();
  const section = companySection(route.section);
  if (!section) return <div className="detail-empty"><div>{t('company.sectionGone')}</div></div>;
  return (
    <div className="detail-in" key={section}>
      <div className="head"><h2 className="who">{sectionLabel(section, books)}<small>{ws?.company.name}</small></h2></div>
      <div className="docbody">{!ws && section !== 'display' ? <p className="m">{t('yearClose.loading')}</p> : <Section {...props} section={section} ws={ws!} />}</div>
    </div>
  );
}

function Section({ section, ...p }: Props & { section: CompanySection; ws: CompanyInfo }) {
  switch (section) {
    case 'profile': return <Profile {...p} />;
    case 'vat': return <Vat {...p} />;
    case 'banks': return <Banks {...p} />;
    case 'invoice-layout': return <InvoiceLayoutSection ws={p.ws} nav={p.nav} canEdit={p.canEdit} />;
    case 'mail': return <MailSection ws={p.ws} nav={p.nav} canEdit={p.canEdit} />;
    case 'sources': return <SourcesSection />;
    case 'accounts': return <Accounts {...p} />;
    case 'periods': return <Periods {...p} />;
    case 'opening': return <Opening {...p} />;
    case 'display': return <Display />;
  }
}

const Kv = ({ k, children, note }: { k: string; children: ReactNode; note?: ReactNode }) => (
  <><dt>{k}</dt><dd>{children}{note ? <> <span className="m">{note}</span></> : null}</dd></>
);

const addressLine = (a: Address) => [[a.street, a.number].filter(Boolean).join(' '), a.line2, `${a.postcode} ${a.town}${a.state ? ` ${a.state}` : ''}`, a.country !== 'CH' ? a.country : ''].filter(Boolean).join(', ');

const FIELDS = ['name', 'uid', 'owner', 'business', 'street', 'number', 'postcode', 'town', 'country'] as const;
type Field = (typeof FIELDS)[number];

function Profile({ ws, nav, canEdit }: Props & { ws: CompanyInfo }) {
  const c = ws.company;
  const [edit, setEdit] = useState(false);
  const was: Record<Field, string> = {
    name: c.name, uid: c.uid, owner: c.owner, business: c.business ?? '',
    street: c.address?.street ?? '', number: c.address?.number ?? '', postcode: c.address?.postcode ?? '', town: c.address?.town ?? '', country: c.address?.country ?? 'CH',
  };
  const [f, setF] = useState(was);
  const changeOf = (v: Record<Field, string>): ManifestPatch['company'] => {
    const hasAddress = [v.street, v.number, v.postcode, v.town].some((x) => x.trim());
    return {
      name: v.name, uid: v.uid, owner: v.owner, business: v.business.trim() || null,
      address: hasAddress ? { ...c.address, street: v.street, number: v.number, postcode: v.postcode, town: v.town, country: v.country.trim().toUpperCase() || 'CH' } : null,
    };
  };
  async function save(e: FormEvent) {
    e.preventDefault();
    const changed = FIELDS.filter((k) => f[k].trim() !== was[k]);
    if (!changed.length) { setEdit(false); return; }
    const undo = { company: { name: c.name, uid: c.uid, owner: c.owner, business: c.business ?? null, address: c.address ?? null } };
    if (await patch(nav, { company: changeOf(f) }, t('company.saved', { fields: changed.map((k) => t(`company.field.${k}`)).join(', ') }), undo)) setEdit(false);
  }
  const begin = () => { setF(was); setEdit(true); };
  const input = (k: Field, cls = '') => (
    <label className={cls}>{t(`company.field.${k}`)}<input name={k} className={k === 'uid' || k === 'postcode' || k === 'number' ? 'mono' : ''} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  );
  return (
    <>
      <dl className="kv2 wide">
        <Kv k={t('company.field.name')}>{c.name}</Kv>
        <Kv k={t('company.field.uid')}><span className="mono">{c.uid}</span></Kv>
        <Kv k={t('company.vatNumber')}><span className="mono">{t('company.vatSuffix', { uid: c.uid })}</span></Kv>
        <Kv k={t('company.field.owner')}>{c.owner}</Kv>
        <Kv k={t('company.field.business')}>{c.business ?? <span className="m">{t('company.notSet')}</span>}</Kv>
        <Kv k={t('company.address')} note={!c.address && canEdit && !edit ? <button type="button" className="quiet2" onClick={begin}>{t('company.add')}</button> : undefined}>
          {c.address ? addressLine(c.address) : <span className="m">{t('company.notSet')}</span>}
        </Kv>
      </dl>
      {edit ? (
        <form className="form inline" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(false); } }}>
          {input('name', 'wide')}{input('uid')}{input('owner')}{input('business', 'wide')}
          {input('street')}{input('number')}{input('postcode')}{input('town')}{input('country')}
          <div className="acts">
            <button type="submit" className="btn primary">{t('common.save')}</button>
            <button type="button" className="btn ghost" onClick={() => setEdit(false)}>{t('common.cancel')}</button>
          </div>
        </form>
      ) : canEdit && <div className="fedit"><button type="button" className="btn" onClick={begin}>{I.edit}{t('company.edit')}</button></div>}
      <p className="m src-note">{t('company.profileSource')}</p>
    </>
  );
}

function Vat({ ws, nav }: Props & { ws: CompanyInfo }) {
  return (
    <>
      <dl className="kv2 wide">
        <Kv k={t('company.vatMethod')} note={t('company.vatForm')}>{t('company.vatMethodEffective')}</Kv>
        <Kv k={t('company.vatBasis')}>{t('company.vatReceived')}</Kv>
        <Kv k={t('company.vatPeriod')} note={t('company.vatDue')}>{t('company.vatQuarterly')}</Kv>
        <Kv k={t('company.vatNumber')}><span className="mono">{t('company.vatSuffix', { uid: ws.company.uid })}</span></Kv>
        <Kv k={t('company.filed')}>{ws.filed.length ? ws.filed.map((q) => <span key={q} className="mono" style={{ display: 'block' }}>{q}</span>) : <span className="m">{t('company.noneFiled')}</span>}</Kv>
      </dl>
      <p>
        <button type="button" className="clink" onClick={() => nav.go({ route: { area: 'vat' }, query: {} })}>{t('company.toVat')}</button>{'  '}
        <button type="button" className="clink" onClick={() => nav.go({ route: { area: 'codes' }, query: {} })}>{t('company.toCodes')}</button>
      </p>
      <p className="m src-note">{t('company.vatOnly')}</p>
    </>
  );
}

const prettyIban = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

function Banks({ ws, nav, canEdit }: Props & { ws: CompanyInfo }) {
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  const key = (b: { bank: string; currency: string }) => `${b.bank} ${b.currency}`;
  const [f, setF] = useState<Record<string, { label: string; iban: string }>>({});
  const start = () => { setF(Object.fromEntries(ws.bankAccounts.map((b) => [key(b), { label: b.label, iban: b.iban ?? '' }]))); setEdit(true); };
  async function save(e: FormEvent) {
    e.preventDefault();
    const changed = ws.bankAccounts.filter((b) => f[key(b)].label.trim() !== b.label || f[key(b)].iban.replace(/\s/g, '').toUpperCase() !== (b.iban ?? ''));
    if (!changed.length) { setEdit(false); return; }
    const banks = changed.map((b) => ({ bank: b.bank, currency: b.currency, label: f[key(b)].label, iban: f[key(b)].iban.trim() || null }));
    const undo = changed.map((b) => ({ bank: b.bank, currency: b.currency, label: b.label, iban: b.iban ?? null }));
    if (await patch(nav, { banks }, t('company.banksSaved', { n: changed.length }), { banks: undo })) setEdit(false);
  }
  const balance = (account: string) => ws.statementBalances.find((s) => s.account === account);
  const goBank = () => nav.go({ route: { area: 'bank' }, query: {} });
  return (
    <>
      <form onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape' && edit) { e.stopPropagation(); setEdit(false); } }}>
        <div className="ftab banks">
          <div className="fh"><span>{t('yearClose.colAccount')}</span><span>{t('company.bank')}</span><span>{t('company.iban')}</span><span className="r">{t('company.statementBalance')}</span></div>
          {ws.bankAccounts.map((b) => {
            const bal = balance(b.account);
            const k = key(b);
            return edit ? (
              <div key={k} className="fr form">
                <span className="mono">{b.account}</span>
                <input aria-label={t('company.field.label')} value={f[k].label} onChange={(e) => setF({ ...f, [k]: { ...f[k], label: e.target.value } })} />
                <input aria-label={t('company.iban')} className="mono" value={f[k].iban} disabled={b.bank === 'manual'} onChange={(e) => setF({ ...f, [k]: { ...f[k], iban: e.target.value } })} />
                <span className="r m">{b.bank} {b.currency}</span>
              </div>
            ) : (
              <div key={k} className="fr go" role="link" tabIndex={0} data-bank={b.account} onClick={goBank} onKeyDown={(e) => { if (e.key === 'Enter') goBank(); }}>
                <span className="mono">{b.account}</span>
                <span>{b.label}{b.bank === 'manual' && <> <span className="m">{t('company.privateOutlay')}</span></>}</span>
                <span className="mono m">{b.iban ? prettyIban(b.iban) : '–'}</span>
                <span className="r mono">{bal ? <>{b.currency} {fmt(bal.amount)} <span className="m">{formatDate(bal.date)}</span></> : '–'}</span>
              </div>
            );
          })}
        </div>
        {canEdit && (
          <div className="fedit">
            {edit ? (
              <>
                <button type="submit" className="btn primary">{t('common.save')}</button>
                <button type="button" className="btn ghost" onClick={() => setEdit(false)}>{t('common.cancel')}</button>
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={start}>{I.edit}{t('company.editBanks')}</button>
                {!adding && <button type="button" className="btn ghost" onClick={() => setAdding(true)}>{I.plus}{t('company.addBank')}</button>}
              </>
            )}
          </div>
        )}
      </form>
      {adding && <AddBank nav={nav} onDone={() => setAdding(false)} />}
      <p className="m src-note">{t('company.banksSource')}</p>
    </>
  );
}

function AddBank({ nav, onDone }: { nav: Nav; onDone(): void }) {
  const [f, setF] = useState({ bank: '', currency: baseCurrency(), account: '', label: '', iban: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const valid = !!f.bank.trim() && /^[A-Za-z]{3}$/.test(f.currency.trim()) && /^\d{4}$/.test(f.account.trim()) && !!f.label.trim();
  async function save(e: FormEvent) {
    e.preventDefault();
    if (valid && await patch(nav, { addBank: { ...f, iban: f.iban.trim() || undefined } }, t('company.bankAdded', { label: f.label.trim() }))) onDone();
  }
  return (
    <form className="form inline" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(); } }}>
      <label>{t('company.bank')}<input value={f.bank} onChange={set('bank')} autoFocus /></label>
      <label>{t('company.currency')}<input className="mono" value={f.currency} onChange={set('currency')} /></label>
      <label>{t('yearClose.colAccount')}<input className="mono" inputMode="numeric" value={f.account} onChange={set('account')} /></label>
      <label>{t('company.field.label')}<input value={f.label} onChange={set('label')} /></label>
      <label className="wide">{t('company.iban')}<input className="mono" value={f.iban} onChange={set('iban')} /></label>
      <div className="acts">
        <button type="submit" className="btn primary" disabled={!valid}>{t('company.addBank')}</button>
        <button type="button" className="btn ghost" onClick={onDone}>{t('common.cancel')}</button>
        <span className="m">{t('company.addBankHint')}</span>
      </div>
    </form>
  );
}

const CLASS = { 1: 'reports.class1', 2: 'reports.class2', 3: 'reports.class3', 4: 'reports.class4', 5: 'reports.class5', 6: 'reports.class6', 7: 'reports.class7', 8: 'reports.class8', 9: 'reports.class9' } as const;

function Accounts({ books, nav, canEdit }: Props) {
  const names = getAccountMap();
  const year = bookYear(books);
  const used = new Map<string, number>();
  for (const e of books.journalEntries ?? []) if (e.date.startsWith(year)) for (const a of [e.accountDebit, e.accountCredit]) if (a) used.set(a, (used.get(a) ?? 0) + 1);
  const open = (a: string) => nav.go({ route: { area: 'reports', report: a < '3' ? 'balance' : 'income', account: a }, query: { period: parsePeriod(year, localToday())! } });
  const [f, setF] = useState({ number: '', name: '' });
  const exists = f.number in names;
  async function save(e: FormEvent) {
    e.preventDefault();
    const before = names[f.number];
    const name = f.name.trim();
    try {
      await api.setAccountName(f.number, name);
    } catch (err) {
      nav.toast(errorText(err));
      return;
    }
    nav.refresh();
    const number = f.number;
    nav.toast(before ? t('company.accountRenamed', { number, name }) : t('company.accountAdded', { number, name }),
      before ? () => { api.setAccountName(number, before).then(nav.refresh, (err) => nav.toast(errorText(err))); } : undefined);
    setF({ number: '', name: '' });
  }
  return (
    <>
      {canEdit && (
        <form className="form inline" onSubmit={save}>
          <label>{t('yearClose.colAccount')}<input className="mono" inputMode="numeric" value={f.number} onChange={(e) => { const number = e.target.value.trim(); setF({ number, name: names[number] ?? (f.number in names ? '' : f.name) }); }} /></label>
          <label className="wide">{t('company.accountName')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <div className="acts">
            <button type="submit" className="btn" disabled={!/^\d{4}$/.test(f.number) || !f.name.trim() || f.name.trim() === names[f.number]}>{exists ? t('company.rename') : t('company.addAccount')}</button>
            <span className="m">{t('company.accountsHint')}</span>
          </div>
        </form>
      )}
      <div className="ftab konten">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => {
          const as = Object.keys(names).filter((a) => a[0] === String(k)).sort();
          if (!as.length) return null;
          return (
            <Fragment key={k}>
              <div className="fg">{k} · {t(CLASS[k as keyof typeof CLASS])}</div>
              {as.map((a) => (
                <button key={a} type="button" className={`fr${used.get(a) ? '' : ' unused'}`} data-account={a} onClick={() => open(a)}>
                  <span className="mono">{a}</span><span>{names[a]}</span>
                  <span className="r mono m">{used.get(a) ? t('company.entriesN', { n: used.get(a)! }) : ''}</span>
                </button>
              ))}
            </Fragment>
          );
        })}
      </div>
      <p className="m src-note">{t('company.accountsSource', { year })}</p>
    </>
  );
}

function Periods({ ws, books, nav }: Props & { ws: CompanyInfo }) {
  const today = localToday();
  const closed = books.config?.closedThrough;
  const filed = new Set<string>(ws.filed);
  const years = [...new Set([...ws.filed, ...ws.seals.map((s) => s.quarter)].map((q) => q.slice(0, 4)).concat(bookYear(books)))].sort().reverse();
  return (
    <>
      <dl className="kv2 wide">
        <Kv k={t('company.closedThrough')} note={t('company.closedNote')}>{closed ? <b className="mono">{formatDate(closed)}</b> : <span className="m">{t('company.nothingClosed')}</span>}</Kv>
      </dl>
      {years.map((y) => (
        <Fragment key={y}>
          {years.length > 1 && <h3>{y}</h3>}
          <div className="qgrid">
            {[1, 2, 3, 4].map((n) => {
              const q = `${y}-Q${n}`;
              const range = parsePeriod(q, today)!;
              const seal = ws.seals.find((s) => s.quarter === q);
              return (
                <button key={q} type="button" className="qcard" data-quarter={q} onClick={() => nav.go({ route: { area: 'vat' }, query: { period: range } })}>
                  <b>{t('company.quarter', { n, year: y })}</b>
                  <span>{filed.has(q) ? t('close.qFiled') : range.to < today ? t('close.qOpenDue', { date: formatDate(addDays(range.to, 60)) }) : range.from <= today ? t('close.qRuns') : ''}</span>
                  {seal?.status === 'intact' && (
                    <>
                      <span className="m">{ICONS.lock}{t('company.sealedOn', { date: formatDate(seal.sealedAt) })}</span>
                      <span className="mono sha" title={t('company.sealTip', { date: formatDate(seal.through) })}>{seal.sha256.slice(0, 16)}…</span>
                      <span className="m">{t('company.sealRecords', { entries: seal.records.entries, transactions: seal.records.transactions })}</span>
                    </>
                  )}
                  {seal?.status === 'broken' && <span className="bad">{t('close.qSealBroken')}: {seal.problem}</span>}
                </button>
              );
            })}
          </div>
        </Fragment>
      ))}
      <p className="m src-note">{t('company.sealNote')}</p>
      <p className="m">{t('company.howToClose')}{' '}
        <button type="button" className="clink" onClick={() => nav.go({ route: { area: 'close' }, query: {} })}>{t('company.toClose')}</button>
      </p>
    </>
  );
}

function Opening({ books, nav }: Props) {
  const year = bookYear(books);
  const names = getAccountMap();
  const rows = Object.entries(books.config?.openingBalances?.[year] ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const sum = (d: string) => Math.round(rows.filter(([a]) => a[0] === d).reduce((s, [, v]) => s + v * 100, 0)) / 100;
  const [assets, liabilities] = [sum('1'), sum('2')];
  if (!rows.length) return <p className="m">{t('company.noOpening', { year })}</p>;
  const open = (a: string) => nav.go({ route: { area: 'reports', report: 'balance', account: a }, query: { period: parsePeriod(year, localToday())! } });
  return (
    <>
      <div className="ftab">
        <div className="fh"><span>{t('yearClose.colAccount')}</span><span>{t('company.accountName')}</span><span /><span className="r">{t('close.openingOn', { date: `1.1.${year}` })}</span></div>
        {rows.map(([a, v]) => (
          <button key={a} type="button" className="fr" onClick={() => open(a)}>
            <span className="mono">{a}</span><span>{names[a] ?? a}</span><span /><span className="r mono">{fmt(v)}</span>
          </button>
        ))}
        <div className="fr tot"><span /><span>{t('yearClose.totalAssets')}</span><span /><span className="r mono">{fmt(assets)}</span></div>
        <div className="fr tot"><span /><span>{t('yearClose.totalLiabilities')}</span><span /><span className="r mono">{fmt(liabilities)}</span></div>
      </div>
      {assets === liabilities
        ? <p className="okline">{I.check}{t('company.openingBalanced')}</p>
        : <p className="warnline">{I.dot}{t('company.openingDiffers', { amount: fmt(assets - liabilities) })}</p>}
      <p className="m src-note">{t('company.openingSource')}</p>
    </>
  );
}

/** The pin of a bar, the same state the bar's own pin edits (src/app/shell/bars.ts). */
function BarSetting({ id }: { id: BarId }) {
  const state = useBar(id);
  return (
    <>
      <dt>{t(id === 'top' ? 'display.topBar' : 'display.dock')}</dt>
      <dd>
        <label><input type="checkbox" checked={state.mode === 'always'} onChange={(e) => dispatchBar(id, { kind: 'pin', on: e.target.checked })} /> {t('display.barAlways')}</label>{' '}
        <span className="m">{t('display.barHint')}</span>
      </dd>
    </>
  );
}

function Display() {
  const ui = useShellUi();
  return (
    <>
      <dl className="kv2 wide">
        <dt>{t('display.color')}</dt>
        <dd>
          <span className="seg2" role="radiogroup" aria-label={t('company.display')}>
            {THEMES.map((th) => (
              <button key={th} type="button" role="radio" aria-checked={ui.theme === th} className={ui.theme === th ? 'on' : ''} onClick={() => ui.setTheme(th)}>{themeLabel(th)}</button>
            ))}
          </span>{' '}
          <span className="m">{ui.theme === 'system' ? t('display.followsOs', { mode: t(ui.dark ? 'display.modeDark' : 'display.modeLight') }) : t('display.toggleHint')}</span>
        </dd>
        <dt>{t('app.language')}</dt>
        <dd>{LOCALES.find((l) => l.code === ui.language)?.name} <span className="m">{t('display.languageHint')}</span></dd>
        <dt>{t('shell.zoom')}</dt>
        <dd><span className="mono">{Math.round(ui.zoom * 100)} %</span> <span className="m">{t('display.zoomHint')}</span></dd>
        {(['top'] as const).map((id) => <BarSetting key={id} id={id} />)}
      </dl>
      <p className="m src-note">{t('display.local')}</p>
    </>
  );
}

// Firma has no search: the shell's default legend would offer /.
const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('keys.selectTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const company: Area<RouteOf<'company'>> = {
  id: 'company',
  label: () => t('area.company'),
  dock: { key: 'f', icon: ICONS.company, tip: () => t('area.company.tip') },
  List,
  Detail,
  legend,
  periodless: true,
  title: (r, books) => { const s = companySection(r.section); return s ? sectionLabel(s, books) : ''; },
  keys(e, { route, nav }) {
    if (e.key === 'Enter') {
      document.querySelector<HTMLElement>('.detail button, .detail a, .detail input')?.focus();
      return true;
    }
    const d = moveKey(e);
    if (!d) return false;
    const i = COMPANY_SECTIONS.indexOf(route.section as CompanySection);
    nav.select({ area: 'company', section: COMPANY_SECTIONS[Math.min(COMPANY_SECTIONS.length - 1, Math.max(0, i + d))] });
    return true;
  },
  palette: ({ nav, books }) => COMPANY_SECTIONS.map((s) => ({ label: sectionLabel(s, books), side: t('area.company'), run: () => nav.go({ route: { area: 'company', section: s }, query: {} }) })),
};
