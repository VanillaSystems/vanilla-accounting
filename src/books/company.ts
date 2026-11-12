/**
 * What the Firma page shows besides books.json: the manifest (company, bank accounts,
 * invoicing), every filed return and seal by quarter, and each bank account's last balance
 * as its statement shows it. The API answers it at /api/workspace; the audit export writes it.
 */
import { readBankStatements } from '../workspace/bank-statements.js';
import { parseIban } from '../workspace/banks.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuarterKey } from '../types/index.js';
import { partDirs, type Workspace } from '../workspace/workspace.js';
import type { Seal } from './seal.js';
import { sealsOf, type Books } from './store.js';
import { bankBalances } from './year-close.js';
import { appTime, appVersion } from '../version.js';
import type { SalesDefaults } from '../workspace/sells.js';

/** A quarter's seal file as checked against today's books. */
export type SealView =
  | ({ status: 'intact' } & Pick<Seal, 'quarter' | 'through' | 'sha256' | 'sealedAt' | 'records'>)
  | { status: 'broken'; quarter: QuarterKey; problem: string };

export interface CompanyInfo extends Pick<Workspace, 'company' | 'bankAccounts' | 'invoicing' | 'outgoingMail' | 'dimensions'> {
  /** Set by GET /api/workspace for a demo (src/workspace/demo-copy.ts isDemo): made-up books, which the page says while they are open. */
  demo?: true;
  /** The quarters whose return lies in transactional-data/<year>/filings/ as filed with the ESTV. */
  filed: QuarterKey[];
  seals: SealView[];
  /** The latest balance a statement shows, per ledger account, in the account's currency. */
  statementBalances: Array<{ account: string; date: string; amount: number }>;
  /** Per ledger account whose manifest line names no IBAN: the IBAN its read statements show (Firma › Bankkonten offers it). */
  statementIbans: Record<string, string>;
  /** The build of the app serving these books (src/version.ts), and how old it is. */
  appVersion: string;
  appTime?: { at: string; kind: 'built' | 'committed' };
  /**
   * The firm's default accounts, as the setup's «Was verkauft ihr?» wrote them (src/workspace/sells.ts):
   * the hand-booking form proposes them and its account fields list them first (#344). `sales` is the
   * one a sale without a rule goes on (the one kind's, else the jurisdiction's for several kinds);
   * `purchase` the first kind's that buys (none for a firm of services only). The API adds it
   * (src/server/routes/config.ts): the jurisdiction's table is the engines'.
   */
  defaults?: { sales: string; purchase?: string; all: SalesDefaults };
  /** The company's repository keeps a history: a file deleted from the books stays in it (#228). */
  versioned?: true;
}

function filedQuarters(ws: Workspace): QuarterKey[] {
  return partDirs(ws.paths, 'filings').flatMap((dir) => readdirSync(dir)
    .map((f) => /^mwst-ech0217-(\d{4}-(?:Q[1-4]|H[12]))\.xml$/.exec(f)?.[1] as QuarterKey | undefined)
    .filter((q): q is QuarterKey => !!q)).sort();
}

function statementIbansOf(ws: Workspace): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readBankStatements(ws)) {
    if (f.status !== 'read' || f.account.iban || !f.statement.iban || out[f.account.account]) continue;
    const iban = parseIban(f.statement.iban);
    if (iban) out[f.account.account] = iban;
  }
  return out;
}

export function companyInfo(ws: Workspace, books: Books): CompanyInfo {
  const seals = sealsOf(books).checks.map((c): SealView => {
    if (c.status === 'broken') return { status: 'broken', quarter: c.quarter, problem: c.problem };
    const s = JSON.parse(readFileSync(c.file, 'utf8')) as Seal;
    return { status: 'intact', quarter: c.quarter, through: s.through, sha256: s.sha256, sealedAt: s.sealedAt, records: s.records };
  });
  const latest = new Map<string, { account: string; date: string; amount: number }>();
  for (const b of bankBalances(ws, books)) {
    const was = latest.get(b.account);
    if (!was || b.date > was.date) latest.set(b.account, { account: b.account, date: b.date, amount: b.amount });
  }
  return {
    company: ws.company,
    bankAccounts: ws.bankAccounts,
    ...(ws.invoicing ? { invoicing: ws.invoicing } : {}),
    ...(ws.outgoingMail ? { outgoingMail: ws.outgoingMail } : {}),
    ...(ws.dimensions?.length ? { dimensions: ws.dimensions } : {}),
    filed: filedQuarters(ws),
    seals,
    statementBalances: [...latest.values()],
    statementIbans: statementIbansOf(ws),
    appVersion: appVersion(),
    ...(appTime() ? { appTime: appTime() } : {}),
    ...(existsSync(join(ws.paths.repository, '.git')) ? { versioned: true as const } : {}),
  };
}
