/**
 * The golden master's data set for one workspace: its books frozen at one moment, the refs of
 * their bank transactions, and the expected figures. A failure therefore means the CODE changed a
 * figure, never that someone booked something.
 *
 *   npm test             each demo workspace; its set is tests/golden/<demo>/ (synthetic, public)
 *   npm run test:books   the configured workspace (VANILLA_WORKSPACE, .env, or the cwd); its set is
 *                        transactional-data/<year>/expected/ of the latest year that has one, which
 *                        belongs to the company, not to the app
 *
 * Intended change of figures: `npm run test:update` (demo) or `npm run test:books:update`, review
 * the diff, and say why in the commit. Newer books: `npm run test:freeze` (or test:books:init),
 * then update.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { CorrectionCase, JournalEntry, VatAdjustment } from '../../src/types/index.js';
import { APP_ROOT, openWorkspace, partDirs, yearPaths, yearsOf, type Workspace } from '../../src/workspace/workspace.js';
import { loadBooks } from '../../src/books/store.js';
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

/** A demo's set ships with the app; any other workspace keeps its own, in the latest year that has one (or the year `of` names). */
function goldenDir(ws: Workspace, of?: string): string {
  const demo = DEMO_ROOTS.find((d) => realpathSync(d) === realpathSync(ws.paths.root));
  if (demo) return join(APP_ROOT, 'tests/golden', basename(dirname(demo)));
  const year = of ?? partDirs(ws.paths, 'expected').map((d) => basename(dirname(d))).at(-1) ?? yearsOf(ws.paths).at(-1);
  if (!year) throw new Error(`${ws.paths.root} has no year folder yet`);
  return yearPaths(ws.paths, year).expected;
}

export function goldenSet(): GoldenSet {
  const ws = openWorkspace();
  const dir = goldenDir(ws);
  const read = (file: string) => {
    const path = join(dir, file);
    if (!existsSync(path)) throw new Error(`${path} missing: freeze the books first (npm run test:freeze or test:books:init).`);
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

/** Freezes the workspace's books into its golden set, in the year of their latest entry: journal and config, and the transaction refs. */
export function freezeBooks(ws: Workspace): string {
  const live = loadBooks(ws);
  const dir = goldenDir(ws, live.journalEntries.map((e) => e.date).sort().at(-1)?.slice(0, 4));
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync(dir, { recursive: true });
  const write = (file: string, body: object) => writeFileSync(join(dir, file), JSON.stringify(body, null, 1) + '\n');
  write('books.json', { note: `The books of ${ws.company.name} frozen on ${day}, the golden master's input.`, journalEntries: live.journalEntries, config: live.config });
  write('transaction-refs.json', { note: `The bank and manual transaction refs of the books frozen on ${day}.`, refs: [...new Set(live.transactions.map((t) => t.ref))].sort() });
  return dir;
}
