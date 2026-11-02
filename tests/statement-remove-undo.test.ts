/**
 * «Auszug entfernen» and its «Rückgängig» on the demo's books (r9k-3, r10h-3): the removal changes only
 * the statement and what belongs to it, the undo gives the books back byte for byte, and a balance of a
 * filed quarter never changes. The demo's index holds statement PDFs whose balances no file on disk
 * repeats (their tables were never kept beside them): read again from the folder they would be lost.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';

const BOOKS = 'transactional-data/2026/books';
const JULY = 'Kontoauszug 01.07.2026 - 31.07.2026 - CH6580808000000000001 - 2026-07-31.pdf';

/** Every line of the books' files, as `file: line`. */
function booksLines(root: string): string[] {
  const dir = join(root, BOOKS);
  return readdirSync(dir).sort().flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => `${f}: ${l}`));
}

function lineDiff(before: string[], after: string[]): string[] {
  const was = new Set(before), now = new Set(after);
  return [...before.filter((l) => !now.has(l)).map((l) => `- ${l}`), ...after.filter((l) => !was.has(l)).map((l) => `+ ${l}`)];
}

test('removing a statement PDF takes only it and its balance; the undo gives the books back byte for byte', async () => {
  const api = await startApi('demo/vanilla-accounting');
  try {
    cpSync(join(process.cwd(), 'demo/vanilla-accounting/transactional-data'), join(api.root, 'transactional-data'), { recursive: true, filter: (src) => !src.includes('/books') });
    const before = booksLines(api.root);
    const pdf = readFileSync(join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen', JULY));

    const removed = await api.send('DELETE', `/api/statements/Raiffeisen/${encodeURIComponent(JULY)}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    const gone = lineDiff(before, booksLines(api.root));
    assert.deepEqual(gone.map((l) => l.replace(/: .*"date":"([^"]+)".*/, ': $1').replace(/: .*"filename":"([^"]+)".*/, ': $1')),
      ['- balances.jsonl: 2026-07-31', `- statements.jsonl: ${JULY}`], `only the statement and its balance leave:\n${gone.join('\n')}`);

    const restored = await api.send('POST', '/api/statements/restore', { undo: (removed.json as { undo: string }).undo });
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    assert.deepEqual(readFileSync(join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen', JULY)), pdf, 'the file is back');
    assert.deepEqual(booksLines(api.root), before, 'the books read byte for byte as before the removal');
  } finally { await api.stop(); }
});

test('a statement of a filed quarter is not removed: its balance stays as filed', async () => {
  const api = await startApi('demo/vanilla-accounting');
  try {
    cpSync(join(process.cwd(), 'demo/vanilla-accounting/transactional-data'), join(api.root, 'transactional-data'), { recursive: true, filter: (src) => !src.includes('/books') });
    const before = booksLines(api.root);
    const march = 'Kontoauszug 01.03.2026 - 31.03.2026 - CH6580808000000000001 - 2026-03-31.pdf';
    const refused = await api.send('DELETE', `/api/statements/Raiffeisen/${encodeURIComponent(march)}`);
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.deepEqual(lineDiff(before, booksLines(api.root)), [], 'nothing changed');
  } finally { await api.stop(); }
});
