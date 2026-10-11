/**
 * The brand in the app: the packaged app takes its icons from the brand's files, and the colour
 * test (Firma › Darstellung › Farbe (Test)) is applied before the first paint and switches tokens
 * that keep text readable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { PALETTES } from '../src/app/brand/palette.js';
import { APP_ROOT } from '../src/workspace/workspace.js';

const config = createRequire(import.meta.url)('../desktop/electron-builder.config.cjs');
const read = (p: string) => readFileSync(join(APP_ROOT, p));

test('the packaged app uses the brand icons: an .icns on macOS, an .ico on Windows', () => {
  assert.equal(config.mac.icon, 'desktop/icon.icns');
  assert.equal(config.win.icon, 'desktop/icon.ico');
  assert.equal(read(config.mac.icon).subarray(0, 4).toString('latin1'), 'icns');
  assert.deepEqual([...read(config.win.icon).subarray(0, 4)], [0, 0, 1, 0]);
});

function paletteBeforePaint(storedPalette: string | null): string | undefined {
  const html = read('index.html').toString();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const root = { dataset: {} as Record<string, string>, style: { setProperty() {} } };
  runInNewContext(script, {
    localStorage: { getItem: (k: string) => (k === 'palette' ? storedPalette : null) },
    matchMedia: () => ({ matches: false }),
    document: { documentElement: root },
  });
  return root.dataset.palette;
}

test('index.html applies the stored colour test before the first paint, and blue for anything else', () => {
  for (const p of PALETTES) assert.equal(paletteBeforePaint(p), p);
  assert.equal(paletteBeforePaint(null), 'blue');
  assert.equal(paletteBeforePaint('purple'), 'blue');
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

test('each colour test but blue switches the light accent, readable at 4.5:1 on white and on its soft background; dark is left alone', () => {
  for (const p of PALETTES.filter((p) => p !== 'blue')) {
    const selector = `:root[data-palette="${p}"]:not([data-theme="dark"])`;
    assert.ok(css.includes(selector + ' {'), `${p} has its tokens, light only`);
    const { accent, 'accent-soft': soft } = tokensOf(selector);
    assert.ok(contrast(accent, '#ffffff') >= 4.5, `${p}: ${accent} on white`);
    assert.ok(contrast(accent, soft) >= 4.5, `${p}: ${accent} on ${soft}`);
  }
  assert.equal(tokensOf(':root').brand, '#ff0000');
});
