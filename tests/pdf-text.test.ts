/**
 * The pdf.js text extractor in its three shapes: `reading` for receipts, `raw` in content-stream
 * order, `layout` for a statement's own text beside the model's read. The shapes are
 * checked on synthetic runs; the extraction on the demo PDFs, whose generator wrote the lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textPdf } from '../tools/demo/pdf.js';
import { pdfText, textOf, type Run } from '../src/parsers/pdf-text.js';
import { DEMO_ROOT } from './support/workspace.js';

const run = (text: string, x: number, y: number, size = 10, angle = 0): Run => ({ text, x, xMax: x + text.length * size * 0.5, y, size, angle });

test('raw: content-stream order; a new line when the baseline moves or the x position goes back', () => {
  // A transfer's last line is written in two runs on one baseline; the next transaction starts below.
  const page = [
    run('25 August 2026 | Transaction: TRANSFER-1 |', 50, 700),
    run('Reference: Invoice 1 Ref.: 2-1', 265, 700),
    run('26 August 2026 | Transaction: CARD-2', 50, 686),
    run('Page 1', 500, 20),
  ];
  const raw = textOf([page], 'raw');
  assert.equal(raw, '25 August 2026 | Transaction: TRANSFER-1 | Reference: Invoice 1 Ref.: 2-1\n26 August 2026 | Transaction: CARD-2\nPage 1\f');
});

test('raw: two runs that touch are one word, and the stream order wins over the position on the page', () => {
  const page = [run('Rech', 50, 700), run('nung', 70, 700), run('Fusszeile', 50, 20), run('Kopf', 50, 800)];
  assert.equal(textOf([page], 'raw'), 'Rechnung\nFusszeile\nKopf\f');
});

test('layout: runs of one row stay on one line, padded to their columns; a vertical gap is a blank line', () => {
  const page = [
    run('Saldo zu Ihren Gunsten', 50, 300),
    run("12'345.67", 480, 300.3),
    run('Kontoauszug', 50, 800),
  ];
  const layout = textOf([page], 'layout');
  assert.match(layout, /^\s*Kontoauszug\n\n\n\s*Saldo zu Ihren Gunsten {2,}12'345\.67\f$/);
});

test('reading: lines top to bottom, left to right, single spaces, whatever the stream order; a paragraph gap is a blank line', () => {
  const page = [run('zwei', 80, 788), run('eins', 50, 788), run('unten', 50, 776), run('oben', 50, 800), run('Absatz', 50, 740)];
  assert.equal(textOf([page], 'reading'), 'oben\neins zwei\nunten\n\nAbsatz\f');
  assert.equal(textOf([[], page], 'reading'), '\foben\neins zwei\nunten\n\nAbsatz\f', 'an empty page is a form feed');
});

test('reading: a sidebar is its own block after the column it sits beside, and a table reads column by column', () => {
  const page = [
    run('Rechnung an', 50, 800), run('Kunde', 400, 800),
    run('Beispiel AG', 50, 788), run('kunde@example.com', 400, 788),
    run('Seeweg 12', 50, 776),
    run('Total CHF', 50, 700), run('963.72', 400, 700),
  ];
  assert.equal(textOf([page], 'reading'), 'Rechnung an\nBeispiel AG\nSeeweg 12\n\nKunde\nkunde@example.com\n\nTotal CHF\n\n963.72\f');
});

test('rotated text reads along its own baseline, after the upright text', () => {
  const page = [run('upright', 50, 800), run('second', 50, 700, 10, 90), run('first', 50, 688, 10, 90)];
  assert.equal(textOf([page], 'reading'), 'upright\n\nsecond\nfirst\f');
});

test('a generated PDF reads back line for line, with a form feed after every page', async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `Zeile ${i + 1}: Betrag CHF ${(i * 1.5).toFixed(2)} – Café «Zürich»`);
  const file = join(mkdtempSync(join(tmpdir(), 'pdf-text-')), 'lines.pdf');
  writeFileSync(file, textPdf(lines));
  assert.equal(await pdfText(file), `${lines.slice(0, 54).join('\n')}\f${lines.slice(54).join('\n')}\f`);
  assert.equal(await pdfText(file, 'raw'), await pdfText(file, 'reading'), 'one column: raw and reading agree');
  assert.equal((await pdfText(file, 'layout')).replace(/(^|[\n\f]) +/g, '$1'), await pdfText(file, 'reading'), 'layout adds only indentation');
});

test('a letter-spaced word reads as one word', async () => {
  const text = await pdfText(join(DEMO_ROOT, 'transactional-data/2026/invoices', '2026-001.pdf'));
  assert.match(text, /^RÖSTEREI · ZÜRICH$/m);
  assert.match(text, /^Total netto\nMWST 8\.1 % auf 360\.00\nMWST 2\.6 % auf 560\.00\nTotal CHF\n\n920\.00\n29\.16\n14\.56\n963\.72$/m, 'the totals and their amounts are a column each, as pdftotext read them');
});
