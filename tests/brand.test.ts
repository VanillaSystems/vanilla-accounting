/**
 * The brand in the app: the packaged app takes its icons from the brand's files, and the accent is
 * the product colour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { APP_ROOT } from '../src/workspace/workspace.js';

const config = createRequire(import.meta.url)('../desktop/electron-builder.config.cjs');
const read = (p: string) => readFileSync(join(APP_ROOT, p));

test('the packaged app uses the brand icons: an .icns on macOS, an .ico on Windows', () => {
  assert.equal(config.mac.icon, 'desktop/icon.icns');
  assert.equal(config.win.icon, 'desktop/icon.ico');
  assert.equal(read(config.mac.icon).subarray(0, 4).toString('latin1'), 'icns');
  assert.deepEqual([...read(config.win.icon).subarray(0, 4)], [0, 0, 1, 0]);
});

const css = read('src/app/styles/tokens.css').toString();
const tokensOf = (selector: string) => {
  const block = css.slice(css.indexOf(selector + ' {')).match(/\{([^}]*)\}/)![1];
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the light accent is Tram blue with a 10 % tint behind it, readable on both; dark mode stays grayscale and no theme uses red', () => {
  const light = tokensOf(':root');
  const dark = tokensOf('[data-theme="dark"]');
  assert.equal(light.accent, '#005b8c');
  const tint = '#' + [1, 3, 5].map((i) => Math.round(parseInt('005b8c'.slice(i - 1, i + 1), 16) * 0.1 + 255 * 0.9).toString(16).padStart(2, '0')).join('');
  assert.equal(light['accent-soft'], tint);
  assert.ok(contrast(light.accent, light['accent-soft']) >= 4.5);
  assert.equal(dark.accent, '#ededed');
  for (const v of [light.accent, light['accent-soft'], dark.accent, dark['accent-soft']]) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
    assert.ok(!(r > g + 60 && r > b + 60), `${v} is no red`);
  }
  assert.ok(!css.includes('data-palette'), 'the colour test is gone');
});
