/**
 * How long «Ist das dieselbe Zahlung?» takes on books of N movements (#254, src/books/twins.ts
 * heldByTwins), which the inbox run asks once per payment: `npx tsx tools/test/twins-bench.ts 2000`.
 * Invented books: every tenth movement read from a PDF, with the bank's twin two days later and five
 * Rappen off; a quarter booked; the first quarter filed.
 */
import { heldByTwins } from '../../src/books/twins.js';
import type { BankTransaction } from '../../src/types/index.js';

const N = Number(process.argv[2] ?? 2000);
const payees = ['Coop', 'Migros', 'Swisscom', 'Digitec', 'Galaxus', 'SBB', 'Post', 'Zalando', 'Brack', 'Interdiscount', 'Landi', 'Ikea', 'Denner', 'Lidl'];
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + Math.min(n, 364) * 86_400_000).toISOString().slice(0, 10);
const transactions: BankTransaction[] = [];
for (let i = 0; transactions.length < N; i++) {
  const base = { bank: 'Bank', currency: 'CHF', direction: i % 3 ? 'DBIT' : 'CRDT', counterparty: payees[i % payees.length], description: `Zahlung ${payees[i % payees.length]}` } as const;
  const amount = 10 + (i * 37 % 900);
  if (i % 10 === 0) {
    transactions.push({ ...base, ref: `R${i}`, date: day(i * 0.2 | 0), amount, unmatched: { since: '2026-10-01', by: 'Bank/x.xml' }, source: 'manual' });
    transactions.push({ ...base, ref: `B${i}t`, date: day((i * 0.2 | 0) + 2), amount: amount + 0.05 });
  } else transactions.push({ ...base, ref: `B${i}`, date: day(i * 0.2 | 0), amount: amount + (i % 5) / 100 });
}
const books = { transactions, journalEntries: transactions.filter((_, i) => i % 4 === 1).map((t) => ({ transactionRef: t.ref })) };
const isClosed = (d: string) => d <= '2026-03-31';
const run = () => heldByTwins(books, isClosed, new Set());
run();
const times: number[] = [];
for (let i = 0; i < 15; i++) { const t = performance.now(); run(); times.push(performance.now() - t); }
times.sort((a, b) => a - b);
console.log(`N=${N} held=${run().size} median ${times[7].toFixed(2)} ms (min ${times[0].toFixed(2)}, max ${times[14].toFixed(2)})`);
