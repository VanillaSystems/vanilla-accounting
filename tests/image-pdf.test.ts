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
