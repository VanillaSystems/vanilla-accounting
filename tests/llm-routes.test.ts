/**
 * The API routes that ask a model call it through src/llm/ask.ts, so every call lands in
 * data/llm-ledger.jsonl under its step, and they save the answer to books loaded after it came,
 * so an edit made while the model was thinking survives. Runs the real API server with
 * tests/support/stub-bin/claude on PATH, gated so a test can edit while a call is pending.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LedgerRow } from '../src/llm/ask.js';
import type { Books } from '../src/books/store.js';
import { startApi, type ApiServer } from './support/api-server.js';

const FIXTURE = 'tests/fixtures/classify-index.json';
const PDF = '2026-08-12_shop-eu_rechnung.pdf';
let api: ApiServer;
let gate = '';
let promptLog = '';

before(async () => {
  const stubBin = join(process.cwd(), 'tests/support/stub-bin');
  const scratch = mkdtempSync(join(tmpdir(), 'llm-routes-'));
  gate = join(scratch, 'gate');
  promptLog = join(scratch, 'prompts.txt');
  api = await startApi(FIXTURE, { PATH: `${stubBin}:${process.env.PATH}`, CLAUDE_STUB_GATE: gate, CLAUDE_STUB_PROMPTS: promptLog });
});
after(() => {
  api?.stop();
  rmSync(dirname(gate), { recursive: true, force: true });
});

beforeEach(() => {
  copyFileSync(FIXTURE, api.indexPath);
  const receipts = join(api.root, 'receipts');
  rmSync(receipts, { recursive: true, force: true });
  mkdirSync(receipts);
  writeFileSync(join(receipts, PDF), 'PDF rw');
  rmSync(join(api.root, 'data'), { recursive: true, force: true });
  rmSync(gate, { force: true });
  rmSync(`${gate}.started`, { force: true });
  writeFileSync(promptLog, '');
});

const books = (): Books => JSON.parse(readFileSync(api.indexPath, 'utf8'));
const receipt = () => books().receipts.find((r) => r.id === 'rw')!;
const ledger = (): LedgerRow[] => {
  const path = join(api.root, 'data', 'llm-ledger.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const openGate = () => writeFileSync(gate, '');

async function modelCalled(): Promise<void> {
  for (let i = 0; i < 500 && !existsSync(`${gate}.started`); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(`${gate}.started`), 'the stubbed model was called');
}

/** Sends `method path`, edits the receipt's remarks while the model call is pending, then lets it answer. */
async function editWhileModelThinks(method: string, path: string, remarks: string) {
  const pending = api.send(method, path, method === 'POST' && path.startsWith('/api/vision') ? { receiptId: 'rw' } : undefined);
  await modelCalled();
  const edit = await api.send('PATCH', '/api/receipts/rw', { remarks });
  assert.equal(edit.status, 200, String(edit.json.error));
  openGate();
  return pending;
}

test('every UI model call is ledgered under its step', async () => {
  openGate();
  const date = await api.send('POST', '/api/receipts/rw/suggest-date');
  assert.deepEqual([date.status, date.json], [200, { date: '2026-08-12' }]);
  const auslage = await api.send('POST', '/api/transactions/manual/suggest', { receiptId: 'rw' });
  assert.deepEqual([auslage.status, auslage.json], [200, { date: '2026-08-12', description: 'Stub Shop', amount: 50, currency: 'EUR' }]);
  const name = await api.send('POST', '/api/rename/suggest', { receiptId: 'rw' });
  assert.deepEqual([name.status, name.json], [200, { suggestedFilename: '20260812-stub-shop.pdf' }]);
  const vision = await api.send('POST', '/api/vision/extract', { receiptId: 'rw' });
  assert.equal(vision.status, 200, String(vision.json.error));
  const batch = await api.send('POST', '/api/rename/batch');
  assert.deepEqual([batch.status, batch.json], [200, { ok: true, renamed: 1, skipped: 0, failed: 0 }]);

  assert.deepEqual(
    ledger().map((r) => [r.step, r.model, r.ok, r.input, r.output]),
    [
      ['ui/receipt-date', 'sonnet', true, 7, 3],
      ['ui/auslage', 'sonnet', true, 7, 3],
      ['ui/rename', 'sonnet', true, 7, 3],
      ['receipt-intake.guide.yaml#vision', 'sonnet', true, 7, 3],
      ['ui/rename', 'sonnet', true, 7, 3],
    ],
  );
  assert.ok(readFileSync(promptLog, 'utf8').includes(`'${join(realpathSync(api.root), 'receipts', PDF)}'`), 'vision reads the PDF by its absolute path');
});

test('vision OCR keeps an edit made while the model reads the PDF', async () => {
  const { status, json } = await editWhileModelThinks('POST', '/api/vision/extract', 'während OCR');
  assert.equal(status, 200, String(json.error));
  const r = receipt();
  assert.deepEqual([r.remarks, r.extractedText, r.extractionMethod], ['während OCR', 'Stub-OCR\n\nBeleg vom Stub gelesen', 'claude']);
});

test('batch rename keeps an edit made while the model suggests names', async () => {
  const { status, json } = await editWhileModelThinks('POST', '/api/rename/batch', 'während Umbenennen');
  assert.deepEqual([status, json], [200, { ok: true, renamed: 1, skipped: 0, failed: 0 }]);
  assert.deepEqual([receipt().remarks, receipt().filename], ['während Umbenennen', '20260812-stub-shop.pdf']);
  assert.deepEqual(readdirSync(join(api.root, 'receipts')), ['20260812-stub-shop.pdf']);
});

test('batch rename skips a receipt renamed while the model suggested a name', async () => {
  const pending = api.send('POST', '/api/rename/batch');
  await modelCalled();
  const edit = await api.send('PATCH', '/api/receipts/rw', { filename: 'von-hand.pdf' });
  assert.equal(edit.status, 200, String(edit.json.error));
  openGate();
  const { json } = await pending;
  assert.deepEqual(json, { ok: true, renamed: 0, skipped: 1, failed: 0 });
  assert.equal(receipt().filename, 'von-hand.pdf');
  assert.deepEqual(readdirSync(join(api.root, 'receipts')), ['von-hand.pdf']);
});

test('re-classify keeps an edit made while the model books the transaction', async () => {
  const { status, json } = await editWhileModelThinks('POST', '/api/journal-entries/classify/W1', 'während Klassifizieren');
  assert.deepEqual([status, json], [200, { ok: true, count: 1 }]);
  const b = books();
  assert.equal(b.receipts.find((r) => r.id === 'rw')!.remarks, 'während Klassifizieren');
  assert.deepEqual(b.journalEntries.filter((e) => e.transactionRef === 'W1').map((e) => [e.description, e.origin]), [['Stub, Aufwand', 'classify']]);
});
