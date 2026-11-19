/**
 * A demo company's invoicing, played through the app's own invoicing service on a scratch copy of
 * the workspace: customers created, invoices drafted, issued (numbered, frozen, printed to PDF by
 * the installed Chromium), sent, reminded, credited, cancelled, commented, each at its own time.
 * The paid invoices' payments are part of the year's bank statements (invoicePayments); the
 * generator lets the app's payment matcher book them (src/invoices/payments.ts).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { partDirs, workspaceAt, type Workspace } from '../../src/workspace/workspace.js';
import { addArticles, addComment, cancelInvoice, createCreditNote, createCustomer, createDraft, issueInvoice, recordSend, sendReminder } from '../../src/invoices/service.js';
import { closeBrowser } from '../../src/invoices/pdf.js';
import { idSource, updateInvoices } from '../../src/invoices/store.js';
import type { CustomerFields, InvoiceBook, Issued } from '../../src/invoices/model.js';
import { qrReference, scorReference } from '../../src/providers/qr-bill/reference.js';
import { liveInvoices, openAmount, skontoOf, totals, withPayment, withWriteOff } from '../../src/invoices/rules.js';
import { TEXTS } from '../../src/invoices/texts.js';
import { allocatePayment, recordHandPayment, writeOffRest, type PaymentContext, type PaymentOutcome } from '../../src/invoices/payments.js';
import { matchStatementRows } from '../../src/books/bank-import.js';
import { periodLock, type Books } from '../../src/books/store.js';
import type { BankTransaction } from '../../src/types/index.js';
import { mulberry32, r2, YEAR, type DemoInvoicing, type DemoSend, type Part, type Payment } from './kit.js';

/** The number each issued document gets: issued in step order, numbered per year from 001. */
export function numbersOf(inv: DemoInvoicing): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of inv.steps) if (s.do === 'issue' || s.do === 'credit') out.set(s.key, `${YEAR}-${String(out.size + 1).padStart(3, '0')}`);
  return out;
}

/** The reference an invoice carries (src/providers/qr-bill/reference.ts referenceFor): QRR to a CHF QR-IBAN, else SCOR. */
const referenceOf = (inv: DemoInvoicing, number: string, currency = 'CHF') => (inv.qrr && currency === 'CHF' ? qrReference(number) : scorReference(number));

/**
 * The bank rows of the demo's invoices, as the customers' banks send them: an invoice paid by its
 * reference (all of it, or `amount`); the row that confirms a Zahlungseingang entered by hand; one
 * payment without a reference that the person ausziffert over several invoices.
 */
export function invoicePayments(inv: DemoInvoicing): Payment[] {
  const numbers = numbersOf(inv);
  const issued = new Map(inv.steps.flatMap((s) => (s.do === 'issue' ? [[s.key, s] as const] : [])));
  const row = (bank: string, date: string, customer: CustomerFields, part: Omit<Part, 'counterparty'>): Payment => ({
    bank, date, text: `Gutschrift ${customer.name}`, parts: [{ counterparty: customer.name.toUpperCase(), ...part }],
  });
  return inv.steps.flatMap((s): Payment[] => {
    if (s.do === 'issue' && s.paid) {
      const number = numbers.get(s.key)!;
      const customer = inv.customers[s.customer];
      return [row(s.paid.bank, s.paid.date, customer, {
        reference: referenceOf(inv, number, s.currency), text: `${TEXTS[customer.language].invoice} ${number}`,
        legs: [{ account: '', amount: s.paid.amount ?? totals(s).gross, text: '' }], invoice: number,
      })];
    }
    if (s.do === 'hand' && s.statement) {
      const of = issued.get(s.of)!;
      const customer = inv.customers[of.customer];
      return [row(s.statement.bank, s.statement.date, customer, {
        text: `${TEXTS[customer.language].invoice} ${numbers.get(s.of)}`,
        legs: [{ account: '', amount: s.amount ?? totals(of).gross, text: '' }], settles: { kind: 'hand', step: s.key },
      })];
    }
    if (s.do === 'allocate') {
      return [{
        bank: s.bank, date: s.at.slice(0, 10), text: `Gutschrift ${s.payer}`, parts: [{
          counterparty: s.payer.toUpperCase(), text: s.text.replace(/\{(\w+)\}/g, (_, k: string) => numbers.get(k) ?? `{unknown ${k}}`),
          legs: [{ account: '', amount: r2(s.parts.reduce((t, p) => t + p.amount, 0)), text: '' }], settles: { kind: 'allocate', step: s.key },
        }],
      }];
    }
    return [];
  });
}

