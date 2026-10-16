/**
 * The changes an answer asks for: a ```vanilla-changes block at its end, a JSON list of Change
 * (src/types/assistant.ts). The block is cut from the text the person reads; every change's shape
 * is checked here, at the edge, before the server applies it (src/server/edits.ts for the books,
 * src/server/workspace-edits.ts for the chart, the invoicing settings and invoice drafts, which
 * check the values their own way). The kinds an undo alone uses (an account taken back, a draft
 * dropped) are not accepted from an answer.
 */
import type { Change, DraftLine, EntrySet, InvoicingSet, NewEntry, ReceiptSet } from '../types/assistant.js';
import { RECEIPT_KINDS, type ReceiptKind } from '../types/index.js';
import type { ApiRefusal } from '../types/api-error.js';
import { parseVatFacts } from '../accounting/vat-facts.js';
import { PRESETS } from '../export/model.js';
import { parseSpec } from '../reports/spec.js';
import { questionChoices, TARGET_KINDS, type QuestionTarget } from '../questions/model.js';

const BLOCK = /```vanilla-changes\s*([\s\S]*?)(?:```|$)/;

/** The text without the block; also while it streams in, an unfinished block is not shown. */
export const withoutChanges = (text: string): string => text.replace(BLOCK, '').trimEnd();

/** A block the app cannot read as changes; `refusal` when a person can be told in plain words what is wrong. */
export class ChangesError extends Error {
  constructor(message: string, readonly refusal?: ApiRefusal) { super(message); }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ChangesError(`${what} fehlt`);
  return v.trim();
};
const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ChangesError(`${what} ist keine Zahl`);
  return v;
};
const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ChangesError(`${what} fehlt`);
  return v as Record<string, unknown>;
};

function receiptSet(v: unknown): ReceiptSet {
  const s = obj(v, 'set');
  const out: ReceiptSet = {};
  if ('date' in s) {
    if (s.date !== null && !DATE.test(String(s.date))) throw new ChangesError('date muss JJJJ-MM-TT sein');
    out.date = s.date === null ? null : String(s.date);
  }
  if ('amount' in s) out.amount = s.amount === null ? null : num(s.amount, 'amount');
  if ('currency' in s) { const c = str(s.currency, 'currency').toUpperCase(); if (!/^[A-Z]{3}$/.test(c)) throw new ChangesError('currency'); out.currency = c; }
  if ('description' in s) out.description = typeof s.description === 'string' ? s.description : '';
  if ('vat' in s) out.vat = parseVatFacts(s.vat, (what) => { throw new ChangesError(what); });
  if (!Object.keys(out).length) throw new ChangesError('set ist leer');
  return out;
}

/**
 * An account as the answer names it: a number (6510 or "6510"), or empty for the side a one-sided
 * VAT entry leaves out. Debit and credit may be the same account: a correction of the VAT alone
 * (6510/6510 -I81, corner-30). Whether a side may be empty is the books' to say (src/server/edits.ts).
 */
const account = (v: unknown, what: string): string => {
  if (v === null || v === '') return '';
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v !== 'string') throw new ChangesError(`${what} ist keine Kontonummer`);
  return v.trim();
};

function entrySet(v: unknown): EntrySet {
  const s = obj(v, 'set');
  const out: EntrySet = {};
  for (const k of ['description', 'vatCode'] as const) if (k in s) out[k] = String(s[k] ?? '');
  for (const k of ['accountDebit', 'accountCredit'] as const) if (k in s) out[k] = account(s[k], k);
  if ('date' in s) { if (!DATE.test(String(s.date))) throw new ChangesError('date muss JJJJ-MM-TT sein'); out.date = String(s.date); }
  if ('amount' in s) out.amount = num(s.amount, 'amount');
  if (!Object.keys(out).length) throw new ChangesError('set ist leer');
  return out;
}

/** A booking the AI adds: always the person's (origin manual); the exchange rate of a foreign payment comes from its other bookings (src/server/edits.ts). */
function newEntry(v: unknown): NewEntry {
  const e = obj(v, 'entry');
  const date = str(e.date, 'date');
  if (!DATE.test(date)) throw new ChangesError('date muss JJJJ-MM-TT sein');
  const amount = num(e.amount, 'amount');
  if (amount === 0) throw new ChangesError('amount ist 0', { code: 'amountZero' });
  const text = (k: string) => (typeof e[k] === 'string' && e[k].trim() ? e[k].trim() : undefined);
  const accountDebit = 'accountDebit' in e ? account(e.accountDebit, 'accountDebit') : '';
  const accountCredit = 'accountCredit' in e ? account(e.accountCredit, 'accountCredit') : '';
  if (!accountDebit && !accountCredit) throw new ChangesError('accountDebit oder accountCredit fehlt', { code: 'noAccount' });
  const transactionRef = text('transactionRef');
  const vatCode = text('vatCode');
  const corrects = text('corrects');
  return {
    ...(transactionRef && { transactionRef }), date, accountDebit, accountCredit, amount,
    ...(vatCode && { vatCode }), description: str(e.description, 'description'), ...(corrects && { corrects }), origin: 'manual',
  };
}

const LANGUAGES = ['de', 'fr', 'it', 'en'];
const TEXTS = ['salutation', 'intro', 'closing', 'mailSubject', 'mailBody'];

