/**
 * A new workspace as files: `planWorkspace` turns the init answers into every directory and file
 * (pure), `applyPlan` writes what is missing and never overwrites. The manifest is written last,
 * so a run that stopped halfway has none and the next run fills in the rest.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { stringify } from 'yaml';
import { chartFor, type Chart, type WorkspaceAccount } from './chart.js';
import type { Preset, SupportedAnswers } from './setup.js';
import { MANIFEST_FILE, WORKSPACE_SCHEMA, type LedgerBankAccount, type Uid, type WorkspaceProfile } from './workspace.js';

/** Where money is kept. `range` is where its ledger account is suggested; `statements` how it is imported. */
interface BankKind {
  range: 'bank' | 'card';
  statements?: 'camt053';
  /** Statement import proven on real files. */
  tested: boolean;
  note?: string;
}

const camt = (tested: boolean): BankKind => ({ range: 'bank', statements: 'camt053', tested });
const UNTESTED = 'Belege is tested with Raiffeisen and Wise camt.053 files. Import your first statement and check its transactions in the Bank tab.';

export const BANKS: Record<string, BankKind> = {
  Raiffeisen: camt(true),
  UBS: { ...camt(false), note: UNTESTED },
  PostFinance: { ...camt(false), note: UNTESTED },
  ZKB: { ...camt(false), note: UNTESTED },
  Wise: camt(true),
  PayPal: { range: 'bank', tested: false, note: 'PayPal statements are not imported yet: its payments are booked by hand.' },
  Kreditkarte: { range: 'card', tested: false, note: 'Credit card statements are not imported yet: book the monthly card bill by hand, or pay with a Wise card.' },
};

/** Any other bank (a cantonal or regional bank) imports camt.053 like the listed ones. */
export function bankKind(bank: string): BankKind {
  return BANKS[bank] ?? { ...camt(false), note: UNTESTED };
}

/** The chart's bank accounts per currency (reference/charts/ch-kmu.yaml); a further account takes the next free number. */
const BANK_BY_CURRENCY: Record<string, string> = { CHF: '1020', EUR: '1021', USD: '1022' };
const NEXT_FREE = { bank: 1023, card: 2101 } as const;

/** The ledger account a new bank account books on: the chart's for its currency while free, else the next free one. */
export function suggestAccount(bank: string, currency: string, taken: ReadonlySet<string>): string {
  const range = bankKind(bank).range;
  const preferred = range === 'bank' ? BANK_BY_CURRENCY[currency] : undefined;
  if (preferred && !taken.has(preferred)) return preferred;
  for (let n = NEXT_FREE[range]; ; n++) if (!taken.has(String(n))) return String(n);
}

export interface InitInput {
  name: string;
  uid: Uid;
  owner: string;
  business?: string;
  preset: Preset;
  answers: SupportedAnswers;
  banks: { bank: string; currency: string; account: string }[];
  exportTo?: string;
}

export interface Plan {
  dirs: string[];
  /** Relative path → content, in write order: the manifest last. */
  files: [string, string][];
}

/** The owner's private payments: a current account (GmbH, AG) or the private account (Einzelfirma). */
function ownerAccount(input: InitInput): LedgerBankAccount {
  return input.answers.legalForm === 'Einzelfirma'
    ? { bank: 'manual', currency: 'CHF', account: '2850', label: `Privat ${input.owner}` }
    : { bank: 'manual', currency: 'CHF', account: '2451', label: `Kontokorrent ${input.owner}` };
}

export function bankAccountsOf(input: InitInput): LedgerBankAccount[] {
  const banks = input.banks.map((b): LedgerBankAccount => {
    const { statements } = bankKind(b.bank);
    return { bank: b.bank, currency: b.currency, account: b.account, label: `${b.bank} ${b.currency}`, ...(statements ? { statements } : {}) };
  });
  return input.answers.ownerPaysPrivately === 'yes' ? [...banks, ownerAccount(input)] : banks;
}

