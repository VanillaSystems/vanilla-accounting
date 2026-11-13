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
import { payText } from '../app/areas/bank/model.js';
import { fillTask, textIn, type Task } from '../workflows/model.js';
import type { EvidenceCheck } from '../accounting/evidence-check.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { baseCurrency, chargesVat, filing, vatSetup } from '../engines/index.js';
import { providerIssuesIn } from '../intake/pair-chain.js';
import { localToday, type IsoDate, type Period } from '../accounting/periods.js';
import type { Workspace } from '../workspace/workspace.js';
import { elsewhereCount, elsewhereOf, nothingOpen, openPeriodState, waitingKinds, type Elsewhere, type OpenPeriodState, type YourReceipt } from '../app/areas/automation/open-period.js';
import { orderPagesOf } from '../booking/order-pages.js';
import { LACK_WORDS } from '../app/areas/automation/period-issues.js';
import { offersInBooks } from '../intake/near-pairs.js';
import { moneyInText } from '../app/lib/utils.js';
import type { Processing } from '../workflows/processing.js';
import { providersOf } from '../intake/sales-report-import.js';
import { setupShareOffers } from '../saving/share-rule.js';
import { outlayWaitsOf } from '../booking/receipt-wait.js';
import type { Purpose } from '../types/assistant.js';
import type { SetupProgress } from '../onboarding/model.js';

