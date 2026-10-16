/**
 * Asking, answering, undoing and closing a question (src/questions/model.ts), for the routes and
 * the AI sidebar alike. An answer that decides something acts at once, code first: «privat» on a
 * payment books it on the owner's account without a VAT code, as the sidebar and the booking by
 * hand do, and «privat» or «geschäftlich» is kept as a precedent, so the next question of the
 * kind about the same counterparty is answered without anyone asked. The answer to the app's own
 * question about a customer payment without an invoice (src/intake/sale-questions.ts) books the sale
 * at the normal rate, as an export, or marks it as no sale, and is kept as a rule for the payer, so
 * the classifier books the payer's next payment by it. Any other answer, or one the app cannot act
 * on (a filed quarter, a payment it cannot read, one with a receipt or an invoice), goes back to
 * the asker, who decides.
 */
import { randomBytes } from 'node:crypto';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { bankAccountFor, ownerAccount } from '../accounting/bank-accounts.js';
import { isVatAmountCode } from '../accounting/validate.js';
import { ClosedPeriodError, periodLock, type Books } from '../books/store.js';
import { appendQuestionLine, readQuestions } from '../questions/store.js';
import { APP_ASKER, saleQuestionLine } from '../intake/sale-questions.js';
import { chart } from '../engines/index.js';
import { dropPrecedent, dropRule, keepPrecedent, keepRule, precedentFor, precedentKey, type ChoicePrecedent, type PrecedentMatch } from '../knowledge/precedents.js';
import { CHOICES, PRIVATE_CHOICES, SALE_CHOICES, type SaleChoice, TARGET_KINDS, type Acted, type NotActed, type Answer, type Choice, type PrivateChoice, type Question, type QuestionLine, type QuestionOrigin, type QuestionTarget, type SaleGone } from '../questions/model.js';
import { saleChoiceOf, saleProposal, saleQuestionGone, saleVatCode, salesWithoutInvoice } from '../accounting/sales-without-vat.js';
import { payerKey } from '../knowledge/payer.js';
import { parseRule } from '../booking/rules.js';
import { ruleFactsOf } from '../saving/rules.js';
import type { BankTransaction } from '../types/index.js';
import type { BookChange } from '../types/assistant.js';
import { WS, RequestError, assertOpen, readBooks, updateBooks } from './books.js';
import { applyChange, bookPayment, setEntry } from './edits.js';
import { keepSwitchedOn } from '../workflows/switch-on.js';
import { loadWorkflows } from '../workflows/load.js';
import { APP_ROOT } from '../workspace/workspace.js';

const now = () => new Date().toISOString();
const append = (line: QuestionLine) => appendQuestionLine(WS, line, readBooks().config.closedThrough);

