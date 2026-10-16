/**
 * An own photo or scan is made smaller before its id (src/parsers/smaller.ts): a phone's 9 MB scan
 * comes down to a fraction, keeps its page, stays a readable PDF; a small or received PDF stays
 * byte for byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { imageToPdf } from '../src/parsers/image-pdf.js';
import { smallerPdf } from '../src/parsers/smaller.js';

const mac = existsSync('/usr/bin/sips');

/** A noisy photo of w x h pixels as JPEG: noise does not compress, as a real photo's grain does not. */
function photo(w: number, h: number): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'smaller-test-'));
  const row = Math.ceil((w * 3) / 4) * 4;
  const bmp = Buffer.alloc(54 + row * h);
  bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(w, 18); bmp.writeInt32LE(h, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  for (let i = 54; i < bmp.length; i++) bmp[i] = (i * 2654435761) >>> 24;
  writeFileSync(join(dir, 'in.bmp'), bmp);
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', join(dir, 'in.bmp'), '--out', join(dir, 'out.jpg')], { stdio: 'ignore' });
  return new Uint8Array(readFileSync(join(dir, 'out.jpg')));
}

test('a large scan comes down, keeps its page size and stays one readable page', { skip: !mac && 'not a Mac' }, async () => {
  const big = await imageToPdf(photo(2000, 3200), 'scan.jpg');
  assert.ok(big.length > 1_500_000, `the fixture is large (${big.length})`);
  const small = await smallerPdf(big);
  assert.ok(small.length < big.length * 0.7, `${big.length} → ${small.length}`);
  const [before, after] = await Promise.all([big, small].map(async (b) => {
    const doc = await getDocument({ data: new Uint8Array(b) }).promise;
    const page = await doc.getPage(1);
    const out = { pages: doc.numPages, view: page.view, draws: (await page.getOperatorList()).fnArray.length };
    await doc.destroy();
    return out;
  }));
  assert.deepEqual(after, before);
});

test('a small PDF and a signed one stay byte for byte', { skip: !mac && 'not a Mac' }, async () => {
  const small = await imageToPdf(photo(200, 300), 'small.jpg');
  assert.equal(await smallerPdf(small), small);
  const big = await imageToPdf(photo(2000, 3200), 'signed.jpg');
  const signed = Buffer.concat([Buffer.from(big), Buffer.from('\n% /ByteRange [0 1 2 3]\n')]);
  assert.equal(await smallerPdf(signed), signed);
});
