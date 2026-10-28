import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, HELP_DIR, VERSION } from '../tools/help/build.js';
import { markdown } from '../tools/help/markdown.js';
import { vatCodes } from '../src/accounting/vat-codes.js';
import { loadCases } from '../src/knowledge/cases.js';
import { PAGE_TAKES } from '../src/app/lib/folder-drop.js';

const site = await buildSite();
const pages = [...site].filter(([path]) => path.endsWith('.html') && path !== 'index.html');

/** A copy of help/ to break one thing in. */
function brokenCopy(file: string, edit: (text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'help-'));
  cpSync(HELP_DIR, dir, { recursive: true });
  writeFileSync(join(dir, file), edit(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

test('every page names the version of the app it describes', () => {
  assert.ok(pages.length > 5);
  for (const [path, html] of pages) assert.match(html, new RegExp(`Vanilla Accounting ${VERSION.replace(/\./g, '\\.')}\\.`), path);
});

test('the VAT-code page has a row for every code of the catalogue', () => {
  const html = site.get('de/mwst-codes.html')!;
  for (const c of vatCodes()) assert.match(html, new RegExp(`<tr id="code-[a-z0-9-]+"><td><code>${c.code.replace(/[-]/g, '\\-')}</code>`), c.code);
});

test('a case page books the lines of its casebook case', () => {
  const html = site.get('de/fall-zollrechnung.html')!;
  const k = loadCases().find((c) => c.id === 'import-vat-evv')!;
  const body = html.slice(html.indexOf('<div class="case">'));
  assert.equal(body.slice(0, body.indexOf('</table>')).match(/<tr><td>/g)?.length, k.lines.length);
  for (const l of k.lines) if (l.vatCode) assert.ok(body.includes(`<code>${l.vatCode}</code>`), l.vatCode);
});

test('a limit on the page is the number the app counts with', () => {
  assert.ok(site.get('de/grenzen.html')!.includes(`<td>${PAGE_TAKES.max.toLocaleString('de-CH')}</td>`));
});

test('no page loads a script or anything from elsewhere', () => {
  for (const [path, html] of site) {
    assert.doesNotMatch(html, /<script|<iframe|<img|src="|@import|url\(/i, path);
    assert.doesNotMatch(html, /<link[^>]+href="(?!\.\.\/style\.css")/, path);
  }
});

test('the build refuses an unknown placeholder, naming it', async () => {
  const dir = brokenCopy('de/grenzen.md', (t) => `${t}\n{{files-per-week}}\n`);
  try {
    await assert.rejects(buildSite(dir), /unknown placeholder \{\{files-per-week\}\}/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('the build refuses a link to a page or anchor that does not exist', async () => {
  const page = brokenCopy('de/quartal.md', (t) => `${t}\n[weg](keine-seite)\n`);
  const anchor = brokenCopy('de/quartal.md', (t) => `${t}\n[weg](mwst-codes#code-x99)\n`);
  try {
    await assert.rejects(buildSite(page), /links to keine-seite, which is no page/);
    await assert.rejects(buildSite(anchor), /links to mwst-codes#code-x99, which that page does not have/);
  } finally { rmSync(page, { recursive: true }); rmSync(anchor, { recursive: true }); }
});

test('the build refuses a quarter step of the flow that the site has no words for', async () => {
  const dir = brokenCopy('de/site.yaml', (t) => t.replace(/\n {2}board:\n.*\n.*\n/, '\n'));
  try {
    await assert.rejects(buildSite(dir), /quarter needs words for the step\(s\) board/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('page text is escaped, links to pages get .html', () => {
  assert.equal(markdown('a <b> & [Q](quartal#x) `c<d>`'), '<p>a &lt;b&gt; &amp; <a href="quartal.html#x">Q</a> <code>c&lt;d&gt;</code></p>');
  assert.equal(markdown('| a | b |\n|---|---|\n| 1 | 2 |'), '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
});
