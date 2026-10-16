import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { accountsOf, filedReturnsOf } from '../../workspace/reads.js';
import { WS, RequestError, patchBody, readBooks, reopenWorkspace, stringField } from '../books.js';
import { readEstvRateTable } from '../../accounting/fx-rates.js';
import { companyInfo } from '../../books/company.js';
import { WorkspaceError, WorkspaceRefusal } from '../../workspace/workspace.js';
import { patchManifest, type BankPatch, type InvoicingPatch, type MailPatch, type ManifestPatch, type NewBank, type ProfilePatch } from '../../workspace/manifest-write.js';
import { writeAtomic } from '../../invoices/store.js';
import { INVOICE_CURRENCIES, INVOICE_LANGUAGES, LAYOUT_ELEMENTS, OWN_TEXTS } from '../../invoices/model.js';
import { accountName, setAccountName } from '../../workspace/accounts-write.js';
import { assertPlaced } from '../edits.js';
import { account, setCustomerTerms } from '../workspace-edits.js';
import type { Address } from '../../invoices/model.js';
import { changesMethod, parseVatSetup, type VatSetup } from '../../workspace/vat-setup.js';
import { booksOpenPeriod, localToday } from '../../accounting/periods.js';
import { filing } from '../../engines/index.js';

export const router = Router();

/** A refusal of the manifest's or the chart's own checks is the user's to fix: 400 with its text. */
function checked<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof WorkspaceRefusal) throw new RequestError(400, e.message, e.refusal);
    if (e instanceof WorkspaceError) throw new RequestError(400, e.message);
    throw e;
  }
}

router.get('/api/accounts', (_req, res) => {
  res.json(accountsOf(WS));
});

router.put('/api/accounts/:number', (req, res) => {
  const name = stringField(patchBody(req.body, ['name']), 'name');
  // A new account goes only where the statements show it (x07); a rename of one the chart has stays possible.
  if (checked(() => accountName(WS, req.params.number)) === undefined) assertPlaced(req.params.number);
  res.json(checked(() => setAccountName(WS, req.params.number, name)));
});

/** Änderungen › «Rückgängig» of an account added since the last save (r9c-6): removed, unless bookings use it (accountInUse). */
router.delete('/api/accounts/:number', (req, res) => {
  account(WS, readBooks(), req.params.number, null);
  res.json({ ok: true });
});

