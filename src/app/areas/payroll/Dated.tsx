/**
 * The one field for a dated value (docs/specs/domain-model.md §5.6): the value that holds today with
 * «ab TT.MM.JJJJ», a planned one below it, a fold «Verlauf» with the earlier ones; «Ändern» asks the new
 * value and «gilt ab». A change a closed payslip would compute otherwise shows the card of §19.3 before
 * anything is saved: «Rückwirkende Korrektur» first, «Wieder öffnen» where offered, «So lassen».
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { entryOn, planned, type DatedEntry } from '../../../core/dated.js';
import { t } from '../../i18n/index.js';
import { errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import type { Nav } from '../index.js';
import { payrollApi, reloadPayroll, type Backdated, type Saved } from './data.js';
import { monthText, rateWarningText } from './words.js';

/** One input of a value's form. */
export interface FieldDef {
  k: string; label: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'check';
  options?: ReadonlyArray<readonly [string, string]>;
  mono?: boolean; wide?: boolean; hint?: string;
}

/** How a value is shown, and read from and written into its form. */
export interface ValueSpec<T> {
  fields: FieldDef[];
  from(v: T | undefined): Record<string, string>;
  to(f: Record<string, string>): unknown;
  show(v: T): ReactNode;
}

export type Form = Record<string, string>;

