/**
 * A new workspace as files: `planWorkspace` turns the init answers into every directory and file
 * (pure), `applyPlan` writes what is missing and never overwrites. The manifest is written last,
 * so a run that stopped halfway has none and the next run fills in the rest.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { stringify } from 'yaml';
import { bankKind, type Iban } from './banks.js';
import { chartFor, type Chart, type WorkspaceAccount } from './chart.js';
import type { Preset, SupportedAnswers } from './setup.js';
import { BOOKS_SCHEMA, WORKSPACE_SCHEMA } from './schema.js';
import { APP_FOLDER, APP_ROOT, MANIFEST_FILE, type LedgerBankAccount, type Uid, type WorkspaceProfile } from './workspace.js';
import { loadJurisdiction } from '../core/modules/load.js';

/** The shipped jurisdiction a new workspace starts from (no workspace, so no overlay yet). */
const ch = () => loadJurisdiction(APP_ROOT, 'ch').jurisdiction;

/** The ledger account a new bank account books on: the chart's for its currency while free, else the next free one. */
export function suggestAccount(bank: string, currency: string, taken: ReadonlySet<string>): string {
  const range = bankKind(bank).range;
  const { byCurrency, nextFree } = ch().setup.bankAccounts;
  const preferred = range === 'bank' ? byCurrency[currency] : undefined;
  if (preferred && !taken.has(preferred)) return preferred;
  for (let n = nextFree[range]; ; n++) if (!taken.has(String(n))) return String(n);
}

export interface InitInput {
  name: string;
  uid: Uid;
  owner: string;
  business?: string;
  /** The UI language (appLanguages()); German when absent. */
  language?: string;
  preset: Preset;
  answers: SupportedAnswers;
  banks: { bank: string; currency: string; account: string; iban?: Iban }[];
  exportTo?: string;
}

export interface Plan {
  dirs: string[];
  /** Relative path → content, in write order: the manifest last. */
  files: [string, string][];
}

/** The owner's private payments: a current account (GmbH, AG) or the private account (Einzelfirma). */
function ownerAccount(input: InitInput): LedgerBankAccount {
  const { setup, manifest } = ch();
  const owner = setup.owner[input.answers.legalForm] ?? setup.owner.otherwise;
  return { bank: 'manual', currency: manifest.baseCurrency, account: owner.account, label: `${owner.label} ${input.owner}` };
}

export function bankAccountsOf(input: InitInput): LedgerBankAccount[] {
  const banks = input.banks.map((b): LedgerBankAccount => {
    const { statements } = bankKind(b.bank);
    return { bank: b.bank, currency: b.currency, account: b.account, label: `${b.bank} ${b.currency}`, ...(statements ? { statements } : {}), ...(b.iban ? { iban: b.iban } : {}) };
  });
  return input.answers.ownerPaysPrivately === 'yes' ? [...banks, ownerAccount(input)] : banks;
}

/** The chart of the profile and legal form, plus what the answers need, with the bank accounts named after their bank. */
export function accountsOf(input: InitInput, chart: Chart): WorkspaceAccount[] {
  const { sells, legalForm, payouts, imports } = input.answers;
  const { answers, bankAccounts } = ch().setup;
  const extra = new Set([...(payouts === 'yes' ? answers.payouts : []), ...(imports === 'yes' ? answers.imports : [])]);
  const base = chartFor(chart, sells, legalForm);
  const byNumber = new Map(base.map((a) => [a.number, a]));
  for (const a of chartFor(chart, 'both', legalForm)) if (extra.has(a.number)) byNumber.set(a.number, a);
  for (const b of bankAccountsOf(input)) {
    const added = bankAccounts.byClass[b.account[0]] ?? bankAccounts.byClass.otherwise;
    const known = byNumber.get(b.account);
    byNumber.set(b.account, known && b.bank === 'manual'
      ? known
      : { number: b.account, name: b.label, type: added.type, line: known?.line ?? added.line });
  }
  return [...byNumber.values()].sort((a, b) => a.number.localeCompare(b.number));
}

