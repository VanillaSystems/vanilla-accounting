/**
 * belege.workspace.yaml → who the company is and which ledger accounts its banks book on.
 * The boundary: everything is checked here, so the rest of the app trusts the types.
 */
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { WORKSPACE_SCHEMA, WorkspaceError, type Company, type LedgerBankAccount, type Uid } from './workspace.js';

export function readManifest(path: string): { company: Company; bankAccounts: LedgerBankAccount[] } {
  if (!existsSync(path)) throw new WorkspaceError(`${path} not found.`);
  const fail = (msg: string): never => { throw new WorkspaceError(`${path}: ${msg}`); };
  const raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return fail('not a YAML mapping');
  if (raw.schema !== WORKSPACE_SCHEMA) fail(`schema must be ${WORKSPACE_SCHEMA} (found ${String(raw.schema)})`);

  const c = (raw.company ?? {}) as Record<string, unknown>;
  const text = (v: unknown, where: string): string => (typeof v === 'string' && v.trim() ? v : fail(`${where} must be a non-empty text`));
  const uid = text(c.uid, 'company.uid');
  if (!/^CHE-\d{3}\.\d{3}\.\d{3}$/.test(uid)) fail(`company.uid "${uid}" must look like CHE-###.###.###`);
  const vat = (c.vat ?? {}) as Record<string, unknown>;
  if (vat.method !== 'effective' || vat.reporting !== 'received') {
    fail('company.vat must be { method: effective, reporting: received }: the only VAT setup the engine supports');
  }
  const company: Company = {
    name: text(c.name, 'company.name'),
    uid: uid as Uid,
    owner: text(c.owner, 'company.owner'),
    ...(c.business === undefined ? {} : { business: text(c.business, 'company.business') }),
    vat: { method: 'effective', reporting: 'received' },
  };

  if (!Array.isArray(raw.bankAccounts) || raw.bankAccounts.length === 0) fail('bankAccounts must list at least one account');
  const bankAccounts = (raw.bankAccounts as Record<string, unknown>[]).map((a, i): LedgerBankAccount => {
    const account = String(a.account ?? '');
    if (!/^\d{4}$/.test(account)) fail(`bankAccounts[${i}].account "${account}" must be a 4-digit ledger account`);
    return {
      bank: text(a.bank, `bankAccounts[${i}].bank`),
      currency: text(a.currency, `bankAccounts[${i}].currency`),
      account,
      label: text(a.label, `bankAccounts[${i}].label`),
      ...(a.statements === undefined ? {} : { statements: a.statements === 'camt053' || a.statements === 'wise' ? a.statements : fail(`bankAccounts[${i}].statements must be camt053 or wise`) }),
    };
  });
  const seen = new Set<string>();
  for (const a of bankAccounts) {
    const key = `${a.bank} ${a.currency}`;
    if (seen.has(key)) fail(`bankAccounts: ${key} is listed twice`);
    seen.add(key);
  }
  return { company, bankAccounts };
}
