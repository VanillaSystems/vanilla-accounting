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
  DEFAULT_LAYOUT, DEFAULT_SHORTFALL_LIMIT, DEFAULT_UNITS, DOCUMENT_KINDS, INVOICE_CURRENCIES, INVOICE_FONTS, INVOICE_LANGUAGES, LAYOUT_ELEMENTS, MAIL_SECURITY, NET_TERMS, OWN_TEXTS, PRICES,
  STANDARD_TEMPLATE, TEMPLATE_TEXTS, type InvoiceLayout, type InvoiceTemplate, type TemplateTexts,
  type Address, type DocumentKind, type InvoiceCurrency, type InvoiceLanguage, type InvoicingSettings, type MailSecurity, type OutgoingMail, type PaymentTerms, type Prices, type UnitDef,
} from '../invoices/model.js';
import { isQrIban, referenceTooLong } from '../providers/qr-bill/reference.js';
import { DEFAULT_NUMBERING, checkNumbering, type Numbering } from './numbering.js';
import { readDimensions, type Dimension } from '../books/tags.js';
import { readDunning } from './dunning.js';

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
  // Absent until the person enters it (#452); one that stands is a UID.
  const uid = c.uid === undefined ? undefined : text(c.uid, 'company.uid');
  if (uid !== undefined && !/^CHE-\d{3}\.\d{3}\.\d{3}$/.test(uid)) fail(`company.uid "${uid}" must look like CHE-###.###.###`);
  const vat = parseVatSetup(c.vat, fail);
  if (c.language !== undefined && !appLanguages().includes(c.language as string)) fail(`company.language must be one of ${appLanguages().join(', ')}`);
  if (c.legalForm !== undefined && !LEGAL_FORMS.includes(c.legalForm as LegalForm)) fail(`company.legalForm must be one of ${LEGAL_FORMS.join(', ')}`);
  const company: Company = {
    name: text(c.name, 'company.name'),
    ...(uid === undefined ? {} : { uid: uid as Uid }),
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
  // The owner is one person on one ledger account, which may run in several currencies (manual CHF, EUR, USD on 2451).
  const ownerAccounts = [...new Set(bankAccounts.filter((a) => a.role === 'owner').map((a) => a.account))];
  if (ownerAccounts.length > 1) fail(`bankAccounts: the owner's accounts (role owner) book on one ledger account, not on ${ownerAccounts.join(' and ')}`);
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

  const layout = readLayout(raw.layout, 'invoicing.layout', fail);
  const texts: InvoicingSettings['texts'] = {};
  if (raw.texts !== undefined) {
    if (!isMap(raw.texts)) fail('invoicing.texts must map a language to { intro, closing, mailSubject, mailBody }');
    for (const [lang, v] of Object.entries(raw.texts as Record<string, unknown>)) {
      if (!INVOICE_LANGUAGES.includes(lang as InvoiceLanguage) || !isMap(v)) fail(`invoicing.texts.${lang}: one of ${INVOICE_LANGUAGES.join(', ')}, with intro and closing`);
      const t = v as Record<string, unknown>;
      texts[lang as InvoiceLanguage] = Object.fromEntries(OWN_TEXTS.filter((k) => t[k] !== undefined).map((k) => [k, String(t[k])]));
    }
  }
  if (raw.templates !== undefined && raw.layout !== undefined) fail('invoicing: with templates, each Vorlage has its layout; invoicing.layout must go');
  const templates = raw.templates === undefined ? [{ id: STANDARD_TEMPLATE, name: 'Standard', layout }] : readTemplates(raw.templates, fail);
  const templateFor = readTemplateFor(raw.templateFor, templates, fail);
  const terms = readTerms(raw.paymentTerms, days as number, fail);
  if (raw.defaultTerms !== undefined && !terms.some((x) => x.id === raw.defaultTerms)) fail(`invoicing.defaultTerms "${String(raw.defaultTerms)}" must be the id of one of invoicing.paymentTerms`);
  const limit = raw.shortfallLimit ?? DEFAULT_SHORTFALL_LIMIT;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) fail('invoicing.shortfallLimit must be an amount from 0');
  const wo = raw.writeOffAccount;
  if (wo !== undefined && !isMap(wo)) fail('invoicing.writeOffAccount must be { skonto, loss }');
  return {
    payTo,
    revenueAccount: account(raw.revenueAccount, 'invoicing.revenueAccount'),
    ...(raw.feeAccount === undefined ? {} : { feeAccount: account(raw.feeAccount, 'invoicing.feeAccount') }),
    paymentTermsDays: days as number,
    layout: templates[0].layout,
    templates,
    templateFor,
    texts,
    units: readUnits(raw.units, fail),
    prices: readPrices(raw.prices, fail),
    numbering: readNumbering(raw.numbering, fail),
    paymentTerms: terms,
    ...(raw.defaultTerms === undefined ? {} : { defaultTerms: String(raw.defaultTerms) }),
    ...(isMap(wo) ? { writeOffAccount: { skonto: account(wo.skonto, 'invoicing.writeOffAccount.skonto'), loss: account(wo.loss, 'invoicing.writeOffAccount.loss') } } : {}),
    shortfallLimit: limit as number,
    dunning: readDunning(raw.dunning, fail),
  };
}

