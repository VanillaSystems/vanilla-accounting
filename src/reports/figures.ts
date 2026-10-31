/**
 * The figures an answer's words state beside a report (src/assistant/conversations.ts): the
 * report's figures come from code only, so a number in the answer that the report's run did not
 * produce is the model's own, and the app withdraws the answer's words. Dates, years, quarters and
 * the accounts of the chart are no figures.
 */
import type { ReportResult } from './result.js';
import { accountRangeText } from './spec.js';

const cents = (n: number) => Math.round(Math.abs(n) * 100);

/** The numbers a text states, in cents: 1'234.50, 1234,50, 1 234.50, 42, 12.5 %. Dates (16.10.2026, 2026-07-01) and Q3 are left out. */
export function numbersIn(text: string): Array<{ text: string; cents: number }> {
  const plain = text
    .replace(/\b\d{1,2}\.\d{1,2}\.(\d{2}|\d{4})\b/g, ' ')
    .replace(/\b\d{4}-\d{2}(-\d{2})?(\.\.\d{4}-\d{2}-\d{2})?\b/g, ' ')
    .replace(/\b[QH]\d\b/gi, ' ')
    .replace(/\{[^{}]*\}/g, ' ');
  const out: Array<{ text: string; cents: number }> = [];
  for (const m of plain.matchAll(/(?<![\w.,'’])\d{1,3}(?:(?:['’   ]\d{3})+)?(?:[.,]\d{1,2})?(?![\d\w])|(?<![\w.,'’])\d+(?:[.,]\d{1,2})?(?![\d\w])/g)) {
    const raw = m[0].replace(/['’   ]/g, '').replace(',', '.');
    out.push({ text: m[0], cents: Math.round(Number(raw) * 100) });
  }
  return out;
}

/** What the run produced: every amount, net, tax and count of its rows and totals, the accounts its filters name, the period's years. */
function produced(results: readonly ReportResult[]): Set<number> {
  const out = new Set<number>();
  const add = (n: number) => out.add(cents(n));
  for (const r of results) {
    add(r.count);
    for (const y of [r.period.from, r.period.to]) add(Number(y.slice(0, 4)));
    for (const t of r.totals) { add(t.amount); add(t.net); add(t.tax); add(t.count); }
    for (const s of r.sections) {
      add(s.count);
      for (const t of s.totals) { add(t.amount); add(t.net); add(t.tax); add(t.count); }
      for (const a of s.section.filter.accounts ?? []) for (const x of accountRangeText(a).split('-')) add(Number(x));
      for (const g of s.groups) {
        if (/^\d+$/.test(g.key)) add(Number(g.key));
        for (const t of g.totals) { add(t.amount); add(t.net); add(t.tax); add(t.count); }
        for (const row of g.rows) { add(row.amount); add(row.net); add(row.tax); }
      }
    }
  }
  return out;
}

/** The numbers of `text` that none of the reports produced; `accounts`: the chart's numbers, which name an account, not a figure. */
export function strayFigures(text: string, results: readonly ReportResult[], accounts: readonly string[] = []): string[] {
  const known = produced(results);
  for (const a of accounts) if (/^\d+$/.test(a)) known.add(Number(a) * 100);
  return numbersIn(text).filter((n) => !known.has(n.cents)).map((n) => n.text);
}
