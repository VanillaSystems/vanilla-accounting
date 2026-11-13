/**
 * The committed demo workspaces are what their generator writes today (#374): each demo is generated into a temp folder
 * by `npm run demo:generate` itself and compared with the committed folder, file by file and byte by byte. A demo the
 * generator has outgrown (a field the parser reads now, a new shape of a record) fails here, with the files named,
 * instead of being found later behind a seal hash that no longer matches its books.
 *
 * The PDFs Chrome prints (the demo's invoices, their sent copies and the paid invoices filed as receipts) are compared
 * by their text, read by the app's own PDF reader (src/parsers/pdf-text.ts), not by their bytes: Chrome writes its
 * version and the OS into every PDF, and its layout follows the installed fonts, so the bytes vary with the machine.
 * Left out with the bytes is what is derived from them: the receipt's id and size and the PDF's SHA-256 in
 * invoices.json and mappings, and the order of the lines of a JSON Lines file holding such an id (ordered by id).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { browserPath } from './support/browser.js';
import { DEMO_ROOTS } from './support/workspace.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { pdfRuns, textOf } from '../src/parsers/pdf-text.js';

/** Every demo tools/demo/generate.ts writes; the last test fails when the app root holds another. */
const DEMOS = ['demo', 'demo-consulting', 'demo-coiffeur', 'demo-schreinerei'];
/** Demos whose invoices Chrome prints: without a browser they cannot be generated, and their test skips. */
const PRINTED = new Set(['demo']);
const FIX = 'run `npm run demo:generate` and commit the result. Stop instead when entries.jsonl, a filed return or tests/golden change with it: '
  + 'no booking or figure may change by a regeneration. A seal\'s sha256 may change only because its sealed records gained fields the generator '
  + 'writes now; check that by recomputing the seal without those fields (#374)';
const SHOWN = 20;
/** The generator of one demo, Chrome included, is stopped after this; it takes a few seconds. */
const GENERATE_MS = 90_000;

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

/** A printed PDF's words in content order: a line broken elsewhere by another font is no difference, a changed amount is. */
async function printedText(bytes: Buffer): Promise<string> {
  return `<printed by Chrome>\n${textOf(await pdfRuns(bytes), 'raw').split(/\s+/).filter(Boolean).join(' ')}`;
}

/**
 * The demo's files as compared: a PDF Chrome printed as its text, and its SHA-256 (as invoices.json keeps it), its
 * receipt id (the first 16 hex digits) and its receipt's size in every text file as a placeholder naming its path.
 */
async function comparable(dir: string): Promise<Map<string, string | Buffer>> {
  const all = new Map(files(dir).map((f) => [f, readFileSync(join(dir, f))]));
  const printed = new Set([...all].filter(([, bytes]) => isChromePdf(bytes)).map(([f]) => f));
  const swaps = [...printed].flatMap((file) => {
    const sha = createHash('sha256').update(all.get(file)!).digest('hex');
    return [[sha, `<chrome-pdf ${file}>`], [sha.slice(0, 16), `<chrome-pdf-id ${file}>`]] as const;
  });
  const out = new Map<string, string | Buffer>();
  for (const [file, bytes] of all) {
    if (printed.has(file)) { out.set(file, await printedText(bytes)); continue; }
    if (!/\.(json|jsonl|ya?ml|xml|txt|md|svg)$|^\.git/.test(file.split('/').pop()!)) { out.set(file, bytes); continue; }
    let text = bytes.toString('utf8');
    for (const [from, to] of swaps) text = text.split(from).join(to);
    if (!text.includes('<chrome-pdf-id ')) { out.set(file, text); continue; }
    // A receipt Chrome printed: its size follows the bytes, and a JSON Lines file ordered by id moves its line.
    const lines = text.split('\n').map((line) => line.includes('<chrome-pdf-id ') ? line.replace(/"fileSize":\d+/, '"fileSize":"<chrome-pdf size>"') : line);
    out.set(file, (file.endsWith('.jsonl') ? lines.sort() : lines).join('\n'));
  }
  return out;
}

/**
 * Runs the generator of one demo in a process group of its own, so the Chrome it starts goes with it: after
 * GENERATE_MS the whole group is killed and the test fails, instead of a hung child keeping the test process alive.
 */
function generate(demo: string, out: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'tools/demo/generate.ts'), '--demo', demo, '--out', out], {
      cwd: APP_ROOT, env: { ...process.env, ...(browserPath ? { CHROME_PATH: browserPath } : {}) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let said = '';
    child.stdout.on('data', (d) => { said += d; });
    child.stderr.on('data', (d) => { said += d; });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      fail(new Error(`npm run demo:generate -- --demo ${demo} did not end within ${GENERATE_MS / 1000} s; it and its Chrome were killed\n${said}`));
    }, GENERATE_MS);
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) done(); else fail(new Error(`npm run demo:generate -- --demo ${demo} ended with ${code ?? signal}\n${said}`));
    });
  });
}

const scratch = mkdtempSync(join(tmpdir(), 'demos-generated-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

for (const demo of DEMOS) {
  const skip = PRINTED.has(demo) && !browserPath ? 'no Chromium browser to print its invoices (npx playwright install chromium, or CHROME_PATH)' : false;
  test(`${demo}: the committed workspace is what npm run demo:generate writes`, { skip, timeout: GENERATE_MS + 30_000 }, async () => {
    const out = join(scratch, demo);
    await generate(demo, out);
    const committed = await comparable(join(APP_ROOT, demo));
    const generated = await comparable(out);
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
