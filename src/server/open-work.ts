/**
 * What waits for the person under Aufgaben, for the AI sidebar's message (w08, w25): the open
 * questions with their text and buttons as their cards show them, the workflows' tasks, the
 * payments of the open period without a booking, the bookings that contradict their receipts
 * (src/accounting/evidence-check.ts; those of the period filed last wait for a correction), and
 * the receipts that may be copies of another. First where the oldest period not filed stands
 * (periodNote, #342), then what waits outside it, each thing once. Read when the message is sent, so the model never
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
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { chargesVat, filing } from '../engines/index.js';
import { addDays, localToday, type IsoDate } from '../accounting/periods.js';
import type { Workspace } from '../workspace/workspace.js';
import { nothingOpen, openPeriodState, waitingKinds, type OpenPeriodState } from '../app/areas/automation/open-period.js';
import { orderPagesOf } from '../booking/order-pages.js';
import { providersOf } from '../intake/sales-report-import.js';
import type { Purpose } from '../types/assistant.js';
import type { SetupProgress } from '../onboarding/model.js';

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
 * The purpose a message is answered with (#342): the setup's while the setup runs, and after the
 * person ended it with «Los geht's» only when she opened the setup again herself (`wanted`: Firma ›
 * «Einrichtung …» or the conversation picked from Verlauf, as the sidebar tells with the message).
 * Otherwise a setup conversation of a finished setup is an ordinary one: its messages carry the
 * state of the books (openWork), never the setup's checklist.
 */
export const purposeNow = (purpose: Purpose | undefined, progress: Pick<SetupProgress, 'ready'>, wanted = false): Purpose | undefined =>
  (purpose === 'onboarding' && progress.ready && !wanted ? undefined : purpose);

type Ws = Pick<Workspace, 'paths' | 'bankAccounts'>;
type Tasks = ReadonlyArray<Task & { rule?: string }>;

/** The state the sidebar's card draws, from the same inputs: the order pages of a provider among them, which are no receipts without a payment. */
export const periodState = (ws: Ws, books: Books, tasks: ReadonlyArray<Task>, today: IsoDate = localToday()): OpenPeriodState =>
  openPeriodState(books, readQuestions(ws), tasks, ws.bankAccounts, { today, vatRegistered: chargesVat(), length: filing().length, dueDays: filing().dueDays }, orderPagesOf(books, providersOf(ws)));

const taskLine = (x: Task & { rule?: string }, language: string) =>
  `- «${fillTask(textIn(x.title, language), x.item, x.reads)}» on the ${x.item.kind} ${x.item.id}, since ${day(x.since)}${x.rule ? `, held by the rule ${x.rule}` : ''}`;
const paymentLine = (p: BankTransaction) => `- ${day(p.date)} ${payText(p).name} ${money(p.currency, p.amount)} (${p.ref})`;

/**
 * Where the oldest period not filed stands (src/app/areas/automation/open-period.ts, the state the
 * sidebar's card draws): what the person asks for with «was muss ich noch machen?». The figures
 * are the app's; the model names them with their places and asks the app for the card.
 */
export function periodNote(ws: Ws, books: Books, tasks: Tasks, language: string, today: IsoDate = localToday(), s: OpenPeriodState = periodState(ws, books, tasks, today)): string {
  const { t } = wordsIn(language);
  const f = s.filing;
  const stage = f.kind === 'filed' ? 'its return is filed'
    : f.kind === 'running' ? `it runs until ${day(f.ends)}`
      : f.kind === 'before' ? 'it ended before anything in these books is dated: whether its return was filed elsewhere the books cannot know, so never call it due or overdue'
      : f.due ? `it is over; its return ${f.overdue ? 'was due on' : 'is due on'} ${day(f.due)}` : 'it is over and not closed yet (the firm files no return)';
  const k = waitingKinds(s);
  const tasksPlace = `«${t('area.automation')} › ${t('automation.tasks')}»`;
  const name = (r: { description?: string; filename: string }) => r.description || r.filename;
  const lines = [
    `Payments without a booking (${s.unbooked.length})${s.unbooked.length ? `, under «${t('area.bank')}»` : ''}:`, ...capped(s.unbooked.map(paymentLine)),
    ...(k.waits ? [`  Of them, ${k.waits} the app holds until their receipt is linked: it books them itself then and nobody is asked yet; the receipts go in under «${t('area.receipts')}».`] : []),
    ...(k.asks ? [`  Of them, ${k.asks} wait for their receipt and their return is near: each is the person's task under ${tasksPlace} now (link the receipt, name another proof, or book without input tax).`] : []),
    ...(k.unread ? [`  Of them, ${k.unread} have their receipt linked, but its VAT could not be read: each waits for the person's word at once, under ${tasksPlace}; no receipt is missing.`] : []),
    `Open questions (${s.questions.length}):`, ...capped(s.questions.map((x) => questionLine(books, x.q, t))),
    `Bookings whose VAT code contradicts their receipts (${s.evidence.length}), each with its one click on the booking and under ${tasksPlace}:`, ...capped(s.evidence.map((x) => evidenceLine(x.entry, x.check, t))),
    `Receipts without a payment (${s.unlinked.length})${s.unlinked.length ? `, under «${t('area.receipts')}»` : ''}:`, ...capped(s.unlinked.map((r) => `- «${name(r)}»${r.date ? ` of ${day(r.date)}` : ''}`)),
    `Tasks of the workflows (${s.tasks.length})${s.tasks.length ? `, under ${tasksPlace}; a task on a payment is one of the payments above, not one more` : ''}:`, ...capped(s.tasks.map((x) => taskLine(x, language))),
  ];
  return [
    `Where the oldest period not filed stands, computed by the app when this message was sent: ${s.period.token} (${day(s.period.from)} to ${day(s.period.to)}); ${stage}. Only what is dated in ${s.period.token} is counted here.`,
    ...(nothingOpen(s) ? [`Nothing of ${s.period.token} is open: no payment without a booking, no question, no booking against its receipt, no receipt without a payment, no task.`] : lines),
    'When the person asks what is left to do, what is open or what comes next («was muss ich noch machen?», «was fehlt noch?»), answer from this state: two to five short lines in the order above, each with its count and its place in the app\'s words, the due day last; never the setup\'s topics, never a rule or setting already kept. Add {"kind":"openPeriod"} to your block: the app then shows this state under your answer as a card whose lines link to the places, so do not repeat every payment.',
  ].join('\n');
}