const LIMIT = 20;
const day = (iso: string) => iso.slice(0, 10).split('-').reverse().join('.');
/** «EUR 3'200.00»: the app's one money format, as the card shows it (src/app/lib/utils.ts fmt). */
const money = (currency: string, amount: number) => `${currency} ${amount.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const capped = (lines: string[]) => (lines.length > LIMIT ? [...lines.slice(0, LIMIT), `  … and ${lines.length - LIMIT} more`] : lines);

type T = ReturnType<typeof wordsIn>['t'];

/** A period as a person says it and the app's own label shows it («Q3 2026», «1. Semester 2026», «2026»), never its token (#398). */
export function periodWords(t: T, p: Pick<Period, 'kind' | 'token'>): string {
  const say = t as unknown as (key: string, vars?: Record<string, string>) => string;
  if (p.kind === 'quarter') return say('period.quarter', { quarter: p.token.slice(-1), year: p.token.slice(0, 4) });
  if (p.kind === 'half') return say('period.half', { half: p.token.slice(-1), year: p.token.slice(0, 4) });
  return p.token;
}

const yourLine = (books: Books, x: YourReceipt, t: T) =>
  `- «${x.name}»${x.receipt.date ? ` of ${day(x.receipt.date)}` : ''}${x.receipt.amount != null ? `, ${money(x.receipt.currency ?? baseCurrency(), x.receipt.amount)}` : ''}: «${x.lacks.map((k) => t(LACK_WORDS[k])).join(', ')}»${fitsOf(books, x.receipt.id)}${x.copyOf ? `, may be a copy of «${nameOf(books, x.copyOf)}», answered on the receipt («${t('receipts.twin.same')}» or «${t('receipts.twin.distinct')}»)` : ''}`;
/** A payment that may fit the receipt (#397's near offers): named once, on the receipt's line, linked on the receipt with one click (#398). */
const fitsOf = (books: Books, id: string) => {
  const o = offersInBooks(books, { receipt: id })[0];
  const tx = o && books.transactions.find((y) => y.ref === o.payment);
  return tx ? `; a payment may fit it, offered on the receipt with one click: ${paymentLine(tx).slice(2)}` : '';
};
const nameOf = (books: Books, id: string) => { const r = books.receipts.find((x) => x.id === id); return r?.description || r?.filename || id; };

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
const evidenceWords = (e: JournalEntry, c: EvidenceCheck, t: T): string => {
  const code = e.vatCode ?? '';
  if (c.kind === 'receiptGroups') return t(c.rate ? 'journal.evidence.groupTaxed' : 'journal.evidence.groupUntaxed', { amount: money(c.currency, c.amount), rate: String(c.rate), code });
  return c.kind === 'receiptShowsVat' ? t('journal.evidence.receiptShowsVat', { rate: String(c.rate), code }) : t('journal.evidence.vatWithoutReceipt', { code, zero: c.code });
};
const evidenceLine = (e: JournalEntry, c: EvidenceCheck, t: T) => `- ${day(e.date)} ${e.description ?? ''} (${e.transactionRef}): «${evidenceWords(e, c, t)}»`;

/**
 * The purpose a message is answered with (#342): the setup's while the setup runs, and after the
 * person ended it with «Los geht's» only when she opened the setup again herself (`wanted`: Firma ›
 * «Einrichtung …» or the conversation picked from Verlauf, as the sidebar tells with the message).
 * Otherwise a setup conversation of a finished setup is an ordinary one: its messages carry the
 * state of the books (openWork), never the setup's checklist.
 */
export const purposeNow = (purpose: Purpose | undefined, progress: Pick<SetupProgress, 'ready'>, wanted = false): Purpose | undefined =>
  (purpose === 'onboarding' && progress.ready && !wanted ? undefined : purpose);

type Ws = Workspace;
type Tasks = ReadonlyArray<Task & { rule?: string }>;

/** The state the sidebar's card draws, from the same inputs: the order pages of a provider among them, which are no receipts without a payment. */
export const periodState = (ws: Ws, books: Books, tasks: ReadonlyArray<Task>, today: IsoDate = localToday(), processing: ReadonlyMap<string, Processing> = new Map()): OpenPeriodState =>
  openPeriodState(books, readQuestions(ws), tasks, ws.bankAccounts, { today, vatRegistered: chargesVat(), length: filing().length, dueDays: filing().dueDays, ...firmOf(ws, books) }, orderPagesOf(books, providersOf(ws)), processing, providerIssuesIn(ws, books, today), setupShareOffers(ws, books));

/** The firm as the open period's state reads it: the owner's name, and the UID and name its own invoices show (#428). */
const firmOf = (ws: Ws, books: Books) => {
  const c = ws.company;
  return { outlays: new Set(outlayWaitsOf(ws, books)), ...(c ? { firm: { ...(c.uid ? { uid: c.uid } : {}), ...(c.name ? { name: c.name } : {}), ...(c.owner ? { owner: c.owner } : {}) } } : {}) };
};

/** What waits outside the period, from the same inputs as the card (src/app/areas/automation/open-period.ts elsewhereOf). */
export const elsewhereFor = <T extends Task>(ws: Ws, books: Books, tasks: readonly T[], s: OpenPeriodState, stuck = 0, today: IsoDate = localToday()): Elsewhere<T> =>
  elsewhereOf(books, readQuestions(ws), tasks, ws.bankAccounts, s, filing().length, stuck, vatSetup().registered, today);

const taskLine = (x: Task & { rule?: string }, language: string) =>
  `- «${fillTask(textIn(x.title, language), x.item, x.reads)}» on the ${x.item.kind} ${x.item.id}, since ${day(x.since)}${x.rule ? `, held by the rule ${x.rule}` : ''}`;
const paymentLine = (p: BankTransaction) => `- ${day(p.date)} ${payText(p).name} ${money(p.currency, p.amount)} (${p.ref})`;

/**
 * Where the oldest period not filed stands (src/app/areas/automation/open-period.ts, the state the
 * sidebar's card draws): what the person asks for with «was muss ich noch machen?». The figures
 * are the app's; the model names them with their places and asks the app for the card.
 */
export function periodNote(ws: Ws, books: Books, tasks: Tasks, language: string, today: IsoDate = localToday(), s: OpenPeriodState = periodState(ws, books, tasks, today), e: Elsewhere = elsewhereFor(ws, books, tasks, s, 0, today)): string {
  const { t } = wordsIn(language);
  const f = s.filing;
  const stage = f.kind === 'filed' ? 'its return is filed'
    : f.kind === 'running' ? `it runs until ${day(f.ends)}`
      : f.kind === 'before' ? 'it ended before anything in these books is dated: whether its return was filed elsewhere the books cannot know, so never call it due or overdue'
      : f.due ? `it is over; its return ${f.overdue ? 'was due on' : 'is due on'} ${day(f.due)}` : 'it is over and not closed yet (the firm files no return)';
  const k = waitingKinds(s);
  const tasksPlace = `«${t('area.automation')} › ${t('automation.tasks')}»`;
  const name = (r: { description?: string; filename: string }) => (r.description ? moneyInText(r.description) : r.filename);
  const label = periodWords(t, s.period);
  const unlinked = s.unlinked;
  const owner = ws.company?.owner ?? '';
  // In the order of the card's lines (openLines): most important first, as code ranks them (#428).
  const lines = [
    ...(s.held.length ? [`Orders a provider's sales report did not book (${s.held.length}): their turnover is missing from the return, and the review withholds «Freigegeben» until each is booked (on the report's receipt under «${t('area.receipts')}»):`, ...capped(s.held.map((h) => `- ${t(`drop.held.${h.why}`, { order: h.order })}, ${day(h.date)}${h.gross !== undefined ? `, ${money(h.currency ?? baseCurrency(), h.gross)}` : ''} (${h.name})`))] : []),
    `Open questions (${s.questions.length}):`, ...capped(s.questions.map((x) => questionLine(books, x.q, t))),
    ...(s.yours.length ? [`Receipts that wait for the person's own word (${s.yours.length}), under «${t('area.receipts')}»: only she can add what each lacks, or answer whether it is a copy:`, ...capped(s.yours.map((x) => yourLine(books, x, t)))] : []),
    `Payments without a booking (${s.unbooked.length})${s.unbooked.length ? `, under «${t('area.bank')}»` : ''}:`, ...capped(s.unbooked.map(paymentLine)),
    ...(k.outlays ? [`  Of them, ${k.outlays} go to the owner and pay back business costs she paid privately: they wait until those receipts are booked as her outlays (on each receipt under «${t('area.receipts')}», «${t('actions.privateOne', { owner })}»); the app books them then. No receipt of their own is missing.`] : []),
    ...(k.waits ? [`  Of them, ${k.waits} the app holds until their receipt is linked: it books them itself then and nobody is asked yet; the receipts go in under «${t('area.receipts')}».`] : []),
    ...(k.asks ? [`  Of them, ${k.asks} wait for their receipt and their return is near: each is the person's task under ${tasksPlace} now (link the receipt, name another proof, or book without input tax).`] : []),
    ...(k.unread ? [`  Of them, ${k.unread} have their receipt linked, but its VAT could not be read: each waits for the person's word at once, under ${tasksPlace}; no receipt is missing.`] : []),
    `Bookings whose VAT code contradicts their receipts (${s.evidence.length}), each with its one click on the booking and under ${tasksPlace}:`, ...capped(s.evidence.map((x) => evidenceLine(x.entry, x.check, t))),
    ...(s.offers.length ? [`Proposals from the setup that wait for the person's answer (${s.offers.length}), each a rule offered on its payment under «${t('area.bank')}», kept or declined with one click:`, ...capped(s.offers.map((o) => `- ${o.name}: ${o.percent} % private, the rest on ${o.account} (the payment of ${day(o.date)}, ${o.ref})`))] : []),
    ...(s.openings.length ? [`Bank accounts the books open at nothing while their statements say they held money (${s.openings.length}): their opening balance goes in under «${t('area.company')} › ${t('company.opening')}»; without it the balance sheet shows them wrong:`, ...capped(s.openings.map((o) => `- ${o.label} (${o.account}): ${money(o.currency ?? baseCurrency(), o.amount)} on 1.1.${o.year}, as its statements imply`))] : []),
    ...(s.clearing.length ? [`Clearing accounts of a payment provider below zero on ${day(s.period.to)} (${s.clearing.length}): the provider paid out more than the account holds sales for, most often a sales report not dropped yet:`, ...capped(s.clearing.map((c) => `- ${c.account} ${c.name}: ${money(baseCurrency(), c.balance)}`))] : []),
    `Receipts without a payment (${unlinked.length})${unlinked.length ? `, under «${t('area.receipts')}»` : ''}:`, ...capped(unlinked.map((r) => `- «${name(r)}»${r.date ? ` of ${day(r.date)}` : ''}${r.amount != null ? `, ${money(r.currency ?? baseCurrency(), r.amount)}` : ''}`)),
    ...(s.issued.length ? [`Invoices the firm issued, with its UID, that no payment in the books fits (${s.issued.length}): they wait for the customer's payment, nothing for the person to do, so never name them as work.`] : []),
    ...(s.bills.length ? [`Monthly bills of a provider not in the books (${s.bills.length}): the VAT on its fees of that month is not deducted until the bill is dropped:`, ...capped(s.bills.map((b) => `- ${b.name}, ${b.month}: fees ${money(baseCurrency(), b.fees)}`))] : []),
    `Tasks of the workflows (${s.tasks.length})${s.tasks.length ? `, under ${tasksPlace}; a task on a payment is one of the payments above, not one more` : ''}:`, ...capped(s.tasks.map((x) => taskLine(x, language))),
  ];
  return [
    `Where the oldest period not filed stands, computed by the app when this message was sent: ${label} (${day(s.period.from)} to ${day(s.period.to)}); ${stage}. Only what is dated in ${label} is counted here, listed most important first as the app ranks it. Say a period as here («${label}»), never as a code like «${s.period.token}».`,
    ...(nothingOpen(s) ? [`Nothing of ${label} is open: no payment without a booking, no question, no booking against its receipt, no receipt without a payment, no receipt waiting for the person's word, no task.${elsewhereCount(e) ? ` Other things wait for the person (${elsewhereCount(e)}, listed below under «What else waits»${e.unbooked.length ? `, ${e.unbooked.length} payments of later open days without a booking among them` : ''}): never say that nothing is open.` : ''}`] : lines),
    'When the person asks what is left to do, what is open or what comes next («was muss ich noch machen?», «was fehlt noch?»), add {"kind":"openPeriod"} to your block: the app then shows this state under your answer as a card that names every item above one by one, each a link to its place, and the due day. Your own words are at most one short sentence before it, in her language (start with the first of them, or that nothing waits); never a count, never a list of the items, never the setup\'s topics, never a rule or setting already kept: the card says them, with the links your words cannot carry.',
  ].join('\n');
}

