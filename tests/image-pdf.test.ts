/** A photo dropped into the inbox becomes a one-page PDF of the image's size, readable by pdf.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('only PNG and JPEG files count as images, whatever their case', () => {
  assert.deepEqual(['a.png', 'B.JPG', 'c.jpeg', 'd.pdf', 'e.heic', 'f.png.icloud'].filter(isImageFile), ['a.png', 'B.JPG', 'c.jpeg']);
});
