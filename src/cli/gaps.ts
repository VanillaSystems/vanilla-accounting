/**
 * npm run gaps [-- <period>]
 *
 * Where the knowledge base is still thin: the transactions of the period that route to no
 * supplier, customer or authority file, grouped by merchant text, most frequent first. A period
 * is 2026-Q3, 2026-H2 or 2026; without one, every transaction after closedThrough. Read-only.
 */
import { derivePeriod } from '../accounting/periods.js';
import { loadBooks, periodLock } from '../books/store.js';
import { knowledgeGaps } from '../knowledge/gaps.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { APP_ROOT, openWorkspace } from '../workspace/workspace.js';

const key = process.argv[2];
const period = key ? derivePeriod(key) : undefined;
if (key && !period) {
  console.error('Usage: npm run gaps [-- <YYYY-Qn | YYYY-Hn | YYYY>]');
  process.exit(1);
}
const ws = openWorkspace();
const books = loadBooks(ws);
const lock = periodLock(books);
const txs = books.transactions.filter((t) => (period ? t.date >= period.from && t.date <= period.to : !lock.isClosed(t.date)));
const gaps = knowledgeGaps(txs, books, loadKnowledge(APP_ROOT, ws.paths.root).counterparties);
const unrouted = gaps.reduce((n, g) => n + g.count, 0);
const scope = key ?? (lock.closedThrough ? `after ${lock.closedThrough}` : 'all periods');

console.log(`${scope}: ${unrouted} of ${txs.length} transactions route to no supplier, customer or authority file.`);
if (gaps.length) {
  console.log('\n count  merchant                                   example');
  for (const g of gaps) console.log(`${String(g.count).padStart(6)}  ${g.merchant.padEnd(40)}   ${g.example}`);
  console.log('\nThe frequent ones are worth a file: knowledge/suppliers/<id>.yaml (or customers/, authorities/)'
    + ' with match.tx naming the merchant text. See docs/quarter-workflow.md#5-review-the-open-cases.');
}
