/**
 * Changes to belege.workspace.yaml from the Firma page: the company's profile, its bank
 * accounts' labels and IBANs, a new bank account, the invoice layout and texts. ADR 0004: the change is applied to the YAML
 * document as it is on disk, field by field, so its comments, its layout and every field this
 * app does not know stay as they were. The result is checked by the same reader the app opens
 * the workspace with before it replaces the file; a change the reader refuses is never written.
 */
import { readFileSync } from 'node:fs';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';
import { writeAtomic } from '../invoices/store.js';
import type { Address, InvoiceCurrency, InvoiceLanguage, InvoiceLayout, LayoutElement, OWN_TEXTS, OutgoingMail } from '../invoices/model.js';
import { parseIban } from './banks.js';
import { parseManifest, type Manifest } from './manifest.js';
import { vatSetupYaml, type VatSetup } from './vat-setup.js';
import { WORKSPACE_SCHEMA, schemaOf } from './schema.js';
import { WorkspaceError, WorkspaceRefusal } from './workspace.js';
import { parseUid } from './uid.js';

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

export interface NewBank {
  bank: string;
  currency: string;
  account: string;
  label: string;
  iban?: string;
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
  const doc = parseDocument(text);
  if (schemaOf(doc.get('schema'), path) !== WORKSPACE_SCHEMA) {
    throw new WorkspaceError(`${path} has an older format: npm run update before changing it here.`);
  }
  const c = patch.company;
  if (c) {
    // A UID a person changes carries a check digit (r9c-5): a typo is refused. The stored one is no change,
    // so a demo's invented UID (wrong on purpose, tools/demo/generate.ts assertFictionalUids) keeps its profile editable.
    if (typeof c.uid === 'string' && c.uid.trim() !== String(doc.getIn(['company', 'uid']) ?? '')) {
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
    if (r.bank === 'manual') throw new WorkspaceError('bankAccounts: the owner\'s private account (manual) is not a bank account to remove');
    const i = seq.items.findIndex((item) => isMap(item) && item.get('bank') === r.bank && item.get('currency') === r.currency);
    if (i < 0) throw new WorkspaceError(`bankAccounts: no account ${r.bank} ${r.currency}`);
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
      bank: a.bank.trim(), currency: a.currency.trim().toUpperCase(), account: a.account.trim(), label: a.label.trim(),
      ...(a.iban?.trim() ? { iban: iban(a.iban, `bankAccounts ${a.bank} ${a.currency}`) } : {}),
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
  if (patch.outgoingMail === null) doc.delete('outgoingMail');
  else if (patch.outgoingMail) {
    if (!isMap(doc.get('outgoingMail'))) doc.set('outgoingMail', doc.createNode({}));
    for (const [key, value] of Object.entries(patch.outgoingMail)) set(doc, ['outgoingMail', key], typeof value === 'string' ? value.trim() : value);
  }
  // A one-line `{ … }` stays one line however long it grows, a quoted text with \n in it too.
  const out = doc.toString({ lineWidth: 0, doubleQuotedAsJSON: true });
  return { text: out, manifest: parseManifest(out, path) };
}

/** Applies `patch` to the manifest file; nothing is written when the result would not open. */
export function patchManifest(path: string, patch: ManifestPatch): Manifest {
  const { text, manifest } = patchManifestText(readFileSync(path, 'utf8'), patch, path);
  writeAtomic(path, text);
  return manifest;
}
