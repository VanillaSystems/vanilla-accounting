/**
 * A dated value of invoicing (docs/specs/invoicing.md 4.12, docs/specs/domain-model.md §5.6): the value
 * valid today with «ab TT.MM.JJJJ» («seit Beginn» for one of before the histories), a planned one below
 * it, a fold «Verlauf» with the earlier ones; «Ändern» asks the new value and «gilt ab» (today by
 * default). A day that reaches issued documents shows the card before anything is saved (4.11): what
 * each printed and what holds now, and the ways on. The same shape as payroll's dated field
 * (src/app/areas/payroll/Dated.tsx), sending `{ path, value, validFrom }` as the AI's wish does.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { entryOn, planned, type Dated, type DatedEntry } from '../../../core/dated.js';
import { SINCE_START } from '../../../invoices/dated-values.js';
import type { DatedCard, DatedWay } from '../../../invoices/backdated.js';
import { t } from '../../i18n/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { api, errorText, type DatedSavedView } from '../../lib/api.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import { reloadWorkspace } from '../../hooks/use-workspace.js';
import type { Nav } from '../index.js';
import { reloadInvoices } from './data.js';

export type Form = Record<string, string>;

/** «ab 01.12.2026», or «seit Beginn» for a value of before the histories. */
export const sinceText = (day: string): string => (day === SINCE_START ? t('dated.sinceStart') : t('dated.from', { date: formatDate(day) }));