/** A layout (`invoicing.layout`, or a Vorlage's): every field optional, the app's default where absent. */
function readLayout(raw: unknown, where: string, fail: (msg: string) => never): InvoiceLayout {
  const l = raw === undefined ? {} : isMap(raw) ? raw : fail(`${where} must be a mapping`);
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T, key: string): T =>
    v === undefined ? fallback : allowed.includes(v as T) ? (v as T) : fail(`${where}.${key} must be one of ${allowed.join(', ')}`);
  const show = { ...DEFAULT_LAYOUT.show };
  if (l.show !== undefined) {
    if (!isMap(l.show)) fail(`${where}.show must map elements to true or false`);
    for (const [k, v] of Object.entries(l.show as Record<string, unknown>)) {
      if (!LAYOUT_ELEMENTS.includes(k as never) || typeof v !== 'boolean') fail(`${where}.show.${k}: one of ${LAYOUT_ELEMENTS.join(', ')}, true or false`);
      show[k as keyof typeof show] = v as boolean;
    }
  }
  const accent = l.accent === undefined ? DEFAULT_LAYOUT.accent : String(l.accent);
  if (!/^#[0-9a-f]{6}$/i.test(accent)) fail(`${where}.accent must be a colour like #141a26`);
  return {
    font: pick(l.font, INVOICE_FONTS, DEFAULT_LAYOUT.font, 'font'),
    accent,
    window: pick(l.window, ['left', 'right'] as const, DEFAULT_LAYOUT.window, 'window'),
    ...(l.logo === undefined ? {} : { logo: String(l.logo) }),
    logoPosition: pick(l.logoPosition, ['left', 'center', 'right'] as const, DEFAULT_LAYOUT.logoPosition, 'logoPosition'),
    logoSize: pick(l.logoSize, ['s', 'm', 'l'] as const, DEFAULT_LAYOUT.logoSize, 'logoSize'),
    show,
  };
}

/** A file a Vorlage names: a PDF path under the workspace, never outside it. */
function readFile(v: unknown, where: string, fail: (msg: string) => never): string {
  const f = typeof v === 'string' ? v.trim() : '';
  if (!f || f.startsWith('/') || f.split(/[\\/]/).includes('..') || !/\.pdf$/i.test(f)) fail(`${where} must be a PDF path under the workspace`);
  return f;
}

