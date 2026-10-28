/**
 * The one owner of "where is the data". A workspace is the app's folder (vanilla-accounting/) in
 * one company's repository, holding its books, receipts, statements and filings, found by its
 * belege.workspace.yaml; its layout is LAYOUT (ADR 0013). The app's own
 * files (processes/, reference/, src/server/scan.html) are found from APP_ROOT, never the cwd.
 */
import type { ApiRefusal } from '../types/api-error.js';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { readManifest } from './manifest.js';
import { workspaceModules } from '../core/modules/load.js';
import { filing, setJurisdiction } from '../engines/index.js';
import type { FilingLength } from '../accounting/periods.js';
import type { LegalForm, Preset, QuestionKey, SupportedAnswers, VatQuestionKey } from './setup.js';
import type { VatSetup } from './vat-setup.js';
import type { Iban, MoneyRole, StatementKind } from './banks.js';
import type { Address, InvoicingSettings, OutgoingMail } from '../invoices/model.js';
import type { Dimension } from '../books/tags.js';

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
  /** Where the company is: printed on its invoices as sender (Art. 26 MWSTG). */
  address?: Address;
  /** Not registered, or registered on the effective or the net tax rate method, with its filing period (src/workspace/vat-setup.ts). */
  vat: VatSetup;
}

/** The questions of the company's VAT setup live on Company.vat; the rest of the answers here. */
export type ProfileKey = Exclude<QuestionKey, 'legalForm' | VatQuestionKey>;

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
/**
 * A money account (#88): a ledger account money sits on or is owed through. Every one is equal:
 * any of them takes movements from receipts, answers and hand entries, and statement imports
 * when a reader exists and the person has them.
 */
export interface LedgerBankAccount {
  /** The account's label: the statements folder, and the `bank` of every movement on it; `manual` is the owner's. */
  bank: string;
  currency: string;
  account: string;
  label: string;
  role: MoneyRole;
  /** How this account's statements are read when imported: from the manifest, else the bank registry; absent when no reader exists. */
  statements?: StatementKind;
  /** The account's IBAN; on an owner's or employee's account their own, so a bank payment to it is known as theirs. */
  iban?: Iban;
}

/**
 * The app's folder in the company's repository (ADR 0013): the workspace of Vanilla Accounting.
 * The repository's root holds its git and agent files, the apps' folders, master-data/ (shared by
 * apps, reserved) and own/ (the company's files no app reads).
 */
export const APP_FOLDER = 'vanilla-accounting';

/** Who writes a name of the workspace: the app (a person changes it only through the app), or the company (a person adds it, the app reads it). */
export type Owner = 'app' | 'company';

/**
 * The one list of the names the app's folder may hold (ADR 0013), each with its owner: at its
 * top level, in its master-data/ and in a year folder of transactional-data/. The workspace
 * check names everything else; the migration, the leak guard and the audit export read it too.
 */
export const LAYOUT = {
  top: {
    'belege.workspace.yaml': 'company', 'mail.yaml': 'company', 'secret-terms.txt': 'company', 'AGENTS.md': 'company', 'CLAUDE.md': 'company',
    knowledge: 'company', modules: 'company', workflows: 'company', sources: 'company', 'beleg-import': 'company', history: 'company',
    VERSION: 'app', collected: 'app', 'ledger.json': 'app', 'invoices.json': 'app', 'onboarding.json': 'app', logos: 'app', data: 'app', output: 'app', 'master-data': 'app', 'transactional-data': 'app',
  },
  masterData: { 'accounts.json': 'company' },
  year: { books: 'app', filings: 'app', invoices: 'app', expected: 'app', 'runs.jsonl': 'app', 'questions.jsonl': 'app', receipts: 'company', 'bank-statements': 'company' },
} as const satisfies Record<string, Record<string, Owner>>;

/** The names a company repository's root holds besides the apps' folders: git and agent files, the shared master-data/, own/. */
export const REPOSITORY_ROOT = new Set([
  '.git', '.gitignore', '.gitattributes', '.github', '.env', '.DS_Store', '.claude', '.agents', '.codex', '.cursor', '.vscode',
  'AGENTS.md', 'CLAUDE.md', 'README.md', 'master-data', 'own',
]);

/** A fiscal year's folder in transactional-data/: four digits. */
export const YEAR_FOLDER = /^\d{4}$/;

