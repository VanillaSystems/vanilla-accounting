/**
 * The year-end in seven steps (docs/year-end.md), each step's state and the checks of step 2,
 * all read off the close the API computed. Texts in the user's language.
 */
import type { Problem, YearClose } from '../../../accounting/year-close.js';
import type { YearCloseView } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';

export const STEPS = ['q4', 'checks', 'entries', 'close', 'open', 'profit', 'handover'] as const;
export type Step = (typeof STEPS)[number];
export const DEFAULT_STEP: Step = 'checks';
export const stepOf = (s: string | undefined): Step => (STEPS as readonly string[]).includes(s ?? '') ? s as Step : DEFAULT_STEP;
/** A link names a step there is none of (urls.md rule 5). */
export const stepGone = (s: string | undefined): boolean => s !== undefined && !(STEPS as readonly string[]).includes(s);

export const GROUPS = [['close.groupBefore', ['q4', 'checks', 'entries']], ['close.groupClose', ['close', 'open']], ['close.groupAfter', ['profit', 'handover']]] as const;

export function stepLabel(step: Step, year: string): string {
  const next = String(+year + 1);
  switch (step) {
    case 'q4': return t('close.step.q4');
    case 'checks': return t('close.step.checks');
    case 'entries': return t('close.step.entries');
    case 'close': return t('close.step.close', { year });
    case 'open': return t('close.step.open', { year: next });
    case 'profit': return t('close.step.profit');
    case 'handover': return t('close.step.handover');
  }
}

export type State = 'ok' | 'warn' | 'open' | 'later';

/** A key built from a code the API sends (a problem, a template): its placeholders vary with the code. */
export const tx = t as unknown as (key: string, vars?: Record<string, string | number>) => string;
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;

