/**
 * The one owner of "where is the data". A workspace is the directory holding one company's
 * books, receipts, statements and filings, found by its belege.workspace.yaml. The app's own
 * files (processes/, reference/, src/server/scan.html) are found from APP_ROOT, never the cwd.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readManifest } from './manifest.js';

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };
/** CHE-###.###.###, parsed at the manifest boundary. */
export type Uid = Brand<string, 'Uid'>;

export const APP_ROOT: string = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** Public reference data shipped with the app: VAT codes, ESTV daily rates. */
export const REFERENCE_DIR = join(APP_ROOT, 'reference');
export const MANIFEST_FILE = 'belege.workspace.yaml';
export const WORKSPACE_SCHEMA = 1;

export interface Company {
  name: string;
  uid: Uid;
  owner: string;
  /** What the company does, in a few words: context for prompts that judge business vs. private. */
  business?: string;
  /** Cash basis on the effective method: the only combination the engine supports. */
  vat: { method: 'effective'; reporting: 'received' };
}

/** A ledger account money moves through, keyed by the `bank` + `currency` of a BankTransaction. */
export interface LedgerBankAccount {
  bank: string;
  currency: string;
  account: string;
  label: string;
  /** The statement format this account's transactions are imported from; absent for manual. */
  statements?: 'camt053' | 'wise';
}

/** Fixed layout. No path is configurable, so there is one way to find each thing. */
export interface WorkspacePaths {
  root: string;
  manifest: string;
  books: string;
  receipts: string;
  inbox: string;
  statements: string;
  filings: string;
  accounts: string;
  history: string;
  data: string;
  /** Mailboxes receipts are collected from and how their senders are sorted (src/collect/mail-config.ts). */
  mail: string;
  /** Terms the leak guard treats as secret that no file of the books names (src/publish/leak-guard.ts). */
  secretTerms: string;
}

export interface Workspace {
  readonly company: Company;
  readonly bankAccounts: readonly LedgerBankAccount[];
  readonly paths: WorkspacePaths;
}

export class WorkspaceError extends Error {}

export function workspacePaths(root: string): WorkspacePaths {
  return {
    root,
    manifest: join(root, MANIFEST_FILE),
    books: join(root, 'books.json'),
    receipts: join(root, 'receipts'),
    inbox: join(root, 'beleg-import'),
    statements: join(root, 'bank-statements'),
    filings: join(root, 'filings'),
    accounts: join(root, 'accounts.json'),
    history: join(root, 'history'),
    data: join(root, 'data'),
    mail: join(root, 'mail.yaml'),
    secretTerms: join(root, 'secret-terms.txt'),
  };
}

/** The workspace whose manifest is in `root`. */
export function workspaceAt(root: string): Workspace {
  const paths = workspacePaths(resolve(root));
  return { ...readManifest(paths.manifest), paths };
}

/**
 * Resolution, first hit wins:
 *   1. BELEGE_WORKSPACE ("demo" means APP_ROOT/demo, a leading ~ is the home directory)
 *   2. walking up from the cwd to the first directory holding a belege.workspace.yaml
 * Memoized: every CLI and the API resolve it once per process.
 */
export function openWorkspace(): Workspace {
  return (opened ??= workspaceAt(locate()));
}
let opened: Workspace | undefined;

function locate(): string {
  const env = process.env.BELEGE_WORKSPACE;
  if (env) {
    const root = env === 'demo' ? join(APP_ROOT, 'demo') : resolve(env.replace(/^~(?=$|\/)/, homedir()));
    if (!existsSync(join(root, MANIFEST_FILE))) {
      throw new WorkspaceError(`BELEGE_WORKSPACE=${env}: no ${MANIFEST_FILE} in ${root}.`);
    }
    return realpathSync(root);
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, MANIFEST_FILE))) return dir;
    if (dirname(dir) === dir) break;
  }
  throw new WorkspaceError(
    `No workspace: set BELEGE_WORKSPACE to a directory holding ${MANIFEST_FILE}, or run from inside one.`,
  );
}

/**
 * The company's identity literals found in `source`: its name (any case), its UID, or the UID's
 * bare digits. App code holds none of them; it reads openWorkspace().company.
 */
export function identityIn(source: string, company: Company): string[] {
  const digits = company.uid.replace(/\D/g, '');
  return [
    source.toLowerCase().includes(company.name.toLowerCase()) && company.name,
    source.includes(company.uid) && company.uid,
    new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(source) && digits,
  ].filter((x): x is string => !!x);
}
