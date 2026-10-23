/**
 * What waits for the person under Aufgaben, for the AI sidebar's message (w08, w25): the open
 * questions with their text and buttons as their cards show them, the workflows' tasks, the
 * payments of the open period without a booking, the bookings that contradict their receipts
 * (src/accounting/evidence-check.ts; those of the period filed last wait for a correction), and
 * the receipts that may be copies of another. Read when the message is sent, so the model never
 * claims a question is missing that is open, or sends the person to answer one the app has closed.
 * The words are the UI's own, in the person's language; the frame is English, for the model.
 */
import type { Books } from '../books/store.js';
import { readQuestions } from '../questions/store.js';
import type { Question } from '../questions/model.js';
import { normalRate } from '../accounting/sales-without-vat.js';
import { chart } from '../engines/index.js';
import { wordsIn } from '../export/texts.js';
import { payText, unbookedPayments } from '../app/areas/bank/model.js';
import { fillTask, textIn, type Task } from '../workflows/model.js';
import { journalOf, unsettledAtFiling } from '../app/areas/journal/model.js';
import { ledgerOf } from '../app/areas/receipts/model.js';
import type { EvidenceCheck } from '../accounting/evidence-check.js';
import type { JournalEntry } from '../types/index.js';
import { filing } from '../engines/index.js';
import { addDays } from '../accounting/periods.js';
import type { Workspace } from '../workspace/workspace.js';

const LIMIT = 20;
const day = (iso: string) => iso.slice(0, 10).split('-').reverse().join('.');
const money = (currency: string, amount: number) => `${currency} ${amount.toFixed(2)}`;
const capped = (lines: string[]) => (lines.length > LIMIT ? [...lines.slice(0, LIMIT), `  … and ${lines.length - LIMIT} more`] : lines);

type T = ReturnType<typeof wordsIn>['t'];

/** The date a question's item has, to keep it to the open period; none for a receipt without one. */
function dateOf(books: Books, q: Question): string | undefined {
  switch (q.on.kind) {
    case 'payment': return books.transactions.find((t) => t.ref === q.on.id)?.date;
    case 'entry': return books.journalEntries.find((e) => e.id === q.on.id)?.date;
    case 'receipt': return books.receipts.find((r) => r.id === q.on.id)?.date ?? undefined;
  }
}

function questionLine(books: Books, q: Question, t: T): string {
  const tx = q.on.kind === 'payment' ? books.transactions.find((x) => x.ref === q.on.id) : undefined;
  const who = tx ? tx.counterparty || tx.description : '';
  const text = q.topic === 'saleVat' && tx ? t('questions.sale.text', { who, amount: money(tx.currency, tx.amount), date: day(tx.date) }) : q.text;
  const item = tx ? `the payment ${tx.ref} (${who}, ${money(tx.currency, tx.amount)}, ${day(tx.date)})` : `the ${q.on.kind} ${q.on.id}`;
  const by = q.origin === 'booking' ? t('questions.app') : q.origin === 'assistant' ? t('questions.ai') : q.by;
  const buttons = q.choices.map((c) => `«${t(`questions.choice.${c}` as 'questions.choice.private', { rate: String(normalRate()) })}»`);
  const parts = [`- «${text}» on ${item}, asked by ${by}${q.to ? ` to ${q.to}` : ''}`];
  if (q.status === 'answered' && q.answer) {
    const a = q.answer.answer;
    const said = 'choice' in a ? t(`questions.choice.${a.choice}` as 'questions.choice.private', { rate: String(normalRate()) }) : a.text;
    parts.push(`answered by ${q.answer.by}: «${said}», waiting for ${by} to read it`);
  } else {
    parts.push(buttons.length ? `its buttons ${buttons.join(', ')}, or an answer in words` : 'answered in words');
  }
  if (q.topic === 'saleVat' && q.status === 'open') {
    const codes = [...new Set(books.journalEntries.filter((e) => e.transactionRef === q.on.id && chart().typeOf(e.accountCredit) === 'revenue').map((e) => e.vatCode || 'none'))];
    if (codes.length) parts.push(`booked meanwhile with ${codes.join(', ')}`);
    parts.push('the app asks this itself: a change of the VAT code of this sale\'s booking in your block answers it (the app closes the question; it keeps no rule for the payer), so never ask the person to answer it as well');
  }
  return parts.join('; ');
}

