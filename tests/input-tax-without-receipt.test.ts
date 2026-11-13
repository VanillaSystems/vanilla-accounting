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
import { matchStep } from '../src/intake/match.js';
import { inputTaxWithoutItsReceipt } from '../src/accounting/evidence-check.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { JournalEntry, Receipt } from '../src/types/index.js';
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
  const matched = () => runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep], ['match', matchStep], ['classify', classifyStep()]] });
  return { ws, rdir, old: r, run, matched };
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
  assert.deepEqual(noteOf(job, 'inputTaxUnproven'), { code: 'inputTaxUnproven', payments: [{ ref: 'TX', date: '2026-11-05', entry: 'e-tx' }] });
  assert.deepEqual(noteOf(job, 'rewritten')?.files.map((f) => f.check), [1]);
});

test('#417 a person\'s booking that records no receipts, on a payment whose app link the rewrite dropped, is counted to check on the rewritten file', async () => {
  const { ws, rdir, old, run } = await booked({ origin: 'manual', by: { kind: 'person', at: '2026-11-06T10:00:00Z' }, receipts: undefined });
  writeFileSync(join(rdir, old.filename), await textPdf(OTHER));
  const job = await run();
  assert.equal(loadBooks(ws).journalEntries.find((x) => x.id === 'e-tx')?.vatCode, 'I81');
  assert.deepEqual(noteOf(job, 'rewritten')?.files.map((f) => f.check), [1], 'its booking claims input tax the dropped link was the proof of');
});

test('#417 a filed quarter\'s booking that claims input tax on a receipt no longer linked is never touched, and not named again on every run', async () => {
  // A link of a filed quarter the books lost (an older run, a hand edit): the entry still names the receipt.
  const { ws, run } = await booked({}, { filed: true, unlinked: true });
  const before = loadBooks(ws).journalEntries.find((e) => e.id === 'e-tx');
  assert.ok(before);
  const job = await run();
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done']);
  assert.deepEqual(loadBooks(ws).journalEntries.find((e) => e.id === 'e-tx'), before, 'the filed entry stays exactly as filed');
  assert.equal(noteOf(job, 'inputTaxUnproven'), undefined, 'nothing may change it: the run does not name it each time');
});

test('#417 the same invoice saved again (other bytes, the same words), no model: the app\'s link and booking go along to the new read, with its VAT; nothing waits, nothing to check', async () => {
  const { ws, rdir, old, run } = await booked({});
  const b = loadBooks(ws);
  update(b, moduleActor('intake'), (x) => { Object.assign(x.receipts.find((r) => r.id === old.id)!, { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 12.9, gross: 172 }], vatExtractedAt: '2026-11-05T10:00:00Z' }); });
  saveBooks(ws, b);
  writeFileSync(join(rdir, old.filename), Buffer.concat([await textPdf(JULY), Buffer.from('\n% saved again\n')]));
  const job = await run();
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done'], JSON.stringify(notesOf(job)));
  const after = loadBooks(ws);
  const now = after.receipts.find((r) => r.filename === old.filename)!;
  assert.notEqual(now.id, old.id);
  assert.equal(after.receipts.some((r) => r.id === old.id), false, 'nothing keeps the old record');
  assert.deepEqual(after.mappings.filter((m) => m.transactionRef === 'TX').map((m) => m.receiptId), [now.id], 'the app\'s link goes along');
  const e = after.journalEntries.find((x) => x.id === 'e-tx');
  assert.equal(e?.vatCode, 'I81', 'the proven booking stays');
  assert.deepEqual(e?.receipts, [now.id], 'naming the new read of its document');
  assert.equal(now.hasSwissVat, true, 'the VAT read off the same words goes along');
  assert.equal(after.transactions.find((t) => t.ref === 'TX')?.waitsForReceipt, undefined);
  assert.deepEqual(noteOf(job, 'rewritten')?.files.map((f) => [f.check, f.kept]), [[0, false]]);
  assert.equal(noteOf(job, 'waitingReceipt'), undefined);
  assert.equal(noteOf(job, 'inputTaxUnproven'), undefined);
});

test('#417 a rewritten file whose new read the match step links to the payment in the same run: the booking is not taken back while the new read\'s VAT is not read', async () => {
  const { ws, rdir, old, matched } = await booked({});
  writeFileSync(join(rdir, old.filename), await textPdf(['Muster Druck AG', 'Rechnung 4712 vom 04.11.2026', 'Flyer', 'Total CHF 172.00 inkl. MWST 8.1% CHF 12.90']));
  const job = await matched();
  assert.deepEqual(job.steps.map((s) => s.state), ['done', 'done', 'done'], JSON.stringify(notesOf(job)));
  const after = loadBooks(ws);
  const now = after.receipts.find((r) => r.filename === old.filename)!;
  assert.deepEqual(after.mappings.filter((m) => m.transactionRef === 'TX').map((m) => m.receiptId), [now.id], 'the match step pairs the new read');
  assert.ok(after.journalEntries.some((e) => e.id === 'e-tx'), 'its VAT is the VAT step\'s to read: nothing is taken back on a guess');
  assert.equal(noteOf(job, 'inputTaxUnproven'), undefined);
});

test('#417 of two receipts a payment was booked with, the one that went leaves its own line unproven, while the other\'s line keeps its proof', () => {
  const r = (id: string, gross: number): Receipt => ({ id, filename: `${id}.pdf`, location: 'archived', amount: gross, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: Math.round(gross * 8.1 / 108.1 * 100) / 100, gross }] }) as Receipt;
  const line = (id: string, amount: number): JournalEntry => ({ id, transactionRef: 'TX', date: '2026-11-05', accountDebit: '6570', accountCredit: '1020', amount, vatCode: 'I81', origin: 'classify', receipts: ['A', 'B'] });
  const books = { journalEntries: [line('la', 100), line('lb', 72)], mappings: [{ transactionRef: 'TX', receiptId: 'A', by: 'llm' as const }], receipts: [r('A', 100), r('B', 72)], transactions: [{ ref: 'TX' }] };
  assert.deepEqual(inputTaxWithoutItsReceipt(books).map((e) => e.id), ['lb']);
});

test('#417 a line of the tax itself (a one-legged deduction by its bill) is named when its bill is linked no more, never taken back', async () => {
  const { ws, run } = await booked({ vatCode: 'I81-2', amount: 12.9, accountDebit: '', accountCredit: '6570' }, { unlinked: true });
  const job = await run();
  assert.ok(loadBooks(ws).journalEntries.some((e) => e.id === 'e-tx'));
  assert.deepEqual(noteOf(job, 'inputTaxUnproven')?.payments.map((p) => p.ref), ['TX']);
});