/** The chart of the profile and legal form, plus what the answers need, with the bank accounts named after their bank. */
export function accountsOf(input: InitInput, chart: Chart): WorkspaceAccount[] {
  const { sells, legalForm, payouts, imports } = input.answers;
  const extra = new Set([...(payouts === 'yes' ? ['1093', '6580'] : []), ...(imports === 'yes' ? ['4020', '4030', '4040'] : [])]);
  const base = chartFor(chart, sells, legalForm);
  const byNumber = new Map(base.map((a) => [a.number, a]));
  for (const a of chartFor(chart, 'both', legalForm)) if (extra.has(a.number)) byNumber.set(a.number, a);
  for (const b of bankAccountsOf(input)) {
    const line = b.account.startsWith('1') ? 'fluessige-mittel' : 'kurzfristig-verzinslich';
    const known = byNumber.get(b.account);
    byNumber.set(b.account, known && b.bank === 'manual'
      ? known
      : { number: b.account, name: b.label, type: b.account.startsWith('1') ? 'asset' : 'liability', line: known?.line ?? line });
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

# Generated VAT artifacts at the root (as-filed copies are committed under filings/<year>/).
/mwst-ech0217-*.xml
/mwst-report-*.html
`;

const MAIL_YAML = `# Mailboxes receipts are collected from (npm run collect). Uncomment and fill in to use it.
# Passwords never go here: put <env>_IMAP_USER and <env>_IMAP_PASSWORD (an app password) in .env.
# See the app's docs/runbooks/receipt-collection.md.
#
# mailboxes:
#   - label: Business
#     address: you@example.com
#     env: WORK                  # .env keys WORK_IMAP_USER, WORK_IMAP_PASSWORD
#     host: imap.example.com
#     mixed: false               # true when business and private mail share the box
# skipDomains: []                # senders of a mixed mailbox that never send receipts
# includeDomains: []             # senders whose mail always is collected
# linkReceiptDomains: []         # senders that send receipts as a link
`;

function agentsMd(input: InitInput, appRel: string): string {
  return `# ${input.name}: books (private workspace)

This folder holds the books, not the code. It is a Belege workspace: \`belege.workspace.yaml\`
(who the company is, how it works, which ledger account each bank books on), \`accounts.json\`
(chart of accounts), \`books.json\`, \`receipts/\`, \`bank-statements/\`, \`filings/\`, plus the
company's own knowledge: \`counterparties/\`, \`policy/\`, \`mail.yaml\`.

The app is at \`${appRel}\`. Its \`.env\` sets \`BELEGE_WORKSPACE\` to this folder, so every
command run there works on these books:

    cd ${appRel} && npm start          # UI on http://localhost:5173
    cd ${appRel} && npm run doctor     # is everything set up?

Read the app's rules first: ${appRel}/AGENTS.md (golden rule 1: a filed quarter never changes;
corrections are booked in the open quarter with \`corrects:\` and declared on a form 0535).

What goes where:
- Code, generic process rules, public vendor facts: the app.
- Anything naming this company's accounts, amounts, customers, suppliers or the owner's
  decisions: here (counterparties/, policy/, this file).

Company notes:
- (add what an agent should know about this company)
`;
}

export function planWorkspace(input: InitInput, chart: Chart, root: string, appRoot: string): Plan {
  const bankAccounts = bankAccountsOf(input);
  const accounts = accountsOf(input, chart);
  const statementDirs = [...new Set(bankAccounts.filter((b) => b.statements).map((b) => `bank-statements/${b.bank}`))];
  const kept = ['receipts', 'filings', 'counterparties', 'policy', ...statementDirs];
  const appRel = relative(root, appRoot) || '.';
  return {
    dirs: [...kept, 'beleg-import', 'data'],
    files: [
      ...kept.map((d): [string, string] => [`${d}/.gitkeep`, '']),
      ['accounts.json', JSON.stringify(accounts, null, 2) + '\n'],
      ['books.json', JSON.stringify({ receipts: [], transactions: [], mappings: [], bankStatements: [], config: {} }, null, 2) + '\n'],
      ['mail.yaml', MAIL_YAML],
      ['AGENTS.md', agentsMd(input, appRel)],
      ['CLAUDE.md', '@AGENTS.md\n'],
      ['.gitignore', GITIGNORE],
      [MANIFEST_FILE, manifestYaml(input, bankAccounts)],
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