/** Fixed layout (ADR 0013). No path is configurable, so there is one way to find each thing. */
export interface WorkspacePaths {
  /** The app's folder, vanilla-accounting/ of the company's repository. */
  root: string;
  /** The company's repository holding the app's folder; the app's folder itself when it lies alone. */
  repository: string;
  manifest: string;
  /** closedThrough and the rest of the books' config, and the books' schema (src/books/store.ts). */
  ledger: string;
  inbox: string;
  history: string;
  data: string;
  /** Mailboxes receipts are collected from and how their senders are sorted (src/collect/mail-config.ts). */
  mail: string;
  /** Terms the leak guard treats as secret that no file of the books names (src/publish/leak-guard.ts). */
  secretTerms: string;
  /** Customers, invoices, sent documents (src/invoices/store.ts). */
  invoices: string;
  /** The logos of the invoice layout, logo-<checksum>.<ext>. */
  logos: string;
  masterData: string;
  /** The chart of accounts. */
  accounts: string;
  /** One folder per fiscal year (yearPaths). */
  transactional: string;
}

/** The folders of one fiscal year in transactional-data/<year>/. */
export interface YearPaths {
  year: string;
  root: string;
  /** entries.jsonl, transactions.jsonl, mappings.jsonl, receipts.jsonl, statements.jsonl, balances.jsonl, asks.jsonl (src/books/store.ts). */
  books: string;
  receipts: string;
  /** bank-statements/<bank>/ */
  statements: string;
  /** VAT returns as filed, seals, year-close.json. */
  filings: string;
  /** The PDFs of issued invoices (<number>.pdf), and of sent reminders and notices (sent/<id>.pdf). */
  invoices: string;
  /** The figures npm run test:books compares the books against. */
  expected: string;
  /** The run log: one line per event of a run that wrote, waited for a person, got stuck or was discarded (src/workflows/runlog.ts). */
  runLog: string;
  /** The questions between the people who keep the books and their answers, one event per line (src/questions/model.ts QuestionLine). */
  questions: string;
}

export interface Workspace {
  readonly company: Company;
  /** How long one filing period of these books is (the firm's, else the jurisdiction's): what the seals and the year close count by. */
  readonly filingLength: FilingLength;
  readonly bankAccounts: readonly LedgerBankAccount[];
  /** Absent in a workspace set up before `npm run init` existed. */
  readonly profile?: WorkspaceProfile;
  /** Absent until the company writes invoices (the manifest's invoicing block). */
  readonly invoicing?: InvoicingSettings;
  /** Absent until the company sends documents by e-mail (the manifest's outgoingMail block). */
  readonly outgoingMail?: OutgoingMail;
  /** The reporting dimensions bookings may carry a tag of (#127, src/books/tags.ts); absent: none. */
  readonly dimensions?: readonly Dimension[];
  readonly paths: WorkspacePaths;
}

export class WorkspaceError extends Error {}
/** A manifest refusal the UI says in the person's words: the API maps `refusal` to its error body. */
export class WorkspaceRefusal extends WorkspaceError {
  constructor(message: string, readonly refusal: ApiRefusal) { super(message); }
}

export function workspacePaths(root: string): WorkspacePaths {
  const masterData = join(root, 'master-data');
  return {
    root,
    repository: basename(root) === APP_FOLDER ? dirname(root) : root,
    manifest: join(root, MANIFEST_FILE),
    ledger: join(root, 'ledger.json'),
    inbox: join(root, 'beleg-import'),
    history: join(root, 'history'),
    data: join(root, 'data'),
    mail: join(root, 'mail.yaml'),
    secretTerms: join(root, 'secret-terms.txt'),
    invoices: join(root, 'invoices.json'),
    logos: join(root, 'logos'),
    masterData,
    accounts: join(masterData, 'accounts.json'),
    transactional: join(root, 'transactional-data'),
  };
}

export function yearPaths(paths: Pick<WorkspacePaths, 'transactional'>, year: string): YearPaths {
  if (!YEAR_FOLDER.test(year)) throw new Error(`not a fiscal year: ${year}`);
  const root = join(paths.transactional, year);
  return {
    year, root,
    books: join(root, 'books'),
    receipts: join(root, 'receipts'),
    statements: join(root, 'bank-statements'),
    filings: join(root, 'filings'),
    invoices: join(root, 'invoices'),
    expected: join(root, 'expected'),
    runLog: join(root, 'runs.jsonl'),
    questions: join(root, 'questions.jsonl'),
  };
}

/** The fiscal years the workspace has a folder for, oldest first. */
export function yearsOf(paths: Pick<WorkspacePaths, 'transactional'>): string[] {
  if (!existsSync(paths.transactional)) return [];
  return readdirSync(paths.transactional, { withFileTypes: true }).filter((d) => d.isDirectory() && YEAR_FOLDER.test(d.name)).map((d) => d.name).sort();
}

/** A part's folder in every year folder that has one, oldest year first. */
export function partDirs(paths: Pick<WorkspacePaths, 'transactional'>, part: Exclude<keyof YearPaths, 'year' | 'root'>): string[] {
  return yearsOf(paths).map((y) => yearPaths(paths, y)[part]).filter((d) => existsSync(d));
}

