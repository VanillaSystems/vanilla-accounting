import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleDashed, Lock, MinusCircle, RefreshCw, XCircle } from 'lucide-react';
import type { Period } from '../../accounting/periods.js';
import { dividendSplit, type EntryTemplate, type Problem, type YearClose } from '../../accounting/year-close.js';
import type { Opening } from '../../accounting/year-close.js';
import { api, errorText, orAlert, type YearCloseView } from '../lib/api.js';
import { getAccounts } from '../lib/accounts.js';
import { cn, fmt, formatDate } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { AccountCombobox } from './account-combobox.js';

/** A key built from a code the API sends (a problem, a check, a template): its placeholders vary with the code. */
const tx = t as unknown as (key: string, vars?: Record<string, string | number>) => string;

const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;

function problemText(p: Problem, year: string): string {
  switch (p.code) {
    case 'q4NotFiled': return tx('yearClose.problem.q4NotFiled', { quarter: p.quarter, year });
    case 'balanceDiffers': return tx('yearClose.problem.balanceDiffers', { ...p, book: fmt(p.book), bank: fmt(p.bank), date: formatDate(p.date) });
    case 'statementGap': return tx('yearClose.problem.statementGap', { ...p, from: formatDate(p.from), to: formatDate(p.to) });
    case 'unbooked': return tx('yearClose.problem.unbooked', { n: p.count, refs: p.refs.join(', ') + (p.count > p.refs.length ? ', …' : '') });
    case 'fxToBook': return tx('yearClose.problem.fxToBook', { account: p.account, difference: signed(p.difference) });
    case 'undecided': return tx('yearClose.problem.undecided', { templates: p.templates.map((id) => tx(`yearClose.template.${id}`)).join(', ') });
    case 'unbalanced': return tx('yearClose.problem.unbalanced', { residual: fmt(p.residual) });
    default: return tx(`yearClose.problem.${p.code}`, p as unknown as Record<string, string>);
  }
}

type Cause = YearClose['ledger']['causes'][number] | Opening['causes'][number];

function causeText(c: Cause): string {
  switch (c.code) {
    case 'oneLeg': return tx('yearClose.cause.oneLeg', { amount: fmt(c.amount), entries: c.entryIds.join(', ') });
    case 'notRevalued': return tx('yearClose.cause.notRevalued', { ...c, actual: fmt(c.actual), expected: fmt(c.expected) });
    default: return tx(`yearClose.cause.${c.code}`, { ...c, amount: fmt(c.amount) });
  }
}

function Section({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-foreground mb-1">{title}</h2>
      {intro && <p className="text-xs text-muted-foreground mb-2">{intro}</p>}
      {children}
    </section>
  );
}

function StatusIcon({ ok, warn }: { ok: boolean; warn?: boolean }) {
  if (ok) return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />;
  if (warn) return <CircleDashed className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />;
  return <XCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />;
}

interface Draft { date: string; accountDebit: string; accountCredit: string; amount: string; vatCode: string; description: string }

