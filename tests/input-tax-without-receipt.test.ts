/**
 * #417 point 1: a booking that claims input tax keeps no proof once its receipt is no longer linked
 * (the receipt's file rewritten under its name, a link taken off). The app's own booking is taken
 * back so its payment waits for its receipt, even without a model; one it may not take back (a
 * person's, a filed quarter's) stays as it is and the run counts it as a fact to check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, moduleActor, PERSON, saveBooks, update } from '../src/books/store.js';
import { runIntake, storePort, type IntakeNote } from '../src/intake/pipeline.js';
import { classifyStep } from '../src/intake/classify.js';
import { readStep } from '../src/intake/read.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { JournalEntry } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import { textPdf } from './support/text-pdf.js';
import './support/jurisdiction.js';

const JULY = ['Muster Druck AG', 'Rechnung 4711 vom 10.07.2026', 'Flyer', 'Total CHF 172.00 inkl. MWST 8.1% CHF 12.90'];
const OTHER = ['Ganz Andere AG', 'Rechnung 99 vom 12.11.2026', 'Total CHF 10.00 inkl. MWST 2.6% CHF 0.25'];

/** A receipt in receipts/ linked by the app to a payment of the open period, booked with input tax as `entry` says. */
async function booked(entry: Partial<JournalEntry>, opts: { filed?: boolean; unlinked?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'input-tax-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const rdir = join(ws.paths.root, 'transactional-data', '2026', 'receipts');
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, '20260710-muster-druck.pdf'), await textPdf(JULY));
  const read = () => runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep]] });
  const run = () => runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep], ['classify', classifyStep()]] });
  await read();
  const b = loadBooks(ws);
  const r = b.receipts.find((x) => x.filename === '20260710-muster-druck.pdf')!;
  const day = '2026-11-05';
  update(b, entry.origin === 'manual' ? PERSON : moduleActor('intake'), (x) => {
    x.transactions.push({ ref: 'TX', bank: 'Raiffeisen', date: day, amount: 172, currency: 'CHF', direction: 'DBIT', description: 'Muster Druck AG', counterparty: 'Muster Druck AG', source: 'manual' } as never);
    x.mappings.push({ transactionRef: 'TX', receiptId: r.id, by: 'llm' });
    x.journalEntries.push({ id: 'e-tx', transactionRef: 'TX', date: day, accountDebit: '6570', accountCredit: '1020', amount: 172, vatCode: 'I81', origin: 'classify', receipts: [r.id], by: { kind: 'model', model: 'stub' }, ...entry } as JournalEntry);
  });
  saveBooks(ws, b);
  if (opts.unlinked) { const c = loadBooks(ws); update(c, PERSON, (x) => { x.mappings = x.mappings.filter((m) => m.transactionRef !== 'TX'); }); saveBooks(ws, c); }
  if (opts.filed) { const ledger = JSON.parse(readFileSync(ws.paths.ledger, 'utf8')); ledger.config.closedThrough = '2026-11-30'; writeFileSync(ws.paths.ledger, JSON.stringify(ledger, null, 2)); }
  return { ws, rdir, old: r, run };
}

const notesOf = (job: Awaited<ReturnType<typeof runIntake>>): IntakeNote[] => job.steps.flatMap((s) => s.notes ?? []);
const noteOf = <C extends IntakeNote['code']>(job: Awaited<ReturnType<typeof runIntake>>, code: C) => notesOf(job).find((n): n is Extract<IntakeNote, { code: C }> => n.code === code);

test('#417 the app\'s input-tax booking whose receipt file was rewritten is taken back without a model: the payment waits for its receipt, the VAT return claims nothing unproven', async () => {
  const { ws, rdir, old, run } = await booked({});
  writeFileSync(join(rdir, old.filename), await textPdf(OTHER));
  const job = await run();
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done'], JSON.stringify(notesOf(job)));
  const b = loadBooks(ws);
  assert.deepEqual(b.mappings.filter((m) => m.transactionRef === 'TX'), [], 'the app\'s link went with the old read');
  assert.equal(b.journalEntries.some((e) => e.transactionRef === 'TX'), false, 'the booking claiming I81 without its receipt is taken back');
  assert.ok(b.transactions.find((t) => t.ref === 'TX')?.waitsForReceipt, 'the payment waits for its receipt');
  assert.deepEqual(noteOf(job, 'waitingReceipt'), { code: 'waitingReceipt', count: 1 });
  assert.equal(noteOf(job, 'inputTaxUnproven'), undefined, 'nothing is left to check');
});

