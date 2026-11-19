/**
 * Teilrechnungen, Akonto, Schlussrechnung and Rückbehalt in Verkauf (docs/specs/invoicing.md 4.4.9):
 * the plan of an Auftrag in its margin with what each stage invoiced, the dialog that writes the plan
 * (it says what is missing or too much), and on a Rechnung draft its kind (Teil- or Schlussrechnung),
 * the Akontos it deducts and its retention.
 */
import { useState } from 'react';
import { isItem, type Draft, type Invoice, type Issued, type Stage } from '../../../invoices/model.js';
import { deductible, planBase, planGap, stageStates } from '../../../invoices/stages.js';
import { fromRappen } from '../../../accounting/rappen.js';
import { totals } from '../../../invoices/rules.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { hrefOf } from '../../shell/history.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import type { RouteOf } from '../../shell/route.js';
import type { AreaProps, Nav } from '../index.js';
import type { Period } from '../../../accounting/periods.js';
import { I } from '../receipts/icons.js';
import { addDeductions, invoiceAt, savePlan, saveDraft, stageInvoice } from './actions.js';
import { parseNumber } from './edit.js';
import { Frame, close } from './frame.js';
import { setUi } from './state.js';
import { groupOf, statusOfKind } from './table.js';

type Props = AreaProps<RouteOf<'invoices'>>;

/** A document of the plan as a link in a period that holds it, with its status. */
function DocLink({ doc, invoices, nav, period, today }: { doc: Invoice; invoices: Invoice[]; nav: Nav; period: Period; today: string }) {
  const loc = invoiceAt(doc, period);
  const name = doc.status === 'issued' ? doc.number : t('invoices.draft');
  const st = t(`sales.status.${groupOf(doc.kind)}.${statusOfKind(doc, invoices, today)}` as 'sales.status.invoice.open');
  return <><a className="golink" href={hrefOf(loc)} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); nav.go(loc); }}>{name}</a><span className="m"> · {st}</span></>;
}

/**
 * The margin's «Teilrechnungsplan» of an Auftrag: each stage with its text, what it plans, its day,
 * and the Rechnung that invoices it (a link) or the button that makes it; the last stage makes the
 * Schlussrechnung. Without a plan: «Plan anlegen».
 */
