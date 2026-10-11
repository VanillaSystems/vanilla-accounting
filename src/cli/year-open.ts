/**
 * npm run year:open -- <YYYY> [--dry-run] [--rates-dir <dir>]
 *
 * Opens <YYYY> from the app's own closed books of the year before (docs/year-end.md): the
 * balance-sheet accounts carried, profit and loss reset, the result added to retained earnings,
 * each foreign account's native closing balance carried with its CHF at the 31.12. rate. Writes
 * config.openingBalances[<YYYY>] and config.openingBalancesNative[<YYYY>].
 *
 * Safe to rerun: after a correction of the old year it updates the opening balances and lists
 * what changed. The other source is Banana's closed year: npm run import-opening.
 */
import { parseArgs } from 'node:util';
import { openingFor, openYear, ratesOf, YearCloseRefused } from '../books/year-close.js';
import type { Opening } from '../accounting/year-close.js';
import { loadBooks } from '../books/store.js';
import { openWorkspace } from '../workspace/workspace.js';
import { causeText, chf } from './year-close-text.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, 'rates-dir': { type: 'string' } } });
const year = positionals[0] ?? '';
if (!/^\d{4}$/.test(year)) {
  console.error('Usage: npm run year:open -- <YYYY> [--dry-run]   e.g. npm run year:open -- 2027');
  process.exit(2);
}
const closed = String(+year - 1);
const ws = openWorkspace();
const rates = ratesOf(values['rates-dir']);

function print(o: Opening): void {
  console.log(`\nOpening balances on 1.1.${o.year}, from the closed ${closed}\n`);
  for (const [account, value] of Object.entries(o.balances)) {
    const native = o.native[account];
    console.log(`  ${account}  ${chf(value).padStart(14)}${native ? `   ${native.currency} ${chf(native.amount)}` : ''}`);
  }
  console.log(`\n  Result ${closed}: ${o.result >= 0 ? 'profit' : 'loss'} CHF ${chf(Math.abs(o.result))}, carried to ${o.retainedEarnings} (profit allocation is a later entry of its own)`);
  console.log(`  Aktiven ${chf(o.totalAssets)}  Passiven ${chf(o.totalLiabilities)}  ${o.residual === 0 ? '✓ balanced' : `✗ difference ${chf(o.residual)}`}`);
  for (const c of o.causes) console.log(`    ${causeText(c)}`);
}

async function main(): Promise<number> {
  if (values['dry-run']) {
    print(openingFor(ws, closed, rates, loadBooks(ws)));
    console.log('\n--dry-run: nothing written.');
    return 0;
  }
  const { opening, changes, ratesReady } = await openYear(ws, closed, rates);
  print(opening);
  if (changes.length) {
    console.log(`\nUpdated config.openingBalances.${opening.year}:`);
    for (const c of changes) console.log(`  ${c.account}  ${chf(c.before).padStart(14)} → ${chf(c.after).padStart(14)}`);
  } else console.log(`\nconfig.openingBalances.${opening.year} is up to date.`);
  if (!ratesReady) console.log(`\n! The ESTV rates do not reach into ${opening.year} yet: npm run fetch-rates -- --year ${opening.year}`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (!(e instanceof YearCloseRefused)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
