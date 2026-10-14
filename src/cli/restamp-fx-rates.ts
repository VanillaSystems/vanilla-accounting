/**
 * Restamp the exchangeRate on every foreign-currency journal entry with the official
 * ESTV daily SELL rate valid on that entry's PAYMENT date.
 *
 * Why payment date: cash-basis taxation means the tax point — and therefore the VAT
 * conversion date (MWSTG Art. 24) — is the day the money moved, i.e. the underlying bank
 * transaction's date. Some entries (Shopify revenue/fee) carry a shifted entry.date (the
 * order date), so we deliberately key off the BankTransaction date, not entry.date. Manual
 * corrections with no bank transaction (Eigenverbrauch M2026-xxx) fall back to entry.date.
 *
 * Reads rates from reference/estv-daily-rates-2026.json (run `npm run fetch-rates` first).
 * Applies the ESTV weekend/holiday rule — "apply the most recently recorded daily rate" —
 * by falling back to the latest validity date on or before the payment date.
 *
 * Usage: npm run restamp-fx -- --dry-run   # preview, write nothing
 *        npm run restamp-fx                 # apply and save
 */
import { existsSync } from 'fs';
import { join } from 'path';
import type { JournalEntry } from '../types/index.js';
import { loadBooks, periodLock, saveBooks, update, PERSON } from '../books/store.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { paymentDateOf } from '../accounting/fx-conversion.js';
import { REFERENCE_DIR, openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();
const RATES_PATH = join(REFERENCE_DIR, 'estv-daily-rates-2026.json');

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!existsSync(RATES_PATH)) {
    console.error(`Missing ${RATES_PATH}. Run \`npm run fetch-rates\` first.`);
    process.exit(1);
  }
  const index = loadBooks(ws);
  const fx = loadFxResolver();

  // ref (and split-ref "ref~suffix") -> bank transaction date (the payment date)
  const txDate = new Map<string, string>();
  for (const tx of index.transactions) txDate.set(tx.ref, tx.date);

  const lock = periodLock(index);
  const foreign = index.journalEntries.filter((e) => e.exchangeCurrency);
  const locked = foreign.filter((e) => lock.isClosed(e.date));
  const entries = foreign.filter((e) => !lock.isClosed(e.date));
  if (locked.length > 0) {
    console.log(`Skipping ${locked.length} entrie(s) dated on or before ${lock.closedThrough} (Periode geschlossen).`);
  }
  let changed = 0;
  let unchanged = 0;
  const unresolved: JournalEntry[] = [];

  // Per-account CHF impact (old rate vs new rate), so the restatement is auditable.
  const impact = new Map<string, { old: number; neu: number }>();
  const bump = (acct: string, side: 1 | -1, oldChf: number, newChf: number) => {
    if (!acct) return;
    const cur = impact.get(acct) ?? { old: 0, neu: 0 };
    cur.old += side * oldChf;
    cur.neu += side * newChf;
    impact.set(acct, cur);
  };

  const changes: Array<{ entry: JournalEntry; cur: string; date: string; from?: number; to: number }> = [];

  for (const e of entries) {
    const cur = e.exchangeCurrency!;
    const payDate = paymentDateOf(e, txDate);
    const newRate = fx.daily(cur, payDate);
    if (newRate === undefined) { unresolved.push(e); continue; }

    const oldRate = e.exchangeRate ?? 1;
    const rounded = round6(newRate);
    const oldChf = e.amount * oldRate;
    const newChf = e.amount * rounded;
    bump(e.accountDebit, 1, oldChf, newChf);
    bump(e.accountCredit, -1, oldChf, newChf);

    if (rounded !== oldRate) {
      changes.push({ entry: e, cur, date: payDate, from: e.exchangeRate, to: rounded });
      changed++;
    } else {
      unchanged++;
    }
  }

  // ---- report ----
  console.log(`\nForeign entries: ${entries.length}  |  restamped: ${changed}  |  already correct: ${unchanged}  |  unresolved: ${unresolved.length}`);

  const byCur = new Map<string, number[]>();
  for (const c of changes) {
    if (!byCur.has(c.cur)) byCur.set(c.cur, []);
    byCur.get(c.cur)!.push(c.to);
  }
  for (const [cur, rs] of byCur) {
    const min = Math.min(...rs), max = Math.max(...rs);
    console.log(`  ${cur}: ${rs.length} entries now span ${min}..${max} (was a single flat rate)`);
  }

  const rows = Array.from(impact.entries())
    .map(([acct, v]) => ({ acct, delta: v.neu - v.old, old: v.old, neu: v.neu }))
    .filter((r) => Math.abs(r.delta) >= 0.005)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (rows.length) {
    console.log(`\nCHF balance impact by account (old flat rate → ESTV daily):`);
    for (const r of rows.slice(0, 20)) {
      const sign = r.delta >= 0 ? '+' : '';
      console.log(`  ${r.acct.padEnd(6)} ${sign}${r.delta.toFixed(2)} CHF   (${r.old.toFixed(2)} → ${r.neu.toFixed(2)})`);
    }
  }

  if (unresolved.length) {
    console.log(`\n⚠ No rate found for ${unresolved.length} entries (payment date before the fetched range?):`);
    for (const e of unresolved.slice(0, 10)) console.log(`    ${e.transactionRef} ${e.date} ${e.exchangeCurrency} — ${e.description ?? ''}`);
  }

  if (dryRun) {
    console.log(`\n(dry run — nothing written; re-run without --dry-run to apply)`);
    return;
  }
  update(index, PERSON, () => {
    for (const c of changes) c.entry.exchangeRate = c.to;
  });
  saveBooks(ws, index);
  console.log(`\n✓ Saved ${ws.paths.books} — ${changed} entries restamped.`);
}

main();
