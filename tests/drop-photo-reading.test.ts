/**
 * Issue #361: what the model's reading of a dropped photo finds decides what the photo is. A photo
 * that shows no receipt at all (a holiday photo) is set aside as «kein Beleg» with what it shows,
 * under the name it came with, never a receipt of CHF 0.00 named by the model; a till receipt
 * whose date cannot be read stays without a date, never dated by the day it was read. The photos
 * and the shop are made up.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageToPdf } from '../src/parsers/image-pdf.js';
import { readStep } from '../src/intake/read.js';
import { datedName, matchStep } from '../src/intake/match.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { RECEIPT_OR_NONE, unclearPrompt, visionVerdict } from '../src/intake/unclear.js';
import { buildMatchPrompt, buildVisionPrompt } from '../src/llm/prompts.js';
import { loadBooks, moduleActor } from '../src/books/store.js';
import { isNoReceipt } from '../src/books/discard.js';
import { waitsForReading } from '../src/parsers/receipt-text.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

// 2 x 2 pixels: a photo, no text of its own.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYBAB7FA/+WnI5aAAAAAElFTkSuQmCC', 'base64');
const TILL = ['Quittung', '', 'Baumarkt Muster', 'Farbe weiss 10 l  187.35', 'TOTAL CHF 187.35', 'inkl. MWST 8.1 % 14.04'].join('\n');

test('the vision reading says «Kein Beleg» only in its exact form: one short line, nothing after it', () => {
  assert.deepEqual(visionVerdict('Kein Beleg: ein Strand mit Sonnenschirmen in Rimini.'), { is: 'none', why: 'ein Strand mit Sonnenschirmen in Rimini.' });
  assert.deepEqual(visionVerdict('  Kein Beleg: Ferienfoto\n'), { is: 'none', why: 'Ferienfoto' });
  // Loose answers are text, never a verdict that sets real evidence aside.
  assert.equal(visionVerdict('Kein Belegdatum erkennbar – Kassenzettel\n\nMigros Gossau\nTOTAL CHF 23.40'), undefined);
  assert.equal(visionVerdict('Kein Beleg im steuerlichen Sinn: Kartenbeleg\n\nVISA ****1234\nTotal CHF 187.35'), undefined);
  assert.equal(visionVerdict('Kein Beleg: Kartenbeleg\nTotal CHF 187.35'), undefined, 'a second line');
  assert.equal(visionVerdict(`Kein Beleg: ${'x'.repeat(161)}`), undefined, 'longer than a short sentence');
  assert.equal(visionVerdict('«Kein Beleg»: Ferienfoto'), undefined);
  assert.equal(visionVerdict(TILL), undefined);
  assert.equal(visionVerdict('Nicht lesbar. Das Foto ist verwackelt.'), undefined);
});

test('one definition of a receipt for both prompts, with the doubt rule; a file the books hold is only read', () => {
  const asked = buildVisionPrompt('/x.pdf', { verdict: true });
  for (const p of [asked, unclearPrompt('Text', 'x.pdf')]) {
    assert.ok(p.includes(RECEIPT_OR_NONE), 'the one definition');
    for (const w of ['a screenshot of an order page', 'a delivery note', 'a customs clearance decision', 'a card or debit slip', 'a contract', 'When in doubt, it is a receipt']) assert.ok(p.includes(w), w);
  }
  assert.match(asked, /«Kein Beleg: <ein kurzer Satz, was sie zeigt>» und nichts danach\. Im Zweifel ist sie ein Beleg/);
  assert.doesNotMatch(buildVisionPrompt('/x.pdf'), /Kein Beleg/, 'a re-read never asks whether it is one');
});

test('the match prompt asks for the document\'s own date and 00000000 without one, never today\'s', () => {
  assert.match(buildMatchPrompt('', [], '/x.pdf'), /When it shows none, or none can be read, "date" is "" and suggestedFilename starts with 00000000: never today's date/);
});

/** A temp workspace with the photos in the inbox, read by a model that answers per photo. */
async function dropPhotos(photos: Record<string, { vision: string; match?: object }>) {
  const ws = tempWorkspace('drop-photo-');
  mkdirSync(ws.paths.inbox, { recursive: true });
  // Each photo its own bytes (a comment after the PDF's end): the same bytes twice are one file.
  for (const name of Object.keys(photos)) writeFileSync(join(ws.paths.inbox, `${name}.pdf`), Buffer.concat([Buffer.from(await imageToPdf(PNG, `${name}.PNG`)), Buffer.from(`\n% ${name}\n`)]));
  writeIndex(ws, { config: { closedThrough: '2026-06-30' }, journalEntries: [] });
  const calls: string[] = [];
  const of = (prompt: string) => Object.keys(photos).find((n) => prompt.includes(`${n}.pdf`))!;
  const ask: Ask = async (prompt, opts) => {
    const name = of(prompt);
    calls.push(`${opts.step}:${name}`);
    if (opts.step === 'receipt-vision') return photos[name].vision;
    if (opts.step === 'receipt-match') return JSON.stringify({ matchedTransactionRefs: [], confidence: 0.2, ...photos[name].match });
    if (opts.step === 'receipt-kind') return JSON.stringify({ is: 'receipt', why: 'Quittung' });
    throw new Error(`unexpected step ${opts.step}`);
  };
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep], ['match', matchStep]], ask });
  return { receipts: loadBooks(ws).receipts, calls };
}

