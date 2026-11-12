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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageToPdf } from '../src/parsers/image-pdf.js';
import { readStep } from '../src/intake/read.js';
import { matchStep } from '../src/intake/match.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { visionVerdict } from '../src/intake/unclear.js';
import { buildMatchPrompt, buildVisionPrompt } from '../src/llm/prompts.js';
import { loadBooks, moduleActor } from '../src/books/store.js';
import { isNoReceipt } from '../src/books/discard.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

// 2 x 2 pixels: a photo, no text of its own.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYBAB7FA/+WnI5aAAAAAElFTkSuQmCC', 'base64');
const TILL = ['Quittung', '', 'Baumarkt Muster', 'Farbe weiss 10 l  187.35', 'TOTAL CHF 187.35', 'inkl. MWST 8.1 % 14.04'].join('\n');

test('the vision reading says «Kein Beleg» for a file that shows no receipt; any other reading is no verdict', () => {
  assert.match(buildVisionPrompt('/x.pdf'), /«Kein Beleg:»/);
  assert.deepEqual(visionVerdict('Kein Beleg: ein Strand mit Sonnenschirmen in Rimini.'), { is: 'none', why: 'ein Strand mit Sonnenschirmen in Rimini.' });
  assert.deepEqual(visionVerdict('«Kein Beleg»: Ferienfoto'), { is: 'none', why: 'Ferienfoto' });
  assert.equal(visionVerdict(TILL), undefined);
  assert.equal(visionVerdict('Nicht lesbar. Das Foto ist verwackelt.'), undefined);
  assert.equal(visionVerdict('Tankquittung\n\nKein Beleg der Firma? Total 20.00'), undefined, 'only a reading that starts so');
});

test('the match prompt asks for the document\'s own date and 00000000 without one, never today\'s', () => {
  assert.match(buildMatchPrompt('', [], '/x.pdf'), /When it shows none, or none can be read, "date" is "" and suggestedFilename starts with 00000000: never today's date/);
});

/** A temp workspace with the photos in the inbox, read by a model that answers per photo. */
async function dropPhotos(photos: Record<string, { vision: string; match?: object }>) {
  const ws = tempWorkspace('drop-photo-');
  mkdirSync(ws.paths.inbox, { recursive: true });
  for (const name of Object.keys(photos)) writeFileSync(join(ws.paths.inbox, `${name}.pdf`), Buffer.from(await imageToPdf(PNG, `${name}.PNG`)));
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