/** A file name that lies in two year folders: which one a record means is not clear. */
export class DuplicateFileError extends Error {}

type FilePart = 'receipts' | 'statements' | 'invoices';

/**
 * The path of the file `name` (relative to its part's folder, as `x.pdf` or `Wise/y.pdf`) in the
 * year folders; undefined when none holds it. Throws DuplicateFileError when two do.
 */
export function findFile(paths: WorkspacePaths, part: FilePart, name: string): string | undefined {
  const found = yearsOf(paths).map((y) => join(yearPaths(paths, y)[part], name)).filter((p) => existsSync(p));
  if (found.length > 1) throw new DuplicateFileError(`${name} lies in ${found.map((p) => relative(paths.root, p)).join(' and ')}: keep one.`);
  return found[0];
}

/** Every file of a part in every year folder, as [name relative to the part's folder, full path], recursively. */
export function filesOfPart(paths: WorkspacePaths, part: FilePart): Array<[string, string]> {
  const walk = (dir: string, prefix: string): Array<[string, string]> => existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e): Array<[string, string]> => {
      if (e.name.startsWith('.')) return [];
      const full = join(dir, e.name);
      return e.isDirectory() ? walk(full, `${prefix}${e.name}/`) : [[`${prefix}${e.name}`, full]];
    })
    : [];
  return yearsOf(paths).flatMap((y) => walk(yearPaths(paths, y)[part], ''));
}

/** The app's folder `dir` names: `dir` itself when it holds the manifest, else its vanilla-accounting/ when that does. */
export function appFolderIn(dir: string): string | undefined {
  if (existsSync(join(dir, MANIFEST_FILE))) return dir;
  if (existsSync(join(dir, APP_FOLDER, MANIFEST_FILE))) return join(dir, APP_FOLDER);
  return undefined;
}

/** The workspace whose manifest is in `root`; from now on the engines compute with its jurisdiction (modules/ch with its overlay) and its VAT setup. */
export function workspaceAt(root: string): Workspace {
  const paths = workspacePaths(appFolderIn(resolve(root)) ?? resolve(root));
  const manifest = readManifest(paths.manifest);
  setJurisdiction(workspaceModules(APP_ROOT, paths.root, manifest.company.vat).effective, manifest.company.vat);
  return { ...manifest, filingLength: filing().length, paths };
}

/**
 * Resolution, first hit wins; a directory counts when it holds the manifest or its
 * vanilla-accounting/ does (appFolderIn):
 *   1. VANILLA_WORKSPACE (or the deprecated BELEGE_WORKSPACE; "demo" or "demo-<name>" means that demo under APP_ROOT, a leading ~ is
 *      the home directory), from
 *      the environment or else from the app's own .env (an empty value skips both)
 *   2. walking up from the cwd to the first such directory
 * Memoized: every CLI and the API resolve it once per process, and books the desktop app opened
 * first (openWorkspaceAt) are the ones it returns. `locate` finds the root when nothing is open yet.
 */
export function openWorkspace(locate: () => string = locateWorkspace): Workspace {
  return (opened ??= workspaceAt(locate()));
}
let opened: Workspace | undefined;

/** Opens the workspace in `root` for the rest of the process: the desktop app switches books without a restart (src/desktop). */
export function openWorkspaceAt(root: string): Workspace {
  return (opened = workspaceAt(root));
}

/** The languages the UI speaks: one dictionary each in src/app/i18n/locales/ (docs/i18n.md). */
export function appLanguages(): string[] {
  return readdirSync(join(APP_ROOT, 'src/app/i18n/locales')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort();
}

/** The demo repositories the app ships (tools/demo/generate.ts): demo/, demo-consulting/, …, each with its vanilla-accounting/. */
export const DEMO_NAME = /^demo(-[a-z0-9]+)*$/;

/** Where openWorkspace() would open, without opening it. */
export function locateWorkspace(): string {
  const env = workspaceVar(process.env) ?? workspaceFromAppEnv();
  if (env) {
    const dir = DEMO_NAME.test(env) ? join(APP_ROOT, env) : resolve(env.replace(/^~(?=$|\/)/, homedir()));
    const root = appFolderIn(dir);
    if (!root) throw new WorkspaceError(`VANILLA_WORKSPACE=${env}: no ${MANIFEST_FILE} in ${dir} or its ${APP_FOLDER}/.`);
    return realpathSync(root);
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const root = appFolderIn(dir);
    if (root) return root;
    if (dirname(dir) === dir) break;
  }
  throw new WorkspaceError(
    `No workspace: set VANILLA_WORKSPACE to a company repository (or its ${APP_FOLDER}/ folder), or run from inside one.`,
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