/** A contradiction in the words the booking page shows. */
const evidenceLine = (e: JournalEntry, c: EvidenceCheck, t: T) =>
  `- ${day(e.date)} ${e.description ?? ''} (${e.transactionRef}): «${c.kind === 'receiptShowsVat' ? t('journal.evidence.receiptShowsVat', { rate: String(c.rate), code: e.vatCode ?? '' }) : t('journal.evidence.vatWithoutReceipt', { code: e.vatCode ?? '', zero: c.code })}»`;

/**
 * The note for the message, or the plain statement that nothing waits. `tasks`: the workflows'
 * tasks as Automatisierung lists them, each with the rule that held its payment (workflows/ask).
 */
export function openWork(ws: Pick<Workspace, 'paths' | 'bankAccounts'>, books: Books, tasks: ReadonlyArray<Task & { rule?: string }>, language: string): string {
  const { t } = wordsIn(language);
  const closed = books.config.closedThrough;
  const inOpen = (date: string | undefined) => !closed || !date || date > closed;
  const questions = readQuestions(ws).filter((q) => q.status !== 'closed' && inOpen(dateOf(books, q)));
  const open = questions.filter((q) => q.status === 'open');
  // The app's own questions need no reading of their answer: answered, they are done.
  const answered = questions.filter((q) => q.status === 'answered' && q.origin !== 'booking');
  const taskRefs = new Set(tasks.filter((x) => x.item.kind === 'transaction').map((x) => x.item.id));
  const unbooked = unbookedPayments(books, ws.bankAccounts).filter((p) => !taskRefs.has(p.ref));
  const journal = journalOf(books);
  const contradicting = journal.views.filter((v) => v.evidence);
  const unsettled = unsettledAtFiling(journal, filing().length);
  const ledger = ledgerOf(books, closed ? addDays(closed, 1) : '0000-01-01');
  const twins = ledger.views.filter((v) => v.twin?.relation === 'duplicate' && !v.none && !v.locked);
  const name = (id: string) => { const r = books.receipts.find((x) => x.id === id); return r?.description || r?.filename || id; };
  const where = `«${t('area.automation')} › ${t('automation.tasks')}»`;
  const head = `What waits for the person under ${where} now, read by the app when this message was sent${closed ? ` (the open period: after ${day(closed)})` : ''}. It is complete: what is not listed does not wait.`;
  if (!questions.length && !tasks.length && !unbooked.length && !contradicting.length && !unsettled?.items.length && !twins.length) return `${head}\nNothing waits: no open question, no task, no payment without a booking, no booking against its receipt, no possible duplicate.`;
  return [
    head,
    `Open questions (${open.length}):`, ...capped(open.map((q) => questionLine(books, q, t))),
    ...(answered.length ? [`Questions answered, not yet marked done by the asker (${answered.length}):`, ...capped(answered.map((q) => questionLine(books, q, t)))] : []),
    `Tasks of the workflows (${tasks.length}):`, ...capped(tasks.map((x) => {
      const title = fillTask(textIn(x.title, language), x.item, x.reads);
      const rule = x.rule ? `, held by the rule ${x.rule}` : '';
      return `- «${title}» on the ${x.item.kind} ${x.item.id}, since ${day(x.since)}${rule}`;
    })),
    `Payments without a booking (${unbooked.length}):`, ...capped(unbooked.map((p) => `- ${day(p.date)} ${payText(p).name} ${money(p.currency, p.amount)} (${p.ref})`)),
    `Bookings whose VAT code contradicts their receipts (${contradicting.length}), each with its one click on the booking and under ${where}:`, ...capped(contradicting.map((v) => evidenceLine(v.e, v.evidence!, t))),
    ...(unsettled?.items.length ? [`Bookings of the filed ${unsettled.period} that contradicted their receipts and were not settled before filing (${unsettled.items.length}): they stay as filed, and wait for a correction in the open period:`, ...capped(unsettled.items.map((u) => evidenceLine(u.v.e, u.check, t)))] : []),
    `Receipts that may be a copy of another (${twins.length}), answered on the receipt («${t('receipts.twin.same')}» or «${t('receipts.twin.distinct')}»):`, ...capped(twins.map((v) => `- «${name(v.r.id)}» may be a copy of «${name(v.twin!.of)}» (${v.twin!.why})`)),
  ].join('\n');
}
