/**
 * Asking, answering, undoing and closing a question (src/questions/model.ts), for the routes and
 * the AI sidebar alike. An answer that decides something acts at once, code first: «privat» on a
 * payment books it on the owner's account without a VAT code, as the sidebar and the booking by
 * hand do, and «privat» or «geschäftlich» is kept as a precedent, so the next question of the
 * kind about the same counterparty is answered without anyone asked. Any other answer, or one the
 * app cannot act on (a filed quarter, a payment it cannot read), goes back to the asker, who decides.
 */
import { randomBytes } from 'node:crypto';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { bankAccountFor, ownerAccount } from '../accounting/bank-accounts.js';
import { isVatAmountCode } from '../accounting/validate.js';
import { ClosedPeriodError, type Books } from '../books/store.js';
import { appendQuestionLine, readQuestions } from '../questions/store.js';
import { counterpartyKey, dropPrecedent, keepPrecedent, precedentFor, type ChoicePrecedent } from '../knowledge/precedents.js';
import { CHOICES, TARGET_KINDS, type Acted, type NotActed, type Answer, type Choice, type Question, type QuestionLine, type QuestionOrigin, type QuestionTarget } from '../questions/model.js';
import type { BankTransaction } from '../types/index.js';
import type { BookChange } from '../types/assistant.js';
import { WS, RequestError, readBooks, updateBooks } from './books.js';
import { applyChange, bookPayment, setEntry } from './edits.js';

const now = () => new Date().toISOString();
const append = (line: QuestionLine) => appendQuestionLine(WS, line, readBooks().config.closedThrough);

export interface AskInput { on: QuestionTarget; by: string; text: string; choices?: Choice[]; to?: string; origin?: QuestionOrigin }

const name = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new RequestError(400, `${what} fehlt.`);
  if (v.trim().length > 80) throw new RequestError(400, `${what}: höchstens 80 Zeichen.`);
  return v.trim();
};

/** The request's fields, checked at the edge. */
export function parseAsk(body: unknown, origin: QuestionOrigin = 'person'): AskInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const on = b.on as Partial<QuestionTarget> | undefined;
  if (!on || !TARGET_KINDS.includes(on.kind as QuestionTarget['kind']) || typeof on.id !== 'string' || !on.id) throw new RequestError(400, 'on: { kind: payment | receipt | entry, id }.');
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) throw new RequestError(400, 'Die Frage fehlt.');
  if (text.length > 2000) throw new RequestError(400, 'Die Frage: höchstens 2000 Zeichen.');
  const choices = Array.isArray(b.choices) ? b.choices : [];
  if (!choices.every((c) => CHOICES.includes(c as Choice))) throw new RequestError(400, `choices: ${CHOICES.join(', ')}.`);
  return {
    on: { kind: on.kind as QuestionTarget['kind'], id: on.id }, by: name(b.by, 'by'), text, choices: [...new Set(choices as Choice[])],
    ...(typeof b.to === 'string' && b.to.trim() ? { to: name(b.to, 'to') } : {}), origin,
  };
}

export function parseAnswer(body: unknown): { by: string; answer: Answer } {
  const b = (body ?? {}) as Record<string, unknown>;
  const by = name(b.by, 'by');
  if (CHOICES.includes(b.choice as Choice)) return { by, answer: { choice: b.choice as Choice } };
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) throw new RequestError(400, 'Die Antwort fehlt.');
  return { by, answer: { text: text.slice(0, 2000) } };
}

/** The payment a question is about: the payment itself, a receipt's one payment, a booking's payment. */
function paymentOf(books: Books, on: QuestionTarget): { tx?: BankTransaction; entry?: string; why?: NotActed } {
  const tx = (ref: string) => books.transactions.find((t) => t.ref === ref);
  switch (on.kind) {
    case 'payment': return { tx: tx(on.id) };
    case 'entry': {
      const e = books.journalEntries.find((x) => x.id === on.id);
      return e ? { tx: tx(e.transactionRef), entry: e.id } : {};
    }
    case 'receipt': {
      const refs = [...new Set(books.mappings.filter((m) => m.receiptId === on.id).map((m) => m.transactionRef))];
      return refs.length === 1 ? { tx: tx(refs[0]) } : { why: refs.length ? 'severalPayments' : 'noPayment' };
    }
  }
}

function exists(books: Books, on: QuestionTarget): boolean {
  switch (on.kind) {
    case 'payment': return books.transactions.some((t) => t.ref === on.id);
    case 'entry': return books.journalEntries.some((e) => e.id === on.id);
    case 'receipt': return books.receipts.some((r) => r.id === on.id);
  }
}

class Unclear extends Error { constructor(readonly why: NotActed, message: string) { super(message); } }

/**
 * The payment `tx` as private: unbooked, one booking on the owner's account against the bank;
 * booked, each booking's side opposite the bank goes to the owner's account and loses its VAT
 * code (`only`: just that booking). A booking that is not one side bank, one side expense (a
 * VAT-amount line, a transfer) is not guessed at.
 */
function bookPrivate(books: Books, tx: BankTransaction, only: string | undefined): { booked: string[]; undo: BookChange[] } {
  const owner = ownerAccount(WS).split(' ')[0];
  if (tx.bank === 'manual') throw new Unclear('paidPrivately', 'paid privately already');
  const bank = bankAccountFor(tx, WS.bankAccounts);
  const entries = books.journalEntries.filter((e) => e.transactionRef === tx.ref && (!only || e.id === only));
  if (!entries.length) {
    const out = tx.direction === 'DBIT';
    const [e] = bookPayment(books, tx.ref, [{ accountDebit: out ? owner : bank, accountCredit: out ? bank : owner, amount: Math.abs(tx.amount), description: tx.description }], WS.bankAccounts, loadFxResolver());
    return { booked: [e.id], undo: [{ kind: 'deleteEntry', id: e.id }] };
  }
  const undo: BookChange[] = [];
  for (const e of entries) {
    const side = e.accountCredit === bank && e.accountDebit !== bank ? 'accountDebit' : e.accountDebit === bank && e.accountCredit !== bank ? 'accountCredit' : undefined;
    if (!side || isVatAmountCode(e.vatCode) || !e[side]) throw new Unclear('notBankExpense', e.description ?? e.id);
    if (e[side] === owner && !e.vatCode) continue;
    undo.push(setEntry(books, e.id, { [side]: owner, vatCode: '' }));
  }
  return { booked: undo.map((u) => (u as { id: string }).id), undo };
}

