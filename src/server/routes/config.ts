import { STATEMENT_KINDS, type StatementKind } from '../../workspace/banks.js';
import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { accountsOf, filedReturnsOf } from '../../workspace/reads.js';
import { WS, RequestError, patchBody, readBooks, reopenWorkspace, stringField } from '../books.js';
import { readEstvRateTable } from '../../accounting/fx-rates.js';
import { MANUAL_BANK, MONEY_ROLES, parseIban, type MoneyRole } from '../../workspace/banks.js';
import { isQrIban, qrIbanTakes } from '../../providers/qr-bill/reference.js';
import { companyInfo, type CompanyInfo } from '../../books/company.js';
import { isDemo } from '../../workspace/demo-copy.js';
import { payoutSales, salesDefaults } from '../../workspace/sells.js';
import { WorkspaceError, WorkspaceRefusal } from '../../workspace/workspace.js';
import { patchManifest, type BankPatch, type InvoicingPatch, type MailPatch, type ManifestPatch, type NewBank, type ProfilePatch } from '../../workspace/manifest-write.js';
import { SALES_KINDS, salesKinds, type SalesKind } from '../../workspace/setup.js';
import { DOCUMENT_KINDS, INVOICE_CURRENCIES, INVOICE_LANGUAGES, LAYOUT_ELEMENTS, OWN_TEXTS, PRICES, isBooked, isItem, type DocumentKind, type Issued, type InvoiceLanguage, type PaymentTerms, type UnitDef } from '../../invoices/model.js';
import { DEFAULT_NUMBERING, nextNumberFor, type Numbering } from '../../invoices/numbering.js';
import { numberingFits, sameReference } from '../../providers/qr-bill/reference.js';
import { docRef } from '../../books/refs.js';
import { loadInvoices, writeAtomic } from '../../invoices/store.js';
import { liveDocuments } from '../../invoices/rules.js';
import { accountName, removeAccount, setAccountName } from '../../workspace/accounts-write.js';
import { standardAccounts } from '../../workspace/chart.js';
import { readBankStatements } from '../../workspace/bank-statements.js';
import type { LedgerBankAccount } from '../../workspace/workspace.js';
import type { JournalEntry } from '../../types/index.js';
import { assertPlaced } from '../edits.js';
import { account, setCustomerTerms } from '../workspace-edits.js';
import type { Address } from '../../invoices/model.js';
import { basisSinceOf, changesMethod, parseVatSetup, type VatSetup } from '../../workspace/vat-setup.js';
import { booksOpenPeriod, localToday } from '../../accounting/periods.js';
import { baseCurrency, chart, filing, setup } from '../../engines/index.js';
import { readDimensions, usesOf, type Dimension } from '../../books/tags.js';

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