/**
 * The note for the message: the state of the oldest period not filed, then what else waits in the
 * other open days. The two never list the same thing. `tasks`: the workflows' tasks as
 * Automatisierung lists them, each with the rule that held its payment (workflows/ask).
 */
export function openWork(ws: Ws, books: Books, tasks: Tasks, language: string, today: IsoDate = localToday()): string {
  const s = periodState(ws, books, tasks, today);
  return [periodNote(ws, books, tasks, language, today, s), elsewhere(ws, books, tasks, language, s)].join('\n\n');
}

/** What waits outside the period `s` describes: the later open days, and what has no day in a period (answered questions, possible duplicates, what a filed period left). */
function elsewhere(ws: Ws, books: Books, tasks: Tasks, language: string, s: OpenPeriodState): string {
  const { t } = wordsIn(language);
  const closed = books.config.closedThrough;
  const inOpen = (date: string | undefined) => !closed || !date || date > closed;
  const listed = { questions: new Set(s.questions.map((x) => x.q.id)), tasks: new Set(s.tasks.map((x) => x.run)), payments: new Set(s.unbooked.map((p) => p.ref)), entries: new Set(s.evidence.map((x) => x.entry.id)) };
  const questions = readQuestions(ws).filter((q) => q.status !== 'closed' && inOpen(dateOf(books, q)) && !listed.questions.has(q.id));
  const open = questions.filter((q) => q.status === 'open');
  // The app's own questions need no reading of their answer: answered, they are done.
  const answered = questions.filter((q) => q.status === 'answered' && q.origin !== 'booking');
  const others = tasks.filter((x) => !listed.tasks.has(x.run));
  const taskRefs = new Set(others.filter((x) => x.item.kind === 'transaction').map((x) => x.item.id));
  const unbooked = unbookedPayments(books, ws.bankAccounts).filter((p) => !listed.payments.has(p.ref) && !taskRefs.has(p.ref));
  const journal = journalOf(books);
  const contradicting = journal.views.filter((v) => v.evidence && !listed.entries.has(v.e.id));
  const unsettled = unsettledAtFiling(journal, filing().length);
  const ledger = ledgerOf(books, closed ? addDays(closed, 1) : '0000-01-01');
  const twins = ledger.views.filter((v) => v.twin?.relation === 'duplicate' && !v.none && !v.locked);
  const name = (id: string) => { const r = books.receipts.find((x) => x.id === id); return r?.description || r?.filename || id; };
  const where = `«${t('area.automation')} › ${t('automation.tasks')}»`;
  const head = `What else waits for the person under ${where} now, outside ${s.period.token}: in the other open days${closed ? ` (all after ${day(closed)})` : ''} and without a day. Nothing of ${s.period.token} is repeated here, so a count here and a count above are never the same things. Both lists together are complete: what is in neither does not wait.`;
  if (!open.length && !answered.length && !others.length && !unbooked.length && !contradicting.length && !unsettled?.items.length && !twins.length) return `${head}\nNothing else waits: no other open question, no other task, no payment without a booking in another period, no other booking against its receipt, no possible duplicate.`;
  return [
    head,
    ...(open.length ? [`Open questions (${open.length}):`, ...capped(open.map((q) => questionLine(books, q, t)))] : []),
    ...(answered.length ? [`Questions answered, not yet marked done by the asker (${answered.length}):`, ...capped(answered.map((q) => questionLine(books, q, t)))] : []),
    ...(others.length ? [`Tasks of the workflows (${others.length}):`, ...capped(others.map((x) => taskLine(x, language)))] : []),
    ...(unbooked.length ? [`Payments without a booking (${unbooked.length}):`, ...capped(unbooked.map(paymentLine))] : []),
    ...(contradicting.length ? [`Bookings whose VAT code contradicts their receipts (${contradicting.length}), each with its one click on the booking and under ${where}:`, ...capped(contradicting.map((v) => evidenceLine(v.e, v.evidence!, t)))] : []),
    ...(unsettled?.items.length ? [`Bookings of the filed ${unsettled.period} that contradicted their receipts and were not settled before filing (${unsettled.items.length}): they stay as filed, and wait for a correction in the open period:`, ...capped(unsettled.items.map((u) => evidenceLine(u.v.e, u.check, t)))] : []),
    ...(twins.length ? [`Receipts that may be a copy of another (${twins.length}), answered on the receipt («${t('receipts.twin.same')}» or «${t('receipts.twin.distinct')}»):`, ...capped(twins.map((v) => `- «${name(v.r.id)}» may be a copy of «${name(v.twin!.of)}» (${v.twin!.why})`))] : []),
  ].join('\n');
}
