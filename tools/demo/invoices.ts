/**
 * A demo company's invoicing, played through the app's own invoicing service on a scratch copy of
 * the workspace: customers created, invoices drafted, issued (numbered, frozen, printed to PDF by
 * the installed Chromium), sent, reminded, credited, cancelled, commented, each at its own time.
 * The paid invoices' payments are part of the year's bank statements (invoicePayments); the
 * generator lets the app's payment matcher book them (src/invoices/payments.ts).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { workspaceAt, type Workspace } from '../../src/workspace/workspace.js';
import { addComment, cancelInvoice, createCreditNote, createCustomer, createDraft, issueInvoice, recordSend, sendReminder } from '../../src/invoices/service.js';
import { closeBrowser } from '../../src/invoices/pdf.js';
import { idSource, updateInvoices } from '../../src/invoices/store.js';
import type { Issued } from '../../src/invoices/model.js';
import { qrReference } from '../../src/invoices/reference.js';
import { totals, withPayment } from '../../src/invoices/rules.js';
import { TEXTS } from '../../src/invoices/texts.js';
import { mulberry32, YEAR, type DemoInvoicing, type Payment } from './kit.js';

/** The number each issued document gets: issued in step order, numbered per year from 001. */
export function numbersOf(inv: DemoInvoicing): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of inv.steps) if (s.do === 'issue' || s.do === 'credit') out.set(s.key, `${YEAR}-${String(out.size + 1).padStart(3, '0')}`);
  return out;
}

/** The bank payments of the paid invoices: the total, with the invoice's QR reference, as the customer's bank sends it. */
export function invoicePayments(inv: DemoInvoicing): Payment[] {
  const numbers = numbersOf(inv);
  return inv.steps.flatMap((s) => {
    if (s.do !== 'issue' || !s.paid) return [];
    const number = numbers.get(s.key)!;
    const customer = inv.customers[s.customer];
    return [{
      bank: s.paid.bank, date: s.paid.date, text: `Gutschrift ${customer.name}`,
      parts: [{
        counterparty: customer.name.toUpperCase(), reference: qrReference(number), text: `${TEXTS[customer.language].invoice} ${number}`,
        legs: [{ account: '', amount: totals(s.lines).gross, text: '' }], invoice: number,
      }],
    }];
  });
}

/** A paid invoice's payment as the bank statement holds it. */
export interface DemoPayment { number: string; transactionRef: string; date: string; amount: number }

/**
 * Plays the steps on a scratch workspace holding `manifest`; returns it, to be read and then
 * removed. Before each step, the payments that arrived by then are allocated to their invoices,
 * as the import of that day's statement would have (the generator books them afterwards).
 */
export async function playInvoicing(inv: DemoInvoicing, manifest: string, owner: string, payments: DemoPayment[]): Promise<Workspace> {
  const root = mkdtempSync(join(tmpdir(), 'belege-demo-invoices-'));
  writeFileSync(join(root, 'belege.workspace.yaml'), manifest);
  mkdirSync(join(root, 'receipts'));
  if (inv.logo) {
    mkdirSync(join(root, 'invoices'), { recursive: true });
    writeFileSync(join(root, inv.logo.file), inv.logo.svg);
  }
  const ws = workspaceAt(root);
  try {
    const customerIds = new Map<string, string>();
    for (const [key, fields] of Object.entries(inv.customers)) customerIds.set(key, createCustomer(ws, fields, `${YEAR}-07-01T08:00:00.000Z`).id);
    const ids = new Map<string, string>();
    const expected = numbersOf(inv);
    const arrived = (until: string) => updateInvoices(ws, (book) => {
      for (const p of payments.filter((x) => x.date <= until)) {
        const at = book.invoices.findIndex((i) => i.status === 'issued' && i.number === p.number);
        if (at >= 0) book.invoices[at] = withPayment(book.invoices[at] as Issued, { transactionRef: p.transactionRef, date: p.date, amount: p.amount, by: 'reference' });
      }
    });
    for (const s of inv.steps) {
      arrived(s.at.slice(0, 10));
      if (s.do === 'issue' || s.do === 'draft') {
        const customer = inv.customers[s.customer];
        const draft = createDraft(ws, {
          customerId: customerIds.get(s.customer)!, date: s.date, subject: s.subject, lines: s.lines, language: customer.language,
          ...(s.currency ? { currency: s.currency } : {}), ...(s.exemption ? { exemption: s.exemption } : {}),
        }, s.at);
        ids.set(s.key, draft.id);
        if (s.do === 'issue') await issueAndSend(ws, s.key, draft.id, s.at, expected);
      } else if (s.do === 'credit') {
        const credit = createCreditNote(ws, ids.get(s.of)!, { reason: s.reason, ...(s.amount !== undefined ? { amount: s.amount } : {}), ...(s.vatRate !== undefined ? { vatRate: s.vatRate } : {}), ...(s.settlement ? { settlement: s.settlement } : {}) }, s.at);
        ids.set(s.key, credit.id);
        await issueAndSend(ws, s.key, credit.id, s.at, expected);
      } else if (s.do === 'remind') {
        await sendReminder(ws, ids.get(s.of)!, { date: s.at.slice(0, 10), ...(s.fee ? { fee: s.fee } : {}) }, { now: s.at });
      } else if (s.do === 'cancel') {
        await cancelInvoice(ws, ids.get(s.of)!, { date: s.at.slice(0, 10), reason: s.reason, notify: true }, { now: s.at });
      } else {
        addComment(ws, ids.get(s.of)!, s.text, owner, s.at);
      }
    }
    arrived('9999-12-31');
  } finally {
    await closeBrowser();
  }
  return ws;
}

/** Runs `fn` with record and entry ids drawn from `seed`, so the same seed gives the same files. */
export async function withSeededIds<T>(seed: number, fn: () => Promise<T>): Promise<T> {
  const rnd = mulberry32(seed ^ 0x1f1f1f);
  const random = idSource.bytes;
  idSource.bytes = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(rnd() * 256)));
  try { return await fn(); } finally { idSource.bytes = random; }
}

async function issueAndSend(ws: Workspace, key: string, id: string, at: string, expected: Map<string, string>): Promise<void> {
  const issued = await issueInvoice(ws, id, { now: at });
  if (issued.number !== expected.get(key)) throw new Error(`demo invoice ${key} was issued as ${issued.number}, expected ${expected.get(key)}`);
  await recordSend(ws, id, { now: at });
}

/** Every file under invoices/ of the scratch workspace, keyed by its path in the workspace. */
export function invoiceFiles(ws: Workspace): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(ws.paths.root, path), readFileSync(path));
    }
  };
  walk(ws.paths.invoiceFiles);
  return out;
}

export const removeScratch = (ws: Workspace) => rmSync(ws.paths.root, { recursive: true, force: true });
