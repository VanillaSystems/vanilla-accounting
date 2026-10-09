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
 */
import { loadBooks, saveBooks } from '../books/store.js';
import { asQuarter, checkSeals, quarterOf, writeSeal } from '../books/seal.js';
import { derivePeriod } from '../accounting/periods.js';
import { openWorkspace } from '../workspace/workspace.js';

const args = process.argv.slice(2);
const quarter = asQuarter(args.find((a) => !a.startsWith('--')) ?? '');
if (!quarter) {
  console.error('Usage: npm run seal -- <YYYY-Qn> [--close]   e.g. npm run seal -- 2026-Q3 --close');
  process.exit(2);
}
const ws = openWorkspace();
const books = loadBooks(ws);
const end = derivePeriod(quarter)!.to;
const closedThrough = books.config.closedThrough;

if (args.includes('--close') && (!closedThrough || closedThrough < end)) {
  const next = closedThrough ? quarterOf(new Date(Date.parse(closedThrough) + 86_400_000).toISOString().slice(0, 10)) : quarter;
  if (next !== quarter) {
    console.error(`The books are closed through ${closedThrough}; the next quarter to close is ${next}, not ${quarter}.`);
    process.exit(1);
  }
  books.config.closedThrough = end;
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
if (unsealed.length) console.log(`Closed quarters without a seal: ${unsealed.join(', ')} (npm run seal -- <quarter> for each)`);
console.log('Commit the workspace now (books.json and filings/), so the filed state is on record.');
