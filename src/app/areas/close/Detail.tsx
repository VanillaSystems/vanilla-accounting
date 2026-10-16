/**
 * One step of the year-end: what it is, what the books say about it, and what can be done
 * there. Every write goes through the year-close API and then reloads the books; what can be
 * taken back says so in the toast.
 */
import { Fragment, useState, type ReactNode } from 'react';
import type { EntryTemplate, TemplateState } from '../../../accounting/year-close.js';
import type { JournalEntry } from '../../../types/index.js';
import { dividendSplit } from '../../../accounting/year-close.js';
import { addDays, booksOpenPeriod, localToday, parsePeriod } from '../../../accounting/periods.js';
import { chargesVat, filing, withoutInputTax } from '../../../engines/index.js';
import type { RouteOf } from '../../shell/route.js';
import { api, errorText, type YearCloseView, type YearEndEntryInput } from '../../lib/api.js';
import { getAccountMap, getAccounts } from '../../lib/accounts.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import { I } from '../receipts/icons.js';
import type { AreaProps, Nav } from '../index.js';
import { closeYear as yearOfPage, useYearClose } from './data.js';
import { useShellUi } from '../../shell/ui.js';
import { configOf } from '../export/state.js';
import { STEPS, stepGone, causeText, checkRows, closeBlockers, lastPeriodOf, problemText, stepLabel, stepOf, tx, type CheckRow, type Step } from './steps.js';
import { correctionName } from '../../lib/vat-words.js';
import { Go } from '../vat/links.js';
import { at } from '../receipts/view.js';

type Props = AreaProps<RouteOf<'close'>>;

/** One write: on success the books reload and the toast says what happened, with its undo when there is one. */
async function act(nav: Nav, call: () => Promise<unknown>, message: string, undo?: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
  } catch (e) {
    nav.toast(errorText(e));
    return false;
  }
  nav.refresh();
  nav.toast(message, undo && (() => { undo().then(nav.refresh, (e) => nav.toast(errorText(e))); }));
  return true;
}

const num = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

export function Detail(props: Props) {
  const { route, query, books } = props;
  const year = yearOfPage(query.period, books);
  const { data, error } = useYearClose(year, books);
  if (stepGone(route.step)) return <div className="detail-empty"><div>{t('close.stepGone')}</div></div>;
  const step = stepOf(route.step);
  return (
    <div className="detail-in" key={step}>
      <div className="head">
        <h2 className="who">{stepLabel(step, year)}<small>{t('close.stepOf', { n: STEPS.indexOf(step) + 1, year })}</small></h2>
      </div>
      <div className="docbody">
        {error ? <p className="warnline">{error}</p> : !data ? <p className="m">{t('yearClose.loading')}</p> : <Step step={step} d={data} {...props} />}
      </div>
    </div>
  );
}

function Step({ step, d, ...p }: Props & { step: Step; d: YearCloseView }) {
  switch (step) {
    case 'q4': return <Q4 d={d} {...p} />;
    case 'checks': return <Checks d={d} {...p} />;
    case 'entries': return <Entries d={d} {...p} />;
    case 'close': return <Close d={d} {...p} />;
    case 'open': return <Open d={d} {...p} />;
    case 'profit': return <Profit d={d} {...p} />;
    case 'handover': return <Handover d={d} {...p} />;
  }
}

type StepProps = Omit<Props, 'step'> & { d: YearCloseView };