test('#417 the same for a link the books lost otherwise: the app\'s input-tax booking is taken back and its payment waits', async () => {
  const { ws, run } = await booked({}, { unlinked: true });
  const job = await run();
  const b = loadBooks(ws);
  assert.equal(b.journalEntries.some((e) => e.transactionRef === 'TX'), false);
  assert.ok(b.transactions.find((t) => t.ref === 'TX')?.waitsForReceipt);
  assert.equal(noteOf(job, 'inputTaxUnproven'), undefined);
});

test('#417 a booking with other proof of its input tax (inputTaxProof) stays: the person named it', async () => {
  const { ws, rdir, old, run } = await booked({});
  const b = loadBooks(ws);
  update(b, PERSON, (x) => { x.transactions.find((t) => t.ref === 'TX')!.inputTaxProof = { text: 'Vertrag mit MWST und Zahlungsbestätigung', at: '2026-11-06T10:00:00Z' }; });
  saveBooks(ws, b);
  writeFileSync(join(rdir, old.filename), await textPdf(OTHER));
  const job = await run();
  assert.ok(loadBooks(ws).journalEntries.some((e) => e.id === 'e-tx'));
  assert.equal(noteOf(job, 'inputTaxUnproven'), undefined);
});

test('#417 a person\'s booking that claims input tax on a receipt no longer linked stays as she made it; the run counts it to check', async () => {
  const { ws, rdir, old, run } = await booked({ origin: 'manual', by: { kind: 'person', at: '2026-11-06T10:00:00Z' } });
  writeFileSync(join(rdir, old.filename), await textPdf(OTHER));
  const job = await run();
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done']);
  const b = loadBooks(ws);
  const e = b.journalEntries.find((x) => x.id === 'e-tx');
  assert.equal(e?.vatCode, 'I81', 'her booking is hers to change');
  assert.equal(b.mappings.some((m) => m.transactionRef === 'TX'), false);
  assert.deepEqual(noteOf(job, 'inputTaxUnproven'), { code: 'inputTaxUnproven', refs: ['TX'] });
  assert.deepEqual(noteOf(job, 'rewritten')?.files.map((f) => f.check), [1]);
});

test('#417 a person\'s booking that records no receipts, on a payment whose app link the rewrite dropped, is counted to check on the rewritten file', async () => {
  const { ws, rdir, old, run } = await booked({ origin: 'manual', by: { kind: 'person', at: '2026-11-06T10:00:00Z' }, receipts: undefined });
  writeFileSync(join(rdir, old.filename), await textPdf(OTHER));
  const job = await run();
  assert.equal(loadBooks(ws).journalEntries.find((x) => x.id === 'e-tx')?.vatCode, 'I81');
  assert.deepEqual(noteOf(job, 'rewritten')?.files.map((f) => f.check), [1], 'its booking claims input tax the dropped link was the proof of');
});

test('#417 a filed quarter\'s booking that claims input tax on a receipt no longer linked is never touched; the run counts it as a fact', async () => {
  // A link of a filed quarter the books lost (an older run, a hand edit): the entry still names the receipt.
  const { ws, run } = await booked({}, { filed: true, unlinked: true });
  const before = loadBooks(ws).journalEntries.find((e) => e.id === 'e-tx');
  assert.ok(before);
  const job = await run();
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done']);
  assert.deepEqual(loadBooks(ws).journalEntries.find((e) => e.id === 'e-tx'), before, 'the filed entry stays exactly as filed');
  assert.deepEqual(noteOf(job, 'inputTaxUnproven'), { code: 'inputTaxUnproven', refs: ['TX'] });
});
