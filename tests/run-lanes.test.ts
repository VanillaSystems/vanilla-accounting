/**
 * r4c-7 / r5h-10: a statement and four receipts dropped together. The statement's run was under
 * way when the receipts came, so they went to a run waiting behind it; the statement's run still
 * read the receipts lying in the inbox, and each row counted the other's work. A run leaves the
 * files a run waiting behind it came in with to that run.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, moduleActor } from '../src/books/store.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { readStep } from '../src/intake/read.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import { textPdf } from './support/text-pdf.js';

test('the reading of a run leaves the files of the run waiting behind it in the inbox, and reads its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanes-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  mkdirSync(ws.paths.inbox, { recursive: true });
  writeFileSync(join(ws.paths.inbox, 'mine.pdf'), await textPdf(['Malerbedarf Muster AG', 'Rechnung R-2001', 'Total CHF 54.00']));
  writeFileSync(join(ws.paths.inbox, 'theirs.pdf'), await textPdf(['Malerbedarf Muster AG', 'Rechnung R-2002', 'Total CHF 81.00']));
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', (ctx) => readStep({ ...ctx, later: () => new Set(['theirs']) })]] });
  const read = loadBooks(ws).receipts.map((r) => r.originalFilename);
  assert.ok(read.includes('mine.pdf'), 'its own file is read');
  assert.ok(!read.includes('theirs.pdf'), 'the waiting run\'s file is not');
  assert.ok(existsSync(join(ws.paths.inbox, 'theirs.pdf')), 'and stays in the inbox for it');
});

test('a photo of the run waiting behind stays a photo for that run, which converts it and renames its own row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanes-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  mkdirSync(ws.paths.inbox, { recursive: true });
  copyFileSync('desktop/icon.png', join(ws.paths.inbox, 'mine.png'));
  copyFileSync('desktop/icon.png', join(ws.paths.inbox, 'theirs.png'));
  const renamed: string[] = [];
  const arrived = { renamed: (inbox: string) => { renamed.push(inbox); }, refused: () => {} };
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', (ctx) => readStep({ ...ctx, later: () => new Set(['theirs']), arrived })]] });
  assert.deepEqual(renamed, ['mine.png'], 'only its own photo is converted and renamed');
  assert.ok(existsSync(join(ws.paths.inbox, 'theirs.png')) && !existsSync(join(ws.paths.inbox, 'theirs.pdf')), 'the waiting run\'s photo stays in the inbox as it came');
});