function Q4({ d, nav, books }: StepProps) {
  const ws = useWorkspace();
  const today = localToday();
  const start = books.config?.closedThrough ? undefined : booksOpenPeriod(books, today, filing().length).from;
  if (!chargesVat()) return <p className="lead">{t('close.noReturnLead', { year: d.year })}</p>;
  return (
    <>
      <p className="lead">{t('close.q4Lead', { period: lastPeriodOf(d.year) })}</p>
      <div className="qgrid">
        {d.vat.quarters.map((q) => {
          const range = parsePeriod(q.quarter, today)!;
          const seal = ws?.seals.find((s) => s.quarter === q.quarter);
          return (
            <button key={q.quarter} type="button" className="qcard" onClick={() => nav.go({ route: { area: 'vat' }, query: { period: range } })}>
              <b>{q.quarter.slice(5)}</b>
              <span>{q.filed !== undefined ? t('close.qFiled') : start && range.to < start ? t('close.qBeforeBooks') : range.to < today ? t('close.qOpenDue', { date: formatDate(addDays(range.to, 60)) }) : t('close.qRuns')}</span>
              <span className="m">{seal?.status === 'intact' ? <>{ICONS.lock}{t('close.qSealed')}</> : seal ? <span className="bad">{t('close.qSealBroken')}</span> : q.filed !== undefined ? t('close.qNotSealed') : ''}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function goCheck(c: CheckRow, { nav, d }: StepProps): (() => void) | undefined {
  const go = c.go;
  if (!go) return undefined;
  if ('step' in go) return () => nav.select({ area: 'close', step: go.step });
  if (go.area === 'balance') return () => nav.go({ route: { area: 'reports', report: 'balance' }, query: { period: parsePeriod(d.year, localToday())! } });
  return () => nav.go({ route: go.area === 'vat' ? { area: 'vat' } : { area: 'bank' }, query: {} });
}

function Checks(p: StepProps) {
  const { d, books, nav } = p;
  const rows = checkRows(d, localToday());
  const dateOf = (ref: string) => books.transactions.find((x) => x.ref === ref)?.date;
  const v = d.vat;
  return (
    <>
      <p className="lead">{t('close.checksLead')}</p>
      <div className="checks">
        {rows.map((c) => {
          const go = goCheck(c, p);
          const inner = (
            <>
              <span className="ic">{c.state === 'ok' ? I.check : c.state === 'warn' ? '!' : c.state === 'open' ? '○' : '·'}</span>
              <span className="cx">
                <b>{c.label}</b>
                <span>{c.detail}</span>
                {c.payments && <span className="chklinks">{c.payments.map((ref) => <Go key={ref} to={at({ area: 'bank', payment: ref }, dateOf(ref))} nav={nav} className="mono">{ref} →</Go>)}</span>}
              </span>
              {go ? <span className="arr">→</span> : <span />}
            </>
          );
          return go
            ? <button key={c.id} type="button" className={`chk st-${c.state}`} data-check={c.id} onClick={go}>{inner}</button>
            : <div key={c.id} className={`chk st-${c.state}`} data-check={c.id}>{inner}</div>;
        })}
      </div>
      {chargesVat() && <VatReconciliation d={d} />}
    </>
  );
}

function VatReconciliation({ d }: { d: YearCloseView }) {
  const v = d.vat;
  return (
    <>
      <h3>{t('yearClose.sectionVat')}</h3>
      <p className="m">{t('yearClose.vatIntro', { account: d.accounts.vatSettlement })}</p>
      <div className="ftab vatq">
        <div className="fh"><span>{t('yearClose.colQuarter')}</span><span className="r">{t('yearClose.colFiled')}</span><span className="r">{t('yearClose.colBooks')}</span><span className="r">{t('yearClose.colCorrection')}</span></div>
        {v.quarters.map((q) => (
          <div key={q.quarter} className="fr">
            <span className="mono">{q.quarter}</span>
            <span className="r mono">{q.filed === undefined ? <span className="m">{t('yearClose.notFiled')}</span> : fmt(q.filed)}</span>
            <span className="r mono">{fmt(q.books)}</span>
            <span className={`r mono${q.filed !== undefined && q.correction !== 0 ? ' warn' : ''}`}>{q.filed === undefined || q.correction === 0 ? '–' : fmt(q.correction)}</span>
          </div>
        ))}
      </div>
      <div className="ftab sums">
        {([['yearClose.vatOpening', v.opening], ['yearClose.vatBooked', v.booked], ['yearClose.vatPaid', v.paid], ['yearClose.vatOwed', v.owed], ['yearClose.vatExpected', v.expected], ['yearClose.vatRounding', v.rounding]] as const).map(([key, value]) => (
          <div key={key} className="fr"><span className="m">{t(key)}</span><span className="r mono">{fmt(value)}</span></div>
        ))}
      </div>
      {v.unexplained === 0
        ? <p className="okline">{I.check}{t('yearClose.vatExplained')}</p>
        : <p className="warnline">{I.dot}{t('yearClose.vatUnexplained', { amount: fmt(v.unexplained), correction: correctionName() })}</p>}
    </>
  );
}

const accountsOf = (tp: EntryTemplate) => [tp.accountDebit || '…', tp.accountCredit || '…'].join(' / ') + (tp.vatCode ? `, ${tp.vatCode}` : '');

function Entries({ d, nav, canEdit }: StepProps) {
  const [open, setOpen] = useState<string | null>(null);
  const editable = canEdit && !d.closed;
  const mark = (id: string, state: TemplateState | null, before: TemplateState | undefined) => {
    const label = tx(`yearClose.template.${id}`);
    if (state) { act(nav, () => api.markYearEndEntry(d.year, id, state), state === 'na' ? t('close.markedNa', { label }) : t('close.markedDone', { label }), () => api.markYearEndEntry(d.year, id, before ?? null)); return; }
    // Open again: the booking the step made is removed with it (r9c-16); the undo books it back as it was and marks the step as before.
    let removed: JournalEntry[] = [];
    const booked = d.templates.find((tp) => tp.id === id)?.booked ?? [];
    act(nav, async () => { removed = (await api.markYearEndEntry(d.year, id, null)).removed ?? []; },
      booked.length ? t('close.reopenedUnbooked', { label, refs: booked.map((b) => b.transactionRef).join(', ') }) : t('close.markedOpen', { label }),
      async () => {
        for (const e of removed) await api.createJournalEntry({ id: e.id, transactionRef: e.transactionRef, date: e.date, accountDebit: e.accountDebit, accountCredit: e.accountCredit, amount: e.amount, description: e.description ?? '', ...(e.vatCode && { vatCode: e.vatCode }), origin: e.origin });
        await api.markYearEndEntry(d.year, id, before ?? null);
      });
  };
  return (
    <>
      <p className="lead">{t('close.entriesLead')}</p>
      <div className="yel">
        {d.templates.map((tp) => (
          <div key={tp.id} data-template={tp.id}>
            <div className={`ye${tp.state ? ' done' : ''}`}>
              <span className="cx"><b>{tx(`yearClose.template.${tp.id}`)}</b><span>{tp.id === 'privateUse' && withoutInputTax() ? t('yearClose.templateHint.privateUseNoInputTax') : tx(`yearClose.templateHint.${tp.id}`)}</span></span>
              <span className="mono acc">{tp.amount !== undefined ? `${fmt(tp.amount)} · ` : ''}{accountsOf(tp)}</span>
              {tp.state ? (
                <>
                  <span className={`st${tp.state === 'na' ? ' na' : ''}`}>{tp.state === 'na' ? t('yearClose.stateNa') : <>{I.check}{t('close.booked')}</>}</span>
                  {tp.booked && !d.state.templates[tp.id]
                    ? <span className="m" data-testid="booked-by">{t('close.bookedAs')} {tp.booked.map((b, i) => <Fragment key={b.id}>{i > 0 && ', '}<button type="button" className="golink" onClick={() => nav.go({ route: { area: 'journal', id: b.id }, query: { period: parsePeriod(d.year, localToday())! } })}>{b.transactionRef}</button></Fragment>)}</span>
                    : editable && <button type="button" className="quiet2" onClick={() => mark(tp.id, null, tp.state)}>{t('close.undoMark')}</button>}
                </>
              ) : editable && (
                <>
                  <button type="button" className="btn ghost" onClick={() => mark(tp.id, 'na', undefined)}>{t('yearClose.markNa')}</button>
                  <button type="button" className="btn" onClick={() => setOpen(open === tp.id ? null : tp.id)}>{t('yearClose.book')}</button>
                </>
              )}
            </div>
            {tp.id === 'receivables' && (
              <div className="ye-inv">
                {d.receivables.invoices.map((i) => `${i.number} ${i.customer}: ${i.currency} ${fmt(i.open)}`).join(' · ')}
              </div>
            )}
            {open === tp.id && <EntryForm d={d} tp={tp} nav={nav} onDone={() => setOpen(null)} />}
          </div>
        ))}
      </div>
    </>
  );
}

/** The entry of a template, prefilled: its accounts, VAT code, the books' amount when they have one, dated 31.12. */
function EntryForm({ d, tp, nav, onDone }: { d: YearCloseView; tp: EntryTemplate & { state?: TemplateState }; nav: Nav; onDone(): void }) {
  const description = tp.id === 'receivables'
    ? t('close.receivablesText', { year: d.year, numbers: d.receivables.invoices.map((i) => i.number).join(', ') })
    : tx(`yearClose.template.${tp.id}`);
  const [f, setF] = useState({ date: `${d.year}-12-31`, accountDebit: tp.accountDebit, accountCredit: tp.accountCredit, amount: tp.amount !== undefined ? tp.amount.toFixed(2) : '', vatCode: tp.vatCode ?? '', description });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const amount = num(f.amount);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(f.date) && amount > 0 && !!(f.accountDebit || f.accountCredit) && !!f.description.trim();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    let id = '';
    const input: YearEndEntryInput = { date: f.date, accountDebit: f.accountDebit.trim(), accountCredit: f.accountCredit.trim(), amount, vatCode: f.vatCode.trim() || undefined, description: f.description.trim(), template: tp.id };
    const ok = await act(nav, async () => { id = (await api.bookYearEndEntry(d.year, input)).entry.id; }, t('close.entryBooked', { label: tx(`yearClose.template.${tp.id}`), amount: fmt(amount) }),
      async () => { await api.deleteJournalEntry(id); await api.markYearEndEntry(d.year, tp.id, tp.state ?? null); });
    if (ok) onDone();
  }
  return (
    <form className="form inline" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(); } }}>
      <AccountList />
      <label>{t('yearClose.form.date')}<input type="date" value={f.date} onChange={set('date')} autoFocus /></label>
      <label>{t('yearClose.form.debit')}<input className="mono" list="close-accounts" value={f.accountDebit} onChange={set('accountDebit')} /></label>
      <label>{t('yearClose.form.credit')}<input className="mono" list="close-accounts" value={f.accountCredit} onChange={set('accountCredit')} /></label>
      <label>{t('yearClose.form.amount')}<input className="mono" inputMode="decimal" value={f.amount} onChange={set('amount')} /></label>
      <label>{t('yearClose.form.vatCode')}<input className="mono" value={f.vatCode} onChange={set('vatCode')} /></label>
      <label className="wide">{t('yearClose.form.description')}<input value={f.description} onChange={set('description')} /></label>
      <div className="acts">
        <button type="submit" className="btn primary" disabled={!valid}>{t('yearClose.form.save')}</button>
        <button type="button" className="btn ghost" onClick={onDone}>{t('common.cancel')}</button>
        <span className="m">{tp.id === 'receivables' ? t('close.receivablesHint') : ''}</span>
      </div>
      {tp.id === 'receivables' && d.receivables.unlinked?.length ? (
        <p className="warnline" data-testid="receivables-unlinked">{I.dot}{t('close.receivablesUnlinked')}{' '}
          {d.receivables.unlinked.map((p, i) => <Fragment key={p.transactionRef}>{i > 0 && ', '}<button type="button" className="golink" onClick={() => nav.go(at({ area: 'bank', payment: p.transactionRef }, p.date))}>{p.transactionRef} → {p.number} ({p.currency} {fmt(p.amount)})</button></Fragment>)}
        </p>
      ) : null}
      {tp.id === 'receivables' && !d.accounts.receivables.inChart && (
        <p className="warnline" data-testid="receivables-account-missing">{I.dot}{t('close.receivablesAccountMissing', { account: d.accounts.receivables.account })}{' '}
          <button type="button" className="btn ghost" onClick={() => act(nav, () => api.setAccountName(d.accounts.receivables.account, t('close.receivablesAccountName')), t('close.accountAdded', { account: d.accounts.receivables.account }))}>{t('close.addAccount', { account: d.accounts.receivables.account })}</button>
        </p>
      )}
    </form>
  );
}

function AccountList() {
  return <datalist id="close-accounts">{getAccounts().map((a) => <option key={a.number} value={a.number}>{a.name}</option>)}</datalist>;
}

function Close({ d, nav, canEdit }: StepProps) {
  const [asking, setAsking] = useState(false);
  const toBook = d.revaluations.some((r) => r.status === 'to-book');
  const locked = !!d.closedThrough && d.closedThrough >= `${d.year}-12-31`;
  const block = closeBlockers(d);
  const l = d.ledger;
  async function run() {
    setAsking(false);
    await act(nav, async () => {
      if (toBook) await api.bookRevaluation(d.year);
      await api.closeYear(d.year);
    }, t('close.closedToast', { year: d.year, period: lastPeriodOf(d.year) }));
  }
  return (
    <>
      <p className="lead">{t('close.closeLead', { year: d.year, period: lastPeriodOf(d.year) })}</p>
      <h3>{t('yearClose.sectionFx')}</h3>
      <p className="m">{t('yearClose.fxIntro', { account: d.accounts.fxDifference })}</p>
      {d.revaluations.length === 0 ? <p className="m">{t('yearClose.fxNone')}</p> : (
        <div className="ftab fx">
          <div className="fh"><span>{t('yearClose.colAccount')}</span><span className="r">{t('yearClose.colNative')}</span><span className="r">{t('yearClose.colRate')}</span><span className="r">{t('yearClose.colTarget')}</span><span className="r">{t('yearClose.colBook')}</span><span className="r">{t('yearClose.colDifference')}</span></div>
          {d.revaluations.map((r) => (
            <div key={r.account} className="fr">
              <span><span className="mono">{r.account}</span> {r.label}</span>
              <span className="r mono">{r.currency} {fmt(r.native)}</span>
              {r.status === 'no-rate' ? <span className="r m" style={{ gridColumn: 'span 4' }}>{t('yearClose.fxNoRate')}</span> : (
                <>
                  <span className="r mono" title={r.rate.source}>{r.rate.rate}</span>
                  <span className="r mono">{fmt(r.targetChf)}</span>
                  <span className="r mono">{fmt(r.bookChf)}</span>
                  <span className={`r mono${r.status === 'booked' ? ' pos' : ''}`}>{fmt(r.difference)}{r.status === 'booked' ? ` ${t('yearClose.fxBooked')}` : ''}</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {canEdit && toBook && !locked && (
        <p><button type="button" className="btn" onClick={() => act(nav, () => api.bookRevaluation(d.year), t('close.fxBookedToast'))}>{t('yearClose.fxBook')}</button> <span className="m">{t('close.fxRebook')}</span></p>
      )}
      <h3>{t('yearClose.sectionResult')}</h3>
      <p className="m">{t(chargesVat() ? 'yearClose.resultIntro' : 'yearClose.resultIntroNoVat')}</p>
      <div className="ftab sums">
        <div className="fr"><span className="m">{t('yearClose.totalAssets')}</span><span className="r mono">{fmt(l.totalAssets)}</span></div>
        <div className="fr"><span className="m">{t('yearClose.totalLiabilities')}</span><span className="r mono">{fmt(l.totalLiabilities)}</span></div>
        <div className="fr tot"><span>{t(l.result >= 0 ? 'yearClose.profit' : 'yearClose.loss')}</span><span className="r mono">{fmt(Math.abs(l.result))}</span></div>
      </div>
      {l.balanced ? <p className="okline">{I.check}{t('yearClose.balanced')}</p> : <p className="warnline">{I.dot}{[...(l.residual === 0 ? [] : [t('yearClose.unbalanced', { amount: fmt(l.residual) })]), ...l.causes.map(causeText)].join(' · ')}</p>}
      {l.causes.map((c, i) => <p key={i} className="m">{causeText(c)}</p>)}
      <h3>{t('close.step.close', { year: d.year })}</h3>
      {d.closed ? <p className="okline">{I.check}{t('yearClose.closedNote', { date: formatDate(d.state.closedAt), year: d.year, period: lastPeriodOf(d.year) })}</p> : (
        <>
          <button type="button" className="btn primary big" disabled={!canEdit || block.length > 0} onClick={() => setAsking(true)}>{t('close.step.close', { year: d.year })}</button>
          {block.length > 0 && (
            <>
              <p className="m">{t('close.lockedWhile', { n: block.length })}</p>
              <ul className="blk">{block.map((b, i) => <li key={i}>{problemText(b, d.year)}</li>)}</ul>
            </>
          )}
        </>
      )}
      {asking && <Confirm title={t('close.step.close', { year: d.year })} text={t('yearClose.closeConfirm', { year: d.year })} ok={t('close.closeNow')} onOk={run} onCancel={() => setAsking(false)} />}
    </>
  );
}

function Confirm({ title, text, ok, onOk, onCancel }: { title: string; text: string; ok: string; onOk(): void; onCancel(): void }) {
  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 40%, transparent)' }} onClick={onCancel} />
      <div className="palette confirm" role="alertdialog" aria-label={title} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
        <h2>{title}</h2>
        <p>{text}</p>
        <div className="acts" style={{ marginTop: 16 }}>
          <button type="button" className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="button" className="btn primary" autoFocus onClick={onOk}>{ok} <span className="k">↵</span></button>
        </div>
      </div>
    </>
  );
}

function Open({ d, books, nav, canEdit }: StepProps) {
  const next = String(+d.year + 1);
  const names = getAccountMap();
  const re = d.accounts.retainedEarnings;
  const o = d.opening;
  const lead = <p className="lead">{t('close.openLead', { year: next, account: re })}</p>;
  if (!d.closed || !o) {
    const before = books.config?.openingBalances?.[d.year]?.[re] ?? 0;
    return (
      <>
        {lead}
        <div className="prev">
          <div className="ph">{t('close.previewAsOf', { date: formatDate(localToday()) })}</div>
          <dl className="kv2">
            <dt>{t('close.balanceTotal')}</dt><dd className="mono">{fmt(d.ledger.totalAssets)}</dd>
            <dt>{t('close.resultSoFar', { year: d.year })}</dt><dd className="mono">{fmt(d.ledger.result)}</dd>
            <dt>{t('close.retainedToday', { account: re })}</dt><dd className="mono">{fmt(before)}</dd>
            <dt>{t('close.retainedNew', { account: re })}</dt><dd className="mono"><b>{fmt(before + d.ledger.result)}</b></dd>
          </dl>
          {d.ledger.residual !== 0 && <p className="warnline">{I.dot}{t('close.openChecks', { amount: fmt(d.ledger.residual) })}</p>}
        </div>
        <p className="m">{t('close.openAfterClose', { year: d.year })}</p>
      </>
    );
  }
  return (
    <>
      {lead}
      <div className="ftab">
        <div className="fh"><span>{t('yearClose.colAccount')}</span><span>{t('company.accountName')}</span><span /><span className="r">{t('close.openingOn', { date: `1.1.${next}` })}</span></div>
        {Object.entries(o.balances).map(([a, v]) => (
          <div key={a} className="fr">
            <span className="mono">{a}</span><span>{names[a] ?? ''}</span>
            <span className="m mono">{o.native[a] ? `${o.native[a].currency} ${fmt(o.native[a].amount)}` : ''}</span>
            <span className="r mono">{fmt(v)}</span>
          </div>
        ))}
        <div className="fr tot"><span /><span>{t('yearClose.totalAssets')}</span><span /><span className="r mono">{fmt(o.totalAssets)}</span></div>
        <div className="fr tot"><span /><span>{t('yearClose.totalLiabilities')}</span><span /><span className="r mono">{fmt(o.totalLiabilities)}</span></div>
      </div>
      {o.causes.map((c, i) => <p key={i} className="warnline">{I.dot}{causeText(c)}</p>)}
      {d.opened && <p className="okline">{I.check}{t('yearClose.openedNote', { date: formatDate(d.state.openedAt) })}</p>}
      {canEdit && (
        <p><button type="button" className="btn primary" disabled={o.residual !== 0} onClick={() => act(nav, () => api.openYear(d.year), t('close.openedToast', { year: next }))}>
          {d.opened ? t('yearClose.update') : t('yearClose.open')}
        </button></p>
      )}
    </>
  );
}

function Profit({ d, nav, canEdit }: StepProps) {
  const next = String(+d.year + 1);
  const [date, setDate] = useState(`${next}-06-30`);
  const [reserve, setReserve] = useState('');
  const [dividend, setDividend] = useState('');
  const result = d.ledger.result;
  const r = num(reserve);
  const split = dividendSplit(num(dividend));
  const rest = Math.round((result - r - num(dividend)) * 100) / 100;
  const lines = [
    { amount: r, accountCredit: '2950', description: t('yearClose.allocation.reserveText', { year: d.year }) },
    { amount: split.net, accountCredit: '2451', description: t('yearClose.allocation.dividendText', { year: d.year }) },
    { amount: split.withholdingTax, accountCredit: '2206', description: t('yearClose.allocation.taxText', { year: d.year }) },
  ].filter((l) => l.amount > 0);
  const ready = canEdit && d.closed && lines.length > 0 && date >= `${next}-01-01`;
  async function book() {
    const ids: string[] = [];
    const ok = await act(nav, async () => {
      for (const l of lines) ids.push((await api.bookYearEndEntry(next, { date, accountDebit: d.accounts.retainedEarnings, accountCredit: l.accountCredit, amount: l.amount, description: l.description, template: 'profitAllocation' })).entry.id);
    }, t('close.allocationBooked', { n: lines.length }), async () => { for (const id of ids) await api.deleteJournalEntry(id); });
    if (ok) { setReserve(''); setDividend(''); }
  }
  const row = (label: ReactNode, value: ReactNode, cls = '') => <div className={`gvrow ${cls}`}><span>{label}</span>{value}</div>;
  return (
    <>
      <p className="lead">{t('close.profitLead')}</p>
      <div className="gv">
        {row(<>{t('close.result', { year: d.year })} {!d.closed && <span className="m">{t('close.soFar')}</span>}</>, <b className="mono">{fmt(result)}</b>)}
        <label className="gvrow"><span>{t('close.resolutionDate')}</span><input type="date" value={date} min={`${next}-01-01`} onChange={(e) => setDate(e.target.value)} disabled={!canEdit} /></label>
        <label className="gvrow"><span>{t('close.reserve')} <span className="mono m">2950</span></span><input className="mono" inputMode="decimal" placeholder="0.00" value={reserve} onChange={(e) => setReserve(e.target.value)} disabled={!canEdit} /></label>
        <label className="gvrow"><span>{t('close.dividend')}</span><input className="mono" inputMode="decimal" placeholder="0.00" value={dividend} onChange={(e) => setDividend(e.target.value)} disabled={!canEdit} /></label>
        {row(<>{t('close.withholding')} <span className="mono m">2206</span></>, <span className="mono">{fmt(split.withholdingTax)}</span>, 'sub')}
        {row(<>{t('close.toShareholder')} <span className="mono m">2451</span></>, <span className="mono">{fmt(split.net)}</span>, 'sub')}
        {row(<>{t('close.staysRetained')} <span className="mono m">{d.accounts.retainedEarnings}</span></>, <b className={`mono${rest < 0 ? ' neg' : ''}`}>{fmt(rest)}</b>, 'tot')}
      </div>
      <p className="m">{t('close.withholdingDue')}</p>
      <p>
        <button type="button" className="btn" disabled={!ready} onClick={book}>{t('yearClose.allocation.book')}</button>{' '}
        {!d.closed && <span className="m">{t('close.afterResolution')}</span>}
      </p>
    </>
  );
}

function Handover({ d, nav }: StepProps) {
  const year = parsePeriod(d.year, localToday())!;
  const ui = useShellUi();
  return (
    <>
      <p className="lead">{t('close.handoverLead')}</p>
      <div className="hand">
        <button type="button" className="hcard" onClick={() => nav.go({ route: { area: 'reports', report: 'balance' }, query: { period: year } })}>
          <b>{t('close.handReports', { year: d.year })}</b><span>{t('close.handReportsText')}</span>
        </button>
        <button type="button" className="hcard" onClick={() => ui.openExport({ period: d.year, items: { journal: ['banana'] }, sums: false, oneBook: false, preset: null })}>
          <b>{t('close.handBanana', { year: d.year })}</b><span>{t('close.handBananaText')}</span>
        </button>
        <button type="button" className="hcard" onClick={() => ui.openExport(configOf('audit', year, year, d.year))}>
          <b>{t('close.handAudit', { year: d.year })}</b><span>{t('close.handAuditText')}</span>
        </button>
      </div>
    </>
  );
}
