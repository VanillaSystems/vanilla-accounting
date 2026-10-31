/**
 * Moves a workspace from the layout before 0.4.0 (the books at the repository's root, one
 * books.json) into the layout of ADR 0013:
 *
 *   <repo>/belege.workspace.yaml, mail.yaml, knowledge/, …  → <repo>/vanilla-accounting/…
 *   accounts.json                                          → vanilla-accounting/master-data/
 *   books.json                                             → vanilla-accounting/ledger.json and
 *                                                             transactional-data/<year>/books/*.jsonl
 *   receipts/, bank-statements/<bank>/                     → transactional-data/<year>/… by the
 *                                                             year of the entry that books each file
 *   filings/<year>/                                        → transactional-data/<year>/filings/
 *   invoices/                                              → transactional-data/<year>/invoices/ (the
 *                                                             logo to logos/), paths in invoices.json and
 *                                                             the manifest follow
 *   golden/                                                → transactional-data/<year>/expected/
 *
 * The repository's own files (.git, .env, AGENTS.md, CLAUDE.md, README.md) stay at its root, and
 * so does every name the app does not know: the workspace check names them. No record changes:
 * the seals hash entries, transactions and mappings, never a path. Tracked files move with git mv.
 * Idempotent: a file already in place is skipped, and a run after a crash finishes the rest;
 * books.json is removed last, after a copy in data/backups/.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import fs from 'node:fs';
import git from 'isomorphic-git';
import { writeBooks, type Books } from '../books/store.js';
import { openYear, placement, statementFile, yearOfDate } from '../books/years.js';
import type { Index } from '../types/index.js';
import { BOOKS_MIGRATIONS, BOOKS_SCHEMA, climb, schemaOf } from './schema.js';
import { APP_FOLDER, LAYOUT, MANIFEST_FILE, workspacePaths, yearPaths } from './workspace.js';
import { repositoryAt } from './git.js';

/** Whether `dir` holds books in the layout before ADR 0013. */
export const isOldLayout = (dir: string): boolean => existsSync(join(dir, MANIFEST_FILE)) && existsSync(join(dir, 'books.json'));

export interface Move { from: string; to: string }

export interface LayoutPlan {
  /** The repository's root, which held the books. */
  repository: string;
  /** Its vanilla-accounting/. */
  app: string;
  moves: Move[];
  /** The books as read from books.json, at the current schema. */
  books: Index;
  /** invoices.json's PDF paths, old → new (relative to the app's folder). */
  invoicePaths: Map<string, string>;
  /** The logo's path in the manifest, old → new. */
  logo?: Move;
}

const YEAR_NAME = /^\d{4}$/;
const read = (path: string) => readFileSync(path, 'utf8');

/** Every file under `dir`, relative to it (dot files skipped). */
function filesUnder(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => !n.startsWith('.')).sort().flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? filesUnder(full, `${prefix}${n}/`) : [`${prefix}${n}`];
  });
}