/** A paid invoice's payment as the bank statement holds it. */
export interface DemoPayment { number: string; transactionRef: string; date: string; amount: number }

/**
 * Plays the steps on a scratch workspace holding `manifest`; returns it, to be read and then
 * removed, and each step key's document id. Before each step, the payments that arrived by then are allocated to their invoices,
 * as the import of that day's statement would have (the generator books them afterwards).
 */
export async function playInvoicing(inv: DemoInvoicing, manifest: string, owner: string, payments: DemoPayment[]): Promise<{ ws: Workspace; ids: Map<string, string> }> {
  const root = mkdtempSync(join(tmpdir(), 'belege-demo-invoices-'));
  writeFileSync(join(root, 'belege.workspace.yaml'), manifest);
  if (inv.logo) {
    mkdirSync(dirname(join(root, inv.logo.file)), { recursive: true });
    writeFileSync(join(root, inv.logo.file), inv.logo.svg);
  }
  const ws = workspaceAt(root);
  const ids = new Map<string, string>();
  try {
    const customerIds = new Map<string, string>();
    for (const [key, fields] of Object.entries(inv.customers)) customerIds.set(key, createCustomer(ws, fields, `${YEAR}-07-01T08:00:00.000Z`).id);
    const expected = numbersOf(inv);
    const arrived = (until: string) => updateInvoices(ws, (book) => {
      for (const p of payments.filter((x) => x.date <= until)) {
        const at = book.invoices.findIndex((i) => i.status === 'issued' && i.number === p.number);
        if (at < 0) continue;
        const before = book.invoices[at] as Issued;
        if (before.payments.some((x) => x.transactionRef === p.transactionRef)) continue;
        // As the import's matcher does (src/invoices/payments.ts matchPayments): a Skonto within the printed days is written off by code with the payment.
        const skonto = skontoOf(before, liveInvoices(book), p.amount, p.date);
        const paid = withPayment(before, { transactionRef: p.transactionRef, date: p.date, amount: p.amount, by: 'reference' });
        book.invoices[at] = skonto === undefined ? paid
          : withWriteOff(paid, liveInvoices(book), { date: p.date, amount: skonto, reason: 'skonto', by: 'code', transactionRef: p.transactionRef }).invoice;
      }
    });
    for (const s of inv.steps) {
      arrived(s.at.slice(0, 10));
      if (s.do === 'issue' || s.do === 'draft') {
        const customer = inv.customers[s.customer];
        const draft = createDraft(ws, {
          customerId: customerIds.get(s.customer)!, date: s.date, subject: s.subject, lines: s.lines, language: customer.language,
          ...(s.currency ? { currency: s.currency } : {}), ...(s.exemption ? { exemption: s.exemption } : {}),
          ...(s.prices ? { prices: s.prices } : {}), ...(s.termsId ? { termsId: s.termsId } : {}), ...(s.supplied ? { supplied: s.supplied } : {}),
        }, s.at);
        ids.set(s.key, draft.id);
        if (s.do === 'issue') await issueAndSend(ws, s.key, draft.id, s.at, expected, false, s.send);
      } else if (s.do === 'credit') {
        const credit = createCreditNote(ws, ids.get(s.of)!, { reason: s.reason, ...(s.amount !== undefined ? { amount: s.amount } : {}), ...(s.vatRate !== undefined ? { vatRate: s.vatRate } : {}), ...(s.settlement ? { settlement: s.settlement } : {}) }, s.at);
        ids.set(s.key, credit.id);
        await issueAndSend(ws, s.key, credit.id, s.at, expected, true, s.send);
      } else if (s.do === 'remind') {
        await sendReminder(ws, ids.get(s.of)!, { date: s.at.slice(0, 10), ...(s.fee ? { fee: s.fee } : {}) }, { now: s.at });
      } else if (s.do === 'cancel') {
        await cancelInvoice(ws, ids.get(s.of)!, { date: s.at.slice(0, 10), reason: s.reason, notify: true }, { now: s.at });
      } else if (s.do === 'comment') {
        addComment(ws, ids.get(s.of)!, s.text, owner, s.at);
      }
      // hand, allocate and write-off are the person's, on the books after the import (settle).
    }
    arrived('9999-12-31');
    // From a seed of their own, so the seeded ids of every other record (and of the entries booked after) stay as they were.
    if (inv.articles?.length) {
      const rnd = mulberry32(0xa271c1e5);
      const before = idSource.bytes;
      idSource.bytes = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(rnd() * 256)));
      try { addArticles(ws, inv.articles, `${YEAR}-07-01T08:00:00.000Z`); } finally { idSource.bytes = before; }
    }
  } finally {
    await closeBrowser();
  }
  return { ws, ids };
}