/** The Vorlagen (spec 4.4.11): `[{ id, name, layout, letterhead?, texts?, attachment? }]`, ids unique. */
function readTemplates(raw: unknown, fail: (msg: string) => never): InvoiceTemplate[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail('invoicing.templates must list Vorlagen { id, name, layout }');
  const seen = new Set<string>();
  return raw.map((t, i): InvoiceTemplate => {
    const where = `invoicing.templates[${i}]`;
    if (!isMap(t)) fail(`${where} must be { id, name, layout, letterhead?, texts?, attachment? }`);
    const id = optText(t.id, `${where}.id`, fail)?.trim();
    if (!id || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) fail(`${where}.id must be a short id (letters, digits, - or _)`);
    if (seen.has(id!)) fail(`${where}.id "${id}" is listed twice`);
    seen.add(id!);
    const name = optText(t.name, `${where}.name`, fail)?.trim();
    if (!name) fail(`${where}.name is missing`);
    const texts: NonNullable<InvoiceTemplate['texts']> = {};
    if (t.texts !== undefined) {
      if (!isMap(t.texts)) fail(`${where}.texts must map a kind to languages`);
      for (const [kind, byLang] of Object.entries(t.texts as Record<string, unknown>)) {
        if (!DOCUMENT_KINDS.includes(kind as DocumentKind) || !isMap(byLang)) fail(`${where}.texts.${kind}: a kind (${DOCUMENT_KINDS.join(', ')}) mapping languages to texts`);
        const out: Partial<Record<InvoiceLanguage, TemplateTexts>> = {};
        for (const [lang, v] of Object.entries(byLang as Record<string, unknown>)) {
          if (!INVOICE_LANGUAGES.includes(lang as InvoiceLanguage) || !isMap(v)) fail(`${where}.texts.${kind}.${lang}: one of ${INVOICE_LANGUAGES.join(', ')}, with ${TEMPLATE_TEXTS.join(', ')}`);
          const x = v as Record<string, unknown>;
          for (const k of Object.keys(x)) if (!TEMPLATE_TEXTS.includes(k as never)) fail(`${where}.texts.${kind}.${lang}.${k}: one of ${TEMPLATE_TEXTS.join(', ')}`);
          out[lang as InvoiceLanguage] = Object.fromEntries(TEMPLATE_TEXTS.filter((k) => x[k] !== undefined).map((k) => [k, String(x[k])]));
        }
        texts[kind as DocumentKind] = out;
      }
    }
    let attachment: InvoiceTemplate['attachment'];
    if (t.attachment !== undefined) {
      const a = t.attachment;
      if (!isMap(a)) fail(`${where}.attachment must be { name, file, kinds? }`);
      const an = optText((a as Record<string, unknown>).name, `${where}.attachment.name`, fail)?.trim();
      if (!an) fail(`${where}.attachment.name is missing`);
      const kinds = (a as Record<string, unknown>).kinds;
      if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.every((k) => DOCUMENT_KINDS.includes(k as DocumentKind)))) fail(`${where}.attachment.kinds: a list of ${DOCUMENT_KINDS.join(', ')}`);
      attachment = { name: an!, file: readFile((a as Record<string, unknown>).file, `${where}.attachment.file`, fail), ...(kinds ? { kinds: kinds as DocumentKind[] } : {}) };
    }
    return {
      id: id!, name: name!, layout: readLayout(t.layout, `${where}.layout`, fail),
      ...(t.letterhead === undefined ? {} : { letterhead: readFile(t.letterhead, `${where}.letterhead`, fail) }),
      ...(Object.keys(texts).length ? { texts } : {}),
      ...(attachment ? { attachment } : {}),
    };
  });
}

/** The Vorlage per kind: `{ invoice: regie }`, each an id of `templates`; a kind it names not takes the first. */
function readTemplateFor(raw: unknown, templates: readonly InvoiceTemplate[], fail: (msg: string) => never): Partial<Record<DocumentKind, string>> {
  if (raw === undefined) return {};
  if (!isMap(raw)) return fail(`invoicing.templateFor must map a kind (${DOCUMENT_KINDS.join(', ')}) to a Vorlage's id`);
  const out: Partial<Record<DocumentKind, string>> = {};
  for (const [kind, id] of Object.entries(raw)) {
    if (!DOCUMENT_KINDS.includes(kind as DocumentKind)) fail(`invoicing.templateFor.${kind}: a kind (${DOCUMENT_KINDS.join(', ')})`);
    if (!templates.some((t) => t.id === id)) fail(`invoicing.templateFor.${kind} "${String(id)}" must be the id of one of invoicing.templates`);
    out[kind as DocumentKind] = String(id);
  }
  return out;
}

/** The units a position may be counted in: each an id with its word in de, fr, it and en; absent: the app's (DEFAULT_UNITS). */
function readUnits(raw: unknown, fail: (msg: string) => never): UnitDef[] {
  if (raw === undefined) return DEFAULT_UNITS.map((u) => ({ ...u }));
  if (!Array.isArray(raw) || raw.length === 0) return fail('invoicing.units must list units { id, de, fr, it, en }');
  const seen = new Set<string>();
  return raw.map((u, i) => {
    const where = `invoicing.units[${i}]`;
    if (!isMap(u)) fail(`${where} must be { id, de, fr, it, en }`);
    const id = optText(u.id, `${where}.id`, fail)?.trim();
    if (!id || !/^[a-z0-9][a-z0-9_-]{0,15}$/i.test(id)) fail(`${where}.id must be a short id (letters, digits, - or _)`);
    if (seen.has(id!)) fail(`${where}.id "${id}" is listed twice`);
    seen.add(id!);
    const words = Object.fromEntries(INVOICE_LANGUAGES.map((l) => {
      const w = optText(u[l], `${where}.${l}`, fail)?.trim();
      if (!w) fail(`${where}.${l}: the unit's word in ${l} is missing`);
      return [l, w!];
    })) as Record<InvoiceLanguage, string>;
    return { id: id!, ...words };
  });
}