/** A manual entry, prefilled from a year-end template. */
function EntryForm({ year, template, onDone }: { year: string; template: EntryTemplate; onDone: () => void }) {
  const [draft, setDraft] = useState<Draft>({
    date: `${year}-12-31`,
    accountDebit: template.accountDebit,
    accountCredit: template.accountCredit,
    amount: '',
    vatCode: template.vatCode ?? '',
    description: tx(`yearClose.template.${template.id}`),
  });
  const [saving, setSaving] = useState(false);
  const accounts = getAccounts();
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(draft.date) && Number(draft.amount) > 0 && (draft.accountDebit || draft.accountCredit) && draft.description.trim();

  async function save() {
    setSaving(true);
    const ok = await orAlert(api.bookYearEndEntry(year, {
      date: draft.date, accountDebit: draft.accountDebit, accountCredit: draft.accountCredit,
      amount: Number(draft.amount), vatCode: draft.vatCode || undefined, description: draft.description, template: template.id,
    }));
    setSaving(false);
    if (ok) onDone();
  }

  const label = 'text-xs text-muted-foreground';
  const input = 'w-full text-sm border border-input rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring';
  return (
    <div className="mt-2 p-3 border border-border rounded bg-muted grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
      <span className={label}>{t('yearClose.form.date')}</span>
      <input type="date" className={cn(input, 'w-44')} value={draft.date} onChange={(e) => set({ date: e.target.value })} />
      <span className={label}>{t('yearClose.form.debit')}</span>
      <AccountCombobox accounts={accounts} allAccounts={accounts} value={draft.accountDebit} onChange={(accountDebit) => set({ accountDebit })} />
      <span className={label}>{t('yearClose.form.credit')}</span>
      <AccountCombobox accounts={accounts} allAccounts={accounts} value={draft.accountCredit} onChange={(accountCredit) => set({ accountCredit })} />
      <span className={label}>{t('yearClose.form.amount')}</span>
      <input inputMode="decimal" className={cn(input, 'w-44 text-right font-mono')} value={draft.amount} onChange={(e) => set({ amount: e.target.value })} />
      <span className={label}>{t('yearClose.form.vatCode')}</span>
      <input className={cn(input, 'w-44 font-mono')} value={draft.vatCode} onChange={(e) => set({ vatCode: e.target.value })} />
      <span className={label}>{t('yearClose.form.description')}</span>
      <input className={input} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
      <span />
      <div className="flex gap-2">
        <button disabled={!valid || saving} onClick={save} className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50">
          {saving ? t('common.saving') : t('yearClose.form.save')}
        </button>
        <button onClick={onDone} className="px-3 py-1 text-xs rounded border border-border text-muted-foreground hover:bg-accent">{t('common.cancel')}</button>
      </div>
    </div>
  );
}

/** Reserve and dividend after the shareholders' resolution: up to three entries, dated in the new year. */
function ProfitAllocation({ year, onDone }: { year: string; onDone: () => void }) {
  const next = String(+year + 1);
  const [date, setDate] = useState(`${next}-06-30`);
  const [reserve, setReserve] = useState('');
  const [dividend, setDividend] = useState('');
  const [saving, setSaving] = useState(false);
  const split = dividendSplit(Number(dividend) || 0);
  const lines = [
    { amount: Number(reserve) || 0, accountCredit: '2950', description: t('yearClose.allocation.reserveText', { year }) },
    { amount: split.net, accountCredit: '2451', description: t('yearClose.allocation.dividendText', { year }) },
    { amount: split.withholdingTax, accountCredit: '2206', description: t('yearClose.allocation.taxText', { year }) },
  ].filter((l) => l.amount > 0);

  async function book() {
    setSaving(true);
    for (const l of lines) {
      if (!await orAlert(api.bookYearEndEntry(next, { date, accountDebit: '2970', accountCredit: l.accountCredit, amount: l.amount, description: l.description, template: 'profitAllocation' }))) break;
    }
    setSaving(false);
    setReserve('');
    setDividend('');
    onDone();
  }

  const input = 'text-sm border border-input rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring';
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center max-w-xl">
      <span className="text-xs text-muted-foreground">{t('yearClose.form.date')}</span>
      <input type="date" className={cn(input, 'w-44')} value={date} min={`${next}-01-01`} onChange={(e) => setDate(e.target.value)} />
      <span className="text-xs text-muted-foreground">{t('yearClose.allocation.reserve')}</span>
      <input inputMode="decimal" className={cn(input, 'w-44 text-right font-mono')} value={reserve} onChange={(e) => setReserve(e.target.value)} />
      <span className="text-xs text-muted-foreground">{t('yearClose.allocation.dividend')}</span>
      <input inputMode="decimal" className={cn(input, 'w-44 text-right font-mono')} value={dividend} onChange={(e) => setDividend(e.target.value)} />
      <span />
      <span className="text-xs text-muted-foreground">{t('yearClose.allocation.split', { net: fmt(split.net), tax: fmt(split.withholdingTax) })}</span>
      <span />
      <button disabled={!lines.length || saving || date < `${next}-01-01`} onClick={book} className="justify-self-start px-3 py-1 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50">
        {t('yearClose.allocation.book')}
      </button>
    </div>
  );
}

