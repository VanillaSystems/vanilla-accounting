/**
 * The AI sidebar's changes outside the books (src/types/assistant.ts WorkspaceChange): an account
 * of the chart, the invoicing settings, an invoice draft. Each goes through the write path the
 * Firma page and Rechnungen use (accounts-write, manifest-write, the invoices' service), refuses
 * what they refuse, and returns the change that undoes it. No record of the books changes, so no
 * period is closed to them.
 */
import type { Books } from '../books/store.js';
import { accountName, removeAccount, setAccountName } from '../workspace/accounts-write.js';
import { assertPlaced } from './edits.js';
import { patchManifest } from '../workspace/manifest-write.js';
import { WorkspaceError, type Workspace } from '../workspace/workspace.js';
import { createCustomer, createDraft, parseCustomer, parseDraftPatch, removeDraft } from '../invoices/service.js';
import { loadInvoices, updateInvoices } from '../invoices/store.js';
import { InvoiceRuleError, liveCustomers, liveInvoices } from '../invoices/rules.js';
import type { Customer, CustomerFields } from '../invoices/model.js';
import type { ChangeNote, InvoicingSet, WorkspaceChange } from '../types/assistant.js';
import { RequestError } from './books.js';
import { askQuestion, closeQuestion, openQuestionOn } from './questions.js';

export interface Applied { undo?: WorkspaceChange; note?: ChangeNote }

/** A refusal of the chart's, the manifest's or the invoices' own checks: 400 with its text, an invoice's with its rule and what is missing. */
function checked<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof InvoiceRuleError) throw new RequestError(400, e.message, { code: 'invoice', params: { refusal: e.code, ...(e.missing ? { missing: e.missing } : {}) } });
    if (e instanceof WorkspaceError) throw new RequestError(400, e.message);
    throw e;
  }
}

function account(ws: Workspace, books: Books, number: string, name: string | null): Applied {
  if (name !== null) {
    const was = checked(() => accountName(ws, number));
    // A new account goes only where the statements show it (x07); an undo of a rename puts back a name.
    if (was === undefined) assertPlaced(number);
    checked(() => setAccountName(ws, number, name));
    return { undo: { kind: 'account', number, name: was ?? null } };
  }
  const entries = books.journalEntries.filter((e) => e.accountDebit === number || e.accountCredit === number).length;
  if (entries) throw new RequestError(400, `Konto ${number} hat ${entries} Buchungen: es bleibt im Kontenplan.`, { code: 'accountInUse', params: { account: number, entries } });
  const was = removeAccount(ws, number);
  return was === undefined ? {} : { undo: { kind: 'account', number, name: was } };
}

/**
 * The payment term and the texts of Firma › Rechnungslayout. A new term also goes to every
 * customer who had the old one (each customer keeps a term of their own, copied when they were
 * added); a customer with a term of their own keeps it. `customers` (an undo) sets each back.
 */
function invoicing(ws: Workspace, set: InvoicingSet, customers: Record<string, number> | undefined): Applied {
  const settings = ws.invoicing;
  if (!settings) throw new RequestError(400, 'Rechnungen sind noch nicht eingerichtet: Firma › Rechnungslayout fragt zuerst das Konto und die Zahlungsfrist.', { code: 'invoicingNotSetUp' });
  const before: InvoicingSet = {};
  if (set.paymentTermsDays !== undefined) before.paymentTermsDays = settings.paymentTermsDays;
  if (set.texts) {
    before.texts = Object.fromEntries(Object.entries(set.texts).map(([lang, texts]) => [lang,
      Object.fromEntries(Object.keys(texts ?? {}).map((k) => [k, (settings.texts[lang as keyof typeof settings.texts] as Record<string, string> | undefined)?.[k] ?? null]))]));
  }
  checked(() => patchManifest(ws.paths.manifest, { invoicing: { ...(set.paymentTermsDays !== undefined ? { paymentTermsDays: set.paymentTermsDays } : {}), ...(set.texts ? { texts: set.texts } : {}) } }));
  const moved = customers ? setCustomerTerms(ws, (c) => customers[c.id])
    : set.paymentTermsDays !== undefined ? setCustomerTerms(ws, (c) => (c.paymentTermsDays === settings.paymentTermsDays ? set.paymentTermsDays : undefined)) : {};
  const n = Object.keys(moved).length;
  return { undo: { kind: 'invoicing', set: before, ...(n ? { customers: moved } : {}) }, ...(n ? { note: { customers: n } } : {}) };
}

