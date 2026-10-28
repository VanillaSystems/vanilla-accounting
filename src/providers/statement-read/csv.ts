/**
 * A bank's CSV export read into a statement by a column mapping (#217): which column holds the
 * day, the amount (one signed column, or a debit and a credit column), the text, the counterparty,
 * the reference, the balance. No bank is named here: the mapping is proposed from the header's
 * words and kept per account once the person confirms it (src/intake/statement-read.ts).
 */
import type { CsvColumns, ReadMovement, ReadStatement } from '../../types/statement-read.js';
import { amountOf } from '../../books/statement-check.js';

/** The most rows a CSV is read with; a longer one is refused with this number named. */
export const MAX_CSV_ROWS = 5000;

export interface CsvTable { header: string[]; rows: string[][] }

/** The bytes as text: UTF-8 when they are, else Latin-1 (the older Swiss bank exports); no BOM. */
function decode(bytes: Buffer): string {
  const utf8 = bytes.toString('utf8');
  return (utf8.includes('�') ? bytes.toString('latin1') : utf8).replace(/^﻿/, '');
}

/** One line's cells, quotes as RFC 4180 has them. */
function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Lines, a quoted cell's line breaks kept inside it. */
function lines(text: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    if ((c === '\n' || c === '\r') && !quoted) { if (cur.trim()) out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const looksLikeValue = (cell: string) => dayOf(cell) !== undefined || amountOf(cell) !== undefined;

/**
 * The CSV's header and rows: the separator the lines use most alike (; , tab), the header the
 * first line with that many cells and no day or amount in it (a bank puts its account's facts above).
 */
export function csvTable(bytes: Buffer): CsvTable | undefined {
  const all = lines(decode(bytes));
  if (all.length < 2) return undefined;
  const best = [';', ',', '\t', '|'].map((sep) => {
    const counts = all.map((l) => cells(l, sep).length);
    const freq = new Map<number, number>();
    for (const n of counts) if (n > 1) freq.set(n, (freq.get(n) ?? 0) + 1);
    const [width, n] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [0, 0];
    return { sep, width, n };
  }).sort((a, b) => b.n - a.n || b.width - a.width)[0];
  if (!best || best.n < 2) return undefined;
  const rows = all.map((l) => cells(l, best.sep));
  const at = rows.findIndex((r) => r.length === best.width && r.filter(Boolean).length >= 2 && !r.some(looksLikeValue));
  if (at < 0) return undefined;
  return { header: rows[at], rows: rows.slice(at + 1).filter((r) => r.length >= 2 && r.some(Boolean)) };
}

const HEADS: [keyof CsvColumns, RegExp][] = [
  ['valueDate', /valuta|value ?date|date (de )?valeur|data valuta/i],
  ['date', /datum|date|data|buchungstag|booking/i],
  ['debit', /belastung|lastschrift|soll|debit|débit|addebito|ausgang|withdrawal/i],
  ['credit', /gutschrift|haben|credit|crédit|accredito|eingang|deposit/i],
  ['balance', /saldo|balance|solde/i],
  ['amount', /betrag|amount|montant|importo/i],
  ['reference', /referenz|reference|référence|riferimento|ref\.?$/i],
  ['counterparty', /empfänger|auftraggeber|begünstigter|gegenpartei|counterparty|payee|payer|name|bénéficiaire|beneficiario/i],
  ['text', /text|beschreibung|description|libellé|descrizione|mitteilung|verwendungszweck|details|zahlungszweck|avis/i],
];

/** The columns the header's words name, each column used once; undefined without a day and an amount. */
export function guessColumns(header: readonly string[]): CsvColumns | undefined {
  const taken = new Set<number>();
  const found: Partial<CsvColumns> = {};
  for (const [field, re] of HEADS) {
    const i = header.findIndex((h, k) => !taken.has(k) && re.test(h));
    if (i >= 0) { found[field] = i; taken.add(i); }
  }
  if (found.date === undefined && found.valueDate !== undefined) { found.date = found.valueDate; delete found.valueDate; }
  if (found.date === undefined || (found.amount === undefined && found.debit === undefined && found.credit === undefined)) return undefined;
  return found as CsvColumns;
}

/** A day as a bank's CSV writes it: 31.03.2026, 31.03.26, 2026-03-31, 31/03/2026. */
export function dayOf(cell: string | undefined): string | undefined {
  const s = (cell ?? '').trim();
  let y: string, m: string, d: string;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(s);
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (iso) [, y, m, d] = iso;
  else if (dmy) { [, d, m, y] = dmy; if (y.length === 2) y = `20${y}`; } else return undefined;
  const day = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const t = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(day) ? day : undefined;
}

/** Why a CSV does not read by its mapping: a row with a day but no amount, or no row at all. */
export type CsvProblem = { kind: 'amount'; row: number } | { kind: 'empty' } | { kind: 'tooMany'; rows: number; limit: number };

/**
 * The CSV's rows as a statement of the account: each row with a day is a movement (a summary
 * line without one is not); oldest first, whatever order the bank wrote. With a balance column the
 * opening is the balance before the first row and the closing the last row's; without one both
 * are 0, for the person to type off the statement.
 */
export function csvStatement(table: CsvTable, c: CsvColumns, account: { currency: string; iban?: string }): ReadStatement | CsvProblem {
  if (table.rows.length > MAX_CSV_ROWS) return { kind: 'tooMany', rows: table.rows.length, limit: MAX_CSV_ROWS };
  const read: { m: ReadMovement; balance?: number; row: number }[] = [];
  for (const [i, r] of table.rows.entries()) {
    const date = dayOf(r[c.date]);
    if (!date) continue;
    const signed = c.amount !== undefined ? amountOf(r[c.amount]) : undefined;
    const debit = c.debit !== undefined ? amountOf(r[c.debit]) : undefined;
    const credit = c.credit !== undefined ? amountOf(r[c.credit]) : undefined;
    const amount = signed ?? (debit !== undefined || credit !== undefined ? (credit ? Math.abs(credit) : 0) - (debit ? Math.abs(debit) : 0) : undefined);
    if (amount === undefined) return { kind: 'amount', row: i + 1 };
    const text = c.text !== undefined ? r[c.text]?.trim() : '';
    const counterparty = c.counterparty !== undefined ? r[c.counterparty]?.trim() : '';
    const reference = c.reference !== undefined ? r[c.reference]?.trim() : '';
    const valueDate = c.valueDate !== undefined ? dayOf(r[c.valueDate]) : undefined;
    const balance = c.balance !== undefined ? amountOf(r[c.balance]) : undefined;
    read.push({ m: { date, ...(valueDate ? { valueDate } : {}), amount: Math.round(amount * 100) / 100, ...(counterparty ? { counterparty } : {}), ...(text ? { text } : {}), ...(reference ? { reference } : {}) }, ...(balance !== undefined ? { balance } : {}), row: i });
  }
  if (!read.length) return { kind: 'empty' };
  // Newest first, as many banks write it: turned round, rows of one day kept in the bank's order.
  if (read[0].m.date > read.at(-1)!.m.date) read.reverse();
  const first = read[0], last = read.at(-1)!;
  const opening = first.balance !== undefined ? Math.round((first.balance - first.m.amount) * 100) / 100 : 0;
  const closing = last.balance ?? 0;
  return {
    ...(account.iban ? { iban: account.iban } : {}), currency: account.currency,
    period: { from: first.m.date, to: last.m.date },
    opening: { date: first.m.date, amount: opening }, closing: { date: last.m.date, amount: closing },
    movements: read.map((x) => x.m),
  };
}
