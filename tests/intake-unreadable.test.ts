/**
 * A file that is no PDF inside (r8k-9: a 4-byte a.pdf stayed «in Arbeit» for good, in the inbox,
 * no receipt, no quarantine): the drop puts it into quarantine with its reason, and the read step
 * does the same with one that reached the inbox another way (the Finder, a mailbox), so nothing
 * lies in beleg-import/ that no step will ever read.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recognize } from '../src/intake/recognize.js';
import { readStep } from '../src/intake/read.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { moduleActor } from '../src/books/store.js';
import { quarantined } from '../src/intake/quarantine.js';
import { tempWorkspace } from './support/workspace.js';

test('a PDF header on bytes pdf.js cannot open is recognized as unreadable: quarantine, with the reason', async () => {
  assert.deepEqual(await recognize(Buffer.from('%PDF'), 'a.pdf'), { kind: 'receipt', how: 'structure', state: 'quarantine', reason: 'unreadable' });
  assert.deepEqual(await recognize(Buffer.from('%PDF-1.4\n%%EOF\n'), 'b.pdf'), { kind: 'receipt', how: 'structure', state: 'quarantine', reason: 'unreadable' }, 'a header and an end, nothing between');
});

test('the read step moves a .pdf that is no PDF inside out of the inbox into quarantine, and says why', async () => {
  const ws = tempWorkspace('unreadable-');
  mkdirSync(ws.paths.inbox, { recursive: true });
  writeFileSync(join(ws.paths.inbox, 'kaputt.pdf'), 'hello, not a pdf');
  writeFileSync(join(ws.paths.inbox, 'leer.pdf'), '');
  const lines: string[] = [];
  const job = await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep]], log: (l) => lines.push(l) });
  assert.equal(job.steps[0].state, 'done', JSON.stringify(job.steps[0].notes));
  assert.deepEqual(readdirSync(ws.paths.inbox), ['leer.pdf'], 'the broken file left the inbox; an empty one may still be being written');
  const held = quarantined(ws.paths.data);
  assert.deepEqual(held.map((q) => [q.file, q.reason]), [['kaputt.pdf', { kind: 'unreadable' }]]);
  assert.ok(existsSync(join(ws.paths.data, 'quarantine', 'kaputt.pdf.reason.txt')));
  assert.ok(lines.some((l) => /kaputt\.pdf/.test(l) && /quarantine/i.test(l)), lines.join('\n'));
});
