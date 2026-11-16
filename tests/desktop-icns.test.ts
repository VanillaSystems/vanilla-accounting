/**
 * The Mac app's icons (desktop/*.icns, made by tools/desktop/icns.mjs): every PNG in them has the
 * pixels its type stands for, and none sits under icp4, icp5 or icp6, the types electron-builder
 * used in 0.6.2, which macOS drew as pixel noise at 16 and 32 px (a .vanillashare in Chrome's
 * download list). The build takes these files, never an icns electron-builder makes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/** The pixel width and height of a PNG under each icns type. */
const PNG_SIZE: Record<string, number> = {
  icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512,
};
/** Types macOS draws wrong when they hold a PNG. */
const NOISE = new Set(['icp4', 'icp5', 'icp6']);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What is wrong with an icns file; empty when it is right. */
function icnsProblems(bytes: Buffer): string[] {
  if (bytes.toString('latin1', 0, 4) !== 'icns' || bytes.readUInt32BE(4) !== bytes.length) return ['not an icns file'];
  const problems: string[] = [];
  for (let at = 8; at < bytes.length;) {
    const type = bytes.toString('latin1', at, at + 4);
    const length = bytes.readUInt32BE(at + 4);
    if (length < 8 || at + length > bytes.length) return [...problems, `${type}: length ${length} runs past the file`];
    const data = bytes.subarray(at + 8, at + length);
    if (data.subarray(0, 8).equals(PNG)) {
      const [w, h] = [data.readUInt32BE(16), data.readUInt32BE(20)];
      if (NOISE.has(type)) problems.push(`${type} holds a PNG, which macOS draws as noise`);
      else if (!(type in PNG_SIZE)) problems.push(`${type} holds a PNG of a type the check does not know`);
      else if (w !== PNG_SIZE[type] || h !== PNG_SIZE[type]) problems.push(`${type} holds ${w}×${h} px, its type stands for ${PNG_SIZE[type]}`);
    }
    at += length;
  }
  return problems;
}

/** An icns of the given entries; each PNG only as far as its header (enough for the check). */
function icnsOf(entries: Array<[string, number]>): Buffer {
  const parts = entries.map(([type, px]) => {
    const ihdr = Buffer.alloc(25);
    PNG.copy(ihdr);
    ihdr.writeUInt32BE(13, 8);
    ihdr.write('IHDR', 12, 'latin1');
    ihdr.writeUInt32BE(px, 16);
    ihdr.writeUInt32BE(px, 20);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(8 + ihdr.length, 4);
    return Buffer.concat([head, ihdr]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

test('every icns in desktop/ holds each image at the size of its type, and none as icp4, icp5 or icp6', () => {
  const files = readdirSync('desktop').filter((f) => f.endsWith('.icns'));
  assert.deepEqual(files.sort(), ['document.icns', 'icon.icns']);
  for (const file of files) assert.deepEqual(icnsProblems(readFileSync(`desktop/${file}`)), [], file);
});

test('the icns electron-builder made for 0.6.2 is refused', () => {
  const built = icnsOf([['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 512], ['ic14', 1024]]);
  assert.deepEqual(icnsProblems(built), [
    'icp4 holds a PNG, which macOS draws as noise',
    'icp5 holds a PNG, which macOS draws as noise',
    'icp6 holds a PNG, which macOS draws as noise',
    'ic13 holds 512×512 px, its type stands for 256',
    'ic14 holds 1024×1024 px, its type stands for 512',
  ]);
});

test('the Mac build takes the committed icons: the app\'s, and the page for its files', () => {
  const config = createRequire(import.meta.url)('../desktop/electron-builder.config.cjs') as {
    mac: { icon: string };
    fileAssociations: Array<{ ext: string; icon?: string }>;
  };
  assert.equal(config.mac.icon, 'desktop/icon.icns');
  for (const ext of ['vanillashare', 'vanilla']) {
    assert.equal(config.fileAssociations.find((f) => f.ext === ext)?.icon, 'desktop/document.icns', ext);
  }
  assert.ok(existsSync('desktop/document.icns'));
});
