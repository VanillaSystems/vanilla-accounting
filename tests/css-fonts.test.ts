/**
 * The app's text never falls back to the browser's default serif. A declaration that named a webfont without a generic
 * family behind it (`font: 700 15px "Hanken Grotesk"`) showed Times while the font loaded, or when it failed (a worktree
 * whose Vite refused the font files), and screenshots caught it. So under src/app:
 * - a font is named only through the tokens of src/app/styles/tokens.css (`var(--font-sans)`, `--font-display`,
 *   `--font-mono`), which carry the generic family;
 * - any other family list ends in a generic family (the invoice sheet's `Helvetica, Arial, sans-serif`);
 * - each weight a rule asks of a token's font is bundled in src/app/main.tsx, never bolded by the browser;
 * - a test's screenshot goes through `screenshot` of tests/support/browser.ts, and a script's waits for
 *   `document.fonts.ready`, so neither captures the fallback while the fonts load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir: string, ext: RegExp): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === 'node_modules' ? [] : files(join(dir, e.name), ext)) : ext.test(e.name) ? [join(dir, e.name)] : []);

/** The bundled webfonts, by the token that names each and its @fontsource package. */
const FONTS = [
  { family: 'Instrument Sans', token: '--font-sans', pkg: 'instrument-sans' },
  { family: 'Hanken Grotesk', token: '--font-display', pkg: 'hanken-grotesk' },
  { family: 'Geist Mono', token: '--font-mono', pkg: 'geist-mono' },
];
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji|fangsong|inherit|initial|unset|revert|revert-layer)$/;
const USE = `name the font by its token: var(--font-sans) (Instrument Sans), var(--font-display) (Hanken Grotesk) or var(--font-mono) (Geist Mono), e.g. \`font: 700 15px/1.2 var(--font-display)\``;

/** The family list of a `font` shorthand (after the size and line height) or of `font-family`; null when it names none. */
function familyList(prop: string, value: string): string | null {
  const v = value.replace(/\s*!important\s*$/, '').trim();
  if (prop === 'font-family') return v;
  const m = v.match(/(?:^|\s)[\d.]+(?:px|pt|em|rem|%|vw|vh)(?:\s*\/\s*[\d.]+\w*%?)?\s+(.+)$/);
  return m ? m[1] : null;
}

/** What is wrong with the font declarations of one CSS file, as `file:line message`. */
function fontFindings(file: string, css: string, bundled: Set<string>): string[] {
  const out: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const lineOf = (at: number) => text.slice(0, at).split('\n').length;
  for (const rule of text.matchAll(/\{([^{}]*)\}/g)) {
    const body = rule[1];
    let token: (typeof FONTS)[number] | undefined;
    let weight: string | undefined;
    for (const d of body.matchAll(/(?:^|[;\s])(font|font-family|font-weight)\s*:\s*([^;]*)/g)) {
      const [, prop, value] = d;
      const at = `${file}:${lineOf(rule.index! + 1 + d.index!)}`;
      if (prop === 'font-weight') { weight = value.trim(); continue; }
      if (prop === 'font') weight = value.trim().match(/^(?:(?:italic|oblique|normal|small-caps)\s+)*(\d{3}|bold|normal)\s/)?.[1] ?? weight;
      for (const f of FONTS) if (value.includes(f.family)) out.push(`${at} names "${f.family}": ${USE}`);
      const t = value.match(/var\((--font-\w+)\)/)?.[1];
      if (t) { token = FONTS.find((f) => f.token === t); continue; }
      const list = familyList(prop, value);
      if (list === null) continue;
      const last = list.split(',').pop()!.trim();
      if (!GENERIC.test(last)) out.push(`${at} \`${prop}: ${value.trim()}\` ends without a generic family, so the browser's default serif shows while it loads: ${USE}, or end the list with sans-serif or monospace`);
    }
    if (token && weight) {
      const w = weight === 'bold' ? 700 : weight === 'normal' ? 400 : Math.ceil(Number(weight) / 100) * 100;
      if (w && !bundled.has(`${token.pkg}/${w}`)) {
        out.push(`${file}:${lineOf(rule.index!)} asks ${token.family} at weight ${weight}, which src/app/main.tsx does not bundle (the browser would fake it): add \`import '@fontsource/${token.pkg}/${w}.css';\` there, or use a bundled weight`);
      }
    }
  }
  return out;
}

const bundled = new Set([...readFileSync('src/app/main.tsx', 'utf8').matchAll(/@fontsource\/([\w-]+)\/(\d{3})\.css/g)].map((m) => `${m[1]}/${m[2]}`));

test('every font declaration under src/app names its font by a token and ends in a generic family', () => {
  // The tokens themselves are custom properties (`--font-sans: "Instrument Sans", …`), which the lint does not read.
  const found = files('src/app', /\.css$/).flatMap((f) => fontFindings(f, readFileSync(f, 'utf8'), bundled));
  assert.deepEqual(found, [], `font declarations that may show the browser's default serif or a faked weight:\n${found.join('\n')}`);
});

test('no inline style under src/app names a webfont', () => {
  const found = files('src/app', /\.tsx?$/).flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
    /(fontFamily|font-family|font)\s*:\s*['"`][^'"`]*(Instrument Sans|Hanken Grotesk|Geist Mono)/.test(line) ? [`${f}:${i + 1}: ${USE}`] : []));
  assert.deepEqual(found, [], found.join('\n'));
});

test('the lint sees a bare webfont, a list without a generic family and an unbundled weight', () => {
  const css = '.a { font: 700 15px/1.2 "Hanken Grotesk"; }\n.b { font-family: Helvetica, Arial; }\n.c { font: 600 12px var(--font-mono); }\n'
    + '.d { font: 6pt Helvetica, Arial, sans-serif; }\n.e { font: inherit; font-size: 12px; }\n.f { font-family: var(--font-sans); font-weight: 500; }';
  const found = fontFindings('x.css', css, new Set(['instrument-sans/500', 'geist-mono/400']));
  assert.equal(found.length, 4, found.join('\n'));
  assert.match(found[0], /^x\.css:1 names "Hanken Grotesk": name the font by its token/);
  assert.match(found[1], /^x\.css:1 `font: 700 15px\/1.2 "Hanken Grotesk"` ends without a generic family/);
  assert.match(found[2], /^x\.css:2 `font-family: Helvetica, Arial` ends without a generic family/);
  assert.match(found[3], /^x\.css:3 asks Geist Mono at weight 600, which src\/app\/main\.tsx does not bundle.*@fontsource\/geist-mono\/600\.css/);
});

test('a test captures the app only through screenshot(page, path), which waits for its fonts', () => {
  const found = files('tests', /\.(ts|mjs)$/).filter((f) => f !== join('tests', 'support', 'browser.ts'))
    .filter((f) => /\.screenshot\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(found, [], `use \`await screenshot(page, path)\` of tests/support/browser.ts, which waits for document.fonts.ready and a frame:\n${found.join('\n')}`);
});

test('a script that takes a screenshot waits for document.fonts.ready first', () => {
  const found = [...files('tools', /\.(ts|mjs|js)$/), ...files('.claude/skills', /\.(ts|mjs|js)$/)]
    .filter((f) => { const s = readFileSync(f, 'utf8'); return /\.screenshot\(/.test(s) && !s.includes('document.fonts.ready'); });
  assert.deepEqual(found, [], `before page.screenshot, await page.evaluate(() => document.fonts.ready.then(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))))):\n${found.join('\n')}`);
});
