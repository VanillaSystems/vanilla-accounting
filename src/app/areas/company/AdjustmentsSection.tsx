/**
 * The company's VAT page, its adjustments: config.vatAdjustments by hand (golden rule 1). A line is a VAT event
 * of an open period that refers to a filed entry, e.g. import VAT refunded now on a filed import; it adds
 * its amount to one input-tax box of that period's return, which the VAT area shows under that box.
 */
import { Fragment, useState, type FormEvent } from 'react';
import type { Index, JournalEntry, VatAdjustment } from '../../../types/index.js';
import { addDays, booksOpenPeriod, derivePeriod, filingKeyOf, localToday, parsePeriod } from '../../../accounting/periods.js';
import { filing, vat } from '../../../engines/index.js';
import { lockedThrough } from '../../../books/lock-line.js';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { Go, entryAt } from '../vat/links.js';
import { I } from '../receipts/icons.js';
import type { Nav } from '../index.js';

interface Form { period: string; ziffer: string; amount: string; entries: string; reason: string }

const parseAmount = (s: string): number | null => {
  const n = Number(s.trim().replace(/['\s]/g, '').replace(',', '.'));
  return s.trim() && Number.isFinite(n) ? n : null;
};

/** The open filing periods a line may be declared in: the books' open one through today's. */
function openPeriods(books: Index, today: string): string[] {
  const length = filing().length;
  const keys: string[] = [];
  for (let k = filingKeyOf(booksOpenPeriod(books, today, length).from, length); ; ) {
    const p = derivePeriod(k)!;
    if (keys.length && p.from > today) break;
    keys.push(k);
    k = filingKeyOf(addDays(p.to, 1), length);
  }
  return keys;
}

const lineOf = (f: Form): Omit<VatAdjustment, 'id'> => ({
  period: f.period, ziffer: f.ziffer, amount: parseAmount(f.amount) ?? 0, reason: f.reason.trim(),
  entryIds: f.entries.split(/[\s,;]+/).filter(Boolean),
});

export function AdjustmentsSection({ books, nav, canEdit }: { books: Index; nav: Nav; canEdit: boolean }) {
  const today = localToday();
  const lines = books.config?.vatAdjustments ?? [];
  const boxes = Object.entries(vat().form.inputTax);
  const through = lockedThrough(books.config);
  const isClosed = (d: string) => !!through && d <= through;
  const periods = openPeriods(books, today);
  const entries = books.journalEntries ?? [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  // The entries a line may refer to: filed ones carrying a VAT code, the newest first.
  const filed = entries.filter((e) => e.vatCode && isClosed(e.date)).sort((a, b) => b.date.localeCompare(a.date));
  const current = parsePeriod(periods[0], today)!;
  const blank = (): Form => ({ period: periods[0], ziffer: boxes[0]?.[0] ?? '', amount: '', entries: '', reason: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [f, setF] = useState<Form>(blank);
  const [err, setErr] = useState('');

  if (!boxes.length) return <div className="adjs"><h3>{t('company.adjTitle')}</h3><p className="m">{t('company.adjNoBox')}</p></div>;

  const editable = (a: VatAdjustment) => canEdit && !isClosed(derivePeriod(a.period)?.from ?? '');
  const start = (a: VatAdjustment | null) => {
    setErr('');
    setEditing(a ? a.id : '');
    setF(a ? { period: a.period, ziffer: a.ziffer, amount: String(a.amount), entries: a.entryIds.join(', '), reason: a.reason } : blank());
  };
  const done = (text: string, undo: () => Promise<unknown>) => {
    setErr('');
    setEditing(null);
    nav.refresh();
    nav.toast(text, () => { undo().then(nav.refresh, (e) => nav.toast(errorText(e))); });
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (parseAmount(f.amount) === null) { setErr(t('journal.errAmount')); return; }
    const was = lines.find((a) => a.id === editing);
    try {
      if (was) {
        const now = await api.changeVatAdjustment({ id: was.id, ...lineOf(f) });
        done(t('company.adjChanged', { period: now.period, ziffer: now.ziffer }), () => api.changeVatAdjustment(was));
      } else {
        const now = await api.addVatAdjustment(lineOf(f));
        done(t('company.adjAdded', { period: now.period, ziffer: now.ziffer }), () => api.removeVatAdjustment(now.id));
      }
    } catch (ex) {
      setErr(errorText(ex));
    }
  }

  async function remove(a: VatAdjustment) {
    try {
      await api.removeVatAdjustment(a.id);
    } catch (ex) {
      nav.toast(errorText(ex));
      return;
    }
    done(t('company.adjRemoved', { period: a.period, ziffer: a.ziffer }), () => api.addVatAdjustment(a));
  }

  const entryLink = (id: string, e: JournalEntry | undefined) =>
    e ? <Go key={id} to={entryAt(e, current)} nav={nav} className="mono clink" title={`${formatDate(e.date)} ${e.description ?? ''}`}>{id}</Go> : <span key={id} className="mono warn">{id}</span>;

  const form = (
    <form className="form inline" data-testid="adj-form" autoComplete="off" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}>
      <label>{t('company.adjPeriod')}
        <select name="period" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}>
          {[...new Set([...periods, f.period])].map((k) => <option key={k} value={k}>{t('company.adjPeriodOption', { period: k, date: formatDate(derivePeriod(k)!.to) })}</option>)}
        </select>
      </label>
      <label>{t('company.adjZiffer')}
        <select name="ziffer" value={f.ziffer} onChange={(e) => setF({ ...f, ziffer: e.target.value })}>
          {boxes.map(([z, b]) => <option key={z} value={z}>{z} {b.label}</option>)}
        </select>
      </label>
      <label>{t('company.adjAmount')}<input name="amount" className="mono" inputMode="decimal" style={{ textAlign: 'right' }} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
      <label className="wide">{t('company.adjEntries')}
        <input name="entries" className="mono" list="adj-filed-entries" value={f.entries} onChange={(e) => setF({ ...f, entries: e.target.value })} />
        <datalist id="adj-filed-entries">
          {filed.map((e) => <option key={e.id} value={e.id}>{`${formatDate(e.date)} · ${e.vatCode} · ${fmt(e.amount)} · ${e.description ?? ''}`}</option>)}
        </datalist>
      </label>
      <label className="wide">{t('company.adjReason')}<textarea name="reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
      {err && <div className="err wide" role="alert" data-testid="adj-refused">{err}</div>}
      <div className="acts">
        <button type="submit" className="btn primary">{t('common.save')}</button>
        <button type="button" className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
      </div>
      <p className="m wide">{t('company.adjHint')}</p>
    </form>
  );

  return (
    <div className="adjs" data-testid="vat-adjustments">
      <h3>{t('company.adjTitle')}</h3>
      <p className="m">{t('company.adjExplain')}</p>
      {lines.length ? (
        <div className="ftab adj">
          <div className="fh"><span>{t('company.adjPeriod')}</span><span>{t('company.adjZiffer')}</span><span>{t('company.adjReason')}</span><span className="r">{t('company.adjAmount')}</span><span /></div>
          {lines.map((a) => (
            <Fragment key={a.id}>
            <div className="fr" data-adjustment={a.id}>
              <span>
                {parsePeriod(a.period, today)
                  ? <Go to={{ route: { area: 'vat', ziffer: a.ziffer }, query: { period: parsePeriod(a.period, today)! } }} nav={nav} className="mono clink" title={t('company.adjToVat')}>{a.period}</Go>
                  : <span className="mono">{a.period}</span>}
              </span>
              <span className="mono">{a.ziffer}</span>
              <span>
                {a.reason}
                <span className="m" style={{ display: 'block' }}>{t('company.adjRefersTo')} {a.entryIds.map((id, i) => <span key={id}>{i ? ', ' : ''}{entryLink(id, byId.get(id))}</span>)}</span>
              </span>
              <span className="r mono">{fmt(a.amount)}</span>
              <span>
                {editable(a) && editing === null ? (
                  <>
                    <button type="button" className="quiet2" onClick={() => start(a)}>{t('company.edit')}</button>{' '}
                    <button type="button" className="quiet2" aria-label={t('company.adjRemove', { period: a.period, ziffer: a.ziffer })} onClick={() => void remove(a)}>×</button>
                  </>
                ) : null}
              </span>
            </div>
            {editing === a.id && form}
            </Fragment>
          ))}
        </div>
      ) : <p className="m">{t('company.adjNone')}</p>}
      {editing === '' ? form : canEdit && editing === null && <div className="fedit"><button type="button" className="btn" onClick={() => start(null)}>{I.edit}{t('company.adjAdd')}</button></div>}
    </div>
  );
}
