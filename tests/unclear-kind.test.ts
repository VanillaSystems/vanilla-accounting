/**
 * Issue #186: a document whose words decide nothing and that shows almost nothing of an invoice (a
 * carrier's sales brochure) is asked of the model once. «No receipt» sets it aside as noise with
 * the model's reason; nothing is deleted. Without a model, or when the model fails, it is taken as
 * a receipt, as before. A person's kind is never asked about.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStep } from '../src/intake/read.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { loadBooks, moduleActor } from '../src/books/store.js';
import { documents } from '../src/engines/index.js';
import { receiptScore } from '../src/intake/document-kind.js';
import { asksModel, kindByOf, MODEL_TEXT, modelCut, parseModelKind, unclearPrompt } from '../src/intake/unclear.js';
import { textPdf } from './support/text-pdf.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const BROCHURE = ['Paketblitz Express', 'Ihr Partner fuer den Versand ins Ausland', 'Neu fuer KMU: Zollabwicklung aus einer Hand',
  'Wir holen Ihre Sendungen direkt in Ihrem Betrieb ab und bringen sie in ueber 200 Laender.', 'Sprechen Sie mit unserem Team ueber Ihre Moeglichkeiten.'];
const CUSTOMS = ['Bundesamt fuer Zoll und Grenzsicherheit BAZG', 'Veranlagungsverfuegung', 'Zollanmeldung 26CHWI000012345', 'Versender: Shenzhen Parts Ltd', 'Empfaenger: Muster AG, Zuerich'];
const INVOICE = ['Farbmix AG', 'Rechnung FM-79010', 'Datum: 28.09.2026', 'Total CHF 1537.22', 'MWST 8.1% CHF 115.01', 'Zahlbar innert 30 Tagen'];

async function inboxWith(lines: string[], name = 'Paketblitz.pdf') {
  const ws = tempWorkspace('unclear-');
  mkdirSync(ws.paths.inbox, { recursive: true });
  const bytes = await textPdf(lines);
  writeFileSync(join(ws.paths.inbox, name), bytes);
  return { ws, id: createHash('sha256').update(bytes).digest('hex').substring(0, 16), path: join(ws.paths.inbox, name) };
}

const run = (ws: ReturnType<typeof tempWorkspace>, ask?: Ask) =>
  runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep]], ...(ask ? { ask } : {}) });

/** A model that answers the kind question with `answer` and records which steps it was asked for. */
function model(answer: string | Error) {
  const steps: string[] = [];
  const ask: Ask = async (_prompt, opts) => {
    steps.push(opts.step);
    if (opts.step !== 'receipt-kind') throw new Error(`unexpected step ${opts.step}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { ask, steps };
}

test('a brochure scores 0 and is asked about; an invoice and an empty text are not', () => {
  const W = documents();
  assert.equal(receiptScore(BROCHURE.join('\n'), W), 0);
  assert.equal(asksModel(BROCHURE.join('\n'), W), true);
  assert.equal(asksModel(INVOICE.join('\n'), W), false);
  assert.equal(asksModel('   ', W), false);
});

test('the answer is read strictly: an unknown verdict is no verdict, the reason is one short line', () => {
  assert.deepEqual(parseModelKind('Sure: {"is": "none", "why": "Verkaufsbroschüre\n eines Paketdienstes"}'), { is: 'none', why: 'Verkaufsbroschüre eines Paketdienstes' });
  assert.equal(parseModelKind('{"is": "maybe"}'), undefined);
  assert.equal(parseModelKind('no json'), undefined);
});

test('a model «no receipt» on an unclear document sets it aside as noise with its reason, and keeps the file', async () => {
  const { ws, id, path } = await inboxWith(BROCHURE);
  const m = model('{"is": "none", "why": "Verkaufsbroschüre eines Paketdienstes"}');
  const job = await run(ws, m.ask);
  assert.equal(job.steps[0].state, 'done', JSON.stringify(job.steps[0].notes));
  assert.deepEqual(m.steps, ['receipt-kind'], 'asked once');
  const r = loadBooks(ws).receipts.find((x) => x.id === id)!;
  assert.deepEqual([r.kind, r.kindBy, r.kindRule, r.kindWhy], ['noise', 'rule', 'model:no-receipt', 'Verkaufsbroschüre eines Paketdienstes']);
  assert.equal(kindByOf(r), 'model');
  assert.ok(existsSync(path), 'nothing is deleted');
});

test('the model only sets aside: a customs decision it calls «supporting» or «receipt» stays a receipt, untyped', async () => {
  // On the private books the model called customs clearance decisions «supporting»: typed so, they would lose their import VAT.
  assert.equal(asksModel(CUSTOMS.join('\n'), documents()), true, 'an unclear document the model is asked about');
  for (const answer of ['{"is": "supporting", "why": "Zollveranlagung"}', '{"is": "receipt", "why": "Zollveranlagung"}']) {
    const { ws, id } = await inboxWith(CUSTOMS, 'Zoll.pdf');
    const m = model(answer);
    await run(ws, m.ask);
    assert.deepEqual(m.steps, ['receipt-kind'], answer);
    const r = loadBooks(ws).receipts.find((x) => x.id === id)!;
    assert.deepEqual([r.kind, r.kindBy, r.kindRule, r.kindWhy], [undefined, undefined, undefined, undefined], answer);
  }
  assert.equal(parseModelKind('{"is": "supporting", "why": "Lieferschein"}'), undefined, '«supporting» is no answer of this step');
  assert.doesNotMatch(unclearPrompt(CUSTOMS.join('\n'), 'Zoll.pdf'), /"supporting"/);
});

test('a score-0 document without a model stays a receipt, as today', async () => {
  const { ws, id } = await inboxWith(BROCHURE);
  await run(ws);
  const r = loadBooks(ws).receipts.find((x) => x.id === id)!;
  assert.deepEqual([r.kind, r.kindBy, r.kindRule], [undefined, undefined, undefined]);
});

test('a model that fails leaves the document a receipt, and the step goes on', async () => {
  const { ws, id } = await inboxWith(BROCHURE);
  const job = await run(ws, model(new Error('rate limited')).ask);
  assert.equal(job.steps[0].state, 'done');
  assert.equal(loadBooks(ws).receipts.find((x) => x.id === id)!.kind, undefined);
});

test('a clear invoice costs no call', async () => {
  const { ws } = await inboxWith(INVOICE, 'Farbmix.pdf');
  const m = model('{"is": "none", "why": "x"}');
  await run(ws, m.ask);
  assert.deepEqual(m.steps, []);
});

test('a person\'s kind is never asked about, even before the file was read', async () => {
  const { ws, id } = await inboxWith(BROCHURE);
  writeIndex(ws, { receipts: [{ id, filename: 'Paketblitz.pdf', originalFilename: 'Paketblitz.pdf', extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-10-20T00:00:00.000Z', location: 'staged', kindBy: 'human' }] });
  const m = model('{"is": "none", "why": "x"}');
  await run(ws, m.ask);
  assert.deepEqual(m.steps, []);
  const r = loadBooks(ws).receipts.find((x) => x.id === id)!;
  assert.deepEqual([r.kind, r.kindBy], [undefined, 'human']);
});

test('the model sees the first MODEL_TEXT characters; a verdict on a longer text says how much it read, and the reason is never cut', () => {
  const long = `${BROCHURE.join('\n')}\n${'Weitere Informationen. '.repeat(400)}`;
  const prompt = unclearPrompt(long, 'Paketblitz.pdf');
  assert.ok(prompt.includes(long.slice(0, MODEL_TEXT)) && !prompt.includes(long.slice(0, MODEL_TEXT + 1)), 'cut at the limit');
  const byModel = { kindBy: 'rule' as const, kindRule: 'model:no-receipt' };
  assert.equal(modelCut({ ...byModel, extractedText: long }), long.length, 'the page names the limit and the whole length');
  assert.equal(modelCut({ ...byModel, extractedText: BROCHURE.join('\n') }), undefined, 'seen whole: nothing to say');
  assert.equal(modelCut({ kindBy: 'human', extractedText: long }), undefined, 'a person read it');
  const why = 'Verkaufsbroschüre '.repeat(20).trim();
  assert.equal(parseModelKind(JSON.stringify({ is: 'none', why }))?.why, why);
});
