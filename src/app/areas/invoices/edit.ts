/**
 * What an edit on a draft's sheet changes: a field's key (`date`, `intro`, `customer`,
 * `l:<line>:<field>`, src/invoices/sheet.ts) and the value it shows become the draft change the API
 * saves. Pure: the sheet reports, Detail.tsx saves or says why not.
 */
import { parseSwissDate } from '../../../accounting/periods.js';
import type { Customer, Draft } from '../../../invoices/model.js';
import { UNITS, type Unit } from '../../../invoices/model.js';
import type { Missing } from '../../../invoices/rules.js';
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
  if (key === 'supplied') {
    const parts = value.split(/\s*(?:–|—|\s-\s|\bbis\b|\bau\b|\bal\b|\bto\b)\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length === 0) return inv.supplied ? changed({ supplied: null }) : undefined;
    const to = parts[1] ? parseSwissDate(parts[1]) : null;
    // «01.09. – 15.09.2026»: the first day takes the year of the last.
    const from = parseSwissDate(parts[0]) ?? (to && /^\d{1,2}\.\d{1,2}\.?$/.test(parts[0]) ? parseSwissDate(`${parts[0].replace(/\.?$/, '.')}${to.slice(0, 4)}`) : null);
    if (!from || parts.length > 2 || (parts.length === 2 && (!to || to < from))) return { refused: 'date' };
    const supplied = to && to !== from ? { from, to } : { from };
    return supplied.from === inv.supplied?.from && (supplied as { to?: string }).to === inv.supplied?.to ? undefined : changed({ supplied });
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
    // «8.1» prices the line net, «incl:8.1» with the VAT in it (src/invoices/sheet.ts).
    const included = value.startsWith('incl:');
    const rate = Number(included ? value.slice(5) : value);
    if (!invoicing().rates.includes(rate) || (included && rate === 0)) return { refused: 'value' };
    if (rate === line.vatRate && included === !!line.vatIncluded) return undefined;
    line.vatRate = rate;
    if (included) line.vatIncluded = true; else delete line.vatIncluded;
    return changed({ lines });
  }
  return undefined;
}

/** Where a person fixes what an invoice still lacks: a part of Firma, the customer, or a field on the sheet. */
export type Fix = { company: 'profile' | 'invoice-layout' } | { customer: 'edit' | 'choose' } | { field: string } | { addLine: true };

export function fixFor(m: Missing): Fix | undefined {
  switch (m.field) {
    case 'sender.name': case 'sender.address': case 'sender.uid': return { company: 'profile' };
    case 'payTo': return { company: 'invoice-layout' };
    case 'customer': return { customer: 'choose' };
    case 'customer.name': case 'customer.address': return { customer: 'edit' };
    case 'date': return { field: 'date' };
    case 'lines': return { addLine: true };
    case 'line.text': return { field: `l:${m.line ?? 0}:text` };
    case 'line.quantity': return { field: `l:${m.line ?? 0}:quantity` };
    case 'line.vatRate': return { field: `l:${m.line ?? 0}:vatRate` };
    case 'exemption': return { field: 'exemption' };
    default: return undefined;
  }
}
