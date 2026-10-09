/**
 * The one owner of "where is the data". A workspace is the directory holding one company's
 * books, receipts, statements and filings, found by its belege.workspace.yaml. The app's own
 * files (processes/, reference/, src/server/scan.html) are found from APP_ROOT, never the cwd.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { readManifest } from './manifest.js';
import type { LegalForm, Preset, QuestionKey, SupportedAnswers } from './setup.js';
import type { Iban, StatementKind } from './banks.js';

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };
/** CHE-###.###.###, parsed at the manifest boundary. */
export type Uid = Brand<string, 'Uid'>;

export const APP_ROOT: string = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** Public reference data shipped with the app: VAT codes, ESTV daily rates. */
export const REFERENCE_DIR = join(APP_ROOT, 'reference');
export const MANIFEST_FILE = 'belege.workspace.yaml';

export interface Company {
  name: string;
  uid: Uid;
  owner: string;
  /** What the company does, in a few words: context for prompts that judge business vs. private. */
  business?: string;
  legalForm?: LegalForm;
  /** The language of the app's UI and of the questions agents ask the owner (appLanguages()); German when absent. */
  language?: string;
  /** Registered, effective method, cash basis, quarterly: the only setup the engine supports. */
  vat: { method: 'effective'; reporting: 'received' };
}

/** The questions of the company's VAT setup live on Company.vat; the rest of the answers here. */
export type ProfileKey = Exclude<QuestionKey, 'legalForm' | 'vatRegistered' | 'vatMethod' | 'basis' | 'period'>;

/** How the company works, as `npm run init` asked it (src/workspace/setup.ts): context for doctor and agents. */
export type WorkspaceProfile = Pick<SupportedAnswers, ProfileKey> & {
  preset: Preset;
  /** Where the books go at year-end: accounting software or a Treuhand. */
  exportTo?: string;
};

/**
 * A ledger account money moves through, keyed by the `bank` + `currency` of a BankTransaction.
 * A statement lands on the account whose `iban` and currency it names, else on the account of
 * its folder (bank-statements/<bank>/) and currency (src/accounting/bank-accounts.ts).
 */
export interface LedgerBankAccount {
  /** The bank's label: the statements folder, and the `bank` of every transaction booked here. */
  bank: string;
  currency: string;
  account: string;
  label: string;
  /** How this account's statements are read: from the manifest, else the bank registry; absent for `manual`. */
  statements?: StatementKind;
  iban?: Iban;
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
  /** Absent in a workspace set up before `npm run init` existed. */
  readonly profile?: WorkspaceProfile;
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
 *   1. VANILLA_WORKSPACE (or the deprecated BELEGE_WORKSPACE; "demo" or "demo-<name>" means that demo under APP_ROOT, a leading ~ is
 *      the home directory), from
 *      the environment or else from the app's own .env (an empty value skips both)
 *   2. walking up from the cwd to the first directory holding a belege.workspace.yaml
 * Memoized: every CLI and the API resolve it once per process.
 */
export function openWorkspace(): Workspace {
  return (opened ??= workspaceAt(locate()));
}
let opened: Workspace | undefined;

/** The languages the UI speaks: one dictionary each in src/app/i18n/locales/ (docs/i18n.md). */
export function appLanguages(): string[] {
  return readdirSync(join(APP_ROOT, 'src/app/i18n/locales')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort();
}

/** The demo workspaces the app ships (tools/demo/generate.ts): demo/, demo-consulting/, … */
export const DEMO_NAME = /^demo(-[a-z0-9]+)*$/;

function locate(): string {
  const env = workspaceVar(process.env) ?? workspaceFromAppEnv();
  if (env) {
    const root = DEMO_NAME.test(env) ? join(APP_ROOT, env) : resolve(env.replace(/^~(?=$|\/)/, homedir()));
    if (!existsSync(join(root, MANIFEST_FILE))) {
      throw new WorkspaceError(`VANILLA_WORKSPACE=${env}: no ${MANIFEST_FILE} in ${root}.`);
    }
    return realpathSync(root);
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, MANIFEST_FILE))) return dir;
    if (dirname(dir) === dir) break;
  }
  throw new WorkspaceError(
    `No workspace: set VANILLA_WORKSPACE to a directory holding ${MANIFEST_FILE}, or run from inside one.`,
  );
}

/** VANILLA_WORKSPACE as the app's .env sets it, so every npm script finds the books without exporting it. */
function workspaceFromAppEnv(): string | undefined {
  const file = join(APP_ROOT, '.env');
  return existsSync(file) ? workspaceVar(parseEnv(readFileSync(file, 'utf8'))) : undefined;
}

/** VANILLA_WORKSPACE of one source, else its deprecated name BELEGE_WORKSPACE (with a note). */
function workspaceVar(vars: Record<string, string | undefined>): string | undefined {
  if (vars.VANILLA_WORKSPACE !== undefined || vars.BELEGE_WORKSPACE === undefined) return vars.VANILLA_WORKSPACE;
  console.error('Note: BELEGE_WORKSPACE is deprecated; rename it to VANILLA_WORKSPACE (in the app\'s .env or your shell).');
  return vars.BELEGE_WORKSPACE;
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
