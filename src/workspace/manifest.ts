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
import {
  DEFAULT_LAYOUT, INVOICE_CURRENCIES, INVOICE_FONTS, INVOICE_LANGUAGES, LAYOUT_ELEMENTS,
  type Address, type InvoiceCurrency, type InvoiceLanguage, type InvoicingSettings,
} from '../invoices/model.js';
import { isQrIban } from '../invoices/reference.js';

const PROFILE_KEYS = Object.keys(QUESTIONS).filter((k) => !['legalForm', 'vatRegistered', 'vatMethod', 'basis', 'period'].includes(k)) as ProfileKey[];

export type Manifest = { company: Company; bankAccounts: LedgerBankAccount[]; profile?: WorkspaceProfile; invoicing?: InvoicingSettings };

export function readManifest(path: string): Manifest {
  if (!existsSync(path)) throw new WorkspaceError(`${path} not found.`);
  return parseManifest(readFileSync(path, 'utf8'), path);
}

/** The manifest's text checked as readManifest checks the file: what a write validates before it lands. */
export function parseManifest(source: string, path: string): Manifest {
  const fail = (msg: string): never => { throw new WorkspaceError(`${path}: ${msg}`); };
  const doc = parseDocument(source);
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
    ...(c.address === undefined ? {} : { address: readAddress(c.address, 'company.address', fail) }),
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
  return {
    company,
    bankAccounts,
    ...(raw.profile === undefined ? {} : { profile: readProfile(raw.profile, fail) }),
    ...(raw.invoicing === undefined ? {} : { invoicing: readInvoicing(raw.invoicing, bankAccounts, fail) }),
  };
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optText = (v: unknown, where: string, fail: (msg: string) => never): string | undefined =>
  v === undefined ? undefined : typeof v === 'string' || typeof v === 'number' ? String(v) : fail(`${where} must be a text`);

function readAddress(raw: unknown, where: string, fail: (msg: string) => never): Address {
  if (!isMap(raw)) return fail(`${where} must be a mapping (street, number, postcode, town, country)`);
  const postcode = optText(raw.postcode, `${where}.postcode`, fail);
  const town = optText(raw.town, `${where}.town`, fail);
  if (!postcode?.trim() || !town?.trim()) fail(`${where} needs postcode and town`);
  const country = optText(raw.country, `${where}.country`, fail) ?? 'CH';
  if (!/^[A-Z]{2}$/.test(country)) fail(`${where}.country must be a two-letter country code (CH, DE, …)`);
  const out: Address = { postcode: postcode!, town: town!, country };
  for (const k of ['street', 'number', 'line2', 'state'] as const) {
    const v = optText(raw[k], `${where}.${k}`, fail);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The invoicing block: where customers pay to (a bank account of the manifest with its IBAN), accounts, terms, layout, texts. */
function readInvoicing(raw: unknown, accounts: LedgerBankAccount[], fail: (msg: string) => never): InvoicingSettings {
  if (!isMap(raw)) return fail('invoicing must be a mapping');
  const payTo: InvoicingSettings['payTo'] = {};
  if (!isMap(raw.payTo)) fail('invoicing.payTo must map a currency (CHF, EUR) to { account, qrIban? }');
  for (const [cur, v] of Object.entries(raw.payTo as Record<string, unknown>)) {
    const where = `invoicing.payTo.${cur}`;
    if (!INVOICE_CURRENCIES.includes(cur as InvoiceCurrency)) fail(`${where}: a QR-bill is in CHF or EUR`);
    if (!isMap(v)) fail(`${where} must be { account, qrIban? }`);
    const p = v as Record<string, unknown>;
    const bank = accounts.find((a) => a.account === String(p.account) && a.currency === cur);
    if (!bank) fail(`${where}.account "${String(p.account)}" must be a ${cur} account of bankAccounts`);
    if (!bank!.iban) fail(`${where}: bankAccounts ${bank!.bank} ${cur} needs its iban to be printed on invoices`);
    const qrIban = p.qrIban === undefined ? undefined : parseIban(String(p.qrIban));
    if (p.qrIban !== undefined && (!qrIban || !isQrIban(qrIban))) fail(`${where}.qrIban "${String(p.qrIban)}" is not a QR-IBAN (CH or LI, institution id 30000 to 31999, valid check digits)`);
    payTo[cur as InvoiceCurrency] = { account: bank!.account, iban: bank!.iban!, ...(qrIban ? { qrIban } : {}), bank: bank!.bank };
  }
  const account = (v: unknown, where: string) => (/^\d{4}$/.test(String(v)) ? String(v) : fail(`${where} "${String(v)}" must be a 4-digit ledger account`));
  const days = raw.paymentTermsDays ?? 30;
  if (!Number.isInteger(days) || (days as number) < 0) fail('invoicing.paymentTermsDays must be a whole number of days');

  const l = raw.layout === undefined ? {} : isMap(raw.layout) ? raw.layout : fail('invoicing.layout must be a mapping');
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T, where: string): T =>
    v === undefined ? fallback : allowed.includes(v as T) ? (v as T) : fail(`invoicing.layout.${where} must be one of ${allowed.join(', ')}`);
  const show = { ...DEFAULT_LAYOUT.show };
  if (l.show !== undefined) {
    if (!isMap(l.show)) fail('invoicing.layout.show must map elements to true or false');
    for (const [k, v] of Object.entries(l.show as Record<string, unknown>)) {
      if (!LAYOUT_ELEMENTS.includes(k as never) || typeof v !== 'boolean') fail(`invoicing.layout.show.${k}: one of ${LAYOUT_ELEMENTS.join(', ')}, true or false`);
      show[k as keyof typeof show] = v as boolean;
    }
  }
  const accent = l.accent === undefined ? DEFAULT_LAYOUT.accent : String(l.accent);
  if (!/^#[0-9a-f]{6}$/i.test(accent)) fail('invoicing.layout.accent must be a colour like #141a26');
  const texts: InvoicingSettings['texts'] = {};
  if (raw.texts !== undefined) {
    if (!isMap(raw.texts)) fail('invoicing.texts must map a language to { intro, closing }');
    for (const [lang, v] of Object.entries(raw.texts as Record<string, unknown>)) {
      if (!INVOICE_LANGUAGES.includes(lang as InvoiceLanguage) || !isMap(v)) fail(`invoicing.texts.${lang}: one of ${INVOICE_LANGUAGES.join(', ')}, with intro and closing`);
      const t = v as Record<string, unknown>;
      texts[lang as InvoiceLanguage] = { ...(t.intro === undefined ? {} : { intro: String(t.intro) }), ...(t.closing === undefined ? {} : { closing: String(t.closing) }) };
    }
  }
  return {
    payTo,
    revenueAccount: account(raw.revenueAccount, 'invoicing.revenueAccount'),
    ...(raw.feeAccount === undefined ? {} : { feeAccount: account(raw.feeAccount, 'invoicing.feeAccount') }),
    paymentTermsDays: days as number,
    layout: {
      font: pick(l.font, INVOICE_FONTS, DEFAULT_LAYOUT.font, 'font'),
      accent,
      window: pick(l.window, ['left', 'right'] as const, DEFAULT_LAYOUT.window, 'window'),
      ...(l.logo === undefined ? {} : { logo: String(l.logo) }),
      logoPosition: pick(l.logoPosition, ['left', 'center', 'right'] as const, DEFAULT_LAYOUT.logoPosition, 'logoPosition'),
      logoSize: pick(l.logoSize, ['s', 'm', 'l'] as const, DEFAULT_LAYOUT.logoSize, 'logoSize'),
      show,
    },
    texts,
  };
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