export function YearCloseTab({ period, canEdit, onRefresh }: { period: Period; canEdit: boolean; onRefresh: () => void }) {
  const year = (period.kind === 'all' ? new Date().toISOString() : period.from).slice(0, 4);
  const [data, setData] = useState<YearCloseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.yearClose(year).then(setData, (e) => setError(errorText(e)));
  }, [year]);
  useEffect(() => { setData(null); load(); }, [load]);

  async function run(call: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    await orAlert(call());
    setBusy(false);
    load();
    onRefresh();
  }

  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>;
  if (!data) return <div className="p-6 text-sm text-muted-foreground">{t('yearClose.loading')}</div>;

  const { checks, revaluations, vat, templates, ledger, blockers, accounts, opening } = data;
  const locked = !!data.closedThrough && data.closedThrough >= `${year}-12-31`;
  const toBook = revaluations.some((r) => r.status === 'to-book');
  const next = String(+year + 1);
  const button = 'px-3 py-1.5 text-xs rounded disabled:opacity-50';
  const th = 'px-2 py-1 font-medium';
  const td = 'px-2 py-1 font-mono tabular-nums text-right';

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-lg font-semibold text-foreground">{t('yearClose.title', { year })}</h1>
          <span className={cn('text-xs px-2 py-0.5 rounded-full', data.closed ? 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200' : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200')}>
            {data.closed ? <><Lock className="inline h-3 w-3 mr-1" />{t('yearClose.statusClosed', { date: formatDate(data.state.closedAt) })}</> : t('yearClose.statusOpen')}
          </span>
          <button onClick={load} className="ml-auto p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground" title={t('yearClose.loading')}><RefreshCw className="h-4 w-4" /></button>
        </div>
        <p className="text-xs text-muted-foreground mb-5">{t('yearClose.yearHint')}</p>

        <Section title={t('yearClose.sectionChecks')}>
          <ul className="space-y-1.5">
            {checks.map((c) => (
              <li key={c.id} data-check={c.id} className="flex gap-2 text-sm">
                <StatusIcon ok={c.status === 'ok'} />
                <div>
                  <div className="text-foreground">{tx(`yearClose.check.${c.id}`)}</div>
                  {c.problems.map((p, i) => <div key={i} className="text-xs text-muted-foreground">{problemText(p, year)}</div>)}
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t('yearClose.sectionFx')} intro={t('yearClose.fxIntro', { account: accounts.fxDifference })}>
          {revaluations.length === 0 ? <p className="text-xs text-muted-foreground">{t('yearClose.fxNone')}</p> : (
            <table className="w-full text-sm border border-border">
              <thead>
                <tr className="text-xs text-muted-foreground bg-muted">
                  <th className={cn(th, 'text-left')}>{t('yearClose.colAccount')}</th>
                  <th className={cn(th, 'text-right')}>{t('yearClose.colNative')}</th>
                  <th className={cn(th, 'text-right')}>{t('yearClose.colRate')}</th>
                  <th className={cn(th, 'text-right')}>{t('yearClose.colTarget')}</th>
                  <th className={cn(th, 'text-right')}>{t('yearClose.colBook')}</th>
                  <th className={cn(th, 'text-right')}>{t('yearClose.colDifference')}</th>
                </tr>
              </thead>
              <tbody>
                {revaluations.map((r) => (
                  <tr key={r.account} className="border-t border-border/50">
                    <td className="px-2 py-1">{r.account} {r.label}</td>
                    <td className={td}>{r.currency} {fmt(r.native)}</td>
                    {r.status === 'no-rate' ? (
                      <td colSpan={4} className="px-2 py-1 text-xs text-amber-700 dark:text-amber-300 text-right">{t('yearClose.fxNoRate')}</td>
                    ) : (
                      <>
                        <td className={td} title={r.rate.source}>{r.rate.rate}</td>
                        <td className={td}>{fmt(r.targetChf)}</td>
                        <td className={td}>{fmt(r.bookChf)}</td>
                        <td className={cn(td, 'font-semibold')}>
                          {signed(r.difference)}
                          {r.status === 'booked' && <span className="ml-1 text-xs font-sans font-normal text-green-700 dark:text-green-300">{t('yearClose.fxBooked')}</span>}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {canEdit && toBook && !locked && (
            <button disabled={busy} onClick={() => run(() => api.bookRevaluation(year))} className={cn(button, 'mt-2 bg-primary text-primary-foreground')}>{t('yearClose.fxBook')}</button>
          )}
        </Section>

        <Section title={t('yearClose.sectionVat')} intro={t('yearClose.vatIntro', { account: accounts.vatSettlement })}>
          <table className="w-full text-sm border border-border mb-2">
            <thead>
              <tr className="text-xs text-muted-foreground bg-muted">
                <th className={cn(th, 'text-left')}>{t('yearClose.colQuarter')}</th>
                <th className={cn(th, 'text-right')}>{t('yearClose.colFiled')}</th>
                <th className={cn(th, 'text-right')}>{t('yearClose.colBooks')}</th>
                <th className={cn(th, 'text-right')}>{t('yearClose.colCorrection')}</th>
              </tr>
            </thead>
            <tbody>
              {vat.quarters.map((q) => (
                <tr key={q.quarter} className="border-t border-border/50">
                  <td className="px-2 py-1">{q.quarter}</td>
                  <td className={td}>{q.filed === undefined ? <span className="font-sans text-xs text-muted-foreground">{t('yearClose.notFiled')}</span> : fmt(q.filed)}</td>
                  <td className={td}>{fmt(q.books)}</td>
                  <td className={cn(td, q.filed !== undefined && q.correction !== 0 && 'text-amber-800 dark:text-amber-200 font-semibold')}>{q.filed === undefined || q.correction === 0 ? '—' : signed(q.correction)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="text-sm">
            <tbody>
              {([['yearClose.vatOpening', vat.opening], ['yearClose.vatBooked', vat.booked], ['yearClose.vatPaid', vat.paid], ['yearClose.vatOwed', vat.owed], ['yearClose.vatExpected', vat.expected], ['yearClose.vatRounding', vat.rounding]] as const).map(([key, value]) => (
                <tr key={key}><td className="pr-6 py-0.5 text-muted-foreground">{t(key)}</td><td className={td}>{fmt(value)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className={cn('mt-2 text-xs flex gap-1.5 items-start', vat.unexplained === 0 ? 'text-green-700 dark:text-green-300' : 'text-amber-800 dark:text-amber-200')}>
            <StatusIcon ok={vat.unexplained === 0} warn />
            {vat.unexplained === 0 ? t('yearClose.vatExplained') : t('yearClose.vatUnexplained', { amount: fmt(vat.unexplained) })}
          </p>
        </Section>

        <Section title={t('yearClose.sectionEntries')} intro={t('yearClose.entriesIntro')}>
          <ul className="divide-y divide-border border border-border rounded">
            {templates.map((tp) => (
              <li key={tp.id} data-template={tp.id} className="px-3 py-2">
                <div className="flex items-start gap-2">
                  {tp.state === 'done' ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
                    : tp.state === 'na' ? <MinusCircle className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                    : <CircleDashed className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground">
                      {tx(`yearClose.template.${tp.id}`)}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{tp.accountDebit || '…'} / {tp.accountCredit || '…'}{tp.vatCode ? ` ${tp.vatCode}` : ''}</span>
                      {tp.state && <span className="ml-2 text-xs text-muted-foreground">{t(tp.state === 'done' ? 'yearClose.stateDone' : 'yearClose.stateNa')}</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">{tx(`yearClose.templateHint.${tp.id}`)}</div>
                  </div>
                  {canEdit && !data.closed && (
                    <div className="flex gap-1 shrink-0">
                      {!locked && <button onClick={() => setForm(form === tp.id ? null : tp.id)} className={cn(button, 'border border-border hover:bg-accent')}>{t('yearClose.book')}</button>}
                      {tp.state ? (
                        <button disabled={busy} onClick={() => run(() => api.markYearEndEntry(year, tp.id, null))} className={cn(button, 'text-muted-foreground hover:bg-accent')}>{t('yearClose.markReset')}</button>
                      ) : (
                        <>
                          <button disabled={busy} onClick={() => run(() => api.markYearEndEntry(year, tp.id, 'done'))} className={cn(button, 'text-muted-foreground hover:bg-accent')}>{t('yearClose.markDone')}</button>
                          <button disabled={busy} onClick={() => run(() => api.markYearEndEntry(year, tp.id, 'na'))} className={cn(button, 'text-muted-foreground hover:bg-accent')}>{t('yearClose.markNa')}</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {form === tp.id && <EntryForm year={year} template={tp} onDone={() => { setForm(null); load(); onRefresh(); }} />}
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t('yearClose.sectionResult')} intro={t('yearClose.resultIntro')}>
          <table className="text-sm mb-2">
            <tbody>
              <tr><td className="pr-6 py-0.5 text-muted-foreground">{t('yearClose.totalAssets')}</td><td className={td}>{fmt(ledger.totalAssets)}</td></tr>
              <tr><td className="pr-6 py-0.5 text-muted-foreground">{t('yearClose.totalLiabilities')}</td><td className={td}>{fmt(ledger.totalLiabilities)}</td></tr>
              <tr><td className="pr-6 py-0.5 text-muted-foreground">{t(ledger.result >= 0 ? 'yearClose.profit' : 'yearClose.loss')}</td><td className={cn(td, 'font-semibold')}>{fmt(Math.abs(ledger.result))}</td></tr>
            </tbody>
          </table>
          <p className="text-xs flex gap-1.5 items-center">
            <StatusIcon ok={ledger.residual === 0} />
            {ledger.residual === 0 ? t('yearClose.balanced') : t('yearClose.unbalanced', { amount: fmt(ledger.residual) })}
          </p>
          {ledger.causes.map((c, i) => <p key={i} className="text-xs text-muted-foreground ml-6">{causeText(c)}</p>)}

          {data.closed ? (
            <p className="mt-3 text-sm text-foreground">{t('yearClose.closedNote', { date: formatDate(data.state.closedAt), year })}</p>
          ) : (
            <div className="mt-3">
              {blockers.length > 0 && (
                <div className="mb-2 p-2 rounded border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
                  <div className="text-xs font-semibold text-amber-900 dark:text-amber-100 mb-1">{t('yearClose.blockers')}</div>
                  {blockers.map((p, i) => <div key={i} className="text-xs text-amber-900 dark:text-amber-100">{problemText(p, year)}</div>)}
                </div>
              )}
              {canEdit && (
                <button disabled={busy || blockers.length > 0} onClick={() => run(() => api.closeYear(year), t('yearClose.closeConfirm', { year }))} className={cn(button, 'bg-primary text-primary-foreground')}>
                  {t('yearClose.close')}
                </button>
              )}
            </div>
          )}
        </Section>

        {data.closed && opening && (
          <Section title={t('yearClose.sectionOpening', { year: next })} intro={t('yearClose.openingIntro', { account: opening.retainedEarnings })}>
            <table className="text-sm border border-border mb-2">
              <tbody>
                {Object.entries(opening.balances).map(([account, value]) => (
                  <tr key={account} className="border-t border-border/50">
                    <td className="px-2 py-0.5 font-mono text-xs text-muted-foreground">{account}</td>
                    <td className="px-2 py-0.5">{getAccounts().find((a) => a.number === account)?.name ?? ''}</td>
                    <td className={td}>{fmt(value)}</td>
                    <td className="px-2 py-0.5 text-xs text-muted-foreground font-mono">{opening.native[account] ? `${opening.native[account].currency} ${fmt(opening.native[account].amount)}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {opening.causes.map((c, i) => <p key={i} className="text-xs text-amber-800 dark:text-amber-200">{causeText(c)}</p>)}
            {data.opened && <p className="text-xs text-muted-foreground mb-2">{t('yearClose.openedNote', { date: formatDate(data.state.openedAt) })}</p>}
            {canEdit && (
              <button disabled={busy || opening.residual !== 0} onClick={() => run(() => api.openYear(year))} className={cn(button, 'bg-primary text-primary-foreground')}>
                {data.opened ? t('yearClose.update') : t('yearClose.open')}
              </button>
            )}
          </Section>
        )}

        {data.closed && canEdit && (
          <Section title={t('yearClose.sectionAllocation')} intro={t('yearClose.allocationIntro')}>
            <ProfitAllocation year={year} onDone={() => { load(); onRefresh(); }} />
          </Section>
        )}
      </div>
    </div>
  );
}
