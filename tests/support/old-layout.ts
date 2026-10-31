/** A workspace in the layout before ADR 0013, made from a demo: what an adopter of 0.3 has on disk. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks } from '../../src/books/store.js';
import { MANIFEST_FILE, partDirs, workspaceAt, yearPaths, yearsOf } from '../../src/workspace/workspace.js';

/**
 * Writes the books of the workspace `app` into `repo` the way 0.3 kept them: everything at the
 * root, one books.json without schema, receipts/, bank-statements/, filings/<year>/, invoices/
 * with the logo, golden/ from `golden` when given.
 */
export function writeOldLayout(app: string, repo: string, golden?: string): void {
  const ws = workspaceAt(app);
  const { schema: _, ...books } = loadBooks(ws);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'books.json'), JSON.stringify(books, null, 2));
  writeFileSync(join(repo, MANIFEST_FILE), readFileSync(ws.paths.manifest, 'utf8').replace('logo: logos/', 'logo: invoices/'));
  cpSync(ws.paths.accounts, join(repo, 'accounts.json'));
  cpSync(join(app, 'knowledge'), join(repo, 'knowledge'), { recursive: true });
  if (existsSync(ws.paths.invoices)) {
    const text = readFileSync(ws.paths.invoices, 'utf8').replace(/transactional-data\/\d{4}\/invoices\//g, 'invoices/').replace(/"logos\//g, '"invoices/');
    writeFileSync(join(repo, 'invoices.json'), text);
  }
  for (const year of yearsOf(ws.paths)) {
    const y = yearPaths(ws.paths, year);
    for (const [from, to] of [[y.receipts, 'receipts'], [y.statements, 'bank-statements'], [y.invoices, 'invoices'], [y.filings, `filings/${year}`]] as const) {
      if (existsSync(from)) cpSync(from, join(repo, to), { recursive: true });
    }
  }
  if (existsSync(ws.paths.logos)) for (const f of readdirSync(ws.paths.logos)) cpSync(join(ws.paths.logos, f), join(repo, 'invoices', f));
  if (golden) cpSync(golden, join(repo, 'golden'), { recursive: true });
  else for (const dir of partDirs(ws.paths, 'expected')) cpSync(dir, join(repo, 'golden'), { recursive: true });
}
