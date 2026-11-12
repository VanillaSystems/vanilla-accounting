/**
 * Issue #361: every file dropped anywhere in the app goes through the one drop door, the drop dialog.
 * No area takes drops of its own again (Kontoauszüge did, and lost every photo without a word); the
 * statement picker of Kontoauszüge hands any other file to the dialog; and the window takes a drop
 * from its first moment: before the API has answered it waits, offline or read-only it is refused
 * with a word, and a file drag never falls through to the browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { heldDrops, installWindowDrop, setDropHandler, type DropHandler, type DropState, type Dropped } from '../src/app/shell/window-drop.js';

const AREAS = join(process.cwd(), 'src/app/areas');

test('no area has a drop target of its own: a drop on any page opens the drop dialog', () => {
  assert.doesNotMatch(readFileSync(join(AREAS, 'index.ts'), 'utf8'), /^\s+drop\??:/m, 'the Area type takes no `drop` (a drop of its own would bypass the dialog)');
  for (const area of readdirSync(AREAS, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of readdirSync(join(AREAS, area.name)).filter((n) => /\.tsx?$/.test(n))) {
      assert.doesNotMatch(readFileSync(join(AREAS, area.name, f), 'utf8'), /^\s+drop: \{/m, `${area.name}/${f}: an area's own drop; hand files to dropFiles (the drop dialog) instead`);
    }
  }
});

test('the statement picker of Kontoauszüge hands every file that is no statement to the drop dialog', () => {
  const src = readFileSync(join(AREAS, 'bank/actions.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function importStatements'), src.indexOf('\n}\n', src.indexOf('export async function importStatements')));
  assert.match(body, /const others = files\.filter\(\(f\) => !ok\.includes\(f\)\)/, 'the files that are no statement');
  assert.match(body, /if \(others\.length\) void dropFiles\(others\)/, 'go to the drop dialog when all statements were read');
  assert.match(body, /dropFiles\(\[\.\.\.ok\.slice\(i\), \.\.\.others\]\)/, 'and with the statements the dialog asks about');
  assert.match(body, /const rest = \[\.\.\.ok\.slice\(i \+ 1\), \.\.\.others\];\n\s+if \(rest\.length\) void dropFiles\(rest\)/, 'and after a refused statement');
  assert.doesNotMatch(body, /skipped|importSkipped/, 'never skipped');
});

/** A window as the drop listeners see it, and a file drag event on it. */
function fakeWindow() {
  const win = new EventTarget() as unknown as Window;
  const fire = (type: string, files: File[] = [new File(['x'], 'IMG_1.jpg')]) => {
    const e = Object.assign(new Event(type, { cancelable: true }), { clientX: 10, dataTransfer: { types: ['Files'], files, items: [] } });
    win.dispatchEvent(e);
    return e;
  };
  return { win, fire };
}

function handler(state: DropState) {
  const taken: Dropped[] = [];
  const refused: string[] = [];
  const h: DropHandler = { state, targetAt: () => 'page', shown: () => undefined, take: (d) => taken.push(d), refuse: (why) => refused.push(why) };
  return { h, taken, refused };
}

test('the window takes a drop from its first moment: held until the app knows it may write, refused with a word offline or read-only', () => {
  const { win, fire } = fakeWindow();
  installWindowDrop(win);
  setDropHandler(undefined);
  assert.equal(fire('dragover').defaultPrevented, true, 'a file drag never falls through to the browser, even while the app loads');
  assert.equal(fire('drop').defaultPrevented, true);
  assert.equal(heldDrops().length, 1, 'dropped while the books load: held');

  const unknown = handler('unknown');
  setDropHandler(unknown.h);
  fire('drop', [new File(['y'], 'oktober.xml')]);
  assert.deepEqual([heldDrops().length, unknown.taken.length], [2, 0], 'before the API answered: held');

  const ready = handler('ready');
  setDropHandler(ready.h);
  assert.deepEqual(ready.taken.map((d) => d.files.map((f) => f.name)), [['IMG_1.jpg'], ['oktober.xml']], 'once it may write: every held drop goes in, in order');
  assert.equal(heldDrops().length, 0);
  fire('drop');
  assert.equal(ready.taken.length, 3, 'and every drop after it');

  for (const state of ['offline', 'readonly'] as const) {
    const off = handler(state);
    setDropHandler(off.h);
    fire('drop');
    assert.deepEqual([off.refused, off.taken.length, heldDrops().length], [[state], 0, 0], `${state}: said, nothing taken, nothing kept for later`);
  }
  setDropHandler(undefined);
});
