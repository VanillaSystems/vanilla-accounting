/**
 * belege.workspace.yaml → who the company is and which ledger accounts its banks book on.
 * The boundary: everything is checked here, so the rest of the app trusts the types.
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { MANIFEST_MIGRATIONS, WORKSPACE_SCHEMA, climb, schemaOf } from './schema.js';
import { WorkspaceError, appLanguages, type Company, type LedgerBankAccount, type ProfileKey, type Uid, type WorkspaceProfile } from './workspace.js';
import { MANUAL_BANK, STATEMENT_KINDS, bankKind, parseIban, type StatementKind } from './banks.js';
import { LEGAL_FORMS, PRESET_NAMES, QUESTIONS, optionOf, type LegalForm, type Preset } from './setup.js';

const PROFILE_KEYS = Object.keys(QUESTIONS).filter((k) => !['legalForm', 'vatRegistered', 'vatMethod', 'basis', 'period'].includes(k)) as ProfileKey[];

export function readManifest(path: string): { company: Company; bankAccounts: LedgerBankAccount[]; profile?: WorkspaceProfile } {
  if (!existsSync(path)) throw new WorkspaceError(`${path} not found.`);
  const fail = (msg: string): never => { throw new WorkspaceError(`${path}: ${msg}`); };
  const doc = parseDocument(readFileSync(path, 'utf8'));
  const found = doc.toJS() as Record<string, unknown> | null;
  if (!found || typeof found !== 'object' || Array.isArray(found)) return fail('not a YAML mapping');
  let raw: Record<string, unknown>;
  try {
    raw = climb(doc, schemaOf(found.schema, path), WORKSPACE_SCHEMA, MANIFEST_MIGRATIONS, path, (d) => d.clone()).toJS();
  } catch (e) {
    throw new WorkspaceError((e as Error).message);
  }

  const c = (raw.company ?? {}) as Record<string, unknown>;
  const text = (v: unknown, where: string): string => (typeof v === 'string' && v.trim() ? v : fail(`${where} must be a non-empty text`));
  const uid = text(c.uid, 'company.uid');
  if (!/^CHE-\d{3}\.\d{3}\.\d{3}$/.test(uid)) fail(`company.uid "${uid}" must look like CHE-###.###.###`);
  const vat = (c.vat ?? {}) as Record<string, unknown>;
  if (vat.method !== 'effective' || vat.reporting !== 'received' || (vat.registered ?? true) !== true || (vat.period ?? 'quarterly') !== 'quarterly') {
    fail('company.vat must be { registered: true, method: effective, reporting: received, period: quarterly }: the only VAT setup the engine supports');
  }
  if (c.language !== undefined && !appLanguages().includes(c.language as string)) fail(`company.language must be one of ${appLanguages().join(', ')}`);
  if (c.legalForm !== undefined && !LEGAL_FORMS.includes(c.legalForm as LegalForm)) fail(`company.legalForm must be one of ${LEGAL_FORMS.join(', ')}`);
  const company: Company = {
    name: text(c.name, 'company.name'),
    uid: uid as Uid,
    owner: text(c.owner, 'company.owner'),
    ...(c.business === undefined ? {} : { business: text(c.business, 'company.business') }),
    ...(c.legalForm === undefined ? {} : { legalForm: c.legalForm as LegalForm }),
    ...(c.language === undefined ? {} : { language: c.language as string }),
    vat: { method: 'effective', reporting: 'received' },
  };

  if (!Array.isArray(raw.bankAccounts) || raw.bankAccounts.length === 0) fail('bankAccounts must list at least one account');
  const bankAccounts = (raw.bankAccounts as Record<string, unknown>[]).map((a, i): LedgerBankAccount => {
    const account = String(a.account ?? '');
    if (!/^\d{4}$/.test(account)) fail(`bankAccounts[${i}].account "${account}" must be a 4-digit ledger account`);
    const bank = text(a.bank, `bankAccounts[${i}].bank`);
    if (a.statements !== undefined && !STATEMENT_KINDS.includes(a.statements as StatementKind)) fail(`bankAccounts[${i}].statements must be ${STATEMENT_KINDS.join(' or ')}`);
    const statements = bank === MANUAL_BANK ? undefined : (a.statements as StatementKind | undefined) ?? bankKind(bank).statements;
    const iban = a.iban === undefined ? undefined : parseIban(String(a.iban)) ?? fail(`bankAccounts[${i}].iban "${String(a.iban)}" is not an IBAN (wrong length or check digits)`);
    return {
      bank,
      currency: text(a.currency, `bankAccounts[${i}].currency`),
      account,
      label: text(a.label, `bankAccounts[${i}].label`),
      ...(statements ? { statements } : {}),
      ...(iban ? { iban } : {}),
    };
  });
  const seen = new Set<string>();
  for (const a of bankAccounts) {
    for (const key of [`${a.bank} ${a.currency}`, ...(a.iban ? [`${a.iban} ${a.currency}`] : [])]) {
      if (seen.has(key)) fail(`bankAccounts: ${key} is listed twice`);
      seen.add(key);
    }
  }
  return { company, bankAccounts, ...(raw.profile === undefined ? {} : { profile: readProfile(raw.profile, fail) }) };
}

/** The profile block: every answer one the engine supports (src/workspace/setup.ts). */
function readProfile(raw: unknown, fail: (msg: string) => never): WorkspaceProfile {
  if (!raw || typeof raw !== 'object') return fail('profile must be a mapping');
  const p = raw as Record<string, unknown>;
  if (!PRESET_NAMES.includes(p.preset as Preset)) fail(`profile.preset must be one of ${PRESET_NAMES.join(', ')}`);
  for (const key of PROFILE_KEYS) {
    const multi = 'multi' in QUESTIONS[key];
    const values = multi ? p[key] : [p[key]];
    const allowed = QUESTIONS[key].options.filter((o) => !('unsupported' in o)).map((o) => o.value);
    const ok = Array.isArray(values) && values.every((v) => typeof v === 'string' && optionOf(key, v) && allowed.includes(v as never));
    if (!ok) fail(`profile.${key} must be ${multi ? 'a list of ' : 'one of '}${allowed.join(', ')}${p[key] === undefined ? ' (missing: rerun npm run init in a new folder, or add it)' : ''}`);
  }
  if (p.exportTo !== undefined && (typeof p.exportTo !== 'string' || !p.exportTo.trim())) fail('profile.exportTo must be a non-empty text');
  return p as unknown as WorkspaceProfile;
}
