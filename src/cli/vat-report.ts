/**
 * Extract the Swiss VAT return (MWST-Abrechnung) figures per quarter, ready to file.
 *
 * Uses the same vat().report() engine as the UI's MWST tab, so the numbers match
 * what you see on screen. Prints each quarter's Ziffern (form line numbers) plus the
 * amount to pay (500) or credit (510).
 *
 * Usage: npm run vat-report                 # every quarter of the current year so far, plus H1
 *        npm run vat-report -- 2026-Q1      # a single period
 */
import type { Index, QuarterKey } from '../types/index.js';
import { loadBooks, periodLock } from '../books/store.js';
import { derivePeriod, filingKeyOf, isFilingKey } from '../accounting/periods.js';
import { openWorkspace } from '../workspace/workspace.js';
import { filing, vat } from '../engines/index.js';
import type { VatLine } from '../engines/return.js';

// Which per-entry value is the one that sums to the Ziffer's reported amount.
const zifferField = (z: string): 'gross' | 'base' | 'tax' | undefined => {
  const row = vat().rateRows.find((r) => r.ziffer === z);
  if (row) return row.kind === 'supply' ? 'base' : 'tax';
  if (z === vat().form.turnoverBox || z in vat().form.deductions) return 'gross';
  return z in vat().form.inputTax ? 'tax' : undefined;
};

const ws = openWorkspace();

function fmt(n: number): string {
  return n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(12);
}

function printPeriod(label: string, index: Index, from: string, to: string, detail: boolean) {
  const entries = index.journalEntries ?? [];
  const adjustments = index.config?.vatAdjustments ?? [];
  // A filing period prints the figures the return files (the page's, the XML's); a year or a half-year sum print the entries' tax (r10c-5).
  const rep = isFilingKey(label, filing().length) ? vat().filedReport(entries, label as QuarterKey, adjustments) : vat().report(entries, label, adjustments);
  const lines = detail ? vat().lines(entries, label, adjustments) : {};
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  MWST-Abrechnung  ${label}   (${from} … ${to})`);
  console.log('='.repeat(72));
  const lock = periodLock(index);
  // Approved («Freigegeben») but not filed yet: the period is held, not set in stone (r9c-17).
  const held = lock.heldBy(to);
  if (held) {
    console.log(`  FREIGEGEBEN, noch nicht eingereicht — ${held.period} is approved and waits for «Eingereicht»; its`);
    console.log('  records are held until then (or until «Zurück» frees them). Nothing is in filings/ yet.');
    console.log('-'.repeat(72));
  } else if (lock.isClosed(to)) {
    console.log(`  EINGEREICHT — set in stone. The return as filed is in filings/${from.slice(0, 4)}/;`);
    if (isFilingKey(label, filing().length)) {
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
      const field = zifferField(z.number) ?? 'gross';
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
  const today = new Date().toISOString().slice(0, 10);
  const curYear = today.slice(0, 4);
  // Every filing period of the year so far, and the first half year as a sum where the firm files quarterly.
  const soFar = [...new Set([1, 4, 7, 10].map((m) => `${curYear}-${String(m).padStart(2, '0')}-01`).filter((d) => d <= today).map((d) => filingKeyOf(d, filing().length)))];
  const keys = periodArg ? [periodArg] : soFar.concat(filing().length === 'quarter' ? [`${curYear}-H1`] : []);
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
