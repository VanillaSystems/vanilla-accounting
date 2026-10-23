/**
 * belege.workspace.yaml → who the company is and which ledger accounts its banks book on.
 * The boundary: everything is checked here, so the rest of the app trusts the types.
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { MANIFEST_MIGRATIONS, WORKSPACE_SCHEMA, climb, schemaOf } from './schema.js';
import { WorkspaceError, WorkspaceRefusal, appLanguages, type Company, type LedgerBankAccount, type ProfileKey, type Uid, type WorkspaceProfile } from './workspace.js';
import { MANUAL_BANK, MONEY_ROLES, STATEMENT_KINDS, bankKind, parseIban, type MoneyRole, type StatementKind } from './banks.js';
import { BUSINESS_PROFILES, LEGAL_FORMS, PRESET_NAMES, QUESTIONS, VAT_QUESTIONS, kindsOf, optionOf, type BusinessProfile, type GoodsKind, type LegalForm, type Preset, type SalesKind } from './setup.js';
import { parseVatSetup } from './vat-setup.js';
import {
  DEFAULT_LAYOUT, INVOICE_CURRENCIES, INVOICE_FONTS, INVOICE_LANGUAGES, LAYOUT_ELEMENTS, MAIL_SECURITY, OWN_TEXTS,
  type Address, type InvoiceCurrency, type InvoiceLanguage, type InvoicingSettings, type MailSecurity, type OutgoingMail,
} from '../invoices/model.js';
import { isQrIban } from '../providers/qr-bill/reference.js';
import { readDimensions, type Dimension } from '../books/tags.js';

const PROFILE_KEYS = Object.keys(QUESTIONS).filter((k) => k !== 'legalForm' && !(VAT_QUESTIONS as readonly string[]).includes(k)) as ProfileKey[];

export type Manifest = {
  company: Company; bankAccounts: LedgerBankAccount[]; profile?: WorkspaceProfile; invoicing?: InvoicingSettings; outgoingMail?: OutgoingMail;
  /** The reporting dimensions bookings may carry a tag of (#127, src/books/tags.ts); absent: none. */
  dimensions?: Dimension[];
};

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
  const vat = parseVatSetup(c.vat, fail);
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
    vat,
  };

  if (!Array.isArray(raw.bankAccounts) || raw.bankAccounts.length === 0) fail('bankAccounts must list at least one account');
  const bankAccounts = (raw.bankAccounts as Record<string, unknown>[]).map((a, i): LedgerBankAccount => {
    const account = String(a.account ?? '');
    if (!/^\d{4}$/.test(account)) fail(`bankAccounts[${i}].account "${account}" must be a 4-digit ledger account`);
    const bank = text(a.bank, `bankAccounts[${i}].bank`);
    if (!MONEY_ROLES.includes(a.role as MoneyRole)) fail(`bankAccounts[${i}].role must be one of ${MONEY_ROLES.join(', ')}`);
    const role = a.role as MoneyRole;
    if (bank === MANUAL_BANK && role !== 'owner') fail(`bankAccounts[${i}]: the label manual is the owner's account, its role is owner`);
    if (a.statements !== undefined && !STATEMENT_KINDS.includes(a.statements as StatementKind)) fail(`bankAccounts[${i}].statements must be ${STATEMENT_KINDS.join(' or ')}`);
    // The bank registry names the reader of an account at a bank; a cash box, a person's account or a clearing account has one only when the manifest says so.
    const statements = (a.statements as StatementKind | undefined) ?? (role === 'bank' || role === 'card' ? bankKind(bank).statements : undefined);
    const iban = a.iban === undefined ? undefined : parseIban(String(a.iban)) ?? ((): never => {
      throw new WorkspaceRefusal(`${path}: bankAccounts[${i}].iban "${String(a.iban)}" is not an IBAN (wrong length or check digits)`, { code: 'iban', params: { bank: `${String(a.bank)} ${String(a.currency)}`, detail: String(a.iban) } });
    })();
    return {
      bank,
      currency: text(a.currency, `bankAccounts[${i}].currency`),
      account,
      label: text(a.label, `bankAccounts[${i}].label`),
      role,
      ...(statements ? { statements } : {}),
      ...(iban ? { iban } : {}),
    };
  });
  if (bankAccounts.filter((a) => a.role === 'owner').length > 1) fail('bankAccounts: one account at most has the role owner');
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
    ...(raw.outgoingMail === undefined ? {} : { outgoingMail: readOutgoingMail(raw.outgoingMail, fail) }),
    ...(raw.dimensions === undefined ? {} : { dimensions: readDimensions(raw.dimensions, fail) }),
  };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The mailbox that sends documents: host, port, security, login, sender. No password: src/secrets/. */
