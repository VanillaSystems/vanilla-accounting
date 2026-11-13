/**
 * Changes to belege.workspace.yaml from the Firma page: the company's profile, its bank
 * accounts' labels and IBANs, a new bank account, the invoice layout and texts. ADR 0004: the change is applied to the YAML
 * document as it is on disk, field by field, so its comments, its layout and every field this
 * app does not know stay as they were. The result is checked by the same reader the app opens
 * the workspace with before it replaces the file; a change the reader refuses is never written.
 */
import type { StatementKind } from './banks.js';
import { readFileSync } from 'node:fs';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';
import { writeAtomic } from '../invoices/store.js';
import type { Address, InvoiceCurrency, InvoiceLanguage, InvoiceLayout, LayoutElement, OWN_TEXTS, OutgoingMail } from '../invoices/model.js';
import { parseIban, roleBefore, type MoneyRole } from './banks.js';
import { parseManifest, type Manifest } from './manifest.js';
import { vatSetupYaml, type VatSetup } from './vat-setup.js';
import { MANIFEST_MIGRATIONS, WORKSPACE_SCHEMA, climb, manifestText, schemaOf, stampManifest } from './schema.js';
import { WorkspaceError, WorkspaceRefusal } from './workspace.js';
import { parseUid } from './uid.js';
import { goodsOf, profileOf, type SalesKind } from './setup.js';
import { dimensionYaml, type Dimension } from '../books/tags.js';

/** A text field set, or removed with null; absent: unchanged. */
type Edit<T> = T | null | undefined;

export interface ProfilePatch {
  name?: string;
  uid?: string;
  owner?: string;
  business?: Edit<string>;
  address?: Edit<Address>;
}

/** A bank account is named by its bank and currency, which the books' transactions carry; only its label and IBAN change. */
export interface BankPatch {
  bank: string;
  currency: string;
  label?: string;
  iban?: Edit<string>;
}

/** A money account added: from Firma › Geldkonten, or when it is first used (#88). */
export interface NewBank {
  bank: string;
  currency: string;
  account: string;
  label: string;
  /** Absent: a card for a card issuer the app knows, else a bank. */
  role?: MoneyRole;
  iban?: string;
  /** How its statements are read, kept on the account; absent: by its bank's name (src/workspace/banks.ts). */
  statements?: StatementKind;
}

/** Firma › Rechnungslayout: the invoicing block's layout and its texts per language; null removes a field (the app's default again). */
export interface InvoicingPatch {
  /** Sets invoicing up when the block is missing: the account customers pay to (in its currency), the revenue account, the payment term. */
  setup?: { currency: string; account: string; revenueAccount: string; paymentTermsDays: number };
  /** The payment term a new customer starts with; each customer keeps their own. */
  paymentTermsDays?: number;
  /** The bank account customers pay to, per currency (its IBAN may come in the same change, as `banks`); null drops the currency. */
  payTo?: Partial<Record<InvoiceCurrency, { account: string } | null>>;
  layout?: Partial<Omit<InvoiceLayout, 'logo' | 'show'>> & { logo?: string | null; show?: Partial<Record<LayoutElement, boolean>> };
  texts?: Partial<Record<InvoiceLanguage, Partial<Record<(typeof OWN_TEXTS)[number], string | null>>>>;
}

/** Firma › E-Mail: the outgoing mailbox, field by field; null removes a field, `outgoingMail: null` the block. */
export type MailPatch = { [K in keyof OutgoingMail]?: OutgoingMail[K] | null };

export interface ManifestPatch {
  company?: ProfilePatch;
  /** The Firma page's VAT section: the whole VAT setup, written as one block (the API checks the method rule before). */
  vat?: VatSetup;
  banks?: BankPatch[];
  addBank?: NewBank;
  /** A bank account taken out again (Firma › Bankkonten › «Entfernen», the undo of an add); the API refuses one the books use (r9k-1). */
  removeBank?: { bank: string; currency: string };
  invoicing?: InvoicingPatch;
  outgoingMail?: MailPatch | null;
  /** «Was verkauft ihr?» (#46): written as `profile.sells` and `profile.goods` (src/workspace/setup.ts kindsOf); only into a manifest with a profile. */
  sells?: SalesKind[];
  /** «Ausgangslage» (#496): written as `profile.start`, only into a manifest with a profile; both answers create the same books. */
  start?: 'new' | 'switching';
  /** Firma › Dimensionen (#127): the whole list, written as one block; empty removes it. The API refuses to drop a dimension bookings carry. */
  dimensions?: Dimension[];
}

