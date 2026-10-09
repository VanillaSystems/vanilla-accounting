/**
 * The standard chart of accounts the app ships (reference/charts/ch-kmu.yaml), and the chart a
 * new workspace starts from: the accounts of its business profile and legal form.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REFERENCE_DIR } from './workspace.js';
import { LEGAL_FORMS, type BusinessProfile, type LegalForm } from './setup.js';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense', 'closing'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type Statement = 'bilanz' | 'erfolgsrechnung' | 'abschluss';

export interface ChartLine {
  statement: Statement;
  label: string;
  /** The article of the Code of Obligations that names the line. */
  article?: string;
}

export interface ChartAccount {
  number: string;
  name: string;
  type: AccountType;
  /** Key into Chart.lines. */
  line: string;
  /** Only in a chart for these profiles; absent means every profile. */
  profiles?: Exclude<BusinessProfile, 'both'>[];
  /** Only for these legal forms; absent means every form. */
  legalForms?: LegalForm[];
  /** The account's name for a legal form, where it differs. */
  names?: Partial<Record<LegalForm, string>>;
}

export interface Chart {
  name: string;
  lines: Record<string, ChartLine>;
  accounts: ChartAccount[];
}

/** One account of a workspace's accounts.json. */
export interface WorkspaceAccount {
  number: string;
  name: string;
  type: AccountType;
  line: string;
}

export const KMU_CHART = join(REFERENCE_DIR, 'charts', 'ch-kmu.yaml');

/** The statement each account type is shown on, and the account class it must be in. */
const TYPE_RULES: Record<AccountType, { statement: Statement; classes: string }> = {
  asset: { statement: 'bilanz', classes: '1' },
  liability: { statement: 'bilanz', classes: '2' },
  equity: { statement: 'bilanz', classes: '2' },
  revenue: { statement: 'erfolgsrechnung', classes: '345678' },
  expense: { statement: 'erfolgsrechnung', classes: '345678' },
  closing: { statement: 'abschluss', classes: '9' },
};

export class ChartError extends Error {}

export function loadChart(path: string = KMU_CHART): Chart {
  const fail = (msg: string): never => { throw new ChartError(`${path}: ${msg}`); };
  const raw = parse(readFileSync(path, 'utf8')) as Partial<Chart> & { schema?: unknown };
  if (raw?.schema !== 1) fail('schema must be 1');
  const lines = raw.lines ?? fail('lines missing');
  const accounts = raw.accounts ?? fail('accounts missing');
  const seen = new Set<string>();
  for (const a of accounts) {
    const where = `account ${a.number}`;
    if (!/^\d{4}$/.test(String(a.number))) fail(`${where}: number must be 4 digits (quote it)`);
    if (seen.has(a.number)) fail(`${where} is listed twice`);
    seen.add(a.number);
    if (!a.name) fail(`${where}: name missing`);
    const rule = TYPE_RULES[a.type] ?? fail(`${where}: type "${a.type}" is not one of ${ACCOUNT_TYPES.join(', ')}`);
    if (!rule.classes.includes(a.number[0])) fail(`${where}: a ${a.type} account must be in class ${[...rule.classes].join('/')}`);
    const line = lines[a.line] ?? fail(`${where}: line "${a.line}" is not in lines`);
    if (line.statement !== rule.statement) fail(`${where}: a ${a.type} account belongs on the ${rule.statement}, line "${a.line}" is on the ${line.statement}`);
    for (const p of a.profiles ?? []) if (p !== 'services' && p !== 'goods') fail(`${where}: profile "${p}" unknown`);
    for (const f of [...(a.legalForms ?? []), ...Object.keys(a.names ?? {})]) {
      if (!LEGAL_FORMS.includes(f as LegalForm)) fail(`${where}: legal form "${f}" unknown`);
    }
  }
  return { name: raw.name ?? 'chart', lines, accounts: [...accounts].sort((x, y) => x.number.localeCompare(y.number)) };
}

/** The accounts of a new workspace with this profile and legal form, as accounts.json holds them. */
export function chartFor(chart: Chart, profile: BusinessProfile, legalForm: LegalForm): WorkspaceAccount[] {
  const inProfile = (a: ChartAccount) => !a.profiles || profile === 'both' || a.profiles.includes(profile);
  const inForm = (a: ChartAccount) => !a.legalForms || a.legalForms.includes(legalForm);
  return chart.accounts.filter((a) => inProfile(a) && inForm(a)).map((a) => ({
    number: a.number,
    name: a.names?.[legalForm] ?? a.name,
    type: a.type,
    line: a.line,
  }));
}