test('a holiday photo is set aside as no receipt with what the model saw, under its own name, and no model names or matches it', async () => {
  const { receipts, calls } = await dropPhotos({ IMG_4590: { vision: 'Kein Beleg: ein Strand mit Sonnenschirmen in Rimini.' } });
  const r = receipts.find((x) => x.originalFilename === 'IMG_4590.pdf')!;
  assert.deepEqual([r.kind, r.kindWhy, r.location, r.filename, r.amount, r.date], ['noise', 'ein Strand mit Sonnenschirmen in Rimini.', 'archived', 'IMG_4590.pdf', undefined, undefined]);
  assert.equal(isNoReceipt(r, 0), true, 'Belege and the drop row call it «kein Beleg»');
  assert.deepEqual(calls, ['receipt-vision:IMG_4590'], 'no question of its kind, no match');
});

test('a till receipt whose date the model cannot read stays without a date: no day of the read in its name or as its date', async () => {
  const { receipts } = await dropPhotos({
    IMG_4733: { vision: TILL, match: { suggestedFilename: '00000000-baumarkt-muster.pdf', date: '', description: 'Baumarkt Muster', amount: 187.35, currency: 'CHF' } },
  });
  const r = receipts.find((x) => x.originalFilename === 'IMG_4733.pdf')!;
  assert.deepEqual([r.filename, r.date, r.dateSource, r.amount, r.kind], ['baumarkt-muster.pdf', undefined, undefined, 187.35, undefined]);
});

test('a delivery note, a customs assessment and an order page read off photos stay what they are, with their facts', async () => {
  const { receipts } = await dropPhotos({
    IMG_5001: { vision: ['Lieferschein', '', 'Farbmix AG', 'Lieferschein L-55120', 'Datum: 03.10.2026', '6 Kessel Fassadenfarbe'].join('\n') },
    IMG_5002: { vision: ['Veranlagungsverfügung MWST', '', 'Bundesamt für Zoll und Grenzsicherheit', 'Veranlagungsverfügung MWST Nr. 26CHWI000123456', 'Datum: 07.10.2026', 'Einfuhrsteuer CHF 81.00', 'Total CHF 81.00'].join('\n'), match: { suggestedFilename: '00000000-bazg.pdf', date: '', amount: 81, currency: 'CHF', description: 'BAZG' } },
    IMG_5003: { vision: ['Bildschirmfoto Bestellung', '', 'Shop Muster', 'Bestellung 4711-2026', 'Bestelldatum 02.10.2026', 'Pinselset 3-teilig', 'Gesamtsumme CHF 34.90', 'inkl. 8.1 % MWST CHF 2.62'].join('\n'), match: { suggestedFilename: '20261002-shop-muster.pdf', date: '2026-10-02', amount: 34.9, currency: 'CHF', description: 'Shop Muster' } },
  });
  const of = (n: string) => { const r = receipts.find((x) => x.originalFilename === `${n}.pdf`); assert.ok(r, `${n}: ${JSON.stringify(receipts.map((x) => [x.originalFilename, x.filename, x.kind]))}`); return r; };
  assert.deepEqual([of('IMG_5001').kind, of('IMG_5001').kindRule], ['supporting', 'document:delivery-note']);
  const customs = of('IMG_5002');
  assert.deepEqual([customs.kind, customs.kindRule, customs.date, customs.amount], ['supporting', 'document:customs-assessment', '2026-10-07', 81]);
  assert.equal(customs.filename, '20261007-bazg.pdf', 'the model read no date: the one code read is kept, in its name too');
  const order = of('IMG_5003');
  assert.deepEqual([order.kind, order.date, order.amount, isNoReceipt(order, 0)], [undefined, '2026-10-02', 34.9, false], 'an order page is a receipt');
});

test('an undated name starts with no day: whatever eight digits the model put there', () => {
  assert.equal(datedName('00000000-baumarkt.pdf', undefined), 'baumarkt.pdf');
  assert.equal(datedName('20261112-baumarkt.pdf', undefined), 'baumarkt.pdf');
  assert.equal(datedName('00000000-baumarkt.pdf', '2026-10-07'), '20261007-baumarkt.pdf');
  assert.equal(datedName('20261002-shop.pdf', '2026-10-02'), '20261002-shop.pdf');
});

