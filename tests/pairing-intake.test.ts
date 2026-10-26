/**
 * Code first at the inbox (#187): a dropped receipt whose payment code pairs clearly is archived,
 * named by the fast model and linked without its per-receipt match prompt; without a model it is
 * archived and linked by code. A receipt code cannot pair still goes to the model's match.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, moduleActor, saveBooks, update } from '../src/books/store.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { readStep } from '../src/intake/read.js';
import { matchStep } from '../src/intake/match.js';
import { workspaceAt, findFile } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';

/** The demo's Post invoice of May and the payment that pays it, open quarter. */
const RECEIPT = '7cde279c427e1f41';
const PAYMENT = '90000000031';

/** A copy of the demo whose Post invoice of May is back in the inbox, its link gone. */
function dropped(): ReturnType<typeof workspaceAt> {
  const dir = mkdtempSync(join(tmpdir(), 'pair-intake-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const books = loadBooks(ws);
  const r = books.receipts.find((x) => x.id === RECEIPT)!;
  const file = findFile(ws.paths, 'receipts', r.filename)!;
  const pdf = readFileSync(file);
  rmSync(file);
  update(books, moduleActor('test'), (b) => {
    b.receipts = b.receipts.filter((x) => x.id !== RECEIPT);
    b.mappings = b.mappings.filter((m) => m.receiptId !== RECEIPT);
  });
  saveBooks(ws, books);
  mkdirSync(ws.paths.inbox, { recursive: true });
  writeFileSync(join(ws.paths.inbox, 'scan-post.pdf'), pdf);
  return ws;
}

/** A model that confirms every check, names every receipt, and says which steps it was asked. */
function model(): { ask: Ask; steps: string[] } {
  const steps: string[] = [];
  const ask: Ask = async (prompt, opts) => {
    steps.push(opts.detail ? `${opts.step}#${opts.detail}` : opts.step);
    if (opts.step === 'receipt-pair') {
      const list = JSON.parse(prompt.slice(prompt.indexOf('\n\n[') + 2, prompt.lastIndexOf(']\n\n') + 1)) as Array<{ i: number }>;
      return JSON.stringify(list.map((x) => ({ i: x.i, fits: true, why: 'stub' })));
    }
    if (opts.step === 'receipt-titles') {
      const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      return JSON.stringify(Object.fromEntries(ids.map((id) => [id, { v: 'Post CH', w: 'Pakete Mai' }])));
    }
    return '{}';
  };
  return { ask, steps };
}

test('a receipt code pairs clearly skips the model\'s match: checked in a batch, named on the fast tier, linked', async () => {
  const ws = dropped();
  const m = model();
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: m.ask, steps: [['read', readStep], ['match', matchStep]] });
  const books = loadBooks(ws);
  const r = books.receipts.find((x) => x.originalFilename === 'scan-post.pdf')!;
  assert.equal(r.location, 'archived');
  assert.deepEqual(books.mappings.filter((x) => x.receiptId === r.id), [{ transactionRef: PAYMENT, receiptId: r.id, by: 'llm', rule: 'pair-checked:amount+day+name' }]);
  assert.equal(m.steps.includes('receipt-match'), false, 'no per-receipt match prompt');
  assert.ok(m.steps.includes('receipt-pair#check') && m.steps.includes('receipt-titles'));
  assert.deepEqual(r.title, { vendor: 'Post CH', what: 'Pakete Mai' });
  assert.match(r.filename, /^\d{8}-post-ch-pakete-mai\.pdf$/);
});

test('without a model the receipt code pairs clearly is archived and linked by code', async () => {
  const ws = dropped();
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep], ['match', matchStep]] });
  const books = loadBooks(ws);
  const r = books.receipts.find((x) => x.originalFilename === 'scan-post.pdf')!;
  assert.equal(r.location, 'archived');
  assert.deepEqual(books.mappings.filter((x) => x.receiptId === r.id), [{ transactionRef: PAYMENT, receiptId: r.id, by: 'rule', rule: 'pair:amount+day+name' }]);
});

test('a receipt whose payment is taken goes to the model\'s match as before', async () => {
  const ws = dropped();
  const books = loadBooks(ws);
  update(books, moduleActor('test'), (b) => { b.mappings.push({ transactionRef: PAYMENT, receiptId: 'a1b05ebfe049b2ca', by: 'human' }); });
  saveBooks(ws, books);
  const m = model();
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: m.ask, steps: [['read', readStep], ['match', matchStep]] });
  assert.ok(m.steps.includes('receipt-match'), m.steps.join(' '));
});
