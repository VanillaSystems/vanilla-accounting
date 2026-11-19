/**
 * What an edit on a draft's sheet changes: a field's key (`date`, `intro`, `customer`,
 * `l:<line>:<field>`, src/invoices/sheet.ts) and the value it shows become the draft change the API
 * saves. Pure: the sheet reports, Detail.tsx saves or says why not.
 */
import { contactOn } from '../../../invoices/dated-values.js';
import { parseSwissDate } from '../../../accounting/periods.js';
import { DEFAULT_UNITS, isItem, type Contact, type Draft, type InvoiceLine, type UnitDef } from '../../../invoices/model.js';
import type { Missing } from '../../../invoices/rules.js';
import { invoicing } from '../../../engines/index.js';
import type { DraftChange } from '../../lib/api.js';
import { customerChange } from './model.js';

/** A change to save, nothing to save, a value refused (the field goes back), or a new contact to create first. */
export type SheetEdit = { change: DraftChange } | { refused: 'date' | 'number' | 'value' } | { newCustomer: true } | undefined;

/** A number typed the Swiss way or another: 1’200.50, 1 200,50, −3. */
export const parseNumber = (s: string): number | null => {
  const n = Number(s.replace(/[’'\s]/g, '').replace('−', '-').replace(',', '.'));
  return s.trim() && Number.isFinite(n) ? n : null;
};

export function sheetEdit(inv: Draft, key: string, value: string, ctx: { contacts: readonly Contact[]; defaultTexts: { intro: string; closing: string }; units?: readonly UnitDef[] }): SheetEdit {
  const changed = (change: DraftChange): SheetEdit => ({ change });
  if (key === 'intro' || key === 'closing') {
    const def = ctx.defaultTexts[key];
    if (value === (inv[key] ?? def)) return undefined;
    return changed({ [key]: value === def ? null : value });
  }
  if (key === 'date' || key === 'dueDate' || key === 'validUntil') {
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
    const next = ctx.contacts.find((x) => x.id === value);
    return next ? changed(customerChange(inv, contactOn(next, inv.date))) : { refused: 'value' };
  }
  const m = /^l:(\d+):(\w+)$/.exec(key);
  if (!m) return undefined;
  const k = Number(m[1]);
  const field = m[2];
  const lines = inv.lines.map((l) => ({ ...l })) as InvoiceLine[];
  const line = lines[k];
  if (!line || line.kind === 'pagebreak') return undefined;
  if (field === 'text') {
    if (value === line.text) return undefined;
    // The subject follows the first item's text while the person has not given it one of its own.
    const first = inv.lines.findIndex(isItem);
    const subject = isItem(line) && (!inv.subject || (k === first && inv.subject === line.text)) ? { subject: value } : {};
    line.text = value;
    return changed({ lines, ...subject });
  }
  if (line.kind === 'text') {
    if (field !== 'style') return undefined;
    const title = value === 'title';
    if (title === (line.style === 'title')) return undefined;
    if (title) line.style = 'title'; else delete line.style;
    return changed({ lines });
  }
  if (line.kind === 'subtotal' || line.kind === 'group') return undefined;
  if (line.kind === 'discount') {
    // «3» is 3 % or 3 in the document's currency by the mode beside it; empty clears the value (the check before issue names it).
    if (field === 'dmode') {
      const amount = value === 'amount';
      if (amount === (line.amount !== undefined)) return undefined;
      const v = line.percent ?? line.amount;
      delete line.percent; delete line.amount;
      if (v !== undefined) line[amount ? 'amount' : 'percent'] = v;
      else if (amount) line.amount = 0; else line.percent = 0;
      return changed({ lines });
    }
    if (field !== 'discount') return undefined;
    const n = value.trim() ? parseNumber(value.replace(/%\s*$/, '')) : null;
    if (value.trim() && n === null) return { refused: 'number' };
    const mode = line.amount !== undefined ? 'amount' : 'percent';
    if ((n ?? undefined) === line[mode]) return undefined;
    delete line.percent; delete line.amount;
    if (n !== null) line[mode] = n;
    return changed({ lines });
  }
  if (field === 'quantity' || field === 'price') {
    const n = parseNumber(value);
    if (n === null) return { refused: 'number' };
    if (n === line[field]) return undefined;
    line[field] = n;
    return changed({ lines });
  }
  if (field === 'discount') {
    const n = value.trim() ? parseNumber(value.replace(/%\s*$/, '')) : 0;
    if (n === null || n < 0 || n > 100) return { refused: 'number' };
    if (n === (line.discount ?? 0)) return undefined;
    if (n) line.discount = n; else delete line.discount;
    return changed({ lines });
  }
  if (field === 'unit') {
    if (value === (line.unit ?? '')) return undefined;
    // A unit the firm's list names, or the one the line holds already (removed from the list since).
    if (value && !(ctx.units ?? DEFAULT_UNITS).some((u) => u.id === value)) return { refused: 'value' };
    if (value) line.unit = value; else delete line.unit;
    return changed({ lines });
  }
  if (field === 'vatRate') {
    const rate = Number(value);
    if (!invoicing().rates.includes(rate)) return { refused: 'value' };
    if (rate === line.vatRate) return undefined;
    line.vatRate = rate;
    return changed({ lines });
  }
  if (field === 'optional') {
    // An option of an Angebot or Auftrag (spec 4.4.1): never in a total.
    const on = value === 'yes';
    if (on === !!line.optional) return undefined;
    if (on) line.optional = true; else delete line.optional;
    return changed({ lines });
  }
  if (field === 'code') {
    // An Artikel position's code, as printed: the person's own once changed.
    const v = value.trim();
    if (v === (line.code ?? '')) return undefined;
    if (v) line.code = v; else delete line.code;
    return changed({ lines });
  }
  if (field === 'account') {
    // The revenue account of the position (spec 4.4.3 «Account and code by code»): four digits, empty for the contact's or the settings'.
    const v = value.trim();
    if (v && !/^\d{4}$/.test(v)) return { refused: 'value' };
    if (v === (line.account ?? '')) return undefined;
    if (v) line.account = v; else delete line.account;
    return changed({ lines });
  }
  if (field === 'activity') {
    // The net rate of a firm with two (#504): 1 is the default and not kept.
    if (value !== '1' && value !== '2') return { refused: 'value' };
    if (Number(value) === (line.activity ?? 1)) return undefined;
    if (value === '2') line.activity = 2; else delete line.activity;
    return changed({ lines });
  }
  return undefined;
}

const member = (l: InvoiceLine | undefined): boolean => !!l && isItem(l) && !!l.inGroup;
const inBlock = (l: InvoiceLine | undefined): boolean => !!l && (l.kind === 'group' || member(l));
const withMark = (l: InvoiceLine, on: boolean): InvoiceLine => {
  if (!isItem(l)) return l;
  const { inGroup: _, ...rest } = l;
  return on ? { ...rest, inGroup: true } : rest;
};

/** The block of the line at `i`: a Gruppe's title and its sub-positions, or the line alone. */
function blockAt(lines: readonly InvoiceLine[], i: number): { start: number; end: number } {
  let start = i;
  if (member(lines[i])) while (start > 0 && member(lines[start])) start--;
  if (lines[start]?.kind !== 'group') return { start: i, end: i };
  let end = start;
  while (member(lines[end + 1])) end++;
  return { start, end };
}

/**
 * The positions with the one at `from` moved by a step (`step`, Alt+↑/↓: `to` is `from` ± 1) or
 * dropped on the row `to` (`drop`, a drag), and the index it ends at; undefined when nothing moves. A move changes which
 * Gruppe a position belongs to only when the person moves a priced position into or out of one:
 *
 * - A Gruppe moves whole, its title with its sub-positions: a step passes the whole block or line
 *   next to it, a drop lands before (up) or after (down) the block or line it is dropped on.
 * - A priced position steps into a group (down onto its title: the first sub-position; up from just
 *   below it: the last, in place) and out of it (down from the last sub-position, in place; up from
 *   the first: above the title). Dropped on a group's title or sub-position it joins that group
 *   (up onto a title: above it, outside); dropped elsewhere it is an ordinary position.
 * - A text, Zwischentotal, Rabatt or page break never goes inside a group: a step passes the whole
 *   block, a drop on a block lands before (up) or after (down) it.
 */
export function moveLine(lines: readonly InvoiceLine[], from: number, to: number, how: 'step' | 'drop' = 'step'): { lines: InvoiceLine[]; at: number } | undefined {
  if (from === to || from < 0 || to < 0 || from >= lines.length || to >= lines.length) return undefined;
  const moved = lines[from];
  const step = how === 'step';
  if (step && Math.abs(to - from) !== 1) return undefined;
  const down = to > from;
  const out = [...lines];
  /** Takes the lines [start, end] out and puts them in at `at` of what is left. */
  const put = (start: number, end: number, at: number, mark?: boolean) => {
    const taken = out.splice(start, end - start + 1);
    if (mark !== undefined) taken[0] = withMark(taken[0], mark);
    out.splice(at, 0, ...taken);
    return { lines: out, at };
  };

  if (moved.kind === 'group' || !isItem(moved)) {
    // A block (a Gruppe whole) or a line that never goes inside one.
    const own = blockAt(lines, from);
    const size = own.end - own.start + 1;
    if (!step && to >= own.start && to <= own.end) return undefined;
    if (step) {
      if (down) {
        if (own.end + 1 >= lines.length) return undefined;
        const next = blockAt(lines, own.end + 1);
        return put(own.start, own.end, next.end - size + 1);
      }
      if (own.start === 0) return undefined;
      const prev = blockAt(lines, own.start - 1);
      return put(own.start, own.end, prev.start);
    }
    const target = blockAt(lines, to);
    return down ? put(own.start, own.end, target.end - size + 1) : put(own.start, own.end, target.start);
  }

  if (step) {
    const next = lines[to];
    if (member(moved)) {
      const own = blockAt(lines, from);
      // Down from the last sub-position, or up from the first: out of the group, beside it.
      if (down && from === own.end) return put(from, from, from, false);
      if (!down && from === own.start + 1) return put(from, from, own.start, false);
      return put(from, from, to, true);
    }
    // An ordinary position: down onto a title becomes the first sub-position; up from below a group the last, in place.
    if (down && next.kind === 'group') return put(from, from, from + 1, true);
    if (!down && inBlock(next)) return put(from, from, from, true);
    return put(from, from, to, false);
  }
  // A drop: on a group's title (down) or one of its sub-positions it joins that group; elsewhere it is ordinary.
  const target = lines[to];
  const joins = down ? inBlock(target) : member(target);
  return put(from, from, to, joins);
}

/**
 * The positions with `added` put in after the position `after` (the one the person is in; -1: none,
 * at the end). A draft that holds only its first item, still empty, starts with what is added
 * instead when no position is named (`newLine`: the text a new item starts with). P1.2: a painter
 * writes a room's title first; the sheet names
 * none while the caret sits in that item's empty text). `at`: the index the added position got.
 * A priced position added in a Gruppe (after its title or one of its sub-positions) is one of its
 * sub-positions; anything else added there (a text, a Rabatt, a Zwischentotal, another group) comes
 * after the group.
 */
export function insertLine(lines: readonly InvoiceLine[], added: InvoiceLine, after: number, newLine = ''): { lines: InvoiceLine[]; at: number } {
  const first = lines[0];
  const untouched = lines.length === 1 && isItem(first) && !first.price && (!first.text.trim() || first.text === newLine);
  if (after < 0 && untouched) return { lines: [added], at: 0 };
  const here = after >= 0 && after < lines.length ? lines[after] : undefined;
  const grouped = inBlock(here);
  const joins = grouped && isItem(added);
  const at = !here ? lines.length : grouped && !joins ? blockAt(lines, after).end + 1 : after + 1;
  const put = isItem(added) ? withMark(added, joins) : added;
  return { lines: [...lines.slice(0, at), put, ...lines.slice(at)], at };
}

/** The positions priced `prices` for the whole document: the legacy flag of a line goes (spec 4.4.3, prices per document). */
export const repriced = (lines: readonly InvoiceLine[]): InvoiceLine[] =>
  lines.map((l) => { if (!isItem(l) || l.vatIncluded === undefined) return l; const { vatIncluded: _, ...rest } = l; return rest; });

/** Where a person fixes what an invoice still lacks: a part of Firma, the customer, or a field on the sheet. */
export type Fix = { company: 'profile' | 'invoice-layout' } | { customer: 'edit' | 'choose' | 'pick' } | { field: string } | { addLine: true };

export function fixFor(m: Missing): Fix | undefined {
  switch (m.field) {
    case 'sender.name': case 'sender.address': case 'sender.uid': return { company: 'profile' };
    case 'payTo': return { company: 'invoice-layout' };
    case 'customer': return { customer: 'choose' };
    case 'customer.name': case 'customer.address': return { customer: 'edit' };
    case 'customer.person': case 'customer.addressGone': return { customer: 'pick' };
    case 'date': return { field: 'date' };
    case 'lines': return { addLine: true };
    case 'line.text': return { field: `l:${m.line ?? 0}:text` };
    case 'line.quantity': case 'line.price': return { field: `l:${m.line ?? 0}:${m.field === 'line.price' ? 'price' : 'quantity'}` };
    case 'line.discount': return { field: `l:${m.line ?? 0}:discount` };
    case 'line.discountBase': case 'line.groupTitle': case 'line.groupEmpty': return { field: `l:${m.line ?? 0}:text` };
    case 'line.vatRate': return { field: `l:${m.line ?? 0}:vatRate` };
    case 'line.activity': return { field: `l:${m.line ?? 0}:activity` };
    case 'exemption': return { field: 'exemption' };
    default: return undefined;
  }
}
