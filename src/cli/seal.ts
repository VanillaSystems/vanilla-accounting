/**
 * npm run seal -- <YYYY-Qn> [--close]
 *
 * Seals a filed quarter: writes filings/<year>/seal-<Qn>.json with a hash of every journal
 * entry, bank transaction and receipt mapping dated on or before its last day
 * (src/books/seal.ts). From then on every load of the books checks it.
 *
 *   npm run seal -- 2026-Q3 --close   after filing 2026-Q3: moves config.closedThrough to
 *                                     2026-09-30, then seals the quarter
 *   npm run seal -- 2026-Q1           seals a quarter that is closed already
 *
 * Safe to rerun: an intact seal is left as it is, and --close on a closed quarter only seals.
 * --close moves closedThrough forward by one quarter at a time, never back.
 *
 * The fourth quarter closes with the year: `npm run year:close` books the year-end entries on
 * 31.12. first, then closes and seals it. `--close` refuses a fourth quarter unless `--force`
 * says the year-end entries are booked already.
 */
import { closeThrough, loadBooks, saveBooks } from '../books/store.js';
import { readFromPdfs } from '../books/bank-import.js';
import { Refused } from '../types/refusal.js';
import { asQuarter, checkSeals, closesTheYear, periodKeyOf, writeSeal } from '../books/seal.js';
import { addDays, derivePeriod } from '../accounting/periods.js';
import { openWorkspace } from '../workspace/workspace.js';

const args = process.argv.slice(2);
const ws = openWorkspace();
const quarter = asQuarter(args.find((a) => !a.startsWith('--')) ?? '', ws.filingLength);
if (!quarter) {
  const half = ws.filingLength === 'half';
  console.error(`Usage: npm run seal -- <${half ? 'YYYY-Hn' : 'YYYY-Qn'}> [--close]   e.g. npm run seal -- ${half ? '2026-H1' : '2026-Q3'} --close`);
  process.exit(2);
}
const books = loadBooks(ws);
const end = derivePeriod(quarter)!.to;
const closedThrough = books.config.closedThrough;

if (args.includes('--close') && (!closedThrough || closedThrough < end)) {
  const next = closedThrough ? periodKeyOf(addDays(closedThrough, 1), ws.filingLength) : quarter;
  if (next !== quarter) {
    console.error(`The books are closed through ${closedThrough}; the next ${ws.filingLength === 'half' ? 'half year' : 'quarter'} to close is ${next}, not ${quarter}.`);
    process.exit(1);
  }
  if (closesTheYear(quarter) && !args.includes('--force')) {
    console.error(`${quarter} closes with the year: npm run year:close -- ${quarter.slice(0, 4)} books the Kursdifferenz and the other year-end entries on 31.12. first, then closes and seals it (docs/year-end.md).\nClosing it now leaves nothing to date 31.12. Add --force if the year-end entries are booked already.`);
    process.exit(1);
  }
  try {
    closeThrough(books, end, readFromPdfs(ws));
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    console.error(`${e.message}. Nothing closed or sealed.`);
    process.exit(1);
  }
  saveBooks(ws, books);
  console.log(`Closed: config.closedThrough ${closedThrough ?? '(not set)'} → ${end}. Nothing dated on or before it can change any more.`);
}

try {
  const result = writeSeal(ws, books, quarter, new Date().toISOString().slice(0, 10));
  if (result.status === 'intact') console.log(`${quarter} is sealed already, and the seal holds: ${result.file}`);
  else console.log(`Sealed ${quarter}: ${result.file}\n  ${result.seal!.records.entries} entries, ${result.seal!.records.transactions} transactions, ${result.seal!.records.mappings} mappings, sha256 ${result.seal!.sha256.slice(0, 16)}…`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const { unsealed } = checkSeals(ws, books);
if (unsealed.length) console.log(`Closed ${ws.filingLength === 'half' ? 'half years' : 'quarters'} without a seal: ${unsealed.join(', ')} (npm run seal -- <period> for each)`);
console.log('Commit the workspace now (books.json and filings/), so the filed state is on record.');
