/**
 * A VAT adjustment (config.vatAdjustments) as a person enters it in Firma › MWST: a VAT event of an
 * open period that refers to a filed entry (AGENTS.md golden rule 1), e.g. import VAT refunded now on
 * a filed import. It adds its amount to one input-tax Ziffer of that period's return; the return
 * engine (src/engines/return.ts adjustmentsFor) reads it, this module only decides what may be kept.
 */
import type { JournalEntry, VatAdjustment } from '../types/index.js';
import { derivePeriod, isFilingKey, type FilingLength } from './periods.js';

/** Why a line is refused; `entry`, `ziffer`, `period`, `id`: the value refused. */
export type AdjustmentWhy = 'period' | 'ziffer' | 'amount' | 'reason' | 'noEntry' | 'entryMissing' | 'entryNotFiled' | 'id' | 'idTaken' | 'gone';
export interface AdjustmentRefusal { code: 'vatAdjustment'; params: { why: AdjustmentWhy; value?: string } }

export type AdjustmentDraft = Omit<VatAdjustment, 'id'>;

export interface AdjustmentContext {
  entries: readonly Pick<JournalEntry, 'id' | 'date'>[];
  /** The Ziffern an adjustment may add to: the form's input-tax boxes, the only ones whose figure takes it as tax. */
  boxes: readonly string[];
  length: FilingLength;
  /** Whether a day is filed (or held by an approved return): periodLock(books).isClosed. */
  isClosed: (date: string) => boolean;
}

const ID = /^[\w.-]{1,80}$/;
const refuse = (why: AdjustmentWhy, value?: string): { ok: false; refusal: AdjustmentRefusal } =>
  ({ ok: false, refusal: { code: 'vatAdjustment', params: value === undefined ? { why } : { why, value } } });

/**
 * A line as sent, checked: a filing period, one of `boxes`, an amount other than 0 in rappen, a reason,
 * and at least one entry, each dated in a filed period before the line's period, so the return that
 * declares the line never declares its entries too. Whether the line's own period is open is the route's
 * (assertOpen, 403): it is golden rule 1, not a shape.
 */
export function parseAdjustment(raw: unknown, ctx: AdjustmentContext): { ok: true; draft: AdjustmentDraft } | { ok: false; refusal: AdjustmentRefusal } {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const period = typeof b.period === 'string' ? b.period : '';
  const range = isFilingKey(period, ctx.length) ? derivePeriod(period) : null;
  if (!range) return refuse('period', period);
  const ziffer = typeof b.ziffer === 'string' ? b.ziffer : '';
  if (!ctx.boxes.includes(ziffer)) return refuse('ziffer', ziffer);
  const amount = typeof b.amount === 'number' && Number.isFinite(b.amount) ? Math.round(b.amount * 100) / 100 : 0;
  if (!amount) return refuse('amount');
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) return refuse('reason');
  const ids = Array.isArray(b.entryIds) ? [...new Set(b.entryIds.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))] : [];
  if (!ids.length) return refuse('noEntry');
  const dates = new Map(ctx.entries.map((e) => [e.id, e.date]));
  for (const id of ids) {
    const date = dates.get(id);
    if (date === undefined) return refuse('entryMissing', id);
    if (!ctx.isClosed(date) || date >= range.from) return refuse('entryNotFiled', id);
  }
  return { ok: true, draft: { period, ziffer, amount, reason, entryIds: ids } };
}

/** A new line's id: the one asked when free (the undo of a removal), else the period's first free `<period>-<n>`. */
export function adjustmentId(asked: unknown, period: string, taken: readonly VatAdjustment[]): { ok: true; id: string } | { ok: false; refusal: AdjustmentRefusal } {
  const ids = new Set(taken.map((a) => a.id));
  if (asked !== undefined) {
    if (typeof asked !== 'string' || !ID.test(asked)) return refuse('id', String(asked));
    return ids.has(asked) ? refuse('idTaken', asked) : { ok: true, id: asked };
  }
  let n = 1;
  while (ids.has(`${period}-${n}`)) n++;
  return { ok: true, id: `${period}-${n}` };
}

/** The days a line covers: a write that touches it is refused while either lies in a closed period. */
export function adjustmentDays(a: Pick<VatAdjustment, 'period'>): string[] {
  const range = derivePeriod(a.period);
  return range ? [range.from, range.to] : [];
}