test('a model that names an undated receipt by today keeps no day in its name', async () => {
  const { receipts } = await dropPhotos({
    IMG_4734: { vision: TILL, match: { suggestedFilename: '20261112-baumarkt-muster.pdf', date: '', description: 'Baumarkt Muster', amount: 187.35, currency: 'CHF' } },
  });
  const r = receipts.find((x) => x.originalFilename === 'IMG_4734.pdf')!;
  assert.deepEqual([r.filename, r.date], ['baumarkt-muster.pdf', undefined]);
});

test('a file the books hold is read without the question; a «Kein Beleg» answer there is never its text', async () => {
  const ws = tempWorkspace('drop-photo-again-');
  mkdirSync(ws.paths.inbox, { recursive: true });
  const bytes = Buffer.from(await imageToPdf(PNG, 'IMG_6000.PNG'));
  writeFileSync(join(ws.paths.inbox, 'IMG_6000.pdf'), bytes);
  const id = createHash('sha256').update(bytes).digest('hex').substring(0, 16);
  // In the books already, a person's receipt whose earlier reading left no text.
  writeIndex(ws, { config: { closedThrough: '2026-06-30' }, journalEntries: [], receipts: [{ id, filename: 'IMG_6000.pdf', originalFilename: 'IMG_6000.pdf', extractedText: '', extractionMethod: 'claude-vision', fileSize: bytes.length, indexedAt: '2026-11-12T10:00:00.000Z', location: 'staged', kind: 'invoice', kindBy: 'human' }] });
  const prompts: string[] = [];
  const ask: Ask = async (prompt, opts) => {
    prompts.push(prompt);
    if (opts.step === 'receipt-vision') return 'Kein Beleg: ein Strand.';
    throw new Error(`unexpected step ${opts.step}`);
  };
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep]], ask });
  const r = loadBooks(ws).receipts.find((x) => x.id === id)!;
  assert.doesNotMatch(prompts.join('\n'), /Kein Beleg/, 'the prompt never asks');
  assert.deepEqual([r.extractedText, r.kind, r.kindBy], ['', 'invoice', 'human'], 'no verdict as its text, the person\'s kind stays');
});

test('«Ist doch ein Beleg» on a file its reading set aside, then «Erneut lesen»: a read receipt; a «Kein Beleg» answer there writes nothing', async () => {
  const FIXTURE = 'tests/fixtures/classify-index.json';
  const stubBin = join(process.cwd(), 'tests/support/stub-bin');
  const scratch = mkdtempSync(join(tmpdir(), 'drop-photo-api-'));
  const promptLog = join(scratch, 'prompts.txt');
  const aside = (api: ApiServer) => {
    const index = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const rw = index.receipts.find((r: { id: string }) => r.id === 'rw');
    Object.assign(rw, { extractedText: '', extractionMethod: 'claude-vision', kind: 'noise', kindBy: 'rule', kindRule: 'model:no-receipt', kindWhy: 'ein Strand' });
    delete rw.date; delete rw.amount;
    writeIndex(api.ws, index);
    const dir = join(api.root, 'transactional-data/2026/receipts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, rw.filename), 'PDF rw');
  };
  const receipt = (api: ApiServer) => loadBooks(workspaceAt(api.ws.paths.root)).receipts.find((r) => r.id === 'rw')!;
  const api = await startApi(FIXTURE, { PATH: `${stubBin}:${process.env.PATH}`, CLAUDE_STUB_PROMPTS: promptLog });
  try {
    aside(api);
    assert.equal((await api.send('PATCH', '/api/receipts/rw', { kind: 'invoice' })).status, 200);
    assert.equal(waitsForReading(receipt(api)), true, 'declared a receipt: it waits for its reading, no verdict as its text');
    const read = await api.send('POST', '/api/vision/extract', { receiptId: 'rw' });
    assert.equal(read.status, 200, String(read.json.error));
    assert.deepEqual([receipt(api).extractedText, receipt(api).kind, waitsForReading(receipt(api))], ['Stub-OCR\n\nBeleg vom Stub gelesen', 'invoice', false]);
    assert.doesNotMatch(readFileSync(promptLog, 'utf8'), /Kein Beleg/, 'the person asked for its text: the prompt never asks whether it is one');
  } finally {
    await api.stop();
  }
  const said = await startApi(FIXTURE, { PATH: `${stubBin}:${process.env.PATH}`, CLAUDE_STUB_OCR_TEXT: 'Kein Beleg: ein Strand.' });
  try {
    aside(said);
    await said.send('PATCH', '/api/receipts/rw', { kind: 'invoice' });
    const read = await said.send('POST', '/api/vision/extract', { receiptId: 'rw' });
    assert.equal(read.status, 422);
    assert.equal(receipt(said).extractedText, '', 'nothing written');
  } finally {
    await said.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});