/** Net or gross prices per kind of document; absent: net for each. */
function readPrices(raw: unknown, fail: (msg: string) => never): InvoicingSettings['prices'] {
  const out = Object.fromEntries(DOCUMENT_KINDS.map((k) => [k, 'net'])) as InvoicingSettings['prices'];
  if (raw === undefined) return out;
  if (!isMap(raw)) return fail(`invoicing.prices must map a kind (${DOCUMENT_KINDS.join(', ')}) to net or gross`);
  for (const [kind, v] of Object.entries(raw)) {
    if (!(kind in out) || !PRICES.includes(v as Prices)) fail(`invoicing.prices.${kind}: a kind (${DOCUMENT_KINDS.join(', ')}), ${PRICES.join(' or ')}`);
    out[kind as keyof typeof out] = v as Prices;
  }
  return out;
}

/**
 * The number series per kind (docs/specs/invoicing.md 4.4.4): `{ format, restartYearly }` per kind;
 * a kind the file names not takes the new firm's default (DEFAULT_NUMBERING). A format a payment
 * reference cannot hold, or a restart without the year, is refused (src/invoices/numbering.ts checkNumbering).
 */
function readNumbering(raw: unknown, fail: (msg: string) => never): Numbering {
  const out: Numbering = { ...DEFAULT_NUMBERING };
  if (raw === undefined) return out;
  if (!isMap(raw)) return fail(`invoicing.numbering must map a kind (${DOCUMENT_KINDS.join(', ')}) to { format, restartYearly }`);
  for (const [kind, v] of Object.entries(raw)) {
    const where = `invoicing.numbering.${kind}`;
    if (!DOCUMENT_KINDS.includes(kind as DocumentKind)) fail(`${where}: a kind (${DOCUMENT_KINDS.join(', ')})`);
    if (!isMap(v) || typeof v.format !== 'string' || (v.restartYearly !== undefined && typeof v.restartYearly !== 'boolean')) fail(`${where} must be { format, restartYearly }`);
    const m = v as Record<string, unknown>;
    out[kind as DocumentKind] = { format: m.format as string, restartYearly: m.restartYearly !== false };
  }
  const bad = checkNumbering(out, referenceTooLong);
  if (bad) fail(`invoicing.numbering.${bad.kind}: "${out[bad.kind].format}" cannot be taken (${bad.refusal})`);
  return out;
}

/** Zahlungskonditionen by name; absent: one of `days` days net, id `net<days>`, named «30 Tage netto» (its words in each document language: NET_TERMS). */
function readTerms(raw: unknown, days: number, fail: (msg: string) => never): PaymentTerms[] {
  if (raw === undefined) return [{ id: `net${days}`, name: NET_TERMS.de(days), days }];
  if (!Array.isArray(raw) || raw.length === 0) return fail('invoicing.paymentTerms must list terms { id, name, days, skonto?, text? }');
  const seen = new Set<string>();
  return raw.map((t, i): PaymentTerms => {
    const where = `invoicing.paymentTerms[${i}]`;
    if (!isMap(t)) fail(`${where} must be { id, name, days, skonto?, text? }`);
    const id = optText(t.id, `${where}.id`, fail)?.trim();
    if (!id) fail(`${where}.id is missing`);
    if (seen.has(id!)) fail(`${where}.id "${id}" is listed twice`);
    seen.add(id!);
    const name = optText(t.name, `${where}.name`, fail)?.trim();
    if (!name) fail(`${where}.name is missing`);
    if (!Number.isInteger(t.days) || (t.days as number) < 0) fail(`${where}.days must be a whole number of days`);
    let skonto: PaymentTerms['skonto'];
    if (t.skonto !== undefined) {
      const k = t.skonto;
      if (!isMap(k) || typeof k.percent !== 'number' || !(k.percent > 0 && k.percent < 100) || !Number.isInteger(k.days) || (k.days as number) < 0 || (k.days as number) > (t.days as number)) {
        fail(`${where}.skonto must be { percent (above 0, below 100), days (whole, at most ${String(t.days)}) }`);
      }
      skonto = { percent: (k as { percent: number }).percent, days: (k as { days: number }).days };
    }
    const text = optText(t.text, `${where}.text`, fail);
    return { id: id!, name: name!, days: t.days as number, ...(skonto ? { skonto } : {}), ...(text ? { text } : {}) };
  });
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