/**
 * Each customer's payment term that `to` names; returns the terms they had. A new default term
 * goes to every customer who had the old one (Firma › Rechnungslayout by hand does the same).
 */
export function setCustomerTerms(ws: Pick<Workspace, 'paths'>, to: (c: Customer) => number | undefined): Record<string, number> {
  const moved: Record<string, number> = {};
  updateInvoices(ws, (book) => {
    for (const c of liveCustomers(book)) {
      const days = to(c);
      if (days === undefined || days === c.paymentTermsDays) continue;
      moved[c.id] = c.paymentTermsDays;
      book.customers[book.customers.indexOf(c)] = { ...c, paymentTermsDays: days };
    }
  });
  return moved;
}

/** A draft for a customer of the invoices, or for a new one added with it: the same draft «N» in Rechnungen writes. */
function invoiceDraft(ws: Workspace, c: Extract<WorkspaceChange, { kind: 'invoiceDraft' }>): Applied {
  return checked(() => {
    const { clear: _, ...draft } = parseDraftPatch(c.draft, loadInvoices(ws));
    const fields = c.newCustomer ? parseCustomer({ language: 'de', ...c.newCustomer }, false) : undefined;
    const customer = fields ? createCustomer(ws, fields as CustomerFields) : liveCustomers(loadInvoices(ws)).find((x) => x.id === c.customer);
    if (!customer) throw new RequestError(400, 'Diesen Kunden gibt es nicht: einen neuen mit newCustomer anlegen.', { code: 'unknownCustomer' });
    const made = createDraft(ws, { ...draft, customerId: customer.id });
    return { undo: { kind: 'dropInvoiceDraft', id: made.id, ...(fields ? { customer: customer.id } : {}) }, note: { draft: { id: made.id, customer: customer.name } } };
  });
}

/** The draft goes as a person deletes one; a customer added with it goes too, while no other invoice names them. */
function dropInvoiceDraft(ws: Workspace, id: string, customer: string | undefined): Applied {
  checked(() => removeDraft(ws, id));
  if (customer) {
    updateInvoices(ws, (book) => {
      const i = book.customers.findIndex((c) => c.id === customer);
      if (i >= 0 && !liveInvoices(book).some((inv) => inv.customerId === customer)) book.customers[i] = { ...book.customers[i], deleted: true };
    });
  }
  return {};
}

/** Who the AI's questions are by: the UI says «KI» in the person's language (origin assistant). */
const AI = 'KI';

/**
 * The AI's question goes to the owner unless it names someone; a precedent may answer it at once.
 * A question open already about the same payment stands instead: nothing is asked twice, and the
 * card shows the open one.
 */
function question(ws: Workspace, c: Extract<WorkspaceChange, { kind: 'question' }>): Applied {
  const open = openQuestionOn(c.on);
  if (open) return { note: { question: { id: open.id, ...(open.to ? { to: open.to } : {}), open: { on: open.on, text: open.text, by: open.by, ...(open.topic ? { topic: open.topic } : {}) } } } };
  const q = askQuestion({ on: c.on, by: AI, text: c.text, choices: c.choices ?? [], to: c.to ?? ws.company.owner, origin: 'assistant' });
  return { undo: { kind: 'withdrawQuestion', id: q.id }, note: { question: { id: q.id, ...(q.to ? { to: q.to } : {}), ...(q.answer ? { answered: q.answer.by } : {}) } } };
}

/** One change; the manifest is read again by the caller (reopenWorkspace) after an invoicing change. */
export function applyWorkspaceChange(ws: Workspace, books: Books, c: WorkspaceChange): Applied {
  switch (c.kind) {
    case 'account': return account(ws, books, c.number, c.name);
    case 'invoicing': return invoicing(ws, c.set, c.customers);
    case 'invoiceDraft': return invoiceDraft(ws, c);
    case 'dropInvoiceDraft': return dropInvoiceDraft(ws, c.id, c.customer);
    case 'question': return question(ws, c);
    case 'withdrawQuestion': closeQuestion(c.id, AI, 'withdrawn'); return {};
  }
}