// The VAT returns as filed with the ESTV (filings/<year>/), read-only.
router.get('/api/vat/filed', (req, res) => {
  const year = String(req.query.year ?? '');
  if (!/^\d{4}$/.test(year)) { res.status(400).json({ error: 'year=YYYY required' }); return; }
  try {
    res.json(filedReturnsOf(WS, year));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// The ESTV daily sell rates the books convert foreign amounts with (reference/, public data).
router.get('/api/fx-rates', (_req, res) => {
  res.json(readEstvRateTable());
});

router.get('/api/workspace', (_req, res) => {
  res.json(companyInfo(WS, readBooks()));
});

const optText = (b: Record<string, unknown>, key: string): string | null | undefined =>
  b[key] === undefined || b[key] === null ? (b[key] as null | undefined) : stringField(b, key);

function profilePatch(raw: unknown): ProfilePatch {
  const b = patchBody(raw, ['name', 'uid', 'owner', 'business', 'address']);
  const out: ProfilePatch = {};
  for (const key of ['name', 'uid', 'owner'] as const) if (b[key] !== undefined) out[key] = stringField(b, key);
  if (b.business !== undefined) out.business = optText(b, 'business');
  if (b.address === null) out.address = null;
  else if (b.address !== undefined) {
    const a = patchBody(b.address, ['street', 'number', 'line2', 'postcode', 'town', 'state', 'country']);
    out.address = Object.fromEntries(Object.keys(a).map((k) => [k, optText(a, k) ?? undefined])) as unknown as Address;
  }
  return out;
}

function bankPatch(raw: unknown): BankPatch {
  const b = patchBody(raw, ['bank', 'currency', 'label', 'iban']);
  const iban = optText(b, 'iban');
  if (iban === null) {
    const bank = WS.bankAccounts.find((a) => a.bank === stringField(b, 'bank') && a.currency === stringField(b, 'currency'));
    const printed = bank && Object.entries(WS.invoicing?.payTo ?? {}).find(([, to]) => to?.account === bank.account);
    if (printed) throw new RequestError(400, `Die IBAN von ${bank.account} steht auf den Rechnungen in ${printed[0]}. Zuerst unter Rechnungslayout › Zahlungskonten ein anderes Konto wählen.`, { code: 'ibanOnInvoices', params: { currency: printed[0], account: bank.account } });
  }
  return { bank: stringField(b, 'bank'), currency: stringField(b, 'currency'), label: optText(b, 'label') ?? undefined, iban };
}

function newBank(raw: unknown): NewBank {
  const b = patchBody(raw, ['bank', 'currency', 'account', 'label', 'iban']);
  return { bank: stringField(b, 'bank'), currency: stringField(b, 'currency'), account: stringField(b, 'account'), label: stringField(b, 'label'), iban: optText(b, 'iban') ?? undefined };
}

/** The layout's values are checked by the manifest's reader; here only their kinds. */
function invoicingPatch(raw: unknown): InvoicingPatch {
  const b = patchBody(raw, ['setup', 'paymentTermsDays', 'layout', 'texts', 'payTo']);
  const out: InvoicingPatch = {};
  if (b.payTo !== undefined) {
    const payTo = patchBody(b.payTo, INVOICE_CURRENCIES);
    out.payTo = Object.fromEntries(Object.entries(payTo).map(([currency, v]) => {
      if (v === null) return [currency, null];
      const account = stringField(patchBody(v, ['account']), 'account');
      // The IBAN may come in the same change (banks); the manifest's reader refuses a payTo without one.
      const bank = WS.bankAccounts.find((a) => a.account === account && a.bank !== 'manual' && a.currency === currency);
      if (!bank) throw new RequestError(400, `Das Konto, auf das Kunden in ${currency} zahlen, muss ein Bankkonto in ${currency} sein.`, { code: 'payToAccount', params: { currency } });
      return [currency, { account }];
    }));
  }
  if (b.paymentTermsDays !== undefined) {
    if (!Number.isInteger(b.paymentTermsDays) || (b.paymentTermsDays as number) < 1 || (b.paymentTermsDays as number) > 120) throw new RequestError(400, 'Zahlungsfrist: 1 bis 120 Tage.');
    out.paymentTermsDays = b.paymentTermsDays as number;
  }
  if (b.setup !== undefined) {
    const s = patchBody(b.setup, ['currency', 'account', 'revenueAccount', 'paymentTermsDays']);
    // Its IBAN may come in the same change (banks); the manifest's reader refuses a payTo without one.
    const bank = WS.bankAccounts.find((a) => a.account === stringField(s, 'account') && a.bank !== 'manual');
    if (!bank) throw new RequestError(400, 'Das Konto, auf das Kunden zahlen, muss ein Bankkonto sein.');
    const days = Number(s.paymentTermsDays ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 120) throw new RequestError(400, 'Zahlungsfrist: 1 bis 120 Tage.');
    if (!/^\d{3,6}$/.test(stringField(s, 'revenueAccount'))) throw new RequestError(400, 'Ertragskonto: eine Kontonummer.');
    out.setup = { currency: bank.currency, account: bank.account, revenueAccount: stringField(s, 'revenueAccount'), paymentTermsDays: days };
  }
  if (b.layout !== undefined) {
    const l = patchBody(b.layout, ['font', 'accent', 'window', 'logo', 'logoPosition', 'logoSize', 'show']);
    const layout: NonNullable<InvoicingPatch['layout']> = {};
    for (const key of ['font', 'accent', 'window', 'logoPosition', 'logoSize'] as const) if (l[key] !== undefined) (layout as Record<string, unknown>)[key] = stringField(l, key);
    if (l.logo !== undefined) layout.logo = optText(l, 'logo');
    if (l.show !== undefined) {
      const show = patchBody(l.show, LAYOUT_ELEMENTS);
      for (const [k, v] of Object.entries(show)) if (typeof v !== 'boolean') throw new RequestError(400, `show.${k}: true oder false.`);
      layout.show = show as NonNullable<typeof layout.show>;
    }
    out.layout = layout;
  }
  if (b.texts !== undefined) {
    const texts = patchBody(b.texts, INVOICE_LANGUAGES);
    out.texts = Object.fromEntries(Object.entries(texts).map(([lang, v]) => {
      const t = patchBody(v, OWN_TEXTS);
      return [lang, Object.fromEntries(OWN_TEXTS.filter((k) => t[k] !== undefined).map((k) => [k, optText(t, k)]))];
    }));
  }
  return out;
}

/**
 * The VAT setup as the Firma page sends it, checked as the manifest's reader checks it. The
 * method rule: registration, method, period and a rate's percent hold for whole years, so a change
 * is refused while the open year holds entries (a label or an activity code may change any time).
 */
function vatPatch(raw: unknown): VatSetup {
  // A refusal the form can meet (an activity code, a rate) carries its code, so the page says it in the person's words (r7f-30).
  const next = parseVatSetup(raw, (msg, refusal) => { throw new RequestError(400, msg, refusal ? { code: 'vatSetup', params: refusal } : undefined); });
  if (!changesMethod(WS.company.vat, next)) return next;
  const books = readBooks();
  const year = booksOpenPeriod(books, localToday(), filing().length).from.slice(0, 4);
  const entries = (books.journalEntries ?? []).filter((e) => e.date.startsWith(year)).length;
  if (entries) {
    throw new RequestError(400, `Die MWST-Einstellung gilt für das ganze Jahr: ${year} hat schon ${entries} Buchungen. Der Wechsel ist auf den 1.1.${Number(year) + 1} möglich, nach dem Jahresabschluss.`, { code: 'vatMethodHeld', params: { year, entries } });
  }
  return next;
}

/** The outgoing mailbox; the manifest's reader checks the values. A password is refused: it never goes into the workspace. */
function mailPatch(raw: unknown): MailPatch | null {
  if (raw === null) return null;
  const b = patchBody(raw, ['host', 'port', 'security', 'user', 'fromName', 'fromAddress', 'replyTo']);
  const out: MailPatch = {};
  for (const key of ['host', 'security', 'user', 'fromName', 'fromAddress', 'replyTo'] as const) if (b[key] !== undefined) (out as Record<string, unknown>)[key] = optText(b, key);
  if (b.port !== undefined) {
    if (b.port !== null && typeof b.port !== 'number') throw new RequestError(400, 'port muss eine Zahl sein.');
    out.port = b.port as number | null;
  }
  return out;
}

const LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };

/**
 * The invoice logo: stored under logos/ by its checksum (a new logo is a new file, so an
 * issued invoice keeps showing the logo it was issued with) and set as the layout's logo.
 */
router.post('/api/workspace/logo', express.raw({ type: Object.keys(LOGO_TYPES), limit: '1500kb' }), (req, res) => {
  const ext = LOGO_TYPES[String(req.headers['content-type'] ?? '').split(';')[0].trim()];
  if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) throw new RequestError(400, 'Logo als PNG, JPEG oder SVG erwartet.');
  const file = `logos/logo-${createHash('sha256').update(req.body).digest('hex').slice(0, 12)}.${ext}`;
  mkdirSync(WS.paths.logos, { recursive: true });
  writeAtomic(join(WS.paths.root, file), req.body);
  checked(() => patchManifest(WS.paths.manifest, { invoicing: { layout: { logo: file } } }));
  reopenWorkspace();
  res.json(companyInfo(WS, readBooks()));
});

/**
 * The company's profile and bank accounts in belege.workspace.yaml, patched field by field
 * (src/workspace/manifest-write.ts). No record of the books changes, so no period is closed to it.
 * A new payment term also goes to every customer who had the old one.
 */
router.patch('/api/workspace', (req, res) => {
  const b = patchBody(req.body, ['company', 'banks', 'addBank', 'invoicing', 'outgoingMail', 'vat']);
  if (b.banks !== undefined && !Array.isArray(b.banks)) throw new RequestError(400, 'banks: eine Liste erwartet.');
  const patch: ManifestPatch = {
    ...(b.vat === undefined ? {} : { vat: vatPatch(b.vat) }),
    ...(b.company === undefined ? {} : { company: profilePatch(b.company) }),
    ...(b.banks === undefined ? {} : { banks: (b.banks as unknown[]).map(bankPatch) }),
    ...(b.addBank === undefined ? {} : { addBank: newBank(b.addBank) }),
    ...(b.invoicing === undefined ? {} : { invoicing: invoicingPatch(b.invoicing) }),
    ...(b.outgoingMail === undefined ? {} : { outgoingMail: mailPatch(b.outgoingMail) }),
  };
  const terms = WS.invoicing?.paymentTermsDays;
  checked(() => patchManifest(WS.paths.manifest, patch));
  const days = patch.invoicing?.paymentTermsDays;
  if (days !== undefined && terms !== undefined) setCustomerTerms(WS, (c) => (c.paymentTermsDays === terms ? days : undefined));
  reopenWorkspace();
  res.json(companyInfo(WS, readBooks()));
});

router.get('/api/config', (_req, res) => {
  res.json(readBooks().config);
});
