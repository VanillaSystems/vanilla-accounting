/**
 * The AI sidebar's changes outside the books (src/types/assistant.ts WorkspaceChange): an account
 * of the chart, the invoicing settings, an invoice draft, a question, a mailbox source drafted. Each goes through the write path the
 * Firma page and Rechnungen use (accounts-write, manifest-write, the invoices' service), refuses
 * what they refuse, and returns the change that undoes it. No record of the books changes, so no
 * period is closed to them.
 */
import type { Books } from '../books/store.js';
import { accountName, removeAccount, setAccountName } from '../workspace/accounts-write.js';
import { assertPlaced } from './edits.js';
import { patchManifest } from '../workspace/manifest-write.js';
import { APP_ROOT, WorkspaceError, type Workspace } from '../workspace/workspace.js';
import { createCustomer, createDraft, parseCustomer, parseDraftPatch, removeDraft } from '../invoices/service.js';
import { loadInvoices, updateInvoices } from '../invoices/store.js';
import { InvoiceRuleError, liveCustomers, liveInvoices } from '../invoices/rules.js';
import type { Customer, CustomerFields } from '../invoices/model.js';
import type { Change, ChangeNote, InvoicingSet, WorkspaceChange } from '../types/assistant.js';
import { RequestError } from './books.js';
import { askQuestion, closeQuestion, openQuestionOn } from './questions.js';
import { sources, withdrawApproval } from '../platform/sources/index.js';
import { mailInputProblem, mailSourceSlot, removeMailSource, writeMailSource, type MailSourceInput } from '../platform/sources/mail-setup.js';
import { mailSecret, secrets } from '../secrets/secrets.js';
import { domainOf, lookupMailHost } from '../platform/sources/mail-host.js';
import { restoreSource, SourceDraftError, takeSourceDraft } from '../platform/sources/draft.js';
import { secretKey } from '../platform/sources/model.js';
import { resolveMx } from 'node:dns/promises';
import { answerQuestion, markTopic } from '../onboarding/store.js';
import type { Answer } from '../onboarding/model.js';

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

/** An account named (added or renamed), or removed with `name` null; a removal of an account with bookings is refused (accountInUse). */
export function account(ws: Workspace, books: Books, number: string, name: string | null): Applied {
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

/**
 * A mailbox drafted from the sidebar, as «Postfach verbinden» in Firma › Quellen drafts it: its
 * source folder, waiting to be switched on; no password (the card puts it into the secret store).
 * A mailbox the workspace holds already is not drafted again: its card stands instead.
 */
function mailbox(ws: Workspace, c: Extract<WorkspaceChange, { kind: 'mailbox' }>): Applied {
  const domain = c.address.split('@')[1] ?? '';
  if (!c.host) throw new RequestError(400, `Für ${domain} ist kein IMAP-Server bekannt.`, { code: 'mailHostUnknown', params: { domain } });
  const input: MailSourceInput = { address: c.address, host: c.host, ...(c.account ? { account: c.account } : {}), ...(c.label ? { label: c.label } : {}) };
  const problem = mailInputProblem(input);
  if (problem) throw new RequestError(400, `Das Feld ${problem} ist nicht gültig.`, { code: 'mailSourceField', params: { field: problem } });
  const { id, existing } = mailSourceSlot(c.address, sources(ws, APP_ROOT));
  if (existing) return { note: { mailbox: { id, existing: true } } };
  writeMailSource(ws, id, input);
  return { undo: { kind: 'dropMailbox', id }, note: { mailbox: { id } } };
}

/** The answer's mailboxes with their IMAP server: one the answer names, else the one the domain's MX records point to (as Belege's «Weg hinzufügen» guesses it). */
export async function withMailHosts(changes: Change[]): Promise<Change[]> {
  return Promise.all(changes.map(async (c) => {
    if (c.kind !== 'mailbox' || c.host) return c;
    const domain = domainOf(c.address);
    const host = domain ? (await lookupMailHost(domain, resolveMx)).host : undefined;
    return host ? { ...c, host } : c;
  }));
}

/** The undo of a mailbox drafted: its folder, its switch and its password go, so the same mailbox drafted again waits to be switched on anew. */
function dropMailbox(ws: Workspace, id: string): Applied {
  removeMailSource(ws, id);
  withdrawApproval(ws, id);
  if (secrets.inApp()) secrets.set(mailSecret(id), null).catch((e: Error) => console.error(`mailbox ${id}: ${e.message}`));
  return {};
}

/**
 * A source the AI wrote with the person, taken from its draft into the workspace, waiting to be
 * switched on; refused with the loader's problems, or when a file holds a secret.
 */
function source(ws: Workspace, c: Extract<WorkspaceChange, { kind: 'source' }>): Applied {
  try {
    const { previous, label } = takeSourceDraft(ws, c.id, APP_ROOT);
    return { undo: { kind: 'dropSource', id: c.id, ...(previous ? { previous } : {}) }, note: { source: { id: c.id, label, ...(previous ? { replaced: true } : {}) } } };
  } catch (e) {
    if (e instanceof SourceDraftError) throw new RequestError(400, e.message, e.refusal);
    throw e;
  }
}

/** The undo of a source taken in: what the folder held before, or nothing, its switch and secrets with it. */
function dropSource(ws: Workspace, id: string, previous?: Record<string, string>): Applied {
  restoreSource(ws, id, previous);
  if (!previous && secrets.inApp()) {
    for (const channel of ['mail', 'api'] as const) secrets.set(secretKey(id, channel), null).catch((e: Error) => console.error(`source ${id}: ${e.message}`));
  }
  return {};
}

/** The profile's starting point, as the setup's «Ausgangslage» answer sets it; none to set, or a manifest without a profile, leaves it. */
function setStart(ws: Workspace, start: 'new' | 'switching' | undefined): void {
  if (!start || !ws.profile || ws.profile.start === start) return;
  checked(() => patchManifest(ws.paths.manifest, { start }));
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
    case 'mailbox': return mailbox(ws, c);
    case 'dropMailbox': return dropMailbox(ws, c.id);
    case 'source': return source(ws, c);
    case 'dropSource': return dropSource(ws, c.id, c.previous);
    case 'setupTopic': {
      const { was } = markTopic(ws, c.topic, c.state, new Date().toISOString());
      return { undo: { kind: 'setupTopic', topic: c.topic, state: was } };
    }
    case 'setupAnswer': {
      const now = new Date().toISOString();
      const before = ws.profile?.start;
      const { was } = answerQuestion(ws, c.question, c.value === null ? undefined : { value: c.value, at: now } as Answer, now);
      // Her «Ausgangslage» in words (#496) is the profile's starting point; the undo puts back the one it replaced.
      if (c.question === 'startingPoint') setStart(ws, c.value === null ? c.start : c.value as 'new' | 'switching');
      return { undo: { kind: 'setupAnswer', question: c.question, value: was?.value ?? null, ...(c.question === 'startingPoint' && before ? { start: before } : {}) } };
    }
  }
}
