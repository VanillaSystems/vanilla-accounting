/** A photo dropped into the inbox becomes a one-page PDF of the image's size, readable by pdf.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { imageToPdf, isImageFile } from '../src/parsers/image-pdf.js';

// 2 x 2 pixels, red.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYBAB7FA/+WnI5aAAAAAElFTkSuQmCC', 'base64');

test('a PNG becomes a one-page PDF whose page is the image', async () => {
  const pdf = await imageToPdf(PNG, 'IMG_0001.PNG');
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), '%PDF-');
  const doc = await getDocument({ data: pdf }).promise;
  assert.equal(doc.numPages, 1);
  const page = await doc.getPage(1);
  assert.deepEqual(page.view, [0, 0, 2, 2]);
  assert.equal((await page.getOperatorList()).fnArray.length > 0, true, 'the page draws something');
  await doc.destroy();
});

test('a JPEG header that is not a JPEG is refused, not written as a broken PDF', async () => {
  await assert.rejects(() => imageToPdf(PNG, 'photo.jpg'), /JPEG|SOI|marker/i);
});

test('PNG, JPEG and HEIC files count as images, whatever their case', () => {
  assert.deepEqual(['a.png', 'B.JPG', 'c.jpeg', 'd.pdf', 'e.heic', 'IMG_1.HEIC', 'f.png.icloud'].filter(isImageFile), ['a.png', 'B.JPG', 'c.jpeg', 'e.heic', 'IMG_1.HEIC']);
});

test('an iPhone photo (HEIC) becomes a one-page PDF of its size, decoded by macOS without Homebrew', { skip: !existsSync('/usr/bin/sips') && 'not a Mac' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heic-test-'));
  writeFileSync(join(dir, 'in.png'), Buffer.from(PNG));
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', '-z', '30', '20', join(dir, 'in.png'), '--out', join(dir, 'IMG_0002.HEIC')], { stdio: 'ignore' });
  const heic = readFileSync(join(dir, 'IMG_0002.HEIC'));
  assert.match(heic.subarray(4, 12).toString('latin1'), /ftyphei[cx]/, 'the fixture is a HEIC file');
  const doc = await getDocument({ data: await imageToPdf(heic, 'IMG_0002.HEIC') }).promise;
  assert.equal(doc.numPages, 1);
  assert.deepEqual((await doc.getPage(1)).view, [0, 0, 20, 30]);
  await doc.destroy();
});

test('a small JPEG as readFileSync returns it (a slice of Node\'s buffer pool) is embedded, not refused', { skip: !existsSync('/usr/bin/sips') && 'not a Mac' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jpeg-test-'));
  writeFileSync(join(dir, 'in.png'), Buffer.from(PNG));
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', join(dir, 'in.png'), '--out', join(dir, 'small.jpg')], { stdio: 'ignore' });
  readFileSync(join(dir, 'in.png'));
  const jpeg = readFileSync(join(dir, 'small.jpg'));
  assert.ok(jpeg.byteOffset > 0 || jpeg.buffer.byteLength > jpeg.length, 'the bytes lie inside a larger buffer');
  const doc = await getDocument({ data: await imageToPdf(jpeg, 'small.jpg') }).promise;
  assert.deepEqual((await doc.getPage(1)).view, [0, 0, 2, 2]);
  await doc.destroy();
});

type Quadrants = [[string, string], [string, string]];
const STORED: Quadrants = [['red', 'green'], ['blue', 'white']];
const flipH = ([[a, b], [c, d]]: Quadrants): Quadrants => [[b, a], [d, c]];
const flipV = ([top, bottom]: Quadrants): Quadrants => [bottom, top];
const transpose = ([[a, b], [c, d]]: Quadrants): Quadrants => [[a, c], [b, d]];
// What a viewer shows for each EXIF orientation, as the standard words it.
const SHOWN: Record<number, Quadrants> = {
  1: STORED, 2: flipH(STORED), 3: flipV(flipH(STORED)), 4: flipV(STORED),
  5: transpose(STORED), 6: flipH(transpose(STORED)), 7: flipV(flipH(transpose(STORED))), 8: flipV(transpose(STORED)),
};

async function photo(orientation: number): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(40, 20);
  const g = canvas.getContext('2d');
  for (const [x, y, colour] of [[0, 0, '#f00'], [20, 0, '#0f0'], [0, 10, '#00f'], [20, 10, '#fff']] as const) {
    g.fillStyle = colour;
    g.fillRect(x, y, 20, 10);
  }
  const jpeg = canvas.encodeSync('jpeg', 95);
  const exif = Buffer.from([0xff, 0xe1, 0, 34, ...Buffer.from('Exif\0\0'), 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

function colourName([r, g, b]: Uint8ClampedArray | number[]): string {
  const on = (v: number) => v > 128;
  return ({ '100': 'red', '010': 'green', '001': 'blue', '111': 'white' } as Record<string, string>)[[r, g, b].map((v) => (on(v) ? 1 : 0)).join('')] ?? `rgb(${r},${g},${b})`;
}

async function rendered(pdf: Uint8Array): Promise<{ size: number[]; quadrants: Quadrants }> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const doc = await getDocument({ data: pdf }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 4 });
  const canvas = createCanvas(viewport.width, viewport.height);
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
  const at = (fx: number, fy: number) => colourName(canvas.getContext('2d').getImageData(Math.floor(viewport.width * fx), Math.floor(viewport.height * fy), 1, 1).data);
  const result = { size: page.view.slice(2), quadrants: [[at(0.25, 0.25), at(0.75, 0.25)], [at(0.25, 0.75), at(0.75, 0.75)]] as Quadrants };
  await doc.destroy();
  return result;
}

let canvasAvailable = true;
try { await import('@napi-rs/canvas'); } catch { canvasAvailable = false; }

test('a phone photo stands upright in its PDF whatever EXIF orientation it carries', { skip: !canvasAvailable && 'no canvas to render with' }, async () => {
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { size, quadrants } = await rendered(await imageToPdf(await photo(orientation), 'IMG_0003.JPG'));
    assert.deepEqual(size, orientation >= 5 ? [20, 40] : [40, 20], `page size for orientation ${orientation}`);
    assert.deepEqual(quadrants, SHOWN[orientation], `picture for orientation ${orientation}`);
  }
});

test('a rotated iPhone photo (HEIC) stands upright too', { skip: (!existsSync('/usr/bin/sips') || !canvasAvailable) && 'not a Mac' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heic-rotated-'));
  writeFileSync(join(dir, 'in.jpg'), await photo(6));
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', join(dir, 'in.jpg'), '--out', join(dir, 'IMG_0004.HEIC')], { stdio: 'ignore' });
  const { size, quadrants } = await rendered(await imageToPdf(readFileSync(join(dir, 'IMG_0004.HEIC')), 'IMG_0004.HEIC'));
  assert.deepEqual(size, [20, 40]);
  assert.deepEqual(quadrants, SHOWN[6]);
});