const ADDRESS_KEYS = ['street', 'number', 'line2', 'postcode', 'town', 'state', 'country'] as const;

function set(doc: Document, path: Array<string | number>, value: unknown): void {
  if (value === undefined) return;
  if (value === null || value === '') doc.deleteIn(path);
  else doc.setIn(path, value);
}

/** An IBAN as the manifest keeps it: compact, upper case, checked. */
function iban(text: Edit<string>, where: string): Edit<string> {
  if (text === undefined || text === null || text.trim() === '') return text === undefined ? undefined : null;
  return parseIban(text) ?? (() => { throw new WorkspaceRefusal(`${where}: "${text}" is not an IBAN (wrong length or check digits)`, { code: 'iban', params: { bank: where.replace(/^bankAccounts /, ''), detail: text } }); })();
}

/** The manifest text with `patch` applied; throws a WorkspaceError for a change the app could not open. */
export function patchManifestText(text: string, patch: ManifestPatch, path: string): { text: string; manifest: Manifest } {
  // An older manifest climbs first, on the document, so its comments stay; the change writes it at the current schema.
  let doc: Document = parseDocument(text);
  try {
    const from = schemaOf(doc.toJS()?.schema, path);
    if (from !== WORKSPACE_SCHEMA) doc = stampManifest(climb(doc, from, WORKSPACE_SCHEMA, MANIFEST_MIGRATIONS, path, (d) => d.clone()));
  } catch (e) {
    throw new WorkspaceError((e as Error).message);
  }
  const c = patch.company;
  if (c) {
    // A UID a person changes carries a check digit (r9c-5): a typo is refused. The stored one is no change,
    // so a demo's invented UID (wrong on purpose, tools/demo/generate.ts assertFictionalUids) keeps its profile editable.
    // An empty one removes it (#452): the books are kept without a UID until she enters one.
    if (typeof c.uid === 'string' && c.uid.trim() && c.uid.trim() !== String(doc.getIn(['company', 'uid']) ?? '')) {
      const parsed = parseUid(c.uid);
      if ('error' in parsed) throw new WorkspaceRefusal(`company.uid: ${parsed.error}`, { code: 'uid', params: { detail: c.uid.trim() } });
      c.uid = parsed.uid;
    }
    for (const key of ['name', 'uid', 'owner', 'business'] as const) set(doc, ['company', key], typeof c[key] === 'string' ? c[key]!.trim() : c[key]);
    if (c.address === null) doc.deleteIn(['company', 'address']);
    else if (c.address) {
      if (!isMap(doc.getIn(['company', 'address']))) doc.setIn(['company', 'address'], doc.createNode({}));
      for (const key of ADDRESS_KEYS) set(doc, ['company', 'address', key], c.address[key] === undefined ? null : String(c.address[key]).trim());
    }
  }
  if (patch.vat) {
    const node = doc.createNode(vatSetupYaml(patch.vat)) as YAMLMap;
    const was = doc.getIn(['company', 'vat']);
    node.flow = !isMap(was) || !!was.flow;
    doc.setIn(['company', 'vat'], node);
  }
  const seq = doc.get('bankAccounts');
  if ((patch.banks?.length || patch.addBank || patch.removeBank) && !isSeq(seq)) throw new WorkspaceError(`${path}: bankAccounts must be a list`);
  if (patch.removeBank && isSeq(seq)) {
    const r = patch.removeBank;
    const i = seq.items.findIndex((item) => isMap(item) && item.get('bank') === r.bank && item.get('currency') === r.currency);
    if (i < 0) throw new WorkspaceError(`bankAccounts: no account ${r.bank} ${r.currency}`);
    if ((seq.items[i] as YAMLMap).get('role') === 'owner') throw new WorkspaceError('bankAccounts: the owner\'s account is not an account to remove');
    seq.items.splice(i, 1);
  }
  for (const b of patch.banks ?? []) {
    const i = isSeq(seq) ? seq.items.findIndex((item) => isMap(item) && item.get('bank') === b.bank && item.get('currency') === b.currency) : -1;
    if (i < 0) throw new WorkspaceError(`bankAccounts: no account ${b.bank} ${b.currency}`);
    set(doc, ['bankAccounts', i, 'label'], b.label?.trim());
    set(doc, ['bankAccounts', i, 'iban'], iban(b.iban, `bankAccounts ${b.bank} ${b.currency}`));
  }
  if (patch.addBank && isSeq(seq)) {
    const a = patch.addBank;
    const node = doc.createNode({
      bank: a.bank.trim(), currency: a.currency.trim().toUpperCase(), account: a.account.trim(), label: a.label.trim(), role: a.role ?? roleBefore(a.bank.trim()),
      ...(a.iban?.trim() ? { iban: iban(a.iban, `bankAccounts ${a.bank} ${a.currency}`) } : {}),
      ...(a.statements ? { statements: a.statements } : {}),
    }) as YAMLMap;
    // The new line looks like its neighbours: one-line `{ … }` when they are.
    node.flow = seq.items.length > 0 && isMap(seq.items[0]) && !!seq.items[0].flow;
    seq.items.push(node);
  }
  const inv = patch.invoicing;
  if (inv) {
    if (inv.setup) {
      if (isMap(doc.get('invoicing'))) throw new WorkspaceError(`${path}: invoicing is set up already`);
      const s = inv.setup;
      doc.set('invoicing', doc.createNode({ payTo: { [s.currency]: { account: s.account } }, revenueAccount: s.revenueAccount, paymentTermsDays: s.paymentTermsDays }));
    }
    if (!isMap(doc.get('invoicing'))) throw new WorkspaceError(`${path} has no invoicing block: add one (payTo, revenueAccount) before the layout`);
    if (inv.paymentTermsDays !== undefined) doc.setIn(['invoicing', 'paymentTermsDays'], inv.paymentTermsDays);
    for (const [currency, to] of Object.entries(inv.payTo ?? {})) {
      if (to === null) doc.deleteIn(['invoicing', 'payTo', currency]);
      else if (to) {
        const node = doc.createNode({ account: to.account }) as YAMLMap;
        // Like its neighbours: one-line `{ account: "1021" }` when the other currencies are.
        const sibling = (doc.getIn(['invoicing', 'payTo']) as YAMLMap | undefined)?.items.map((i) => i.value).find(isMap);
        node.flow = !sibling || !!sibling.flow;
        doc.setIn(['invoicing', 'payTo', currency], node);
      }
    }
    const { show, ...layout } = inv.layout ?? {};
    for (const [key, value] of Object.entries(layout)) set(doc, ['invoicing', 'layout', key], value);
    for (const [key, value] of Object.entries(show ?? {})) doc.setIn(['invoicing', 'layout', 'show', key], value);
    for (const [lang, texts] of Object.entries(inv.texts ?? {})) {
      for (const [key, value] of Object.entries(texts)) set(doc, ['invoicing', 'texts', lang, key], value);
    }
  }
  if (patch.sells) {
    if (!isMap(doc.get('profile'))) throw new WorkspaceError(`${path} has no profile: what the firm sells is kept in it (npm run init writes one)`);
    if (!patch.sells.length) throw new WorkspaceError('profile.sells: one kind at least');
    doc.setIn(['profile', 'sells'], profileOf(patch.sells));
    const goods = goodsOf(patch.sells);
    if (goods.length) doc.setIn(['profile', 'goods'], doc.createNode(goods, { flow: true }));
    else doc.deleteIn(['profile', 'goods']);
  }
  if (patch.start) {
    if (!isMap(doc.get('profile'))) throw new WorkspaceError(`${path} has no profile: the starting point is kept in it (npm run init writes one)`);
    doc.setIn(['profile', 'start'], patch.start);
  }
  if (patch.dimensions) {
    if (patch.dimensions.length) doc.set('dimensions', doc.createNode(patch.dimensions.map(dimensionYaml)));
    else doc.delete('dimensions');
  }
  if (patch.outgoingMail === null) doc.delete('outgoingMail');
  else if (patch.outgoingMail) {
    if (!isMap(doc.get('outgoingMail'))) doc.set('outgoingMail', doc.createNode({}));
    for (const [key, value] of Object.entries(patch.outgoingMail)) set(doc, ['outgoingMail', key], typeof value === 'string' ? value.trim() : value);
  }
  // A one-line `{ … }` stays one line however long it grows, a quoted text with \n in it too.
  const out = manifestText(doc);
  return { text: out, manifest: parseManifest(out, path) };
}

/** Applies `patch` to the manifest file; nothing is written when the result would not open. */
export function patchManifest(path: string, patch: ManifestPatch): Manifest {
  const { text, manifest } = patchManifestText(readFileSync(path, 'utf8'), patch, path);
  writeAtomic(path, text);
  return manifest;
}
