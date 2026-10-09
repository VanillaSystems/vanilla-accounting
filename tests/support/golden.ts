/**
 * The golden master's data set for one workspace: its books frozen at one moment, the refs of
 * their bank transactions, and the expected figures. A failure therefore means the CODE changed a
 * figure, never that someone booked something.
 *
 *   npm test             each demo workspace; its set is tests/golden/<demo>/ (synthetic, public)
 *   npm run test:books   the configured workspace (VANILLA_WORKSPACE, .env, or the cwd); its set is
 *                        <workspace>/golden/, which belongs to the company, not to the app
 *
 * Intended change of figures: `npm run test:update` (demo) or `npm run test:books:update`, review
 * the diff, and say why in the commit. Newer books: `npm run test:freeze` (or test:books:freeze),
 * then update.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { CorrectionCase, JournalEntry, VatAdjustment } from '../../src/types/index.js';
import { APP_ROOT, openWorkspace, type Workspace } from '../../src/workspace/workspace.js';
import { DEMO_ROOTS } from './workspace.js';

export interface FrozenBooks {
  journalEntries: JournalEntry[];
  config: { closedThrough: string; vatAdjustments: VatAdjustment[]; correctionCases: CorrectionCase[] };
}

export interface GoldenSet {
  ws: Workspace;
  books: FrozenBooks;
  /** The refs of the frozen books' bank and manual transactions. */
  refs: Set<string>;
  /** Compares `actual` with <set>/<name>.json, or writes it under UPDATE_GOLDEN=1. */
  expect(name: string, actual: unknown): void;
}

/** A demo's set ships with the app; any other workspace keeps its own. */
function goldenDir(ws: Workspace): string {
  const demo = DEMO_ROOTS.find((d) => realpathSync(d) === ws.paths.root);
  return demo ? join(APP_ROOT, 'tests/golden', basename(demo)) : join(ws.paths.root, 'golden');
}

export function goldenSet(): GoldenSet {
  const ws = openWorkspace();
  const dir = goldenDir(ws);
  const read = (file: string) => {
    const path = join(dir, file);
    if (!existsSync(path)) throw new Error(`${path} missing: freeze the books first (npm run test:freeze or test:books:freeze).`);
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const update = process.env.UPDATE_GOLDEN === '1';
  return {
    ws,
    books: read('books.json') as FrozenBooks,
    refs: new Set<string>(read('transaction-refs.json').refs),
    expect(name, actual) {
      const file = join(dir, `${name}.json`);
      const json = JSON.stringify(actual, null, 2) + '\n';
      if (update) { writeFileSync(file, json); return; }
      assert.ok(existsSync(file), `${relative(APP_ROOT, file)} missing: run the update script and review the new file`);
      assert.deepEqual(JSON.parse(json), JSON.parse(readFileSync(file, 'utf8')), `${name} differs from ${relative(APP_ROOT, file)}`);
    },
  };
}

/** Freezes the workspace's books.json into its golden set: journal and config, and the transaction refs. */
export function freezeBooks(ws: Workspace): string {
  const dir = goldenDir(ws);
  const live = JSON.parse(readFileSync(ws.paths.books, 'utf8')) as FrozenBooks & { transactions: { ref: string }[] };
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync(dir, { recursive: true });
  const write = (file: string, body: object) => writeFileSync(join(dir, file), JSON.stringify(body, null, 1) + '\n');
  write('books.json', { note: `books.json of ${ws.company.name} frozen on ${day}, the golden master's input.`, journalEntries: live.journalEntries, config: live.config });
  write('transaction-refs.json', { note: `The bank and manual transaction refs of books.json frozen on ${day}.`, refs: [...new Set(live.transactions.map((t) => t.ref))].sort() });
  return dir;
}
