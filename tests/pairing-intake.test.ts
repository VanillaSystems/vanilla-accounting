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
import { runIntake, storePort, type Ask, type StepRun } from '../src/intake/pipeline.js';
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

/** The demo copy with a second receipt, the Post invoice of June, back in the inbox too, its link gone. */
function droppedTwo(): ReturnType<typeof workspaceAt> {
  const ws = dropped();
  const books = loadBooks(ws);
  const r = books.receipts.find((x) => x.id === 'a1b05ebfe049b2ca')!;
  const file = findFile(ws.paths, 'receipts', r.filename)!;
  writeFileSync(join(ws.paths.inbox, 'scan-post-juni.pdf'), readFileSync(file));
  rmSync(file);
  update(books, moduleActor('test'), (b) => {
    b.receipts = b.receipts.filter((x) => x.id !== r.id);
    b.mappings = b.mappings.filter((m) => m.receiptId !== r.id);
  });
  saveBooks(ws, books);
  return ws;
}

/** A model whose match names `ref` for every receipt, sure of it, and keeps the prompts it was shown. */
function sure(ref: string): { ask: Ask; prompts: string[] } {
  const prompts: string[] = [];
  const ask: Ask = async (prompt, opts) => {
    if (opts.step !== 'receipt-match') return model().ask(prompt, opts);
    prompts.push(prompt);
    return JSON.stringify({ suggestedFilename: '20260512-post-ch.pdf', date: '2026-05-12', description: 'Post CH', amount: 208.7, currency: 'CHF', matchedTransactionRefs: [ref], confidence: 0.95 });
  };
  return { ask, prompts };
}

test('the model\'s match neither sees nor links a payment that needs no receipt', async () => {
  const ws = dropped();
  const books = loadBooks(ws);
  update(books, moduleActor('test'), (b) => { b.transactions.find((t) => t.ref === PAYMENT)!.noReceiptNeeded = true; });
  saveBooks(ws, books);
  const m = sure(PAYMENT);
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: m.ask, steps: [['read', readStep], ['match', matchStep]] });
  assert.ok(m.prompts.length && !m.prompts[0].includes(`"ref":"${PAYMENT}"`), 'not among the payments shown');
  assert.deepEqual(loadBooks(ws).mappings.filter((x) => x.transactionRef === PAYMENT), [], 'not linked, whatever the model says');
});

test('the model\'s match never points a receipt at a filed payment another receipt points at: its tax is corrected once', async () => {
  const ws = dropped();
  // Q2 filed: the payment of the Post invoice lies in a filed quarter now.
  const ledger = join(ws.paths.root, 'ledger.json');
  writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('"closedThrough": "2026-03-31"', '"closedThrough": "2026-06-30"'));
  const books = loadBooks(ws);
  update(books, moduleActor('test'), (b) => { b.receipts.find((r) => r.id === 'a1b05ebfe049b2ca')!.filedPayment = PAYMENT; });
  saveBooks(ws, books);
  assert.equal(loadBooks(ws).config.closedThrough, '2026-06-30');
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: sure(PAYMENT).ask, steps: [['read', readStep], ['match', matchStep]] });
  const r = loadBooks(ws).receipts.find((x) => x.originalFilename === 'scan-post.pdf')!;
  assert.equal(r.filedPayment, undefined);
});

test('two receipts of one run the model names the same payment for: the first links it, the second waits for a person', async () => {
  const ws = droppedTwo();
  const books = loadBooks(ws);
  // Code pairs neither: the payment's amount and text fit no receipt, the June payment needs none.
  update(books, moduleActor('test'), (b) => {
    Object.assign(b.transactions.find((t) => t.ref === PAYMENT)!, { amount: 999, description: 'Zahlung' });
    b.transactions.find((t) => t.ref === '90000000038')!.noReceiptNeeded = true;
  });
  saveBooks(ws, books);
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: sure(PAYMENT).ask, steps: [['read', readStep], ['match', matchStep]] });
  assert.equal(loadBooks(ws).mappings.filter((m) => m.transactionRef === PAYMENT).length, 1);
});

test('the model\'s match is not shown a payment a person took apart from the receipt', async () => {
  const ws = dropped();
  const m = sure(PAYMENT);
  const apart: StepRun = async ({ books }) => {
    books.update((b) => { for (const r of b.receipts) if (r.originalFilename === 'scan-post.pdf') r.notPaidBy = [PAYMENT]; });
    return { notes: [] };
  };
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: m.ask, steps: [['read', readStep], ['vat', apart], ['match', matchStep]] });
  assert.ok(m.prompts.length && !m.prompts[0].includes(`"ref":"${PAYMENT}"`), 'not among the payments shown');
  assert.deepEqual(loadBooks(ws).mappings.filter((x) => x.transactionRef === PAYMENT), []);
});
