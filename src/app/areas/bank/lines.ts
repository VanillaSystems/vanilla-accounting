/**
 * Where a payment stands on its statement PDF: the vertical bands of its line(s), found in the
 * page's own text (pdf.js text content in page pixels). A Wise statement prints each transaction's
 * id, so the payment's (and its fee's) id finds it; an older import that carries Wise's internal
 * id is found by its amount and the date line under it. Other banks print one row per booking
 * with the date first ("04.09.26") and the amount in a column: the row of that amount closest to
 * the payment's date, with the lines of text that continue it.
 */
import type { BankTransaction } from '../../../types/index.js';

/** One piece of text on the page: its string, where it starts and how high it is, in page pixels (y grows down). */
export interface TextItem { s: string; x: number; y: number; h: number }

interface Line { y: number; h: number; s: string; items: TextItem[] }

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function linesOf(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  for (const it of items.filter((i) => i.s.trim()).map((i) => ({ ...i, s: i.s.trim() })).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = lines.at(-1);
    if (last && Math.abs(last.y - it.y) < it.h * 0.5) { last.items.push(it); last.s += ` ${it.s}`; last.h = Math.max(last.h, it.h); }
    else lines.push({ y: it.y, h: it.h, s: it.s, items: [it] });
  }
  return lines;
}

/** The bands [top, bottom] that hold the payment's line(s), in page pixels; empty when it is not on this page. `wise`: the account's statements are Wise's. */
export function findLines(items: TextItem[], t: Pick<BankTransaction, 'ref' | 'date' | 'amount'>, wise: boolean, fee?: Pick<BankTransaction, 'ref'>): Array<[number, number]> {
  const lines = linesOf(items);
  const band = (i: number, j: number): [number, number] => [lines[i].y - lines[i].h * 1.2, lines[j].y + lines[j].h * 0.45];
  const out: Array<[number, number]> = [];
  const amount = Math.abs(t.amount).toFixed(2);
  if (wise) {
    for (const ref of [t.ref, fee?.ref].filter((r): r is string => !!r).map((r) => r.split('~')[0])) {
      const re = new RegExp(`(^|[^-\\w])${ref.replace(/[-]/g, '\\-')}(?![\\w-])`);
      const i = lines.findIndex((l) => re.test(l.s));
      if (i < 0) continue;
      let j = i;
      while (j > 0 && i - j < 4 && !/-?[\d,]+\.\d\d\s+-?[\d,]+\.\d\d\s*$/.test(lines[j].s)) j--;
      out.push(band(j, i));
    }
    if (!out.length) {
      const day = `${Number(t.date.slice(8))} ${EN_MONTHS[Number(t.date.slice(5, 7)) - 1]} ${t.date.slice(0, 4)}`;
      const hasAmount = (l: Line) => l.items.some((it) => it.s.replace(/,/g, '').replace(/^-/, '') === amount);
      for (let i = 0; i < lines.length && !out.length; i++) {
        if (!hasAmount(lines[i])) continue;
        for (let k = i + 1; k <= i + 3 && k < lines.length; k++) if (lines[k].s.startsWith(day)) { out.push(band(i, k)); break; }
      }
    }
    return out;
  }
  // A column holds the amount alone ("1'234.50"); a line printed as one text has it between separators.
  const norm = (s: string) => s.replace(/['’\s]/g, '').replace(/,(?=\d{3})/g, '').replace(/^-/, '');
  const hasAmount = (l: Line) => l.items.some((it) => norm(it.s) === amount || it.s.split(/\s*\|\s*|\s{2,}/).some((part) => norm(part) === amount));
  const dateOf = (l: Line) => { const m = /^(\d\d)\.(\d\d)\.(\d{4}|\d\d)\b/.exec(l.s); return m ? `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2]}-${m[1]}` : null; };
  const near = (d: string) => Math.abs(Date.parse(d) - Date.parse(t.date));
  const best = lines
    .map((l, i) => ({ i, d: dateOf(l) }))
    .filter((c): c is { i: number; d: string } => !!c.d && hasAmount(lines[c.i]))
    .sort((a, b) => near(a.d) - near(b.d))[0];
  if (best) {
    let j = best.i;
    while (j + 1 < lines.length && j - best.i < 2 && !dateOf(lines[j + 1]) && lines[j + 1].y - lines[j].y < lines[j].h * 1.8) j++;
    out.push(band(best.i, j));
  }
  return out;
}