/** The standard chart's accounts an account field offers to add (F07): only these are created from a field, named as the chart names them. */
router.get('/api/accounts/standard', (_req, res) => {
  res.json(standardAccounts(WS.company.legalForm));
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

/** The firm's default accounts from the setup's «what do you sell?» and the jurisdiction's table (#344); none for a manifest without the answers. */
function firmDefaults(): CompanyInfo['defaults'] {
  const kinds = WS.profile?.sells;
  if (!kinds?.length) return undefined;
  const all = salesDefaults(kinds, setup().sells);
  return { sales: payoutSales(kinds, setup().sells, setup().answers.payouts.sales.otherwise), ...(all.purchase[0] ? { purchase: all.purchase[0].account } : {}), all };
}

/** What GET and PATCH /api/workspace answer: the company's info with its default accounts; a demo says that it is one. */
function workspaceInfo(): CompanyInfo {
  const defaults = firmDefaults();
  return { ...companyInfo(WS, readBooks()), ...(isDemo(WS.paths.root) ? { demo: true as const } : {}), ...(defaults && { defaults }) };
}

router.get('/api/workspace', (_req, res) => {
  res.json(workspaceInfo());
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

/**
 * A new bank account takes a ledger account of its own (r10h-2): on one another bank account already
 * uses, every statement would list under both and the balance sheet would show the account twice.
 */
function newBank(raw: unknown): NewBank {
  const b = patchBody(raw, ['bank', 'currency', 'account', 'label', 'iban', 'role', 'statements']);
  // How its statements are read (#401): a second Wise account under another name still reads as Wise's.
  const statements = b.statements === undefined ? undefined : stringField(b, 'statements');
  if (statements !== undefined && !STATEMENT_KINDS.includes(statements as StatementKind)) throw new RequestError(400, `statements: ${STATEMENT_KINDS.join(', ')}.`);
  const account = stringField(b, 'account').trim();
  // A money account of another kind than a bank's (#216: an employee's, asked once by «Von Mitarbeitenden bezahlt»); never a second owner's.
  const role = b.role === undefined ? undefined : stringField(b, 'role');
  if (role !== undefined && (!MONEY_ROLES.includes(role as MoneyRole) || role === 'owner')) throw new RequestError(400, `role: ${MONEY_ROLES.filter((r) => r !== 'owner').join(', ')}.`);
  const taken = WS.bankAccounts.find((a) => a.account === account);
  if (taken) {
    throw new RequestError(400, `Konto ${account} gehört schon zum Bankkonto ${taken.label} (${taken.bank} ${taken.currency}). Jedes Bankkonto braucht ein eigenes Konto im Kontenplan.`,
      { code: 'ledgerAccountTaken', params: { account, bank: taken.bank, currency: taken.currency, label: taken.label } });
  }
  const bank = stringField(b, 'bank').trim();
  const currency = stringField(b, 'currency').trim();
  // The manifest's own rules, said before it is written: «manual» is the owner's account, and a bank holds each currency once.
  if (bank === MANUAL_BANK) throw new RequestError(400, `Der Name ${MANUAL_BANK} gehört dem Konto des Inhabers.`, { code: 'bankNameManual', params: { bank } });
  if (WS.bankAccounts.some((a) => a.bank === bank && a.currency === currency)) throw new RequestError(400, `${bank} ${currency} gibt es schon unter den Geldkonten.`, { code: 'bankTwice', params: { bank, currency } });
  if (role === 'employee') {
    // What the firm owes the employee (or advanced her) is a balance-sheet account, in a currency the books know.
    const side = chart().sideOf(account);
    if (side !== 'assets' && side !== 'liabilities') throw new RequestError(400, `Konto ${account} ist kein Bilanzkonto: das Konto einer Mitarbeiterin ist eine Schuld oder ein Guthaben der Firma.`, { code: 'moneyAccountSide', params: { account } });
    if (!knownCurrencies().has(currency)) throw new RequestError(400, `Die Währung ${currency} kennen die Bücher nicht: ${[...knownCurrencies()].join(', ')}.`, { code: 'unknownCurrency', params: { currency, known: [...knownCurrencies()].join(', ') } });
  }
  return { bank, currency, account, label: stringField(b, 'label'), iban: optText(b, 'iban') ?? undefined, ...(role ? { role: role as MoneyRole } : {}), ...(statements ? { statements: statements as StatementKind } : {}) };
}

/** The currencies of the books: the base currency, those of the money accounts and those the official rate table converts. */
function knownCurrencies(): Set<string> {
  const table = readEstvRateTable().rates;
  const rated = Object.values(table).flatMap((day) => Object.keys(day ?? {}).filter((k) => /^[A-Z]{3}$/.test(k)));
  return new Set([baseCurrency(), ...WS.bankAccounts.map((a) => a.currency), ...rated]);
}

/**
 * The bank account to take out (r9k-1), refused while the books use it: statements read into it,
 * its payments and their bookings, bookings on its ledger account, invoices paid to it. The refusal
 * counts them, so the page says what to clear first. Books set up before the ledger-account check
 * may hold two bank accounts on one ledger account (r10h-2): then only the bank's own count, so
 * the one added by mistake can still go.
 */
function removedBank(raw: unknown): NonNullable<ManifestPatch['removeBank']> {
  const b = patchBody(raw, ['bank', 'currency']);
  const r = { bank: stringField(b, 'bank'), currency: stringField(b, 'currency') };
  const bank = WS.bankAccounts.find((a) => a.bank === r.bank && a.currency === r.currency);
  if (!bank || bank.role === 'owner') return r;
  const books = readBooks();
  const statements = readBankStatements(WS).filter((f) => f.status === 'read' && f.account.bank === bank.bank && f.account.currency === bank.currency).length;
  const payments = books.transactions.filter((t) => t.bank === bank.bank && t.currency === bank.currency);
  const refs = new Set(payments.map((t) => t.ref));
  const shared = WS.bankAccounts.some((a) => a !== bank && a.account === bank.account);
  const own = (e: JournalEntry) => (e.transactionRef !== undefined && refs.has(e.transactionRef)) || (!shared && (e.accountDebit === bank.account || e.accountCredit === bank.account));
  const entries = books.journalEntries.filter(own).length + payments.length;
  const invoices = Object.entries(WS.invoicing?.payTo ?? {}).filter(([cur, to]) => cur === bank.currency && to?.account === bank.account).length;
  if (statements || entries || invoices) {
    throw new RequestError(400, `Das Bankkonto ${bank.label} (${bank.account}) wird gebraucht: ${statements} Auszüge, ${entries} Buchungen oder Zahlungen, ${invoices} Rechnungskonten. Erst diese entfernen.`,
      { code: 'bankInUse', params: { account: bank.account, label: bank.label, statements, entries, invoices } });
  }
  return r;
}

/**
 * The chart beside the bank accounts (r9k-1): a new bank account's ledger account joins the chart
 * under the bank's label when the chart lacks it, so the year close never blocks on it; a removed
 * bank account takes its ledger account along only when that account was made with it (its name
 * is still the bank's label), no booking is on it and no other bank account uses it.
 */
function chartWithBanks(patch: ManifestPatch, before: readonly LedgerBankAccount[]): void {
  const a = patch.addBank;
  if (a && accountName(WS, a.account.trim()) === undefined) checked(() => setAccountName(WS, a.account.trim(), a.label));
  const r = patch.removeBank;
  const gone = r && before.find((b) => b.bank === r.bank && b.currency === r.currency);
  if (!gone) return;
  const books = readBooks();
  const used = books.journalEntries.some((e) => e.accountDebit === gone.account || e.accountCredit === gone.account) || WS.bankAccounts.some((b) => b.account === gone.account);
  if (!used && accountName(WS, gone.account) === gone.label) removeAccount(WS, gone.account);
}

/**
 * The QR-IBAN of a currency's account (#506): a QR-IBAN or nothing (null, an empty text). Under any
 * currency but CHF it is refused with the warning `qrIbanNotChf` (SIX IG v2.4: QR-IBAN and QR
 * reference for CHF only; v2.3 valid until November 2027) unless the request carries the person's
 * «Trotzdem speichern», `confirm: 'qrIbanNotChf'`; then it is stored like any other value.
 */
function qrIbanOf(to: Record<string, unknown>, currency: string, confirm: unknown): string | null | undefined {
  if (to.qrIban === undefined) return undefined;
  const raw = to.qrIban === null ? '' : stringField(to, 'qrIban');
  if (!raw.trim()) return null;
  const qrIban = parseIban(raw);
  if (!qrIban || !isQrIban(qrIban)) throw new RequestError(400, `${raw.trim()} ist keine QR-IBAN (CH oder LI, Institut 30000 bis 31999, gültige Prüfziffern).`, { code: 'notQrIban', params: { iban: raw.trim() } });
  if (!qrIbanTakes(currency) && confirm !== 'qrIbanNotChf') {
    throw new RequestError(400, `Eine QR-IBAN gilt seit den SIX-Richtlinien v2.4 nur für CHF, nicht für ${currency} (v2.3 gilt bis November 2027, danach weisen Banken sie zurück).`, { code: 'qrIbanNotChf', params: { currency } });
  }
  return qrIban;
}

/**
 * Firma › Rechnungslayout › Nummern: a format per kind, checked with the firm's other formats as they
 * would stand (src/invoices/numbering.ts checkNumbering); a format no number or payment reference can
 * hold is refused with `numberFormat`. It applies from the next number: issued numbers never change.
 */
function numberingPatch(raw: unknown): NonNullable<InvoicingPatch['numbering']> {
  const p = patchBody(raw, DOCUMENT_KINDS);
  const out: NonNullable<InvoicingPatch['numbering']> = {};
  for (const [kind, v] of Object.entries(p)) {
    const f = patchBody(v, ['format', 'restartYearly']);
    if (typeof f.format !== 'string' || (f.restartYearly !== undefined && typeof f.restartYearly !== 'boolean')) throw new RequestError(400, `numbering.${kind}: { format, restartYearly }.`);
    out[kind as DocumentKind] = { format: f.format.trim(), restartYearly: f.restartYearly !== false };
  }
  const merged = { ...(WS.invoicing?.numbering ?? DEFAULT_NUMBERING), ...out };
  const bad = numberingFits(merged) ?? referenceClash(merged, Object.keys(out) as DocumentKind[]);
  if (bad) throw new RequestError(400, `Nummernformat «${merged[bad.kind].format}» (${bad.kind}) geht nicht: ${bad.refusal}.`, { code: 'numberFormat', params: { kind: bad.kind, refusal: bad.refusal, format: merged[bad.kind].format } });
  return out;
}

/**
 * A changed format whose next number would make the payment reference or the booking ref of a
 * document issued already (2026-001 then 2026001 make one QR reference): refused as `referenceTaken`.
 */
function referenceClash(n: Numbering, changed: readonly DocumentKind[]): { kind: DocumentKind; refusal: 'referenceTaken' } | undefined {
  const docs = liveDocuments(loadInvoices(WS));
  const issued = docs.filter((d): d is Issued => d.status === 'issued' && isBooked(d));
  const today = new Date().toISOString().slice(0, 10);
  for (const kind of changed.filter((k) => k === 'invoice' || k === 'credit-note')) {
    const next = nextNumberFor(docs, kind, today, n);
    if (issued.some((d) => sameReference(next, d.number) || docRef(d) === docRef({ number: next, kind }))) return { kind, refusal: 'referenceTaken' };
  }
  return undefined;
}

/** The layout's values are checked by the manifest's reader; here only their kinds. */
function invoicingPatch(raw: unknown): InvoicingPatch {
  const out: InvoicingPatch = {};
  const b = patchBody(raw, ['setup', 'paymentTermsDays', 'layout', 'texts', 'payTo', 'confirm', 'units', 'prices', 'paymentTerms', 'defaultTerms', 'numbering']);
  if (b.numbering !== undefined) out.numbering = numberingPatch(b.numbering);
  if (b.paymentTerms !== undefined) out.paymentTerms = b.paymentTerms === null ? null : termsPatch(b.paymentTerms);
  if (b.defaultTerms !== undefined) {
    if (b.defaultTerms !== null && typeof b.defaultTerms !== 'string') throw new RequestError(400, 'defaultTerms: die Id einer Zahlungskondition.');
    out.defaultTerms = b.defaultTerms as string | null;
  }
  if (b.units !== undefined) out.units = b.units === null ? null : unitsPatch(b.units);
  if (b.prices !== undefined) {
    const p = patchBody(b.prices, DOCUMENT_KINDS);
    for (const [kind, v] of Object.entries(p)) if (v !== null && !PRICES.includes(v as never)) throw new RequestError(400, `prices.${kind}: net oder gross.`);
    out.prices = p as NonNullable<InvoicingPatch['prices']>;
  }
  if (b.payTo !== undefined) {
    const payTo = patchBody(b.payTo, INVOICE_CURRENCIES);
    out.payTo = Object.fromEntries(Object.entries(payTo).map(([currency, v]) => {
      if (v === null) return [currency, null];
      const to = patchBody(v, ['account', 'qrIban']);
      const account = stringField(to, 'account');
      // The IBAN may come in the same change (banks); the manifest's reader refuses a payTo without one.
      const bank = WS.bankAccounts.find((a) => a.account === account && a.role === 'bank' && a.currency === currency);
      if (!bank) throw new RequestError(400, `Das Konto, auf das Kunden in ${currency} zahlen, muss ein Bankkonto in ${currency} sein.`, { code: 'payToAccount', params: { currency } });
      const qrIban = qrIbanOf(to, currency, b.confirm);
      return [currency, { account, ...(qrIban !== undefined ? { qrIban } : {}) }];
    }));
  }
  if (b.paymentTermsDays !== undefined) {
    if (!Number.isInteger(b.paymentTermsDays) || (b.paymentTermsDays as number) < 1 || (b.paymentTermsDays as number) > 120) throw new RequestError(400, 'Zahlungsfrist: 1 bis 120 Tage.');
    out.paymentTermsDays = b.paymentTermsDays as number;
  }
  if (b.setup !== undefined) {
    const s = patchBody(b.setup, ['currency', 'account', 'revenueAccount', 'paymentTermsDays']);
    // Its IBAN may come in the same change (banks); the manifest's reader refuses a payTo without one.
    const bank = WS.bankAccounts.find((a) => a.account === stringField(s, 'account') && a.role === 'bank');
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
 * The firm's payment terms as Firma › Rechnungslayout sends them: the whole list, each term's id
 * made from its name when it has none; the manifest's reader checks the values (days, Skonto).
 * An issued invoice keeps the terms it printed, so a term may go any time.
 */
function termsPatch(raw: unknown): PaymentTerms[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new RequestError(400, 'paymentTerms: eine Liste mit mindestens einer Zahlungskondition.');
  const taken = new Set<string>();
  return raw.map((x, i) => {
    const f = patchBody(x, ['id', 'name', 'days', 'skonto', 'text']);
    const name = stringField(f, 'name').trim();
    if (!name) throw new RequestError(400, `paymentTerms[${i}].name fehlt.`);
    if (typeof f.days !== 'number') throw new RequestError(400, `paymentTerms[${i}].days: eine Zahl von Tagen.`);
    const base = (typeof f.id === 'string' && f.id.trim()) || name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'terms';
    let id = base;
    for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
    taken.add(id);
    const sk = f.skonto === undefined || f.skonto === null ? undefined : patchBody(f.skonto, ['percent', 'days']);
    const text = typeof f.text === 'string' && f.text.trim() ? f.text.trim() : undefined;
    return { id, name, days: f.days, ...(sk ? { skonto: { percent: sk.percent as number, days: sk.days as number } } : {}), ...(text ? { text } : {}) };
  });
}

/**
 * The firm's units as Firma › Rechnungslayout sends them: the whole list. A unit a draft still uses
 * stays (an issued document keeps the words it was issued with): its removal is refused with the
 * drafts that name it.
 */
function unitsPatch(raw: unknown): UnitDef[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new RequestError(400, 'units: eine Liste mit mindestens einer Einheit.');
  const units = raw.map((u, i) => {
    const f = patchBody(u, ['id', ...INVOICE_LANGUAGES]);
    const id = stringField(f, 'id').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,15}$/i.test(id)) throw new RequestError(400, `units[${i}].id: ein kurzes Kürzel (Buchstaben, Ziffern, - oder _).`, { code: 'unitId', params: { id } });
    const words = Object.fromEntries(INVOICE_LANGUAGES.map((l) => {
      const w = typeof f[l] === 'string' ? (f[l] as string).trim() : '';
      if (!w) throw new RequestError(400, `units[${i}].${l}: das Wort der Einheit fehlt.`, { code: 'unitWord', params: { id, language: l } });
      return [l, w];
    })) as Record<InvoiceLanguage, string>;
    return { id, ...words };
  });
  const twice = units.find((u, i) => units.findIndex((x) => x.id === u.id) !== i);
  if (twice) throw new RequestError(400, `units: ${twice.id} steht zweimal.`, { code: 'unitTwice', params: { id: twice.id } });
  const kept = new Set(units.map((u) => u.id));
  const used = liveDocuments(loadInvoices(WS)).filter((i) => i.status === 'draft').flatMap((i) => i.lines.flatMap((l) => (isItem(l) && l.unit && !kept.has(l.unit) ? [l.unit] : [])));
  if (used.length) throw new RequestError(409, `Die Einheit ${used[0]} steht in einem Entwurf: dort zuerst ändern.`, { code: 'unitInUse', params: { id: used[0] } });
  return units;
}

/**
 * The VAT setup as the Firma page sends it, checked as the manifest's reader checks it. The
 * method rule: registration, method, period and a rate's percent hold for whole years, so a change
 * is refused while the open year holds entries (a label or an activity code may change any time).
 */
/** What the firm sells: one kind at least, of made, traded, services. */
function sellsPatch(raw: unknown): SalesKind[] {
  const kinds = Array.isArray(raw) ? salesKinds(raw.filter((v): v is string => typeof v === 'string')) : [];
  if (!kinds.length || kinds.length !== (raw as unknown[]).length) throw new RequestError(400, `sells: eine Liste aus ${SALES_KINDS.join(', ')}, mindestens eines.`);
  return kinds;
}

function vatPatch(raw: unknown): VatSetup {
  // A refusal the form can meet (an activity code, a rate) carries its code, so the page says it in the person's words (r7f-30).
  const next = parseVatSetup(raw, (msg, refusal) => { throw new RequestError(400, msg, refusal ? { code: 'vatSetup', params: refusal } : undefined); });
  const was = WS.company.vat;
  // The form sends no year: the one the manifest holds stays, a switch of the basis sets it.
  const since = (year: number | undefined): VatSetup => (next.registered && next.reportingSince === undefined && year !== undefined ? { ...next, reportingSince: year } : next);
  if (!changesMethod(was, next)) return since(basisSinceOf(was));
  const books = readBooks();
  const year = booksOpenPeriod(books, localToday(), filing().length).from.slice(0, 4);
  const entries = (books.journalEntries ?? []).filter((e) => e.date.startsWith(year)).length;
  if (entries) {
    throw new RequestError(400, `Die MWST-Einstellung gilt für das ganze Jahr: ${year} hat schon ${entries} Buchungen. Der Wechsel ist auf den 1.1.${Number(year) + 1} möglich, nach dem Jahresabschluss.`, { code: 'vatMethodHeld', params: { year, entries } });
  }
  // A new basis holds from the open year: a document of an earlier year is an open item of the switch (MWSTV Art. 106), one of a later year belongs to its own return.
  const switched = next.registered && (!was.registered || was.reporting !== next.reporting);
  return since(switched ? Number(year) : basisSinceOf(was));
}

/**
 * Firma › Dimensionen (#127): the whole list as the manifest's reader checks it. A dimension taken
 * out that bookings still carry a value of is refused with their count: their tags would name a
 * dimension the firm no longer has. Values come and go freely; a booking keeps the value it carries.
 */
function dimensionsPatch(raw: unknown): Dimension[] {
  const next = readDimensions(raw, (msg) => { throw new RequestError(400, msg); });
  const entries = readBooks().journalEntries ?? [];
  for (const d of WS.dimensions ?? []) {
    const n = next.some((x) => x.id === d.id) ? 0 : usesOf(d.id, entries);
    if (n) throw new RequestError(400, `Die Dimension ${d.label} tragen noch ${n} Buchungen: erst ihre Werte dort entfernen.`, { code: 'dimensionInUse', params: { dimension: d.label, entries: n } });
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
  res.json(workspaceInfo());
});

/**
 * The company's profile and bank accounts in belege.workspace.yaml, patched field by field
 * (src/workspace/manifest-write.ts). No record of the books changes, so no period is closed to it.
 * A new payment term also goes to every customer who had the old one.
 */
router.patch('/api/workspace', (req, res) => {
  const b = patchBody(req.body, ['company', 'banks', 'addBank', 'removeBank', 'invoicing', 'outgoingMail', 'vat', 'sells', 'dimensions']);
  if (b.banks !== undefined && !Array.isArray(b.banks)) throw new RequestError(400, 'banks: eine Liste erwartet.');
  const patch: ManifestPatch = {
    ...(b.vat === undefined ? {} : { vat: vatPatch(b.vat) }),
    ...(b.company === undefined ? {} : { company: profilePatch(b.company) }),
    ...(b.banks === undefined ? {} : { banks: (b.banks as unknown[]).map(bankPatch) }),
    ...(b.addBank === undefined ? {} : { addBank: newBank(b.addBank) }),
    ...(b.removeBank === undefined ? {} : { removeBank: removedBank(b.removeBank) }),
    ...(b.invoicing === undefined ? {} : { invoicing: invoicingPatch(b.invoicing) }),
    ...(b.outgoingMail === undefined ? {} : { outgoingMail: mailPatch(b.outgoingMail) }),
    ...(b.sells === undefined ? {} : { sells: sellsPatch(b.sells) }),
    ...(b.dimensions === undefined ? {} : { dimensions: dimensionsPatch(b.dimensions) }),
  };
  const terms = WS.invoicing?.paymentTermsDays;
  const banksBefore = WS.bankAccounts;
  checked(() => patchManifest(WS.paths.manifest, patch));
  const days = patch.invoicing?.paymentTermsDays;
  if (days !== undefined && terms !== undefined) setCustomerTerms(WS, (had) => (had === terms ? days : undefined));
  reopenWorkspace();
  chartWithBanks(patch, banksBefore);
  reopenWorkspace();
  res.json(workspaceInfo());
});

router.get('/api/config', (_req, res) => {
  res.json(readBooks().config);
});