/** Runs `fn` with record and entry ids drawn from `seed`, so the same seed gives the same files. */
export async function withSeededIds<T>(seed: number, fn: () => Promise<T>): Promise<T> {
  const rnd = mulberry32(seed ^ 0x1f1f1f);
  const random = idSource.bytes;
  idSource.bytes = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(rnd() * 256)));
  try { return await fn(); } finally { idSource.bytes = random; }
}

/**
 * `confirmed`: the demo's «Trotzdem ausstellen», for a credit note of a paid invoice (paid back).
 * `send`: by e-mail, as the firm's mail server took it (a Message-ID of the demo's own); downloaded;
 * or not sent, so it waits in «Nicht gesendet».
 */
async function issueAndSend(ws: Workspace, key: string, id: string, at: string, expected: Map<string, string>, confirmed = false, send: DemoSend = 'email'): Promise<void> {
  const issued = await issueInvoice(ws, id, { now: at, confirmed });
  if (issued.number !== expected.get(key)) throw new Error(`demo invoice ${key} was issued as ${issued.number}, expected ${expected.get(key)}`);
  if (send === 'none') return;
  const to = issued.customer.email;
  if (send === 'email' && !to) throw new Error(`demo invoice ${key} goes by e-mail: its customer needs an address`);
  const deliver = send === 'email' ? async () => ({ to: to!, messageId: `<${issued.number}.${at.slice(0, 10)}@mail.demo.example>` }) : undefined;
  await recordSend(ws, id, { now: at, ...(deliver ? { deliver } : {}) });
}

/**
 * What the person does in the app after the statements are imported (the steps hand, allocate,
 * write-off), played in step order on the books and the invoice book through the app's own
 * functions (src/invoices/payments.ts): a Zahlungseingang by hand, then the statement row that
 * confirms it (src/books/bank-import.ts matchStatementRows: that row is no new movement); an
 * Ausziffern of one payment over several invoices; «Rest ausbuchen». `rows`: the statement rows
 * of these steps by step key, as the books read them; a row that confirms a hand payment is no
 * longer among the books' movements (generate.ts takes it off before the matcher).
 */
export function settle(inv: DemoInvoicing, books: Books, book: InvoiceBook, ids: Map<string, string>, rows: Map<string, BankTransaction>, ctx: PaymentContext): PaymentOutcome['files'] {
  const files: PaymentOutcome['files'] = [];
  for (const s of inv.steps) {
    if (s.do === 'hand') {
      const id = ids.get(s.of)!;
      const open = openAmount(book.invoices.find((i) => i.id === id)!, liveInvoices(book));
      const made = recordHandPayment(books, book, id, { date: s.at.slice(0, 10), account: s.account, amount: s.amount ?? open }, ctx);
      files.push(...made.files);
      if (s.statement) {
        const row = rows.get(s.key)!;
        const confirmed = matchStatementRows([row], books.transactions, periodLock(books).isClosed);
        if (confirmed.get(made.transaction.ref) !== row.ref) throw new Error(`demo step ${s.key}: the statement row ${row.ref} does not confirm the hand payment ${made.transaction.ref}`);
        books.transactions = books.transactions.map((t) => (t.ref === made.transaction.ref ? { ...t, statement: row.ref } : t));
      }
    } else if (s.do === 'allocate') {
      const out = allocatePayment(books, book, rows.get(s.key)!.ref, s.parts.map((p) => ({ invoiceId: ids.get(p.of)!, amount: p.amount, ...(p.rest ? { rest: p.rest } : {}) })), ctx);
      files.push(...out.files);
    } else if (s.do === 'write-off') {
      const id = ids.get(s.of)!;
      const open = openAmount(book.invoices.find((i) => i.id === id)!, liveInvoices(book));
      writeOffRest(books, book, id, { date: s.at.slice(0, 10), amount: open, reason: s.reason, by: 'person', ...(s.note ? { note: s.note } : {}) }, ctx, { files });
    }
  }
  return files;
}

/** Every file under each year's invoices/ of the scratch workspace, keyed by its path in the workspace. */
export function invoiceFiles(ws: Workspace): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(ws.paths.root, path), readFileSync(path));
    }
  };
  for (const dir of partDirs(ws.paths, 'invoices')) walk(dir);
  return out;
}

export const removeScratch = (ws: Workspace) => rmSync(ws.paths.root, { recursive: true, force: true });