/** The last day an ISO 20022 statement in XML covers, else its last booking day. */
function xmlStatementLastDay(text: string): string | undefined {
  const to = [...text.matchAll(/<ToDtTm>(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]).sort().at(-1);
  return to ?? [...text.matchAll(/<BookgDt>\s*<Dt>(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]).sort().at(-1);
}

/** What the migration of `repository` would move. Reads, never writes. */
export function planLayout(repository: string, today = new Date().toISOString().slice(0, 10)): LayoutPlan {
  const app = join(repository, APP_FOLDER);
  const booksFile = join(repository, 'books.json');
  const raw = JSON.parse(read(booksFile)) as Record<string, unknown>;
  const books = climb(raw, schemaOf(raw.schema, booksFile), BOOKS_SCHEMA, BOOKS_MIGRATIONS, booksFile, (d) => structuredClone(d)) as unknown as Index;
  const closedThrough = books.config?.closedThrough;
  // Each record keeps the year of its own date: nothing was in a closed year's files before.
  const place = placement({ ...books, journalEntries: books.journalEntries ?? [] }, books.config, () => true);
  const fallback = openYear(today.slice(0, 4), closedThrough);
  const moves: Move[] = [];
  const to = (year: string, part: 'receipts' | 'statements' | 'filings' | 'invoices' | 'expected', name: string) =>
    relative(repository, join(yearPaths(workspacePaths(app), year)[part], name));

  const top = Object.keys(LAYOUT.top).filter((n) => n !== 'AGENTS.md' && n !== 'CLAUDE.md' && n !== 'master-data' && n !== 'transactional-data');
  for (const name of top) if (existsSync(join(repository, name))) moves.push({ from: name, to: `${APP_FOLDER}/${name}` });
  if (existsSync(join(repository, 'accounts.json'))) moves.push({ from: 'accounts.json', to: `${APP_FOLDER}/master-data/accounts.json` });

  const receiptYear = new Map(books.receipts.map((r) => [r.filename, place.receipt(r)]));
  for (const f of filesUnder(join(repository, 'receipts'))) moves.push({ from: `receipts/${f}`, to: to(receiptYear.get(f) ?? fallback, 'receipts', f) });

  const statementYear = new Map(books.bankStatements.map((s) => [statementFile(s), place.statement(s)]));
  for (const f of filesUnder(join(repository, 'bank-statements'))) {
    const last = f.toLowerCase().endsWith('.xml') ? xmlStatementLastDay(read(join(repository, 'bank-statements', f))) : undefined;
    const year = statementYear.get(f) ?? (last ? openYear(yearOfDate(last), closedThrough) : fallback);
    moves.push({ from: `bank-statements/${f}`, to: to(year, 'statements', f) });
  }

  for (const f of filesUnder(join(repository, 'filings'))) {
    const [year, ...rest] = f.split('/');
    if (YEAR_NAME.test(year) && rest.length) moves.push({ from: `filings/${f}`, to: to(year, 'filings', rest.join('/')) });
  }

  const frozen = existsSync(join(repository, 'golden', 'books.json')) ? JSON.parse(read(join(repository, 'golden', 'books.json'))) as { journalEntries?: { date: string }[] } : undefined;
  const goldenYear = frozen?.journalEntries?.map((e) => e.date).sort().at(-1)?.slice(0, 4) ?? fallback;
  for (const f of filesUnder(join(repository, 'golden'))) moves.push({ from: `golden/${f}`, to: to(goldenYear, 'expected', f) });

  const invoicePaths = new Map<string, string>();
  // On a rerun after a crash invoices.json may lie in the app's folder already.
  const invoicesFile = [join(repository, 'invoices.json'), join(app, 'invoices.json')].find((f) => existsSync(f)) ?? join(repository, 'invoices.json');
  const invoiceBook = existsSync(invoicesFile) ? JSON.parse(read(invoicesFile)) as { invoices?: Array<{ issuedAt?: string; pdf?: { file: string } }>; sent?: Array<{ file: string; sentAt: string }> } : {};
  const docYear = new Map<string, string>([
    ...(invoiceBook.invoices ?? []).flatMap((i) => (i.pdf && i.issuedAt ? [[i.pdf.file, i.issuedAt.slice(0, 4)] as [string, string]] : [])),
    ...(invoiceBook.sent ?? []).map((d) => [d.file, d.sentAt.slice(0, 4)] as [string, string]),
  ]);
  const manifest = read(join(repository, MANIFEST_FILE));
  const logoPath = /logo:\s*([^,}\s]+)/.exec(manifest)?.[1];
  let logo: Move | undefined;
  for (const f of filesUnder(join(repository, 'invoices'))) {
    const old = `invoices/${f}`;
    if (old === logoPath || /^logo[-.]/.test(f)) {
      const move = { from: old, to: `${APP_FOLDER}/logos/${f}` };
      moves.push(move);
      if (old === logoPath) logo = { from: old, to: `logos/${f}` };
      continue;
    }
    moves.push({ from: old, to: to(docYear.get(old) ?? yearOfDate(f.match(/^(\d{4})-/)?.[1] ?? fallback), 'invoices', f) });
  }
  // Every document names its PDF, moved now or by an earlier run.
  for (const [old, year] of docYear) if (old.startsWith('invoices/')) invoicePaths.set(old, relative(APP_FOLDER, to(year, 'invoices', old.slice('invoices/'.length))));
  return { repository, app, moves, books, invoicePaths, logo };
}

export interface LayoutResult {
  moved: Move[];
  /** Already at their new place: a rerun. */
  done: string[];
  /** The copy of books.json kept in data/backups/. */
  backup: string;
}

/**
 * Applies the plan: moves the files (git mv for a tracked file), writes the books by year, points
 * invoices.json and the manifest at the moved PDFs and logo, and removes books.json last. Throws
 * before moving anything if a file exists at both its old and its new place.
 */
export async function applyLayout(plan: LayoutPlan): Promise<LayoutResult> {
  const { repository, app } = plan;
  const at = (p: string) => join(repository, p);
  const both = plan.moves.filter((m) => existsSync(at(m.from)) && existsSync(at(m.to)) && !statSync(at(m.from)).isDirectory());
  if (both.length) throw new Error(`in both places, keep one: ${both.map((m) => `${m.from} and ${m.to}`).join('; ')}`);

  const repo = await repositoryAt(repository);
  const tracked = new Set(repo ? await git.listFiles({ fs, dir: repo }) : []);
  const out: LayoutResult = { moved: [], done: [], backup: '' };
  // The manifest moves last: until it does, the repository still opens as books of the old layout, and a rerun finishes.
  const last = plan.moves.filter((m) => m.from === MANIFEST_FILE);
  for (const m of plan.moves.filter((x) => x.from !== MANIFEST_FILE)) {
    if (!existsSync(at(m.from))) { out.done.push(m.to); continue; }
    if (statSync(at(m.from)).isDirectory()) {
      for (const f of filesUnder(at(m.from))) await move(`${m.from}/${f}`, `${m.to}/${f}`);
      removeEmpty(at(m.from));
    } else {
      await move(m.from, m.to);
    }
    out.moved.push(m);
  }
  async function move(from: string, to: string) {
    if (existsSync(at(to))) return;
    mkdirSync(dirname(at(to)), { recursive: true });
    renameSync(at(from), at(to));
    if (repo && tracked.has(from)) {
      await git.remove({ fs, dir: repo, filepath: from });
      await git.add({ fs, dir: repo, filepath: to });
    }
  }
  for (const dir of ['receipts', 'bank-statements', 'filings', 'golden', 'invoices']) removeEmpty(at(dir));

  const paths = workspacePaths(app);
  const booksFile = at('books.json');
  if (existsSync(booksFile)) writeBooks(paths, { ...plan.books, journalEntries: plan.books.journalEntries ?? [] } as Books);
  if ((plan.invoicePaths.size || plan.logo) && existsSync(paths.invoices)) {
    const book = JSON.parse(read(paths.invoices)) as { invoices?: Array<{ pdf?: { file: string }; layout?: { logo?: string } }>; sent?: Array<{ file: string }> };
    for (const i of book.invoices ?? []) {
      if (i.pdf) i.pdf.file = plan.invoicePaths.get(i.pdf.file) ?? i.pdf.file;
      if (plan.logo && i.layout?.logo === plan.logo.from) i.layout.logo = plan.logo.to;
    }
    for (const d of book.sent ?? []) d.file = plan.invoicePaths.get(d.file) ?? d.file;
    writeFileSync(paths.invoices, JSON.stringify(book, null, 2) + '\n');
  }
  if (plan.logo && existsSync(at(MANIFEST_FILE))) {
    const text = read(at(MANIFEST_FILE));
    writeFileSync(at(MANIFEST_FILE), text.replace(`logo: ${plan.logo.from}`, `logo: ${plan.logo.to}`));
  }
  for (const m of last) {
    if (existsSync(at(m.from))) { await move(m.from, m.to); out.moved.push(m); } else out.done.push(m.to);
  }

  if (existsSync(booksFile)) {
    const backups = join(paths.data, 'backups');
    mkdirSync(backups, { recursive: true });
    out.backup = join(backups, `books.json.schema-${(JSON.parse(read(booksFile)) as { schema?: number }).schema ?? 'none'}`);
    if (!existsSync(out.backup)) copyFileSync(booksFile, out.backup);
    if (repo && tracked.has('books.json')) await git.remove({ fs, dir: repo, filepath: 'books.json' });
    fs.rmSync(booksFile);
  }
  if (repo) await git.add({ fs, dir: repo, filepath: relative(repo, paths.ledger) });
  if (repo && existsSync(paths.transactional)) for (const f of filesUnder(paths.transactional)) {
    if (f.includes('/books/')) await git.add({ fs, dir: repo, filepath: relative(repo, join(paths.transactional, f)) });
  }
  return out;
}

/** Removes `dir` and the empty folders in it, bottom up; a folder holding a file stays. */
function removeEmpty(dir: string): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const n of readdirSync(dir)) removeEmpty(join(dir, n));
  const rest = readdirSync(dir);
  if (rest.every((n) => n === '.gitkeep' || n === '.DS_Store')) {
    for (const n of rest) fs.rmSync(join(dir, n));
    rmdirSync(dir);
  }
}
