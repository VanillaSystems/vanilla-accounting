/**
 * node --import tsx .claude/skills/verify/review-figures.ts <base-books.json> <review-file.json> <merged-books.json>
 *
 * The VAT figures of every quarter the review touches, three ways: the snapshot the Treuhänder
 * reviewed, the snapshot with his corrections replayed (what the review package showed him),
 * and the books after the owner's merge. Exits 1 when a merged figure differs from the preview.
 */
import { readFileSync } from 'node:fs';
import type { Books } from '../../../src/books/lock.js';
import { figuresFromBooks } from '../../../src/accounting/return-figures.js';
import { quartersOf } from '../../../src/review/corrections.js';
import { replay } from '../../../src/review/session.js';
import { parseReviewFile } from '../../../src/review/types.js';

const [basePath, filePath, mergedPath] = process.argv.slice(2);
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const base = read(basePath) as Books;
base.journalEntries ??= [];
base.config ??= {};
const file = parseReviewFile(read(filePath));
const merged = read(mergedPath) as Books;
const previewed = replay(base, file.corrections).books;

const fig = (b: Books, q: Parameters<typeof figuresFromBooks>[1]) => figuresFromBooks(b.journalEntries ?? [], q, b.config?.vatAdjustments ?? []).ziffern;
let bad = 0;
for (const q of quartersOf(file.corrections.flatMap((c) => c.changes))) {
  const [a, p, m] = [fig(base, q), fig(previewed, q), fig(merged, q)];
  console.log(`\n${q}   Ziffer     vorher   Vorschau   nach Merge`);
  for (const z of [...new Set([...Object.keys(a), ...Object.keys(p), ...Object.keys(m)])].sort()) {
    const [x, y, w] = [a[z] ?? 0, p[z] ?? 0, m[z] ?? 0];
    if (x === y && y === w) continue;
    const ok = Math.round(y * 100) === Math.round(w * 100);
    if (!ok) bad++;
    console.log(`         ${z.padEnd(6)} ${x.toFixed(2).padStart(10)} ${y.toFixed(2).padStart(10)} ${w.toFixed(2).padStart(12)}  ${ok ? 'ok' : 'DIFFERS'}`);
  }
}
console.log(bad ? `\n${bad} figure(s) differ from the preview.` : '\nEvery merged figure is the one the review package previewed.');
process.exit(bad ? 1 : 0);
