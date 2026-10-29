/**
 * #190 part 3: a supplier's usual delay between receipt and payment, from the books' own links,
 * ranks a receipt's candidates and reaches past the fixed window for a supplier that pays late.
 * Invented suppliers and payments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { DELAY, delaysOf } from '../src/intake/delays.js';
import { BOUNDS, searchPairs, stagesOf } from '../src/intake/pairing.js';
import { runPairChain } from '../src/intake/pair-chain.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Mapping, Receipt } from '../src/types/index.js';

const toChf = (a: number) => a;
let n = 0;
const receipt = (date: string, vendor: string, amount = 50): Receipt => {
  const k = ++n;
  return { id: `r${k}`, filename: `beleg-${k}.pdf`, originalFilename: `beleg-${k}.pdf`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date, amount, currency: 'CHF', title: { vendor, what: 'Fracht' }, extractedText: vendor } as Receipt;
};
const pay = (ref: string, date: string, amount = 50, description = 'Zahlung Kurierdienst Beispiel'): BankTransaction =>
  ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction: 'DBIT', description });
const booksOf = (transactions: BankTransaction[], receipts: Receipt[], mappings: Mapping[] = []): Books =>
  ({ transactions, receipts, mappings, bankStatements: [], journalEntries: [], config: {} }) as unknown as Books;
const plusDays = (date: string, d: number) => new Date(Date.parse(date) + d * 864e5).toISOString().slice(0, 10);

/** `delays.length` past receipts of `vendor`, each linked to a payment that many days after it. */
function history(vendor: string, delays: number[]) {
  const rs = delays.map((_, i) => receipt(`2026-0${i + 1}-05`, vendor, 30 + i));
  const ps = delays.map((d, i) => pay(`H-${vendor}-${i}`, plusDays(rs[i].date!, d), 30 + i));
  return { rs, ps, ms: rs.map((r, i) => ({ transactionRef: ps[i].ref, receiptId: r.id, by: 'human' as const })) };
}

test(`delaysOf: the median once ${DELAY.after} receipts show a pattern, none for fewer or a scatter`, () => {
  const steady = history('Kurierdienst Beispiel', [20, 22, 21]);
  const few = history('Druckerei Muster', [20, 21]);
  const scatter = history('Verlag Beispiel', [0, 20, 40]);
  const all = booksOf([...steady.ps, ...few.ps, ...scatter.ps], [...steady.rs, ...few.rs, ...scatter.rs], [...steady.ms, ...few.ms, ...scatter.ms]);
  const delays = delaysOf(all);
  assert.equal(delays(receipt('2026-07-01', 'KURIERDIENST Beispiel.')), 21, 'one supplier by its title, whatever its case and stops');
  assert.equal(delays(receipt('2026-07-01', 'Druckerei Muster')), undefined, 'two receipts are no pattern yet');
  assert.equal(delays(receipt('2026-07-01', 'Verlag Beispiel')), undefined, 'a scatter is no pattern');
});

test('a supplier that pays three weeks later: its candidate on the usual day outranks a nearer one, and a far one no longer competes', async () => {
  const past = history('Kurierdienst Beispiel', [20, 22, 21]);
  const r = receipt('2026-08-01', 'Kurierdienst Beispiel');
  const books = booksOf([...past.ps, pay('EARLY', '2026-08-03'), pay('USUAL', '2026-08-22')], [...past.rs, r], past.ms);
  assert.deepEqual(searchPairs(books, toChf, () => false).byReceipt.get(r.id)!.map((c) => c.payment), ['EARLY', 'USUAL'], 'without its delay the nearer day wins');
  assert.deepEqual(searchPairs(books, toChf, () => false, { delays: delaysOf(books) }).byReceipt.get(r.id)!.map((c) => [c.payment, c.offDays]), [['USUAL', 0], ['EARLY', -19]]);

  const far = booksOf([...past.ps, pay('USUAL', '2026-08-22'), pay('FAR', '2026-09-25')], [...past.rs, r], past.ms);
  assert.deepEqual(stagesOf(searchPairs(far, toChf, () => false), { receipt: r.id }).map((s) => s.kind), ['short'], 'without its delay the two are close');
  assert.deepEqual(stagesOf(searchPairs(far, toChf, () => false, { delays: delaysOf(far) }), { receipt: r.id }).map((s) => s.kind), ['clear']);
  const port = { read: () => far, update: <T>(fn: (b: Books) => T) => fn(far) };
  const result = await runPairChain(port, { toChf });
  assert.deepEqual(result.linked.map((l) => [l.receipt, l.payment]), [[r.id, 'USUAL']], 'the chain reads the delays off the books itself');
});

test('a supplier that pays later than the fixed window: its payment is a candidate as far past its usual delay as the reach', () => {
  const late = BOUNDS.daysAfter + 10;
  const past = history('Kurierdienst Beispiel', [late, late + 2, late + 1]);
  const r = receipt('2026-08-01', 'Kurierdienst Beispiel');
  const books = booksOf([...past.ps, pay('LATE', plusDays('2026-08-01', late + 1)), pay('BEYOND', plusDays('2026-08-01', late + 1 + DELAY.reach + 1))], [...past.rs, r], past.ms);
  assert.deepEqual(searchPairs(books, toChf, () => false).byReceipt.get(r.id), [], 'the fixed window ends before');
  assert.deepEqual(searchPairs(books, toChf, () => false, { delays: delaysOf(books) }).byReceipt.get(r.id)!.map((c) => c.payment), ['LATE']);
});

test('a usual delay within the first day band changes nothing: the receipt\'s day speaks for itself', () => {
  const past = history('Abo Beispiel', [1, 1, 1]);
  const r = receipt('2026-08-01', 'Abo Beispiel');
  const books = booksOf([...past.ps, pay('P', '2026-08-31')], [...past.rs, r], past.ms);
  const strip = (cs: ReturnType<typeof searchPairs>['byReceipt'] extends Map<string, infer V> ? V : never) => cs.map((c) => [c.payment, c.score, c.offDays]);
  assert.deepEqual(strip(searchPairs(books, toChf, () => false, { delays: delaysOf(books) }).byReceipt.get(r.id)!), strip(searchPairs(books, toChf, () => false).byReceipt.get(r.id)!));
});