function manifestYaml(input: InitInput, bankAccounts: LedgerBankAccount[]): string {
  const { legalForm, vatRegistered: _r, vatMethod: _m, basis: _b, period: _p, ...answers } = input.answers;
  const profile: WorkspaceProfile = { preset: input.preset, ...answers, ...(input.exportTo ? { exportTo: input.exportTo } : {}) };
  const doc = {
    schema: WORKSPACE_SCHEMA,
    company: {
      name: input.name,
      uid: input.uid,
      owner: input.owner,
      ...(input.business ? { business: input.business } : {}),
      ...(input.language ? { language: input.language } : {}),
      legalForm,
      vat: { registered: true, method: 'effective', reporting: 'received', period: 'quarterly' },
    },
    profile,
    bankAccounts,
  };
  return '# Who the company is, how it works, and which ledger account each bank books on.\n'
    + '# Written by npm run init; checked by npm run doctor. Edit by hand when something changes.\n'
    + stringify(doc, { flowCollectionPadding: true });
}

const GITIGNORE = `.env
data/
beleg-import/
.DS_Store
.llm-concurrency.json
`;

/**
 * Two people who keep the books append to the same questions file in their clones; git keeps
 * both sides' lines instead of a conflict (src/questions/store.ts: append-only, folded by id).
 */
export const GITATTRIBUTES = `${APP_FOLDER}/transactional-data/*/questions.jsonl merge=union
`;

const SOURCES_README = `# Sources

Each folder here is a place the app collects documents from (ADR 0014 of the app): a mailbox, a
vendor's portal, an API. A mailbox needs no code; it binds the app's IMAP source:

\`\`\`yaml
# sources/work/source.yaml
label: Business
code: app:imap
settings:
  boxes: [{ label: Business, address: you@example.com }]
reach:
  mail: { host: imap.example.com, account: you@example.com, from: ["*"] }
feeds:
  attachments: { output: document, every: daily }
\`\`\`

The password goes into the keychain, never here: npm run secret -- source:work:mail. Firma ›
Quellen shows each source, and a new one runs once you switch it on there.
`;

/** Commented templates, one per knowledge folder. A file starting with _ is never read as knowledge. */
const KNOWLEDGE_TEMPLATES: [string, string][] = [
  ['knowledge/suppliers/_example.yaml', `# A supplier: one file per business you buy from, named <id>.yaml (copy this file).
# The app ships public files for common suppliers in its processes/suppliers/; a file here with
# the same id adds your accounts and rules to it (then leave out name and match).
#
# id: muster-druck                # = the file name
# name: Muster Druck AG
# match:                          # how a receipt or bank line is recognised, strongest first
#   uid: []                      # its Swiss UID (CHE-…), only if no other business prints it
#   tx: ["muster druck"]          # part of the bank text
#   file: ['^\\d{8}-muster-druck'] # archived file name
# accounts: ["6600"]              # the only accounts its entries may use
# roles: [customer]               # only if it is also a customer or an authority
# steps:
#   booking.guide.yaml#classify:
#     rules:
#       - id: muster-druck-flyer
#         when: a Muster Druck invoice for flyers
#         then: 6600 Werbung, I81 when the invoice shows Swiss MWST
#         source: decision 2026-01-15, owner
`],
  ['knowledge/customers/_example.yaml', `# A customer: one file per business that pays you and needs its own rules (copy this file).
#
# id: beispiel-kunde
# name: Beispiel Kunde AG
# match:
#   tx: ["beispiel kunde"]
# accounts: ["3400"]
# steps:
#   booking.guide.yaml#classify:
#     rules:
#       - id: beispiel-kunde-retainer
#         when: the monthly payment of Beispiel Kunde AG
#         then: 3400 Ertrag Beratung, V81 (a Swiss customer)
#         source: decision 2026-01-15, owner
`],
  ['knowledge/authorities/_example.yaml', `# An authority: the app ships public files for the ESTV, the Ausgleichskasse, the cantonal
# tax office and the BAZG in its processes/authorities/. A file here with the same id adds your
# accounts and rules, e.g. your own Ausgleichskasse's bank text:
#
# id: ausgleichskasse
# match:
#   tx: ["sva zuerich"]
# accounts: ["2270", "5700"]
`],
  ['knowledge/rules/_example.guide.yaml', `# Your company's rules for one process, next to the app's processes/<process>.guide.yaml.
# Name the file like the app's guide (booking.guide.yaml) and use its step ids.
#
# A rule whose then is a map is carried out by the app (AGENTS.md, "Rules the app carries out"):
#
# steps:
#   classify:
#     rules:
#       - id: own-coffee
#         when: { text: "Kaffee Bar" }
#         then: { account: "6500", vat: I81 }
#         source: decision 2026-01-15, owner
#     precedents: []
`],
];

