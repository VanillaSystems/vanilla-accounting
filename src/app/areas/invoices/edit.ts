/**
 * What an edit on a draft's sheet changes: a field's key (`date`, `intro`, `customer`,
 * `l:<line>:<field>`, src/invoices/sheet.ts) and the value it shows become the draft change the API
 * saves. Pure: the sheet reports, Detail.tsx saves or says why not.
 */
import { parseSwissDate } from '../../../accounting/periods.js';
import type { Customer, Draft } from '../../../invoices/model.js';
import { UNITS, type Unit } from '../../../invoices/model.js';
import { invoicing } from '../../../engines/index.js';
import type { DraftChange } from '../../lib/api.js';
import { customerChange } from './model.js';

/** A change to save, nothing to save, a value refused (the field goes back), or a new customer to create first. */
export type SheetEdit = { change: DraftChange } | { refused: 'date' | 'number' | 'value' } | { newCustomer: true } | undefined;

/** A number typed the Swiss way or another: 1’200.50, 1 200,50, −3. */
export const parseNumber = (s: string): number | null => {
  const n = Number(s.replace(/[’'\s]/g, '').replace('−', '-').replace(',', '.'));
  return s.trim() && Number.isFinite(n) ? n : null;
};

export function sheetEdit(inv: Draft, key: string, value: string, ctx: { customers: readonly Customer[]; defaultTexts: { intro: string; closing: string } }): SheetEdit {
  const changed = (change: DraftChange): SheetEdit => ({ change });
  if (key === 'intro' || key === 'closing') {
    const def = ctx.defaultTexts[key];
    if (value === (inv[key] ?? def)) return undefined;
    return changed({ [key]: value === def ? null : value });
  }
  if (key === 'date' || key === 'dueDate') {
    const iso = parseSwissDate(value);
    if (!iso) return { refused: 'date' };
    return iso === inv[key] ? undefined : changed({ [key]: iso });
  }
  if (key === 'exemption') return value === (inv.exemption ?? '') ? undefined : changed({ exemption: value === 'abroad' || value === 'export' ? value : null });
  if (key === 'customer') {
    if (value === '+') return { newCustomer: true };
    if (value === inv.customerId) return undefined;
    const next = ctx.customers.find((x) => x.id === value);
    return next ? changed(customerChange(inv, next)) : { refused: 'value' };
  }
  const m = /^l:(\d+):(\w+)$/.exec(key);
  if (!m) return undefined;
  const k = Number(m[1]);
  const field = m[2];
  const lines = inv.lines.map((l) => ({ ...l }));
  const line = lines[k];
  if (!line) return undefined;
  if (field === 'text') {
    if (value === line.text) return undefined;
    const subject = !inv.subject || (k === 0 && inv.subject === line.text) ? { subject: k === 0 ? value : inv.subject ?? value } : {};
    line.text = value;
    return changed({ lines, ...subject });
  }
  if (field === 'quantity' || field === 'price') {
    const n = parseNumber(value);
    if (n === null) return { refused: 'number' };
    if (n === line[field]) return undefined;
    line[field] = n;
    return changed({ lines });
  }
  if (field === 'unit') {
    if (value === (line.unit ?? '')) return undefined;
    if (value && !(UNITS as readonly string[]).includes(value)) return { refused: 'value' };
    if (value) line.unit = value as Unit; else delete line.unit;
    return changed({ lines });
  }
  if (field === 'vatRate') {
    const rate = Number(value);
    if (!invoicing().rates.includes(rate)) return { refused: 'value' };
    if (rate === line.vatRate) return undefined;
    line.vatRate = rate;
    return changed({ lines });
  }
  return undefined;
}
