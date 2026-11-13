/**
 * The committed demo workspaces are what their generator writes today (#374): each demo is generated into a temp folder
 * by `npm run demo:generate` itself and compared with the committed folder, file by file and byte by byte. A demo the
 * generator has outgrown (a field the parser reads now, a new shape of a record) fails here, with the files named,
 * instead of being found later behind a seal hash that no longer matches its books.
 *
 * Left out, because Chrome makes them and its bytes vary with the machine (its version and the OS are written into
 * every PDF, its layout follows the installed fonts): the bytes of the PDFs Chrome prints (the demo's invoices, their
 * sent copies and the paid invoices filed as receipts), and what is derived from those bytes, the receipt's id and
 * size and the PDF's SHA-256 in invoices.json and mappings, and in a demo with such a PDF the order of the lines of
 * its books' JSON Lines (they are ordered by id). Such a PDF must still exist under the same name on both sides, and
 * every other field of its records is compared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { browserPath } from './support/browser.js';
import { DEMO_ROOTS } from './support/workspace.js';
import { APP_ROOT } from '../src/workspace/workspace.js';

/** Every demo tools/demo/generate.ts writes; the last test fails when the app root holds another. */
const DEMOS = ['demo', 'demo-consulting', 'demo-coiffeur', 'demo-schreinerei'];
/** Demos whose invoices Chrome prints: without a browser they cannot be generated, and their test skips. */
const PRINTED = new Set(['demo']);
const FIX = 'run `npm run demo:generate` and commit the result; when a seal or a golden figure changes with it, stop: no booking or figure may change by a regeneration (#374)';
const SHOWN = 20;

/** Every file under `dir`, relative, without what the demo's .gitignore keeps out of the repository. */
function files(dir: string): string[] {
  const ignored = new Set(readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').map((l) => l.trim().replace(/\/$/, '')).filter(Boolean));
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (d === dir && ignored.has(name)) continue;
      if (name === '.DS_Store') continue;
      if (statSync(path).isDirectory()) walk(path); else out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.sort();
}

const isChromePdf = (bytes: Buffer) => bytes.subarray(0, 4).toString() === '%PDF' && bytes.includes('HeadlessChrome/');

/**
 * The demo's files with Chrome's PDFs set aside: each such PDF becomes a placeholder naming its path, and its SHA-256
 * (as invoices.json keeps it), its receipt id (the first 16 hex digits) and its receipt's size in every text file
 * become the same placeholder, so both sides compare equal however Chrome printed.
 */
function comparable(dir: string): Map<string, string | Buffer> {
  const all = new Map(files(dir).map((f) => [f, readFileSync(join(dir, f))]));
  const printed = [...all].filter(([, bytes]) => isChromePdf(bytes));
  const swaps = printed.flatMap(([file, bytes]) => {
    const sha = createHash('sha256').update(bytes).digest('hex');
    return [[sha, `<chrome-pdf ${file}>`], [sha.slice(0, 16), `<chrome-pdf-id ${file}>`]] as const;
  });
  const out = new Map<string, string | Buffer>();
  for (const [file, bytes] of all) {
    if (printed.some(([f]) => f === file)) { out.set(file, `<printed by Chrome: ${bytes.length > 0 ? 'present' : 'empty'}>`); continue; }
    if (!/\.(json|jsonl|ya?ml|xml|txt|md|svg)$|^\.git/.test(file.split('/').pop()!)) { out.set(file, bytes); continue; }
    let text = bytes.toString('utf8');
    for (const [from, to] of swaps) text = text.split(from).join(to);
    // A receipt Chrome printed: its size follows the bytes.
    const lines = text.split('\n').map((line) => line.includes('<chrome-pdf-id ') ? line.replace(/"fileSize":\d+/, '"fileSize":"<chrome-pdf size>"') : line);
    // The books' JSON Lines are ordered by id, and such a receipt's id follows Chrome: its line moves with it.
    out.set(file, (file.endsWith('.jsonl') && swaps.length ? lines.sort() : lines).join('\n'));
  }
  return out;
}

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), 'demos-generated-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

for (const demo of DEMOS) {
  const skip = PRINTED.has(demo) && !browserPath ? 'no Chromium browser to print its invoices (npx playwright install chromium, or CHROME_PATH)' : false;
  test(`${demo}: the committed workspace is what npm run demo:generate writes`, { skip, timeout: 120_000 }, async () => {
    const out = join(scratch, demo);
    await run(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'tools/demo/generate.ts'), '--demo', demo, '--out', out], {
      cwd: APP_ROOT, env: { ...process.env, ...(browserPath ? { CHROME_PATH: browserPath } : {}) },
    });
    const committed = comparable(join(APP_ROOT, demo));
    const generated = comparable(out);
    const differ = [...new Set([...committed.keys(), ...generated.keys()])].sort().flatMap((f) => {
      const a = committed.get(f), b = generated.get(f);
      if (a === undefined) return [`${f}: written by the generator, not committed`];
      if (b === undefined) return [`${f}: committed, no longer written by the generator`];
      return Buffer.from(a).equals(Buffer.from(b)) ? [] : [`${f}: differs`];
    });
    const shown = differ.slice(0, SHOWN).map((d) => `  ${d}`).join('\n');
    const more = differ.length > SHOWN ? `\n  … ${differ.length - SHOWN} more files, ${SHOWN} shown` : '';
    assert.equal(differ.length, 0, `${demo}/ is not what the generator writes today, ${differ.length} files:\n${shown}${more}\n${FIX}`);
  });
}

test('every demo workspace at the app root is compared', () => {
  const found = DEMO_ROOTS.map((root) => relative(APP_ROOT, dirname(root)));
  assert.deepEqual(found.sort(), [...DEMOS].sort(), 'a demo of tools/demo/generate.ts DEMOS is missing from this test, or a demo folder is left over');
});
