/**
 * The question the app asks the owner by itself about a customer payment without an invoice
 * (src/accounting/sales-without-vat.ts): was it a sale with VAT, an export, or no sale at all?
 * Asked once per payment, with the app's proposal, which the classifier booked meanwhile; the
 * answer books it and becomes a rule for the payer (src/server/questions.ts). Run after the
 * booking step, so every sale without an invoice it finds waits as a question under Aufgaben
 * until it is answered.
 */
import { randomBytes } from 'node:crypto';
import { saleProposal, saleQuestionGone, salesWithoutInvoice } from '../accounting/sales-without-vat.js';
import type { BankTransaction, Index } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { appendQuestionLine, readQuestions } from '../questions/store.js';
import { SALE_CHOICES, type Question, type QuestionLine, type SaleGone } from '../questions/model.js';

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
 * answered or withdrawn) is never asked again. First closes the questions whose reason went away.
 * Returns the questions it asked.
 */
export function askSalesWithoutVat(ws: Pick<Workspace, 'paths' | 'company'>, books: Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'config'>, at = new Date().toISOString()): Question[] {
  closeGoneSaleQuestions(ws, books, at);
  const sales = salesWithoutInvoice(books, ws.company.vat.registered);
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

type QuestionBooks = Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'config'>;

/** The app's open questions about sales whose reason went away, and why (src/accounting/sales-without-vat.ts saleQuestionGone). */
export function goneSaleQuestions(questions: readonly Question[], books: QuestionBooks): Array<{ q: Question; why: SaleGone }> {
  return questions.flatMap((q) => {
    const why = q.topic === 'saleVat' && q.status === 'open' ? saleQuestionGone(books, q.on.id) : undefined;
    return why ? [{ q, why }] : [];
  });
}

/** Closes the app's questions whose reason went away, saying why, so no one is asked what the books settled. Returns how many. */
export function closeGoneSaleQuestions(ws: Pick<Workspace, 'paths'>, books: QuestionBooks, at = new Date().toISOString()): number {
  const gone = goneSaleQuestions(readQuestions(ws), books);
  for (const { q, why } of gone) appendQuestionLine(ws, { v: 1, event: 'closed', id: q.id, at, by: APP_ASKER, how: 'withdrawn', why }, books.config?.closedThrough);
  return gone.length;
}

/**
 * Closes the app's open sale questions about `refs`, payments a company rule now holds for the
 * person or books (r7h-27): the rule decides their VAT, the question would ask twice. Returns the ids closed.
 */
export function closeSaleQuestionsHeld(ws: Pick<Workspace, 'paths'>, refs: readonly string[], closedThrough: string | undefined, at = new Date().toISOString()): string[] {
  if (!refs.length) return [];
  const open = readQuestions(ws).filter((q) => q.topic === 'saleVat' && q.status === 'open' && refs.includes(q.on.id));
  for (const q of open) appendQuestionLine(ws, { v: 1, event: 'closed', id: q.id, at, by: APP_ASKER, how: 'withdrawn', why: 'ruleHolds' }, closedThrough);
  return open.map((q) => q.id);
}
