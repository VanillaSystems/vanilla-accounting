/**
 * Nothing the app ships for testing (tests/, demo/) may carry the real company's data: its name,
 * UID, IBANs, receipt ids or transaction refs. The secrets are read from the company workspace
 * at run time, so this file names none of them. Skipped where there is no such workspace (the
 * public repo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Index } from '../src/types/index.js';
import { APP_ROOT, identityIn, type Workspace } from '../src/workspace/workspace.js';
import { companyWorkspace, DEMO_ROOT } from './support/workspace.js';

const SCANNED = [join(APP_ROOT, 'tests'), DEMO_ROOT];
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
}

/** The company's identifiers other than its name and UID, by kind. */
function secretsOf(ws: Workspace): Map<string, string> {
  const books = JSON.parse(readFileSync(ws.paths.books, 'utf8')) as Index;
  const secrets = new Map<string, string>();
  for (const r of books.receipts) secrets.set(r.id, 'receipt id');
  // The app numbers manual transactions M<year>-<nnn> in every workspace, so those identify no one.
  for (const t of books.transactions) if (!/^M\d{4}-\d{3}$/.test(t.ref)) secrets.set(t.ref, 'transaction ref');
  const statements = existsSync(ws.paths.statements) ? filesUnder(ws.paths.statements) : [];
  const ibanSources = [
    ...books.bankStatements.map((s) => s.filename),
    ...statements.map((f) => f.endsWith('.xml') ? readFileSync(f, 'utf8').match(/<IBAN>[^<]+<\/IBAN>/g)?.join(' ') ?? '' : f),
  ];
  for (const iban of ibanSources.flatMap((s) => s.match(IBAN) ?? [])) secrets.set(iban, 'IBAN');
  return secrets;
}

const ws = companyWorkspace();

test('tests/ and demo/ carry none of the company workspace\'s identifiers', { skip: ws ? false : 'no company workspace in this checkout' }, () => {
  const secrets = secretsOf(ws!);
  assert.ok(secrets.size > 0, 'the company books list receipts and transactions');
  const found: string[] = [];
  for (const file of SCANNED.flatMap(filesUnder)) {
    const text = readFileSync(file, 'latin1');
    const where = relative(APP_ROOT, file);
    for (const hit of identityIn(text, ws!.company)) found.push(`${where}: company identity ${hit}`);
    for (const [secret, kind] of secrets) if (text.includes(secret)) found.push(`${where}: ${kind} ${secret}`);
  }
  assert.deepEqual(found, []);
});