/** The inputs of a form, in the app's form grid. */
export function Fields({ fields, f, set }: { fields: FieldDef[]; f: Form; set(f: Form): void }) {
  return (
    <>
      {fields.map((d) => (
        <label key={d.k} className={`${d.wide ? 'wide' : ''}${d.type === 'check' ? ' check' : ''}`}>
          {d.type === 'check' ? (
            <><input type="checkbox" name={d.k} checked={f[d.k] === 'true'} onChange={(e) => set({ ...f, [d.k]: String(e.target.checked) })} />{d.label}</>
          ) : (
            <>
              {d.label}
              {d.type === 'select' ? (
                <select name={d.k} value={f[d.k] ?? ''} onChange={(e) => set({ ...f, [d.k]: e.target.value })}>
                  {d.options?.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              ) : (
                <input name={d.k} type={d.type === 'date' ? 'date' : 'text'} inputMode={d.type === 'number' ? 'decimal' : undefined} className={d.mono || d.type === 'number' ? 'mono' : ''}
                  value={f[d.k] ?? ''} onChange={(e) => set({ ...f, [d.k]: e.target.value })} />
              )}
            </>
          )}
          {d.hint ? <span className="fhint">{d.hint}</span> : null}
        </label>
      ))}
    </>
  );
}

/** A number as typed: «8'600», «0,5», «1.2» → 8600, 0.5, 1.2; empty → undefined. */
export function numberOf(s: string | undefined): number | undefined {
  const x = (s ?? '').trim().replace(/['’\s]/g, '').replace(',', '.');
  if (!x) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}
export const numText = (n: number | undefined): string => (n === undefined ? '' : String(n));

/** The card of §19.3 and the ways on; `act` sends the change again with the chosen way. */
export function useBackdated(nav: Nav, kind?: string) {
  const [card, setCard] = useState<{ res: Extract<Saved, { saved: false }>; retry(how: Backdated): Promise<Saved>; done?(): void } | null>(null);
  const finish = async (r: Saved, done?: () => void) => {
    if (!r.saved) return;
    setCard(null);
    // A rate outside its range is said with the save, never refused (§18).
    const warn = kind && r.warnings.length ? ` ${r.warnings.map((w) => rateWarningText(kind, w)).join(' · ')}` : '';
    nav.toast((r.corrections.length ? t('payroll.saved.corrections', { n: r.corrections.length }) : t('payroll.saved')) + warn);
    await reloadPayroll();
    done?.();
  };
  /** Sends a change; a card comes back instead when a closed payslip computes otherwise. True once saved. */
  const send = async (call: (how?: Backdated) => Promise<Saved>, done?: () => void): Promise<boolean> => {
    try {
      const r = await call();
      if (!r.saved) { setCard({ res: r, retry: call, done }); return false; }
      await finish(r, done);
      return true;
    } catch (e) { nav.toast(errorText(e)); return false; }
  };
  const choose = async (how: Backdated, reopen?: string) => {
    if (!card) return;
    try {
      // «Wieder öffnen»: the month opens first; the change then touches no closed payslip and saves alone. A refused reopening saves nothing.
      if (reopen) await payrollApi.reopen(reopen);
      const r = await card.retry(how);
      if (!r.saved) { setCard({ ...card, res: r }); return; }
      await finish(r, card.done);
    } catch (e) { nav.toast(errorText(e)); }
  };
  const node = card ? <BackdatedCard res={card.res} onChoose={choose} onCancel={() => setCard(null)} /> : null;
  return { send, node, open: !!card };
}

const signed = (x: number): string => `${x > 0 ? '+' : ''}${fmt(x)}`;

function BackdatedCard({ res, onChoose, onCancel }: { res: Extract<Saved, { saved: false }>; onChoose(how: Backdated, reopen?: string): Promise<void>; onCancel(): void }) {
  const closedPeriod = res.affected.some((a) => a.closedPeriod);
  return (
    <div className="pcard warnpanel" role="alert" data-testid="backdated-card">
      <h4>{t('payroll.backdated.title', { n: res.affected.length })}</h4>
      {res.affected.map((a) => (
        <div key={a.payslip} className="affected">
          <b>{t('payroll.backdated.payslip', { month: monthText(a.month), name: a.name })}</b>{a.closedPeriod ? <span className="m"> · {t('payroll.backdated.closedPeriod')}</span> : null}
          <ul>
            {a.differences.filter((d) => d.carry).map((d) => (
              <li key={`${d.wageType}|${d.side}`}>
                {t('payroll.backdated.line', { label: d.label, before: fmt(d.before), after: fmt(d.after), diff: signed(d.diff) })}
              </li>
            ))}
            {a.differences.some((d) => !d.carry) ? (
              <li className="m">{t('payroll.backdated.follows', { list: a.differences.filter((d) => !d.carry).map((d) => `${d.label} ${signed(d.diff)}`).join(', ') })}</li>
            ) : null}
          </ul>
        </div>
      ))}
      <p className="m">{t('payroll.backdated.rule')}</p>
      <div className="acts">
        <AsyncButton type="button" className="btn primary" onClick={() => onChoose('correct')}>{t('payroll.backdated.correct')}</AsyncButton>
        {res.reopen ? <AsyncButton type="button" className="btn" onClick={() => onChoose('keep', res.reopen)}>{t('payroll.backdated.reopen')}</AsyncButton> : null}
        {closedPeriod ? null : <AsyncButton type="button" className="btn" onClick={() => onChoose('keep')}>{t('payroll.backdated.keep')}</AsyncButton>}
        <button type="button" className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      <p className="m">{t(closedPeriod ? 'payroll.backdated.waysClosed' : 'payroll.backdated.ways')}</p>
    </div>
  );
}

interface DatedProps<T> {
  label: string;
  path: string;
  history: readonly DatedEntry<T>[] | undefined;
  spec: ValueSpec<T>;
  today: string;
  defaultFrom: string;
  /** `path|validFrom|enteredAt` of the entries a closed payslip read. */
  used: ReadonlySet<string>;
  canEdit: boolean;
  nav: Nav;
  /** Words under the value (where it comes from, what it does). */
  note?: ReactNode;
  /** The insurance kind of a solution's rates: its range warnings name its rates. */
  kind?: string;
}

/** A dated value with «ab», «geplant», «Verlauf» and «Ändern». */
export function DatedField<T>({ label, path, history, spec, today, defaultFrom, used, canEdit, nav, note, kind }: DatedProps<T>) {
  const h = history ?? [];
  const now = entryOn(h, today);
  const ahead = planned(h, today);
  const earlier = [...h].filter((e) => e !== now && !ahead.includes(e)).reverse();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState<Form>({});
  const [from, setFrom] = useState(defaultFrom);
  const card = useBackdated(nav, kind);
  const begin = () => { setF(spec.from((ahead.at(-1) ?? now)?.value)); setFrom(defaultFrom); setEdit(true); };
  const key = (e: DatedEntry<T>) => `${path}|${e.validFrom}|${e.enteredAt}`;

  async function save(e: FormEvent) {
    e.preventDefault();
    const value = spec.to(f);
    await card.send((how) => payrollApi.addEntry({ path, validFrom: from, value }, how), () => setEdit(false));
  }
  const withdraw = (x: DatedEntry<T>) => card.send((how) => payrollApi.withdraw({ path, validFrom: x.validFrom, enteredAt: x.enteredAt }, how));

  return (
    <div className="dated" data-path={path}>
      <div className="dlabel">{label}</div>
      <div className="dbody">
        <div className="dnow">
          {now ? <>{spec.show(now.value)} <span className="from">{t('payroll.dated.from', { date: formatDate(now.validFrom) })}{now.validUntil ? ` ${t('payroll.dated.until', { date: formatDate(now.validUntil) })}` : ''}</span></>
            : <span className="m">{note ?? t('payroll.dated.none')}</span>}
          {canEdit && !edit ? <button type="button" className="quiet2" onClick={begin}>{t('payroll.dated.change')}</button> : null}
        </div>
        {ahead.map((x) => (
          <div key={key(x)} className="dplanned">
            {spec.show(x.value)} <span className="from">{t('payroll.dated.planned', { date: formatDate(x.validFrom) })}</span>
            {canEdit && !used.has(key(x)) ? <AsyncButton type="button" className="quiet2" onClick={() => withdraw(x)}>{t('payroll.dated.withdraw')}</AsyncButton> : null}
          </div>
        ))}
        {note && now ? <div className="m">{note}</div> : null}
        {earlier.length ? (
          <details className="dhist">
            <summary>{t('payroll.dated.history', { n: earlier.length })}</summary>
            <ul>
              {earlier.map((x) => (
                <li key={key(x)}>
                  <span className="from">{t('payroll.dated.from', { date: formatDate(x.validFrom) })}</span> {spec.show(x.value)}
                  <span className="m"> · {t('payroll.dated.entered', { date: formatDate(x.enteredAt.slice(0, 10)) })}{used.has(key(x)) ? ` · ${t('payroll.dated.used')}` : ''}</span>
                  {x.source?.note ? <span className="m"> · {x.source.note}</span> : null}
                  {canEdit && !used.has(key(x)) ? <AsyncButton type="button" className="quiet2" onClick={() => withdraw(x)}>{t('payroll.dated.withdraw')}</AsyncButton> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {edit ? (
          <AsyncForm className="form inline pform" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(false); } }}>
            <Fields fields={spec.fields} f={f} set={setF} />
            <label>{t('payroll.dated.validFrom')}<input type="date" name="validFrom" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <div className="acts">
              <AsyncButton type="submit" className="btn primary">{t('common.save')}</AsyncButton>
              <button type="button" className="btn ghost" onClick={() => setEdit(false)}>{t('common.cancel')}</button>
            </div>
          </AsyncForm>
        ) : null}
        {card.node}
      </div>
    </div>
  );
}