function agentsMd(input: InitInput, appRel: string): string {
  return `# ${input.name}: the company's repository (private)

This repository holds the company's data, not the code. Each app has its own folder; the books of
Vanilla Accounting are in \`vanilla-accounting/\`: \`belege.workspace.yaml\` (who the company is, how
it works, which ledger account each bank books on), \`knowledge/\` (suppliers, customers,
authorities, rules), \`mail.yaml\`, \`master-data/accounts.json\` (chart of accounts), \`ledger.json\`,
and per fiscal year \`transactional-data/<year>/\` (\`books/\`, \`receipts/\`, \`bank-statements/\`,
\`filings/\`). Files no app reads (notes, scripts, reference documents) go to \`own/\`;
\`npm run doctor\` names every other file.

The app is at \`${appRel}\`. Its \`.env\` sets \`VANILLA_WORKSPACE\` to this folder, so every
command run there works on these books:

    cd ${appRel} && npm start          # UI on http://localhost:5173
    cd ${appRel} && npm run doctor     # is everything set up?

Read the app's rules first: ${appRel}/AGENTS.md (golden rule 1: a filed quarter never changes;
corrections are booked in the open quarter with \`corrects:\` and declared on a form 0535).

What goes where:
- Code, generic process rules, public vendor facts: the app.
- Anything naming this company's accounts, amounts, customers, suppliers or the owner's
  decisions: here (knowledge/, this file).

Company notes:
- (add what an agent should know about this company)
`;
}

/**
 * The company's repository at `root` (ADR 0013): its agent files at the root, the books in
 * vanilla-accounting/ with the folders of the fiscal year `year`.
 */
export function planWorkspace(input: InitInput, chart: Chart, root: string, appRoot: string, year = new Date().toISOString().slice(0, 4)): Plan {
  const bankAccounts = bankAccountsOf(input);
  const accounts = accountsOf(input, chart);
  const app = (p: string) => `${APP_FOLDER}/${p}`;
  const yearDir = (p: string) => app(`transactional-data/${year}/${p}`);
  const statementDirs = [...new Set(bankAccounts.filter((b) => b.statements).map((b) => yearDir(`bank-statements/${b.bank}`)))];
  const kept = [yearDir('receipts'), yearDir('filings'), ...statementDirs];
  const appRel = relative(root, appRoot) || '.';
  return {
    dirs: [...kept, app('beleg-import'), app('data')],
    files: [
      ...kept.map((d): [string, string] => [`${d}/.gitkeep`, '']),
      ...KNOWLEDGE_TEMPLATES.map(([path, text]): [string, string] => [app(path), text]),
      [app('master-data/accounts.json'), JSON.stringify(accounts, null, 2) + '\n'],
      [app('ledger.json'), JSON.stringify({ schema: BOOKS_SCHEMA, config: {} }, null, 2) + '\n'],
      [app('sources/README.md'), SOURCES_README],
      ['AGENTS.md', agentsMd(input, appRel)],
      ['CLAUDE.md', '@AGENTS.md\n'],
      ['.gitignore', GITIGNORE],
      ['.gitattributes', GITATTRIBUTES],
      [app(MANIFEST_FILE), manifestYaml(input, bankAccounts)],
    ],
  };
}

export interface Applied {
  created: string[];
  /** Files that exist with other content than planned: left as they are. */
  differing: string[];
}

export function applyPlan(root: string, plan: Plan): Applied {
  const applied: Applied = { created: [], differing: [] };
  for (const dir of plan.dirs) {
    if (existsSync(join(root, dir))) continue;
    mkdirSync(join(root, dir), { recursive: true });
    applied.created.push(`${dir}/`);
  }
  for (const [path, content] of plan.files) {
    const full = join(root, path);
    if (existsSync(full)) {
      if (readFileSync(full, 'utf8') !== content) applied.differing.push(path);
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    applied.created.push(path);
  }
  return applied;
}