export function PlanRows({ inv, invoices, nav, period, canEdit, today }: { inv: Invoice; invoices: Invoice[]; nav: Nav; period: Period; canEdit: boolean; today: string }) {
  const states = stageStates(inv, invoices);
  const issued = inv.status === 'issued' && !inv.cancelled;
  const edit = canEdit && !(inv.status === 'issued' && inv.cancelled);
  return (
    <div className="ivplan" data-testid="plan">
      {!states.length && <p className="m">{t('sales.plan.none')}</p>}
      {states.length > 0 && (
        <ol>
          {states.map((s) => (
            <li key={s.k} data-stage={s.k}>
              <div className="ph"><b>{s.k + 1}. {s.stage.label}</b><span className="mono">{inv.currency} {fmt(s.planned)}</span></div>
              <div className="pd">
                <span className="m">{[s.stage.percent !== undefined ? `${s.stage.percent} %` : s.stage.amount !== undefined ? t('sales.plan.byAmount') : t('sales.plan.rest'), s.stage.date ? formatDate(s.stage.date) : ''].filter(Boolean).join(' · ')}</span>
                {s.doc ? <span data-testid="plan-doc"><DocLink doc={s.doc} invoices={invoices} nav={nav} period={period} today={today} />{s.invoiced ? <span className="m mono"> · {fmt(s.invoiced)}</span> : null}</span>
                  : issued && canEdit ? <AsyncButton type="button" className="quiet2" data-act={s.last ? 'plan-final' : 'plan-partial'} onClick={() => stageInvoice(nav, inv as Issued, s.last ? 'final' : s.k)}>{t(s.last ? 'sales.plan.finalCreate' : 'sales.plan.partialCreate', { n: s.k + 1 })}</AsyncButton> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
      {edit && <button type="button" className="quiet2" data-act="plan-edit" onClick={() => setUi({ dialog: { kind: 'plan' } })}>{t(states.length ? 'sales.plan.edit' : 'sales.plan.add')}</button>}
      {/* Without a plan the Schlussrechnung is the Rechnung of the whole work less Akontos made by hand (spec 4.4.9). */}
      {!states.length && issued && canEdit && <> · <AsyncButton type="button" className="quiet2" data-act="plan-final" onClick={() => stageInvoice(nav, inv as Issued, 'final')}>{t('sales.plan.finalCreate')}</AsyncButton></>}
    </div>
  );
}

type Mode = 'percent' | 'amount' | 'rest';
interface Row { label: string; mode: Mode; value: string; date: string }

const rowOf = (s: Stage): Row => ({ label: s.label, mode: s.percent !== undefined ? 'percent' : s.amount !== undefined ? 'amount' : 'rest', value: s.percent !== undefined ? String(s.percent) : s.amount !== undefined ? fmt(s.amount) : '', date: s.date ?? '' });
const stageOf = (r: Row): Stage => {
  const n = parseNumber(r.value);
  return { label: r.label.trim(), ...(r.mode === 'percent' && n != null ? { percent: n } : {}), ...(r.mode === 'amount' && n != null ? { amount: n } : {}), ...(r.date ? { date: r.date } : {}) };
};
const START: Row[] = [{ label: '', mode: 'percent', value: '30', date: '' }, { label: '', mode: 'percent', value: '40', date: '' }, { label: '', mode: 'rest', value: '', date: '' }];

/**
 * The plan of an Auftrag (spec 4.4.9): stages by percent or amount of its total, the last one the rest
 * if wanted, each with a text and a planned day. The foot says what is missing or too much; «Speichern»
 * waits until the stages add up. A stage invoiced already is shown, not changed.
 */
export function PlanDialog({ inv, invoices, nav }: Props & { inv: Invoice; invoices: Invoice[] }) {
  const states = stageStates(inv, invoices);
  const [rows, setRows] = useState<Row[]>(() => (inv.stages?.length ? inv.stages.map(rowOf) : START.map((r, k) => ({ ...r, label: t(k === 2 ? 'sales.plan.restLabel' : k === 0 ? 'sales.plan.firstLabel' : 'sales.plan.stageLabel') }))));
  const stages = rows.map(stageOf);
  const base = fromRappen(planBase(inv));
  const filled = rows.every((r, k) => r.label.trim() && (r.mode === 'rest' ? k === rows.length - 1 : parseNumber(r.value) != null));
  const gap = filled ? fromRappen(planGap(inv, stages)) : undefined;
  const locked = (k: number) => !!states[k]?.doc && !states[k].last;
  const set = (k: number, patch: Partial<Row>) => setRows(rows.map((r, i) => (i === k ? { ...r, ...patch } : r)));
  const net = (inv.prices ?? 'net') === 'net' && totals(inv).vat !== 0;
  // What the rest stage takes: the total less the other stages, each to the cent as the API counts it.
  const rest = Math.max(0, Math.round((base - stages.slice(0, -1).reduce((s, x) => s + (x.amount ?? (x.percent !== undefined ? Math.round(base * x.percent) / 100 : 0)), 0)) * 100) / 100);
  return (
    <Frame className="iplan" label={t('sales.plan.title')} title={`${inv.number ?? t('invoices.draft')} · ${inv.currency} ${fmt(base)}${net ? ` ${t('sales.plan.net')}` : ''}`} foot={<>
      {inv.stages?.length && !states.some((s) => s.doc) ? <AsyncButton type="button" className="btn ghost danger" data-act="plan-remove" onClick={async () => { if (await savePlan(nav, inv, [])) close(); }}>{t('sales.plan.remove')}</AsyncButton> : null}
      <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
      <AsyncButton type="button" className="btn primary" data-act="plan-save" disabled={!filled || gap !== 0} onClick={async () => { if (await savePlan(nav, inv, stages)) close(); }}>{t('common.save')}</AsyncButton>
    </>}>
      <div className="ibody">
        <table className="ivt ivstages" aria-label={t('sales.plan.title')}>
          <thead><tr><th>{t('sales.plan.col.label')}</th><th>{t('sales.plan.col.share')}</th><th className="num">{t('sales.plan.col.value')}</th><th>{t('sales.plan.col.date')}</th><th /></tr></thead>
          <tbody>
            {rows.map((r, k) => {
              const off = locked(k);
              return (
                <tr key={k} data-stage={k} className={off ? 'gone' : ''}>
                  <td><input aria-label={t('sales.plan.col.label')} value={r.label} disabled={off} onChange={(e) => set(k, { label: e.target.value })} /></td>
                  <td>
                    <select aria-label={t('sales.plan.col.share')} value={r.mode} disabled={off} onChange={(e) => set(k, { mode: e.target.value as Mode, ...(e.target.value === 'rest' ? { value: '' } : {}) })}>
                      <option value="percent">%</option>
                      <option value="amount">{inv.currency}</option>
                      {k === rows.length - 1 && <option value="rest">{t('sales.plan.rest')}</option>}
                    </select>
                  </td>
                  <td className="num">{r.mode === 'rest' ? <span className="m mono" data-testid="plan-rest">{gap !== undefined ? fmt(rest) : '–'}</span>
                    : <input className="mono ivqty" inputMode="decimal" aria-label={t('sales.plan.col.value')} value={r.value} disabled={off} onChange={(e) => set(k, { value: e.target.value })} />}</td>
                  <td><input type="date" aria-label={t('sales.plan.col.date')} value={r.date} disabled={off} onChange={(e) => set(k, { date: e.target.value })} /></td>
                  <td>{!off && rows.length > 1 && <button type="button" className="edx" aria-label={t('sales.plan.removeStage')} onClick={() => setRows(rows.filter((_, i) => i !== k).map((x, i, all) => (x.mode === 'rest' && i !== all.length - 1 ? { ...x, mode: 'percent' } : x)))}>×</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p><button type="button" className="quiet2" data-act="plan-add" onClick={() => setRows([...rows.map((x) => (x.mode === 'rest' ? { ...x, mode: 'percent' as const, value: '' } : x)), { label: t('sales.plan.restLabel'), mode: 'rest', value: '', date: '' }])}>＋ {t('sales.plan.addStage')}</button></p>
        {gap !== undefined && gap !== 0 && <p className="warnline" role="note" data-testid="plan-gap">{I.dot}{t(gap > 0 ? 'sales.plan.missing' : 'sales.plan.tooMuch', { amount: `${inv.currency} ${fmt(Math.abs(gap))}` })}</p>}
        {gap === 0 && <p className="m ivhint" data-testid="plan-ok">{t('sales.plan.adds', { amount: `${inv.currency} ${fmt(base)}` })}</p>}
        {states.some((s) => s.doc && !s.last) && <p className="m ivhint">{t('sales.plan.lockedHint')}</p>}
      </div>
    </Frame>
  );
}

/**
 * On a Rechnung draft: its kind (Rechnung, Teilrechnung, Schlussrechnung), a Schlussrechnung's
 * «Akontos abziehen» with the contact's Teilrechnungen not yet deducted, and the retention.
 */
export function DraftPlanRows({ inv, invoices, nav, canEdit }: { inv: Draft; invoices: Invoice[]; nav: Nav; canEdit: boolean }) {
  const offered = inv.role === 'final' ? deductible(inv, invoices) : [];
  const [picked, setPicked] = useState<string[]>([]);
  const r = inv.schedule?.retention;
  const [pct, setPct] = useState<number | undefined>(r?.percent);
  const [day, setDay] = useState(r?.until ?? '');
  const deducted = inv.lines.filter(isItem).filter((l) => l.deducts).length;
  return (
    <>
      <label className="lkr"><span>{t('sales.role')}</span>
        <select data-testid="draft-role" value={inv.role ?? ''} disabled={!canEdit || inv.stage !== undefined || deducted > 0} onChange={(e) => saveDraft(nav, inv, { role: (e.target.value || null) as Draft['role'] | null })}>
          <option value="">{t('sales.role.none')}</option>
          <option value="partial">{t('sales.role.partial')}</option>
          <option value="final">{t('sales.role.final')}</option>
        </select>
      </label>
      {inv.role === 'final' && (
        <div className="ivdeduct" data-testid="deductible">
          <span className="m">{offered.length ? t('sales.plan.deductHead') : t('sales.plan.deductNone')}</span>
          {offered.map((p) => (
            <label key={p.id} className="tickline">
              <input type="checkbox" checked={picked.includes(p.id)} disabled={!canEdit} onChange={() => setPicked(picked.includes(p.id) ? picked.filter((x) => x !== p.id) : [...picked, p.id])} />
              <span>{p.number} · {formatDate(p.date)}</span><span className="mono">{p.currency} {fmt(totals(p).gross)}</span>
            </label>
          ))}
          {offered.length > 0 && canEdit && <AsyncButton type="button" className="quiet2" data-act="deduct" disabled={!picked.length} onClick={async () => { if (await addDeductions(nav, inv, picked)) setPicked([]); }}>{t('sales.plan.deduct')}</AsyncButton>}
        </div>
      )}
      <div className="lkr"><span>{t('sales.retention')}</span>
        <span className="ivret">
          <input className="mono" inputMode="decimal" aria-label={t('sales.retention.percent')} data-testid="retention-percent" defaultValue={r ? String(r.percent) : ''} placeholder="5" disabled={!canEdit}
            onBlur={(e) => { const n = parseNumber(e.target.value); setPct(n != null && n > 0 ? n : undefined); if (n == null || n <= 0) { if (r) void saveDraft(nav, inv, { schedule: null }); return; } const until = r?.until ?? day; if (until && n !== r?.percent) void saveDraft(nav, inv, { schedule: { retention: { percent: n, until } } }); }} />
          <span className="m">% {t('sales.retention.until')}</span>
          {/* The day is the person's, never the invoice date by default (it must lie after it). */}
          <input type="date" aria-label={t('sales.retention.until')} data-testid="retention-until" value={r?.until ?? day} min={inv.date} disabled={!canEdit} onChange={(e) => { setDay(e.target.value); const p = r?.percent ?? pct; if (p && e.target.value) void saveDraft(nav, inv, { schedule: { retention: { percent: p, until: e.target.value } } }); }} />
        </span>
      </div>
    </>
  );
}