function readOutgoingMail(raw: unknown, fail: (msg: string) => never): OutgoingMail {
  if (!isMap(raw)) return fail('outgoingMail must be a mapping (host, port, security, user, fromName, fromAddress, replyTo)');
  if ('password' in raw) fail('outgoingMail.password does not belong in the workspace: VANILLA_SMTP_PASSWORD in .env, or the keychain in the app');
  const host = optText(raw.host, 'outgoingMail.host', fail)?.trim();
  if (!host) fail('outgoingMail.host is missing');
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('outgoingMail.port must be a port number (465, 587, …)');
  const security = (raw.security ?? (port === 465 ? 'tls' : 'starttls')) as MailSecurity;
  if (!MAIL_SECURITY.includes(security)) fail(`outgoingMail.security must be one of ${MAIL_SECURITY.join(', ')}`);
  const fromAddress = optText(raw.fromAddress, 'outgoingMail.fromAddress', fail)?.trim();
  if (!fromAddress || !EMAIL.test(fromAddress)) fail('outgoingMail.fromAddress must be an e-mail address');
  const replyTo = optText(raw.replyTo, 'outgoingMail.replyTo', fail)?.trim();
  if (replyTo && !EMAIL.test(replyTo)) fail('outgoingMail.replyTo must be an e-mail address');
  const user = optText(raw.user, 'outgoingMail.user', fail)?.trim();
  const fromName = optText(raw.fromName, 'outgoingMail.fromName', fail)?.trim();
  return { host: host!, port, security, fromAddress: fromAddress!, ...(user ? { user } : {}), ...(fromName ? { fromName } : {}), ...(replyTo ? { replyTo } : {}) };
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
    if (!bank!.iban) throw new WorkspaceRefusal(`${where}: bankAccounts ${bank!.bank} ${cur} needs its iban to be printed on invoices`, { code: 'payToNeedsIban', params: { bank: bank!.bank, currency: cur } });
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
    if (!isMap(raw.texts)) fail('invoicing.texts must map a language to { intro, closing, mailSubject, mailBody }');
    for (const [lang, v] of Object.entries(raw.texts as Record<string, unknown>)) {
      if (!INVOICE_LANGUAGES.includes(lang as InvoiceLanguage) || !isMap(v)) fail(`invoicing.texts.${lang}: one of ${INVOICE_LANGUAGES.join(', ')}, with intro and closing`);
      const t = v as Record<string, unknown>;
      texts[lang as InvoiceLanguage] = Object.fromEntries(OWN_TEXTS.filter((k) => t[k] !== undefined).map((k) => [k, String(t[k])]));
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
  const sells = readSells(p, fail);
  for (const key of PROFILE_KEYS) {
    if (key === 'sells') continue;
    const multi = 'multi' in QUESTIONS[key];
    const values = multi ? p[key] : [p[key]];
    const allowed = QUESTIONS[key].options.filter((o) => !('unsupported' in o)).map((o) => o.value);
    const ok = Array.isArray(values) && values.every((v) => typeof v === 'string' && optionOf(key, v) && allowed.includes(v as never));
    if (!ok) fail(`profile.${key} must be ${multi ? 'a list of ' : 'one of '}${allowed.join(', ')}${p[key] === undefined ? ' (missing: rerun npm run init in a new folder, or add it)' : ''}`);
  }
  if (p.exportTo !== undefined && (typeof p.exportTo !== 'string' || !p.exportTo.trim())) fail('profile.exportTo must be a non-empty text');
  const { goods: _, ...rest } = p;
  return { ...rest, sells } as unknown as WorkspaceProfile;
}

/**
 * What the firm sells (src/workspace/setup.ts SALES_KINDS), from the manifest's `sells` (services,
 * goods or both, as it has always been kept) and `goods` (which goods: made, traded); a manifest
 * without `goods` sells traded goods, what `goods` stood for before #46.
 */
function readSells(p: Record<string, unknown>, fail: (msg: string) => never): SalesKind[] {
  if (!BUSINESS_PROFILES.includes(p.sells as BusinessProfile)) fail(`profile.sells must be one of ${BUSINESS_PROFILES.join(', ')}${p.sells === undefined ? ' (missing: rerun npm run init in a new folder, or add it)' : ''}`);
  const goods = p.goods;
  const kinds = ['made', 'traded'];
  if (goods !== undefined && (!Array.isArray(goods) || !goods.every((g) => kinds.includes(g)))) fail(`profile.goods must be a list of ${kinds.join(', ')}`);
  return kindsOf(p.sells as BusinessProfile, goods as GoodsKind[] | undefined);
}