function invoicingSet(v: unknown): InvoicingSet {
  const s = obj(v, 'set');
  const out: InvoicingSet = {};
  if ('paymentTermsDays' in s) {
    const days = num(s.paymentTermsDays, 'paymentTermsDays');
    if (!Number.isInteger(days) || days < 1 || days > 120) throw new ChangesError('paymentTermsDays: 1 bis 120 Tage');
    out.paymentTermsDays = days;
  }
  if ('texts' in s) {
    const texts = obj(s.texts, 'texts');
    out.texts = Object.fromEntries(Object.entries(texts).map(([lang, t]) => {
      if (!LANGUAGES.includes(lang)) throw new ChangesError(`texts: Sprache ${lang}`);
      const own = obj(t, `texts.${lang}`);
      return [lang, Object.fromEntries(Object.entries(own).map(([k, text]) => {
        if (!TEXTS.includes(k)) throw new ChangesError(`texts.${lang}.${k}`);
        if (text !== null && typeof text !== 'string') throw new ChangesError(`texts.${lang}.${k} ist kein Text`);
        return [k, text];
      }))];
    }));
  }
  if (!Object.keys(out).length) throw new ChangesError('set ist leer');
  return out;
}

/** A draft as the invoices' own reader takes it (src/invoices/service.ts parseDraftPatch checks the lines when it is made). */
function invoiceDraft(c: Record<string, unknown>): Change {
  const draft = obj(c.draft, 'draft');
  if (!Array.isArray(draft.lines) || !draft.lines.length) throw new ChangesError('draft.lines fehlt');
  if ('customerId' in draft) throw new ChangesError('der Kunde steht in customer, nicht im Entwurf');
  const customer = typeof c.customer === 'string' && c.customer.trim() ? c.customer.trim() : undefined;
  const newCustomer = c.newCustomer === undefined ? undefined : obj(c.newCustomer, 'newCustomer');
  if (!customer === !newCustomer) throw new ChangesError('customer oder newCustomer, eines von beiden');
  const lines = draft.lines as DraftLine[];
  return { kind: 'invoiceDraft', ...(customer ? { customer } : { newCustomer: { ...newCustomer, name: str(newCustomer!.name, 'newCustomer.name') } }), draft: { ...draft, lines } };
}

function change(v: unknown): Change {
  const c = obj(v, 'change');
  switch (c.kind) {
    case 'receipt': return { kind: 'receipt', id: str(c.id, 'id'), set: receiptSet(c.set) };
    case 'link': case 'unlink': return { kind: c.kind, receipt: str(c.receipt, 'receipt'), payment: str(c.payment, 'payment') };
    case 'entry': return { kind: 'entry', id: str(c.id, 'id'), set: entrySet(c.set) };
    case 'newEntry': return { kind: 'newEntry', entry: newEntry(c.entry) };
    case 'deleteEntry': return { kind: 'deleteEntry', id: str(c.id, 'id') };
    case 'receiptKind': {
      if (c.as !== null && !RECEIPT_KINDS.includes(c.as as ReceiptKind)) throw new ChangesError(`as: eines von ${RECEIPT_KINDS.join(', ')} oder null`);
      return { kind: 'receiptKind', id: str(c.id, 'id'), as: c.as as ReceiptKind | null };
    }
    case 'account': {
      const number = str(c.number, 'number');
      if (!/^\d{4}$/.test(number)) throw new ChangesError('number: vier Stellen', { code: 'accountNumber', params: { account: number } });
      if (typeof c.name !== 'string' || !c.name.trim()) throw new ChangesError('name fehlt', { code: 'accountName', params: { account: number } });
      return { kind: 'account', number, name: c.name.trim() };
    }
    case 'invoicing': return { kind: 'invoicing', set: invoicingSet(c.set) };
    case 'invoiceDraft': return invoiceDraft(c);
    case 'export': {
      const preset = str(c.preset, 'preset');
      if (!PRESETS.some((p) => p.id === preset)) throw new ChangesError(`preset: eines von ${PRESETS.map((p) => p.id).join(', ')}`);
      return { kind: 'export', preset, ...(typeof c.period === 'string' && c.period.trim() ? { period: c.period.trim() } : {}) };
    }
    case 'bookAgain': return { kind: 'bookAgain' };
    case 'report': {
      const p = parseSpec(c.spec);
      if (!p.ok) throw new ChangesError(`report: ${p.refusal.code} ${JSON.stringify(p.refusal.params)}`, { code: 'report', params: { refusal: p.refusal } });
      return { kind: 'report', spec: p.value, ...(typeof c.period === 'string' && c.period.trim() ? { period: c.period.trim() } : {}) };
    }
    case 'question': {
      const on = obj(c.on, 'on');
      if (!TARGET_KINDS.includes(on.kind as QuestionTarget['kind'])) throw new ChangesError(`on.kind: eines von ${TARGET_KINDS.join(', ')}`);
      const choices = questionChoices(c.choices === undefined ? [] : Array.isArray(c.choices) ? c.choices : [c.choices]);
      if (!choices) throw new ChangesError(`choices: ${JSON.stringify(c.choices)}`, { code: 'questionChoices' });
      const to = typeof c.to === 'string' && c.to.trim() ? c.to.trim() : undefined;
      return { kind: 'question', on: { kind: on.kind as QuestionTarget['kind'], id: str(on.id, 'on.id') }, text: str(c.text, 'text'), ...(choices.length ? { choices } : {}), ...(to ? { to } : {}) };
    }
    default: throw new ChangesError(`unbekannte Änderung ${String(c.kind)}`);
  }
}

/** The changes the answer asks for; none without a block. A block that does not parse throws. */
export function changesIn(text: string): Change[] {
  const m = BLOCK.exec(text);
  if (!m) return [];
  let raw: unknown;
  try { raw = JSON.parse(m[1]); } catch { throw new ChangesError('kein gültiges JSON'); }
  if (!Array.isArray(raw)) throw new ChangesError('keine Liste');
  return raw.map(change);
}