/** The card of a change dated before issued documents: what each printed and what holds now, and the ways on. */
export function DatedCardView({ card, onChoose, onCancel }: { card: DatedCard; onChoose(way: DatedWay): Promise<void>; onCancel(): void }) {
  return (
    <div className="dcard warnpanel" role="alert" data-testid="dated-card">
      <h4>{t(`dated.card.${card.kind}`, { n: card.affected.length, date: formatDate(card.validFrom) })}</h4>
      <ul>
        {card.affected.map((a) => (
          <li key={a.id}>
            <b>{a.number}</b> <span className="m">{formatDate(a.date)} · {a.customer}{a.open !== undefined ? ` · ${t('dated.card.open', { amount: fmt(a.open) })}` : ''}</span>
            {a.lines?.map((l) => <div key={l.line} className="m">{t('dated.card.line', { text: l.text, quantity: String(l.quantity), price: fmt(l.price), now: fmt(l.now) })}</div>)}
            {a.printed !== undefined ? <div className="m">{t('dated.card.printed', { printed: a.printed, now: a.now ?? '' })}</div> : null}
          </li>
        ))}
      </ul>
      <p className="m">{t(`dated.card.rule.${card.kind}`)}</p>
      <div className="acts">
        {card.ways.map((w, i) => <AsyncButton key={w} type="button" className={`btn${i === 0 ? ' primary' : ''}`} data-way={w} onClick={() => onChoose(w)}>{t(`dated.way.${w}`)}</AsyncButton>)}
        <button type="button" className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

/** What a saved change made, said in the toast: the drafts of the difference, the notices to send. */
export function savedText(r: Extract<DatedSavedView, { saved: true }>): string {
  if (r.drafts.length) return t('dated.saved.drafts', { n: r.drafts.length });
  if (r.notices.length) return t('dated.saved.notices', { n: r.notices.length });
  return t('dated.saved', { date: formatDate(r.validFrom) });
}

/** Sends a dated change; while the card is open it holds the change, and a way sends it again. */
export function useDatedChange(nav: Nav, after?: (r: Extract<DatedSavedView, { saved: true }>) => void) {
  const [card, setCard] = useState<{ card: DatedCard; retry(way: DatedWay): Promise<DatedSavedView>; done?(): void } | null>(null);
  const finish = async (r: Extract<DatedSavedView, { saved: true }>, done?: () => void) => {
    setCard(null);
    nav.toast(savedText(r));
    if (r.path.startsWith('invoicing/')) reloadWorkspace();
    await reloadInvoices();
    done?.();
    after?.(r);
  };
  const send = async (change: { path: string; value: unknown; validFrom: string }, done?: () => void): Promise<boolean> => {
    try {
      const r = await api.datedChange(change);
      if (!r.saved) { setCard({ card: r, retry: (way) => api.datedChange({ ...change, way }), done }); return false; }
      await finish(r, done);
      return true;
    } catch (e) { nav.toast(errorText(e)); return false; }
  };
  const choose = async (way: DatedWay) => {
    if (!card) return;
    try {
      const r = await card.retry(way);
      if (!r.saved) { setCard({ ...card, card: r }); return; }
      await finish(r, card.done);
    } catch (e) { nav.toast(errorText(e)); }
  };
  const node = card ? <DatedCardView card={card.card} onChoose={choose} onCancel={() => setCard(null)} /> : null;
  return { send, node };
}

/**
 * Under a value shown elsewhere (a contact's addresses, its terms): from when today's holds, what is
 * planned, and «Verlauf»; nothing while the value never changed. Changed in its form, with «gilt ab».
 */
export function DatedTrail<T>({ history, today, show }: { history: Dated<T> | undefined; today: string; show(v: T): ReactNode }) {
  const h = history ?? [];
  const now = entryOn(h, today);
  const ahead = planned(h, today);
  const earlier = [...h].filter((e) => e !== now && !ahead.includes(e)).reverse();
  if (!ahead.length && !earlier.length) return null;
  return (
    <div className="dval trail">
      {now ? <span className="from">{sinceText(now.validFrom)}</span> : null}
      {ahead.map((x) => <div key={`${x.validFrom}|${x.enteredAt}`} className="dplanned" data-testid="dated-planned">{show(x.value)} <span className="from">{t('dated.planned', { date: formatDate(x.validFrom) })}</span></div>)}
      {earlier.length ? (
        <details className="dhist">
          <summary>{t('dated.history', { n: earlier.length })}</summary>
          <ul>{earlier.map((x) => <li key={`${x.validFrom}|${x.enteredAt}`}><span className="from">{sinceText(x.validFrom)}</span> {show(x.value)}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

interface Props<T> {
  label: string;
  /** `articles/<id>/price`, `contacts/<id>/terms`, `invoicing/payTo/EUR`, … */
  path: string;
  history: Dated<T> | undefined;
  today: string;
  show(v: T): ReactNode;
  /** The inputs of «Ändern»; absent: shown only. */
  form?: { from(v: T | undefined): Form; fields(f: Form, set: (f: Form) => void): ReactNode; to(f: Form): unknown };
  nav: Nav;
  /** Shown while no value holds today. */
  none?: ReactNode;
}

/** A dated value with «ab», «geplant», «Verlauf» and «Ändern». */
export function DatedValue<T>({ label, path, history, today, show, form, nav, none }: Props<T>) {
  const h = history ?? [];
  const now = entryOn(h, today);
  const ahead = planned(h, today);
  const earlier = [...h].filter((e) => e !== now && !ahead.includes(e)).reverse();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState<Form>({});
  const [from, setFrom] = useState(today);
  const change = useDatedChange(nav);
  const key = (e: DatedEntry<T>) => `${e.validFrom}|${e.enteredAt}`;
  const begin = () => { setF(form!.from((ahead.at(-1) ?? now)?.value)); setFrom(today); setEdit(true); };
  async function save(e: FormEvent) {
    e.preventDefault();
    await change.send({ path, value: form!.to(f), validFrom: from }, () => setEdit(false));
  }
  return (
    <div className="dval" data-path={path}>
      <div className="dlabel">{label}</div>
      <div className="dbody">
        <div className="dnow">
          {now ? <>{show(now.value)} <span className="from">{sinceText(now.validFrom)}</span></> : <span className="m">{none ?? t('dated.none')}</span>}
          {form && !edit ? <button type="button" className="quiet2" data-act="dated-change" onClick={begin}>{t('dated.change')}</button> : null}
        </div>
        {ahead.map((x) => (
          <div key={key(x)} className="dplanned" data-testid="dated-planned">{show(x.value)} <span className="from">{t('dated.planned', { date: formatDate(x.validFrom) })}</span></div>
        ))}
        {earlier.length ? (
          <details className="dhist">
            <summary>{t('dated.history', { n: earlier.length })}</summary>
            <ul>
              {earlier.map((x) => (
                <li key={key(x)}><span className="from">{sinceText(x.validFrom)}</span> {show(x.value)}
                  {x.validFrom !== SINCE_START ? <span className="m"> · {t('dated.entered', { date: formatDate(x.enteredAt.slice(0, 10)) })}</span> : null}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {edit && form ? (
          <AsyncForm className="form inline dform" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(false); } }}>
            {form.fields(f, setF)}
            <label>{t('dated.validFrom')}<input type="date" name="validFrom" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <div className="acts">
              <AsyncButton type="submit" className="btn primary">{t('common.save')}</AsyncButton>
              <button type="button" className="btn ghost" onClick={() => setEdit(false)}>{t('common.cancel')}</button>
            </div>
          </AsyncForm>
        ) : null}
        {change.node}
      </div>
    </div>
  );
}

/** One text or number input of a dated value's form. */
export function Input({ k, label, f, set, mono, type }: { k: string; label: string; f: Form; set(f: Form): void; mono?: boolean; type?: 'number' }) {
  return (
    <label>{label}
      <input name={k} className={mono || type === 'number' ? 'mono' : ''} inputMode={type === 'number' ? 'decimal' : undefined} value={f[k] ?? ''} onChange={(e) => set({ ...f, [k]: e.target.value })} />
    </label>
  );
}

/** A number as typed: «8'600», «0,5» → 8600, 0.5; empty → undefined. */
export function numberOf(s: string | undefined): number | undefined {
  const x = (s ?? '').trim().replace(/['’\s]/g, '').replace(',', '.');
  if (!x) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}