export function problemText(p: Problem, year: string): string {
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

type Cause = YearClose['ledger']['causes'][number] | NonNullable<YearCloseView['opening']>['causes'][number];

export function causeText(c: Cause): string {
  switch (c.code) {
    case 'oneLeg': return tx('yearClose.cause.oneLeg', { amount: fmt(c.amount), entries: c.entryIds.join(', ') });
    case 'notRevalued': return tx('yearClose.cause.notRevalued', { ...c, actual: fmt(c.actual), expected: fmt(c.expected) });
    default: return tx(`yearClose.cause.${c.code}`, { ...c, amount: fmt(c.amount) });
  }
}

/** Where a check leads: another step of the close, or another page. */
export type Go = { step: Step } | { area: 'vat' | 'bank' | 'balance' };

export interface CheckRow { id: string; state: State; label: string; detail: string; go?: Go }

const yearOver = (year: string, today: string) => today > `${year}-12-31`;

/** The checks of step 2: the engine's preconditions, then the Kursdifferenz, the VAT, the entries, open invoices and the balance sheet. */
export function checkRows(d: YearCloseView, today: string): CheckRow[] {
  const year = d.year;
  const over = yearOver(year, today);
  const text = (ps: readonly Problem[]) => ps.map((p) => problemText(p, year)).join(' ');
  const engine = d.checks.map((c): CheckRow => {
    const label = tx(`yearClose.check.${c.id}`);
    if (c.status === 'ok') return { id: c.id, state: 'ok', label, detail: t('close.checkOk') };
    // Before 31.12. a missing year-end balance, statement or Q4 return is not late yet.
    const waits = !over && (c.id === 'q4Filed' || c.id === 'bankReconciled' || c.id === 'statementsComplete');
    const sealedLater = c.id === 'quartersSealed' && c.problems.every((p) => p.code === 'notClosed' || p.code === 'unsealed');
    const state: State = waits ? 'later' : sealedLater ? 'open' : 'warn';
    const go: Go | undefined = c.id === 'quartersSealed' || c.id === 'q4Filed' ? { area: 'vat' } : c.id === 'bankReconciled' || c.id === 'statementsComplete' ? { area: 'bank' } : undefined;
    return { id: c.id, state, label, detail: c.id === 'q4Filed' && waits ? t('close.q4Later', { next: String(+year + 1) }) : text(c.problems), go };
  });

  const toBook = d.revaluations.filter((r) => r.status === 'to-book');
  const noRate = d.revaluations.some((r) => r.status === 'no-rate');
  const fx: CheckRow = {
    id: 'fx', label: t('close.check.fx'), go: { step: 'close' },
    ...(d.revaluations.length === 0 ? { state: 'ok', detail: t('yearClose.fxNone') }
      : noRate ? { state: 'later', detail: t('close.fxLater', { account: d.accounts.fxDifference }) }
      : toBook.length ? { state: 'open', detail: t('close.fxToBook', { n: toBook.length, account: d.accounts.fxDifference }) }
      : { state: 'ok', detail: t('close.fxBooked') }),
  };
  const vat: CheckRow = {
    id: 'vat', label: t('close.check.vat'),
    ...(d.vat.unexplained === 0 ? { state: 'ok', detail: t('yearClose.vatExplained') } : { state: over ? 'warn' : 'later', detail: t('yearClose.vatUnexplained', { amount: fmt(d.vat.unexplained) }) }),
  };
  const decided = d.templates.filter((tp) => tp.state).length;
  const entries: CheckRow = { id: 'entries', label: t('close.step.entries'), state: decided === d.templates.length ? 'ok' : 'open', detail: t('close.entriesDone', { done: decided, n: d.templates.length }), go: { step: 'entries' } };
  const r = d.receivables;
  const invoices: CheckRow = r.invoices.length
    ? { id: 'invoices', label: t('close.check.invoices'), state: d.templates.find((tp) => tp.id === 'receivables')?.state ? 'ok' : 'open', detail: t('close.invoicesOpen', { n: r.invoices.length, amount: fmt(r.total) }), go: { step: 'entries' } }
    : { id: 'invoices', label: t('close.check.invoices'), state: 'ok', detail: t('close.invoicesNone') };
  const l = d.ledger;
  const balance: CheckRow = l.residual === 0
    ? { id: 'balance', label: t('close.check.balance'), state: 'ok', detail: t('yearClose.balanced') }
    : { id: 'balance', label: t('close.check.balance'), state: 'warn', detail: [t('yearClose.unbalanced', { amount: fmt(l.residual) }), ...l.causes.map(causeText)].join(' · '), go: { area: 'balance' } };
  return [...engine, fx, vat, entries, invoices, balance];
}

/** What still keeps "Jahr abschliessen" shut, besides the Kursdifferenz the close books itself. */
export const closeBlockers = (d: YearCloseView): Problem[] => d.blockers.filter((p) => p.code !== 'fxToBook');

export function stepState(step: Step, d: YearCloseView | undefined, today: string): [State, string] {
  if (!d) return ['later', ''];
  const next = String(+d.year + 1);
  switch (step) {
    case 'q4': {
      const filed = d.checks.find((c) => c.id === 'q4Filed')?.status === 'ok';
      return filed ? ['ok', t('close.filed')] : yearOver(d.year, today) ? ['open', t('close.dueOn', { date: formatDate(`${next}-03-01`) })] : ['later', t('close.fromDate', { date: formatDate(`${next}-01-01`) })];
    }
    case 'checks': {
      const rows = checkRows(d, today);
      const warn = rows.filter((r) => r.state === 'warn').length;
      const open = rows.filter((r) => r.state === 'open').length;
      return warn ? ['warn', t('close.hints', { n: warn })] : open ? ['open', t('close.openN', { n: open })] : ['ok', t('close.allDone')];
    }
    case 'entries': {
      const done = d.templates.filter((tp) => tp.state).length;
      return done === d.templates.length ? ['ok', t('close.done')] : ['open', t('close.nOfM', { done, n: d.templates.length })];
    }
    case 'close':
      return d.closed ? ['ok', t('close.closedOn', { date: formatDate(d.state.closedAt) })] : closeBlockers(d).length ? ['later', t('close.locked')] : ['open', t('close.ready')];
    case 'open':
      return d.opened ? ['ok', t('close.openedOn', { date: formatDate(d.state.openedAt) })] : d.closed ? ['open', t('close.ready')] : ['later', t('close.afterClose')];
    case 'profit':
      return ['later', t('close.until', { date: formatDate(`${next}-06-30`) })];
    case 'handover':
      return ['open', t('close.anytime')];
  }
}