/** A person's answer, or its undo, is their switching on: the rule or precedent it writes leaves no workflow waiting (r6h-24). */
function asSwitchedOn<T>(change: () => T): T {
  const switchedOn = keepSwitchedOn(WS, () => loadWorkflows(APP_ROOT, WS.paths.root).workflows);
  const out = change();
  switchedOn();
  return out;
}

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
  if (!choices.every((c) => PRIVATE_CHOICES.includes(c as PrivateChoice))) throw new RequestError(400, `choices: ${PRIVATE_CHOICES.join(', ')}.`);
  return {
    on: { kind: on.kind as QuestionTarget['kind'], id: on.id }, by: name(b.by, 'by'), text, choices: [...new Set(choices as PrivateChoice[])],
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

/** A refusal of the books as the answer's words: a filed quarter, a payment it cannot book, an edit refused. */
function refusalOf(e: unknown): Acted {
  if (e instanceof Unclear) return { refused: e.why, detail: e.message };
  if (e instanceof ClosedPeriodError) return { refused: 'closed', ...(e.closedThrough ? { detail: e.closedThrough } : {}) };
  if (e instanceof RequestError) return { refused: 'refused', detail: e.message };
  throw e;
}

const isSaleChoice = (c: Choice): c is SaleChoice => (SALE_CHOICES as readonly string[]).includes(c);

/**
 * The sale `tx` as the owner said: its revenue entries at the normal rate or the export code
 * (booked by hand from now on, origin manual), or the payment marked as needing no receipt, its
 * booking kept. The entries are the classifier's; a payment whose revenue a person booked by hand
 * (her correction, asked back, r4c-35) takes hers. A payment with a receipt or an invoice is the
 * document's to decide, never changed; one with no revenue entry to set is refused, not answered
 * with nothing booked (r4c-28).
 */
function bookSale(books: Books, tx: BankTransaction, choice: SaleChoice): { booked: string[]; undo: BookChange[]; vatCode: string; marked?: true; account?: string } {
  if (books.mappings.some((m) => m.transactionRef === tx.ref)) throw new Unclear('hasReceipt', tx.description);
  const own = books.journalEntries.filter((e) => e.transactionRef === tx.ref);
  if (own.some((e) => e.origin === 'invoice')) throw new Unclear('hasInvoice', tx.description);
  assertOpen(books, [tx.date, ...own.map((e) => e.date)], 'editEntry');
  const sales = own.filter((e) => !e.corrects && chart().typeOf(e.accountCredit) === 'revenue');
  const hers = sales.length && sales.every((e) => e.origin === 'manual') ? sales : [];
  const classified = salesWithoutInvoice({ ...books, transactions: [tx] }, true)[0]?.entries ?? [];
  const entries = classified.length ? classified : hers;
  const account = entries[0]?.accountCredit;
  if (!entries.length && choice !== 'notSale') throw new Unclear('noSaleEntry', tx.description);
  if (choice === 'notSale') {
    tx.noReceiptNeeded = true;
    return { booked: [], undo: [], vatCode: '', marked: true, ...(account ? { account } : {}) };
  }
  const code = saleVatCode(choice) ?? '';
  const undo = entries.map((e) => setEntry(books, e.id, { vatCode: code }));
  return { booked: entries.map((e) => e.id), undo, vatCode: code, ...(account ? { account } : {}) };
}

/**
 * The answer kept as a rule for the payer: the payer's next payment in is booked on `account`
 * with the answer's VAT code, in code, without a question. A payer the bank names only by a
 * generic text gets no rule (src/knowledge/payer.ts): its next payment is asked again.
 */
function keepSaleRule(q: Question, choice: SaleChoice, tx: BankTransaction, account: string | undefined, vatCode: string, at: string): string | undefined {
  const payer = payerKey(tx);
  if (!payer || !account) return undefined;
  const raw = { id: `sale-${q.id}`, when: { payer, direction: 'in' }, then: { account, vat: vatCode || 'none' }, source: `correction ${at.slice(0, 10)}`, why: `${choice}: ${tx.counterparty || tx.description}` };
  if (!parseRule(raw, ruleFactsOf(WS)).ok) return undefined;
  keepRule(WS, raw, (old) => typeof old.id === 'string' && old.id.startsWith('sale-') && (old.when as { payer?: unknown } | undefined)?.payer === payer);
  return raw.id;
}

/** What the answer does in the books and the knowledge, or why it does nothing. `from`: the precedent that answers, kept already. */
function act(q: Question, answer: Answer, by: string, at: string, from: string | undefined): Acted | undefined {
  if (!('choice' in answer)) return undefined;
  const books = readBooks();
  const { tx, entry, why } = paymentOf(books, q.on);
  if (!tx) return { refused: why ?? 'noPayment' };
  const choice = answer.choice;
  if (isSaleChoice(choice)) {
    let sale: ReturnType<typeof bookSale>;
    try {
      sale = updateBooks((b) => bookSale(b, b.transactions.find((t) => t.ref === tx.ref)!, choice));
    } catch (e) { return refusalOf(e); }
    const rule = keepSaleRule(q, choice, tx, sale.account, sale.vatCode, at);
    return { booked: sale.booked, undo: sale.undo, vatCode: sale.vatCode, ...(sale.marked ? { marked: true as const } : {}), ...(rule ? { rule } : {}) };
  }
  let booked: { booked: string[]; undo: BookChange[] } | undefined;
  if (choice === 'private') {
    try {
      booked = updateBooks((b) => bookPrivate(b, b.transactions.find((t) => t.ref === tx.ref)!, entry));
    } catch (e) { return refusalOf(e); }
  }
  const key = precedentKey(books, tx);
  const precedent = key && !from ? keep(q, choice, by, at, tx, key) : undefined;
  if (booked) return { ...booked, ...(precedent ? { precedent } : {}) };
  return precedent ? { precedent } : undefined;
}

const DECISION: Record<PrivateChoice, (owner: string) => string> = {
  private: (owner) => `private: D ${owner}, no VAT code`,
  business: () => 'business: booked as the company\'s expense',
};

function keep(q: Question, choice: PrivateChoice, by: string, at: string, tx: BankTransaction, key: PrecedentMatch): string {
  const day = tx.date.split('-').reverse().join('.');
  const p: ChoicePrecedent = {
    id: `prec-${q.id}`, date: at.slice(0, 10), item: `${tx.counterparty || tx.description} (${day}, ${tx.currency} ${Math.abs(tx.amount).toFixed(2)})`,
    decision: DECISION[choice](ownerAccount(WS).split(' ')[0]), by, match: key, choice, question: q.id,
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
  // A question offering the sale's choices on a payment is the app's own question about it: the app never asks it again, a correction of the sale answers it.
  const sale = input.on.kind === 'payment' && !!input.choices?.length && input.choices.every(isSaleChoice);
  append({ v: 1, event: 'asked', id, at, by: input.by, on: input.on, text: input.text, choices: input.choices ?? [], ...(input.to ? { to: input.to } : {}), origin: input.origin ?? 'person', ...(sale ? { topic: 'saleVat' as const } : {}) });
  const decides = PRIVATE_CHOICES.every((c) => input.choices?.includes(c));
  const tx = decides ? paymentOf(books, input.on).tx : undefined;
  const key = tx && precedentKey(books, tx);
  const p = key ? precedentFor(WS, key) : undefined;
  if (p) answerQuestion(id, { by: p.by, answer: { choice: p.choice } }, p.id);
  return find(id);
}

/** The payment a target is about, by its ref: the payment itself, a booking's, a receipt's only one. */
function paymentRef(books: Books, on: QuestionTarget): string | undefined {
  return on.kind === 'payment' ? on.id : paymentOf(books, on).tx?.ref;
}

/** The question open already about the same item, or about the same payment, that `on` would ask about again. */
export function openQuestionOn(on: QuestionTarget): Question | undefined {
  const books = readBooks();
  const ref = paymentRef(books, on);
  return readQuestions(WS).find((q) => q.status === 'open'
    && ((q.on.kind === on.kind && q.on.id === on.id) || (!!ref && paymentRef(books, q.on) === ref)));
}

const GONE: Record<SaleGone, string> = {
  noPayment: 'Die Zahlung gibt es nicht mehr: die Frage ist geschlossen.',
  closed: 'Das Quartal der Zahlung ist eingereicht: die Frage ist geschlossen. Fehlt Steuer, bucht eine Korrektur in der offenen Periode sie nach.',
  hasReceipt: 'Die Zahlung hat jetzt einen Beleg, er entscheidet die Steuer: die Frage ist geschlossen.',
  hasInvoice: 'Die Zahlung ist aus einer Rechnung gebucht, die entscheidet die Steuer: die Frage ist geschlossen.',
};

export function answerQuestion(id: string, { by, answer }: { by: string; answer: Answer }, from?: string): Question {
  const q = find(id);
  if (q.status !== 'open') throw new RequestError(409, 'Diese Frage ist schon beantwortet.', { code: 'questionAnswered' });
  if ('choice' in answer && !q.choices.includes(answer.choice)) throw new RequestError(400, `Diese Frage hat die Wahl ${answer.choice} nicht.`);
  // The app's question whose reason went away is closed, and the person told why, not answered with nothing done (r4c-29).
  const gone = q.topic === 'saleVat' ? saleQuestionGone(readBooks(), q.on.id) : undefined;
  if (gone) {
    append({ v: 1, event: 'closed', id, at: now(), by: APP_ASKER, how: 'withdrawn', why: gone });
    throw new RequestError(409, GONE[gone], { code: 'questionGone', params: { why: gone } });
  }
  const at = now();
  const acted = asSwitchedOn(() => act(q, answer, by, at, from));
  append({ v: 1, event: 'answered', id, at, by, answer, ...(acted ? { acted } : {}), ...(from ? { from } : {}) });
  return find(id);
}

/** Takes back what the answer did (its bookings, its precedent); the question is open again. */
export function undoAnswer(id: string, by: string): Question {
  const q = find(id);
  const acted = q.answer?.acted;
  if (q.status !== 'answered') throw new RequestError(409, 'Diese Frage hat keine Antwort, die sich zurücknehmen liesse.');
  // A booking the answer changed that was booked anew since (Neu klassifizieren) is no longer there to put back: the rest is.
  const there = (b: Books, c: BookChange) => c.kind !== 'entry' || b.journalEntries.some((e) => e.id === c.id);
  if (acted && 'undo' in acted && acted.undo.length) updateBooks((b) => { for (const c of [...acted.undo].reverse()) if (there(b, c)) applyChange(b, c); });
  asSwitchedOn(() => {
    if (acted && 'precedent' in acted && acted.precedent) dropPrecedent(WS, acted.precedent);
    if (acted && 'rule' in acted && acted.rule) dropRule(WS, acted.rule);
  });
  // A booking the withdrawn rule made is the app's guess again, so the next answer books it (r4c-28).
  if (acted && 'rule' in acted && acted.rule) {
    const rule = acted.rule;
    updateBooks((b) => { const lock = periodLock(b); for (const e of b.journalEntries) if (e.rule === rule && !lock.isClosed(e.date)) delete e.rule; });
  }
  if (acted && 'marked' in acted && acted.marked && q.on.kind === 'payment') {
    updateBooks((b) => { const tx = b.transactions.find((t) => t.ref === q.on.id); if (tx) { assertOpen(b, [tx.date], 'editTransaction'); delete tx.noReceiptNeeded; } });
  }
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

/**
 * A person's correction of a customer payment without an invoice (by hand, or by a wish in the AI
 * sidebar) answers the app's question about it, as she would have: the code she set on its
 * revenue decides the choice, and the answer is kept as a rule for the payer, so the payer's next
 * payment, and «Neu klassifizieren» of this one, are booked as she set. The question is asked
 * first when the app had not asked it yet. A question answered or closed before, a code that says
 * neither a rate nor an exemption, and a payment with a receipt or an invoice are left alone; the
 * answer's «Zurücknehmen» drops the rule and keeps her booking. Her export code on a payer at home
 * answers nothing: the question stays open and asks whether it was an export or no sale (r4c-35).
 * Returns the questions it answered.
 */
export function learnFromCorrection(refs: Iterable<string>, by: string = WS.company.owner): Question[] {
  if (!WS.company.vat) return [];
  const books = readBooks();
  const closed = books.config.closedThrough;
  const answered: Question[] = [];
  for (const ref of new Set(refs)) {
    const tx = books.transactions.find((t) => t.ref === ref);
    if (!tx || tx.direction !== 'CRDT' || tx.noReceiptNeeded || (closed && tx.date <= closed)) continue;
    if (books.mappings.some((m) => m.transactionRef === ref)) continue;
    const own = books.journalEntries.filter((e) => e.transactionRef === ref);
    if (own.some((e) => e.origin === 'invoice')) continue;
    const sales = own.filter((e) => chart().typeOf(e.accountCredit) === 'revenue');
    const hers = sales.filter((e) => e.origin === 'manual');
    const codes = [...new Set(hers.map((e) => e.vatCode ?? ''))];
    if (!hers.length || hers.length !== sales.length || codes.length !== 1) continue;
    const choice = saleChoiceOf(codes[0]);
    if (!choice) continue;
    const asked = readQuestions(WS).filter((q) => q.topic === 'saleVat' && q.on.id === ref);
    if (asked.some((q) => q.status !== 'open')) continue;
    const at = now();
    let q = asked[0];
    if (!q) {
      const line = saleQuestionLine(WS, tx, at);
      append(line);
      q = find(line.id);
    }
    // A zero code on a payer at home is an export or no sale at all: asked back once, not taken as «Ausland» (r4c-35).
    if (choice === 'saleAbroad' && saleProposal(tx).choice === 'saleDomestic') continue;
    const rule = asSwitchedOn(() => keepSaleRule(q, choice, tx, hers[0].accountCredit, codes[0], at));
    const acted: Acted = { booked: [], undo: [], vatCode: codes[0], correction: true, ...(rule ? { rule } : {}) };
    append({ v: 1, event: 'answered', id: q.id, at, by, answer: { choice }, acted });
    answered.push(find(q.id));
  }
  return answered;
}
