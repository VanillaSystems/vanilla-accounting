/**
 * Extract the Swiss VAT return (MWST-Abrechnung) figures per quarter, ready to file.
 *
 * Uses the same computeVatReport() engine as the UI's MWST tab, so the numbers match
 * what you see on screen. Prints each quarter's Ziffern (form line numbers) plus the
 * amount to pay (500) or credit (510).
 *
 * Usage: npm run vat-report                 # every quarter of the current year so far, plus H1
 *        npm run vat-report -- 2026-Q1      # a single period
 */
import type { Index } from '../types/index.js';
import { loadBooks, periodLock } from '../books/store.js';
import { computeVatReport, computeVatReportLines, type VatLine } from '../accounting/vat-report.js';
import { derivePeriod } from '../accounting/periods.js';
import { TAX_RATE_ROWS } from '../accounting/ziffern.js';
import { openWorkspace } from '../workspace/workspace.js';

// Which per-entry value is the one that sums to the Ziffer's reported amount.
const ZIFFER_FIELD: Record<string, 'gross' | 'base' | 'tax'> = {
  '200': 'gross', '220': 'gross', '221': 'gross', '225': 'gross', '230': 'gross', '280': 'gross',
  ...Object.fromEntries(TAX_RATE_ROWS.map((row) => [row.ziffer, row.kind === 'supply' ? 'base' : 'tax'] as const)),
  '400': 'tax', '405': 'tax', '410': 'tax', '415': 'tax', '420': 'tax',
};

const ws = openWorkspace();

function fmt(n: number): string {
  return n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(12);
}

function printPeriod(label: string, index: Index, from: string, to: string, detail: boolean) {
  const entries = index.journalEntries ?? [];
  const adjustments = index.config?.vatAdjustments ?? [];
  const rep = computeVatReport(entries, label, adjustments);
  const lines = detail ? computeVatReportLines(entries, label, adjustments) : {};
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  MWST-Abrechnung  ${label}   (${from} … ${to})`);
  console.log('='.repeat(72));
  if (periodLock(index).isClosed(to)) {
    console.log(`  EINGEREICHT — set in stone. The return as filed is in filings/${from.slice(0, 4)}/;`);
    if (/-Q\d$/.test(label)) {
      console.log('  The figures below are recomputed from today\'s books, including entries tagged');
      console.log(`  corrects: "${label}", so they are what its Korrekturabrechnung (form 0535) declares.`);
    } else {
      console.log('  The figures below are recomputed from today\'s books for every entry dated in the range.');
    }
    console.log('-'.repeat(72));
  }
  for (const z of rep.ziffern) {
    // Skip empty optional lines to keep the sheet readable, but always show the key totals.
    const keyLine = ['200', '299', '399', '479', '500', '510'].includes(z.number);
    if (z.amount === 0 && !keyLine) continue;
    const mark = keyLine ? ' *' : '  ';
    console.log(`${mark} Ziffer ${z.number.padEnd(4)} ${z.label.padEnd(42)} ${fmt(z.amount)}`);

    if (detail && lines[z.number]?.length) {
      const field = ZIFFER_FIELD[z.number] ?? 'gross';
      const rows = lines[z.number].slice().sort((a, b) => a.date.localeCompare(b.date));
      let sum = 0;
      for (const r of rows) {
        const v = r[field] as number;
        sum += v;
        console.log(`        ${r.date}  ${r.code.padEnd(7)} ${String(r.description).slice(0, 46).padEnd(46)} ${fmt(v)}`);
      }
      console.log(`        ${''.padEnd(7 + 1)}${'—'.repeat(46)} ${fmt(sum)}  (${rows.length} Buchungen)`);
      console.log('');
    }
  }
  if (rep.toPay > 0) console.log(`\n  → ZU BEZAHLEN (Ziffer 500): CHF ${fmt(rep.toPay).trim()}`);
  else console.log(`\n  → GUTHABEN (Ziffer 510): CHF ${fmt(rep.credit).trim()}`);
}

function main() {
  const index = loadBooks(ws);

  const args = process.argv.slice(2);
  const detail = args.includes('--detail');
  const periodArg = args.find(a => !a.startsWith('--'));
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curQ = Math.floor(now.getUTCMonth() / 3) + 1;
  const keys = periodArg
    ? [periodArg]
    : [...Array(curQ).keys()].map((i) => `${curYear}-Q${i + 1}`).concat(`${curYear}-H1`);
  for (const key of keys) {
    const p = derivePeriod(key);
    if (!p) {
      console.error(`Unknown period "${key}". Use YYYY-Qn, YYYY-Hn or YYYY (e.g. 2026-Q3).`);
      process.exit(1);
    }
    printPeriod(key, index, p.from, p.to, detail);
  }
  console.log(`\n(* = key totals. Leistungen rows (303, 313, 343, …) show the taxable base; 382/383 and 400-420 show tax amounts. Add --detail for the per-transaction breakdown.)`);
}

main();
