/**
 * The check a statement read without a bank export passes before anything is imported (#217): its
 * opening balance and its movements make its closing balance, to the cent, and so does each page
 * between the carry-overs it prints, and what one page carries out the next brings in. A misread
 * digit shows as a gap on its page. Pure, in cents: the drop row runs it on every change, the
 * server again before it imports.
 */
import type { BalanceCheck, BalanceGap, ReadStatement } from '../types/statement-read.js';

const cents = (n: number) => Math.round(n * 100);
const francs = (c: number) => c / 100;

export function checkStatement(s: Pick<ReadStatement, 'opening' | 'closing' | 'movements' | 'pages'>): BalanceCheck {
  const gaps: BalanceGap[] = [];
  const gap = (where: BalanceGap['where'], expected: number, found: number, page?: number) => {
    if (expected !== found) gaps.push({ where, ...(page !== undefined ? { page } : {}), expected: francs(expected), found: francs(found), gap: francs(expected - found) });
  };
  const pages = [...(s.pages ?? [])].sort((a, b) => a.page - b.page);
  for (const p of pages) {
    if (p.carriedIn === undefined || p.carriedOut === undefined) continue;
    const moved = s.movements.filter((m) => m.page === p.page).reduce((sum, m) => sum + cents(m.amount), 0);
    gap('page', cents(p.carriedOut), cents(p.carriedIn) + moved, p.page);
  }
  for (const [i, p] of pages.entries()) {
    const next = pages[i + 1];
    if (next && next.page === p.page + 1 && p.carriedOut !== undefined && next.carriedIn !== undefined) gap('carry', cents(next.carriedIn), cents(p.carriedOut), next.page);
  }
  gap('total', cents(s.closing.amount), cents(s.opening.amount) + s.movements.reduce((sum, m) => sum + cents(m.amount), 0));
  return { ok: gaps.length === 0, gaps };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().startsWith(v);

/** A number as a statement prints it, or as a model or a form gives it: 1'234.50, -12.5, «1 234,50», 12.50-. */
export function amountOf(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  let s = v.replace(/[\s'’ ]/g, '').replace(/^\((.*)\)$/, '-$1').replace(/[−–]/g, '-');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (/^[^-].*-$/.test(s)) s = `-${s.slice(0, -1)}`;
  const n = Number(s);
  return s && Number.isFinite(n) ? n : undefined;
}

const words = (v: unknown, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const round = (n: number) => Math.round(n * 100) / 100;

/** A movement's amount in another currency than the account's, as printed beside it; none in the account's own. */
function originalOf(v: unknown, account: string): { amount: number; currency: string } | undefined {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.currency !== 'string') return undefined;
  const currency = o.currency.trim().toUpperCase();
  const amount = amountOf(o.amount);
  return /^[A-Z]{3}$/.test(currency) && currency !== account && amount !== undefined && amount !== 0 ? { amount: round(Math.abs(amount)), currency } : undefined;
}

const sameCents = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);

/**
 * The opening balance of a statement that prints none but a balance on every row (a running
 * balance column): the balance before the earliest row. The rows run oldest first when each row's
 * balance is the one before plus its amount, newest first when it is the one after less; a
 * statement whose rows chain neither way gives none. A statement without a movement opens as it
 * closes. Its day: the period's first, else the earliest row's.
 */
function openingOfRows(rows: readonly { date: string; amount: number; balance?: number }[], { date: closingDay, amount: closing }: { date: string; amount: number }, from?: string): { date: string; amount: number } | undefined {
  if (!rows.length) return { date: from ?? closingDay, amount: closing };
  if (rows.some((r) => r.balance === undefined)) return undefined;
  const chains = (list: readonly { amount: number; balance?: number }[]) => list.every((r, i) => i === 0 || sameCents(r.balance!, list[i - 1].balance! + r.amount));
  const oldest = chains(rows) ? rows[0] : chains([...rows].reverse()) ? rows[rows.length - 1] : undefined;
  if (!oldest) return undefined;
  const day = from ?? [...rows.map((r) => r.date)].sort()[0];
  return day <= closingDay ? { date: day, amount: round(oldest.balance! - oldest.amount) } : undefined;
}

/**
 * A statement from outside the code (the model's answer, the person's corrected table) in its
 * shape, or undefined when it is none: a currency, the opening and closing balance with their days,
 * movements each with a day and an amount. An opening the statement does not print comes from the
 * balance its rows print (openingOfRows). A wholly empty line is dropped; any other line without
 * a day or an amount makes the statement none, so a misread line is never lost silently.
 */
export function parseReadStatement(x: unknown): ReadStatement | undefined {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return undefined;
  const currency = typeof o.currency === 'string' && /^[A-Za-z]{3}$/.test(o.currency.trim()) ? o.currency.trim().toUpperCase() : undefined;
  const balance = (v: unknown) => {
    const b = v as Record<string, unknown> | null;
    const amount = amountOf(b?.amount);
    return b && isDay(b.date) && amount !== undefined ? { date: b.date, amount: round(amount) } : undefined;
  };
  const closing = balance(o.closing);
  if (!currency || !closing || !Array.isArray(o.movements)) return undefined;
  const movements: ReadStatement['movements'] = [];
  for (const raw of o.movements as unknown[]) {
    const m = raw as Record<string, unknown> | null;
    if (!m || typeof m !== 'object') return undefined;
    const amount = amountOf(m.amount);
    if (!m.date && amount === undefined && !words(m.counterparty) && !words(m.text) && !words(m.reference)) continue;
    if (!isDay(m.date) || amount === undefined) return undefined;
    const page = typeof m.page === 'number' && Number.isInteger(m.page) && m.page > 0 ? m.page : undefined;
    const counterparty = words(m.counterparty, 140), said = words(m.text), reference = words(m.reference, 140);
    const original = originalOf(m.original, currency);
    const after = amountOf(m.balance);
    movements.push({
      date: m.date, ...(isDay(m.valueDate) ? { valueDate: m.valueDate } : {}), amount: round(amount),
      ...(counterparty ? { counterparty } : {}), ...(said ? { text: said } : {}), ...(reference ? { reference } : {}),
      ...(original ? { original } : {}), ...(page ? { page } : {}), ...(after !== undefined ? { balance: round(after) } : {}),
    });
  }
  const p = o.period as Record<string, unknown> | undefined;
  const period = p && isDay(p.from) && isDay(p.to) && p.from <= p.to ? { from: p.from, to: p.to } : undefined;
  const opening = o.opening === undefined || o.opening === null ? openingOfRows(movements, closing, period?.from) : balance(o.opening);
  if (!opening) return undefined;
  const pages = Array.isArray(o.pages) ? (o.pages as (Record<string, unknown> | null)[]).flatMap((p) => {
    if (!p || typeof p.page !== 'number' || !Number.isInteger(p.page) || p.page < 1) return [];
    const carriedIn = amountOf(p.carriedIn), carriedOut = amountOf(p.carriedOut);
    return carriedIn === undefined && carriedOut === undefined ? [] : [{ page: p.page, ...(carriedIn !== undefined ? { carriedIn: round(carriedIn) } : {}), ...(carriedOut !== undefined ? { carriedOut: round(carriedOut) } : {}) }];
  }) : [];
  const compact = typeof o.iban === 'string' ? o.iban.replace(/\s+/g, '').toUpperCase() : '';
  const iban = /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(compact) ? compact : undefined;
  const bankName = words(o.bankName, 140), owner = words(o.owner, 140);
  return {
    ...(iban ? { iban } : {}), currency, ...(bankName ? { bankName } : {}), ...(owner ? { owner } : {}), ...(period ? { period } : {}),
    opening, closing, ...(pages.length ? { pages } : {}), movements,
  };
}

/**
 * A table nobody filled (#254): no movement and both balances 0.00, as the hand form starts. Nothing
 * was checked, so it neither shows «Geht auf» nor imports.
 */
export const isBlank = (s: Pick<ReadStatement, 'movements' | 'opening' | 'closing'>): boolean =>
  !s.movements.length && s.opening.amount === 0 && s.closing.amount === 0;