/** What the answer does in the books and the knowledge, or why it does nothing. `from`: the precedent that answers, kept already. */
function act(q: Question, answer: Answer, by: string, at: string, from: string | undefined): Acted | undefined {
  if (!('choice' in answer)) return undefined;
  const books = readBooks();
  const { tx, entry, why } = paymentOf(books, q.on);
  if (!tx) return { refused: why ?? 'noPayment' };
  let booked: { booked: string[]; undo: BookChange[] } | undefined;
  if (answer.choice === 'private') {
    try {
      booked = updateBooks((b) => bookPrivate(b, b.transactions.find((t) => t.ref === tx.ref)!, entry));
    } catch (e) {
      if (e instanceof Unclear) return { refused: e.why, detail: e.message };
      if (e instanceof ClosedPeriodError) return { refused: 'closed', ...(e.closedThrough ? { detail: e.closedThrough } : {}) };
      if (e instanceof RequestError) return { refused: 'refused', detail: e.message };
      throw e;
    }
  }
  const key = counterpartyKey(tx);
  const precedent = key && !from ? keep(q, answer.choice, by, at, tx, key) : undefined;
  if (booked) return { ...booked, ...(precedent ? { precedent } : {}) };
  return precedent ? { precedent } : undefined;
}

const DECISION: Record<Choice, (owner: string) => string> = {
  private: (owner) => `private: D ${owner}, no VAT code`,
  business: () => 'business: booked as the company\'s expense',
};

function keep(q: Question, choice: Choice, by: string, at: string, tx: BankTransaction, key: string): string {
  const day = tx.date.split('-').reverse().join('.');
  const p: ChoicePrecedent = {
    id: `prec-${q.id}`, date: at.slice(0, 10), item: `${key} (${day}, ${tx.currency} ${Math.abs(tx.amount).toFixed(2)})`,
    decision: DECISION[choice](ownerAccount(WS).split(' ')[0]), by, match: { tx: key }, choice, question: q.id,
  };
  keepPrecedent(WS, p);
  return p.id;
}

function find(id: string): Question {
  const q = readQuestions(WS).find((x) => x.id === id);
  if (!q) throw new RequestError(404, 'Diese Frage gibt es nicht.');
  return q;
}

/**
 * A new question. Asked «privat oder geschäftlich?» about a payment whose counterparty a
 * precedent decided, it is answered by that precedent at once, as the person would have.
 */
export function askQuestion(input: AskInput): Question {
  const books = readBooks();
  if (!exists(books, input.on)) throw new RequestError(404, 'Das, worum es geht, gibt es in den Büchern nicht.');
  const id = `q-${randomBytes(4).toString('hex')}`;
  const at = now();
  append({ v: 1, event: 'asked', id, at, by: input.by, on: input.on, text: input.text, choices: input.choices ?? [], ...(input.to ? { to: input.to } : {}), origin: input.origin ?? 'person' });
  const decides = CHOICES.every((c) => input.choices?.includes(c));
  const key = decides ? counterpartyKey(paymentOf(books, input.on).tx ?? { description: '' }) : undefined;
  const p = key ? precedentFor(WS, key) : undefined;
  if (p) answerQuestion(id, { by: p.by, answer: { choice: p.choice } }, p.id);
  return find(id);
}

export function answerQuestion(id: string, { by, answer }: { by: string; answer: Answer }, from?: string): Question {
  const q = find(id);
  if (q.status !== 'open') throw new RequestError(409, 'Diese Frage ist schon beantwortet.', { code: 'questionAnswered' });
  if ('choice' in answer && !q.choices.includes(answer.choice)) throw new RequestError(400, `Diese Frage hat die Wahl ${answer.choice} nicht.`);
  const at = now();
  const acted = act(q, answer, by, at, from);
  append({ v: 1, event: 'answered', id, at, by, answer, ...(acted ? { acted } : {}), ...(from ? { from } : {}) });
  return find(id);
}

/** Takes back what the answer did (its bookings, its precedent); the question is open again. */
export function undoAnswer(id: string, by: string): Question {
  const q = find(id);
  const acted = q.answer?.acted;
  if (q.status !== 'answered') throw new RequestError(409, 'Diese Frage hat keine Antwort, die sich zurücknehmen liesse.');
  if (acted && 'undo' in acted && acted.undo.length) updateBooks((b) => { for (const c of [...acted.undo].reverse()) applyChange(b, c); });
  if (acted && 'precedent' in acted && acted.precedent) dropPrecedent(WS, acted.precedent);
  append({ v: 1, event: 'undone', id, at: now(), by });
  return find(id);
}

/** Done (the asker read the answer) or withdrawn (an open question no longer needed; an answer's bookings go back first). */
export function closeQuestion(id: string, by: string, how: 'done' | 'withdrawn'): Question {
  const q = find(id);
  if (q.status === 'closed') return q;
  if (how === 'withdrawn' && q.status === 'answered') undoAnswer(id, by);
  append({ v: 1, event: 'closed', id, at: now(), by, how });
  return find(id);
}
