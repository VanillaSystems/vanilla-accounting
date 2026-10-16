/**
 * The question the app asks the owner by itself about a customer payment without an invoice
 * (src/accounting/sales-without-vat.ts): was it a sale with VAT, an export, or no sale at all?
 * Asked once per payment, with the app's proposal, which the classifier booked meanwhile; the
 * answer books it and becomes a rule for the payer (src/server/questions.ts). Run after the
 * booking step, so every sale without an invoice it finds waits as a question under Aufgaben
 * until it is answered.
 */
import { randomBytes } from 'node:crypto';
import { saleProposal, salesWithoutInvoice } from '../accounting/sales-without-vat.js';
import type { BankTransaction, Index } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { appendQuestionLine, readQuestions } from '../questions/store.js';
import { SALE_CHOICES, type Question, type QuestionLine } from '../questions/model.js';

/** Who asks a question the app asks by itself (the UI says «die App»). */
export const APP_ASKER = 'app';

const day = (iso: string) => iso.split('-').reverse().join('.');

/** The app's question about the sale `tx`, asked as of `at`. */
export function saleQuestionLine(ws: Pick<Workspace, 'company'>, tx: BankTransaction, at: string): Extract<QuestionLine, { event: 'asked' }> {
  const who = tx.counterparty || tx.description;
  return {
    v: 1, event: 'asked', id: `q-${randomBytes(4).toString('hex')}`, at, by: APP_ASKER, to: ws.company.owner, origin: 'booking', topic: 'saleVat',
    on: { kind: 'payment', id: tx.ref }, choices: [...SALE_CHOICES], proposal: saleProposal(tx),
    text: `Kundenzahlung ohne Rechnung: ${who}, ${tx.currency} ${tx.amount.toFixed(2)} am ${day(tx.date)}. Ein Verkauf im Inland, ins Ausland, oder kein Umsatz?`,
  };
}

/**
 * Asks about every sale without an invoice that has no question yet; a payment asked about once (open,
 * answered or withdrawn) is never asked again. Returns the questions it asked.
 */
export function askSalesWithoutVat(ws: Pick<Workspace, 'paths' | 'company'>, books: Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'config'>, at = new Date().toISOString()): Question[] {
  const sales = salesWithoutInvoice(books, !!ws.company.vat);
  if (!sales.length) return [];
  const asked = new Set(readQuestions(ws).filter((q) => q.topic === 'saleVat').map((q) => q.on.id));
  const ids: string[] = [];
  for (const { payment: tx } of sales) {
    if (asked.has(tx.ref)) continue;
    const line = saleQuestionLine(ws, tx, at);
    appendQuestionLine(ws, line, books.config?.closedThrough);
    ids.push(line.id);
  }
  const qs = readQuestions(ws);
  return ids.map((id) => qs.find((q) => q.id === id)!);
}