/**
 * The note for the message: the state of the oldest period not filed, then what else waits in the
 * other open days. The two never list the same thing. `tasks`: the workflows' tasks as
 * Automatisierung lists them, each with the rule that held its payment (workflows/ask).
 */
export function openWork(ws: Ws, books: Books, tasks: Tasks, language: string, today: IsoDate = localToday(), stuck = 0, processing: ReadonlyMap<string, Processing> = new Map()): string {
  const s = periodState(ws, books, tasks, today, processing);
  const e = elsewhereFor(ws, books, tasks, s, stuck, today);
  return [periodNote(ws, books, tasks, language, today, s, e), elsewhere(books, language, s, e)].join('\n\n');
}

/** What waits outside the period `s` describes (elsewhereOf, the list the card checks too): the later open days, and what has no day in a period (answered questions, possible duplicates, what a filed period left). */
function elsewhere(books: Books, language: string, s: OpenPeriodState, e: Elsewhere<Task & { rule?: string }>): string {
  const { t } = wordsIn(language);
  const closed = books.config.closedThrough;
  const name = (id: string) => { const r = books.receipts.find((x) => x.id === id); return r?.description || r?.filename || id; };
  const where = `«${t('area.automation')} › ${t('automation.tasks')}»`;
  const label = periodWords(t, s.period);
  const head = `What else waits for the person under ${where} now, outside ${label}: in the other open days${closed ? ` (all after ${day(closed)})` : ''} and without a day. Nothing of ${label} is repeated here, so a count here and a count above are never the same things. Both lists together are complete: what is in neither does not wait.`;
  if (!elsewhereCount(e)) return `${head}\nNothing else waits: no other open question, no other task, no payment without a booking in another period, no other booking against its receipt, no possible duplicate.`;
  return [
    head,
    ...(e.open.length ? [`Open questions (${e.open.length}):`, ...capped(e.open.map((q) => questionLine(books, q, t)))] : []),
    ...(e.answered.length ? [`Questions answered, not yet marked done by the asker (${e.answered.length}):`, ...capped(e.answered.map((q) => questionLine(books, q, t)))] : []),
    ...(e.tasks.length ? [`Tasks of the workflows (${e.tasks.length}):`, ...capped(e.tasks.map((x) => taskLine(x, language)))] : []),
    ...(e.stuck ? [`Runs of the workflows that stopped (${e.stuck}), under «${t('area.automation')}»: each waits for the person to resume or discard it.`] : []),
    ...(e.unbooked.length ? [`Payments without a booking (${e.unbooked.length}):`, ...capped(e.unbooked.map(paymentLine))] : []),
    ...(e.contradicting.length ? [`Bookings whose VAT code contradicts their receipts (${e.contradicting.length}), each with its one click on the booking and under ${where}:`, ...capped(e.contradicting.map((v) => evidenceLine(v.e, v.evidence!, t)))] : []),
    ...(e.unsettled?.items.length ? [`Bookings of the filed ${e.unsettled.period} that contradicted their receipts and were not settled before filing (${e.unsettled.items.length}): they stay as filed, and wait for a correction in the open period:`, ...capped(e.unsettled.items.map((u) => evidenceLine(u.v.e, u.check, t)))] : []),
    ...(e.twins.length ? [`Receipts that may be a copy of another (${e.twins.length}), answered on the receipt («${t('receipts.twin.same')}» or «${t('receipts.twin.distinct')}»):`, ...capped(e.twins.map((v) => `- «${name(v.r.id)}» may be a copy of «${name(v.twin!.of)}» (${v.twin!.why})`))] : []),
    ...(e.threshold.length ? [`The turnover of ${e.threshold.join(' and ')} reached the VAT registration threshold (the firm is not registered): a task under ${where}, read off «${t('area.vat')}».`] : []),
    ...(e.assessments.length ? [`Import payments whose customs assessment is missing (${e.assessments.length}), under ${where}.`] : []),
  ].join('\n');
}
