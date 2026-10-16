/**
 * The correction of a filed entry, by what was wrong with it (golden rule 1: booked in the open
 * period with `corrects`, declared on the correction return). The payment happened, so a
 * correction of the VAT code or of the account leaves the bank alone; only a storno takes the
 * whole entry back, bank side included. Pure: Buchungen opens its correction form with these.
 */
import type { BankTransaction, CorrectionCase, JournalEntry, Receipt } from '../types/index.js';
import { chart, vat, yearEnd } from '../engines/index.js';
import { reversalOf, turned, type Draft } from './reversal.js';
import { codeForRate } from './vat-codes.js';
import { filingKeyOf, type FilingLength } from './periods.js';

/** What was wrong: the VAT code, the account (expense or revenue), or the whole entry. */
export type CorrectionKind = 'vat' | 'account' | 'storno';

type Corrected = Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'amount' | 'vatCode'>;

/** The kinds an entry offers, the first the form starts with: a VAT code to take back first. */
export const correctionKinds = (e: Corrected): CorrectionKind[] => (e.vatCode ? ['vat', 'account', 'storno'] : ['account', 'storno']);

/** The side the money did not move on: the expense or revenue account, the debit when neither side is a bank. */
function ownSide(e: Corrected, isBank: (account: string) => boolean): 'accountDebit' | 'accountCredit' {
  if (!e.accountDebit) return 'accountCredit';
  if (!e.accountCredit) return 'accountDebit';
  return isBank(e.accountDebit) && !isBank(e.accountCredit) ? 'accountCredit' : 'accountDebit';
}

/** The input tax a purchase claimed: its rate, or undefined (a sale, a zero code, a refund, a correction). */
function inputTaxRate(code: string | undefined): number | undefined {
  const info = code ? vat().codes.parse(code) : null;
  return info && info.inputTaxZiffer && !info.acquisitionZiffer && !info.isNegative && info.rate > 0 ? info.rate : undefined;
}

/** The Swiss VAT rate the receipts of an entry show (the highest with tax on it); undefined when none shows Swiss VAT. */
export function receiptRate(receipts: ReadonlyArray<Pick<Receipt, 'hasSwissVat' | 'vatSummary' | 'kind'>>): number | undefined {
  const rates = receipts.filter((r) => r.hasSwissVat && r.kind !== 'duplicate').flatMap((r) => (r.vatSummary ?? []).filter((g) => g.ratePercent > 0 && g.vat > 0).map((g) => g.ratePercent));
  return rates.length ? Math.max(...rates) : undefined;
}

/**
 * The receipts whose VAT a correction of `e` reads: those linked to it, and those of its payment
 * that came after the filing and so are not linked (`filedPayment`, corner-33); `from` is the
 * receipt the correction was opened from, pointed at the payment or not.
 */
export function correctionReceipts<R extends Pick<Receipt, 'id' | 'filedPayment'>>(e: Pick<JournalEntry, 'transactionRef'>, linked: readonly R[], receipts: readonly R[], from?: string): R[] {
  const late = receipts.filter((r) => !linked.some((l) => l.id === r.id) && ((!!r.filedPayment && r.filedPayment === e.transactionRef) || r.id === from));
  return [...linked, ...late];
}

/** A purchase booked without input tax (I0, M0): the code a receipt with Swiss VAT at `rate` gives it. */
export function claimCode(e: Corrected, account: string, rate: number | undefined): string | undefined {
  const info = e.vatCode ? vat().codes.parse(e.vatCode) : null;
  if (!rate || !info || info.rate !== 0 || info.isNegative || info.revenueZiffer || info.deductionZiffer || info.correctionZiffer) return undefined;
  const type = chart().typeOf(account);
  if (type !== 'expense' && type !== 'asset') return undefined;
  return codeForRate(rate, account, account) ?? undefined;
}

/**
 * The code that takes back the input tax of a purchase moved onto the owner's private account
 * (Eigenverbrauch, the year close's `privateUse` code such as K81-B, at the purchase's rate):
 * private spending claims no input tax. Undefined when the purchase claimed none.
 */
export function privateUseCode(code: string | undefined): string | undefined {
  const rate = inputTaxRate(code);
  const template = yearEnd().templates.find((t) => t.id === 'privateUse')?.vatCode;
  const like = template && vat().codes.parse(template);
  if (!rate || !template || !like) return undefined;
  const candidate = template.replace(/\d+/, String(Math.round(rate * 10)));
  const info = vat().codes.parse(candidate);
  return info && info.rate === rate && info.correctionZiffer === like.correctionZiffer ? candidate : undefined;
}

/**
 * The VAT code an account correction carries: none (the VAT stays as declared), except onto the
 * owner's private account, where the input tax the purchase claimed is taken back with it (r4t-7).
 */
export function accountCorrectionCode(e: Corrected, to: string, isPrivate: (account: string) => boolean): string | undefined {
  return to && isPrivate(to) ? privateUseCode(e.vatCode) : undefined;
}

/**
 * The correction entry, dated `date`:
 * - `vat`: the expense (or revenue) account against itself with the VAT code turned, so only the
 *   tax is taken back (6510/6510 -I81). A one-sided VAT entry is turned whole: it has no bank side.
 *   A purchase booked without input tax whose receipt shows Swiss VAT at `receiptRate` claims it
 *   instead (6000/6000 I81, r4c-37): turning a zero code would book nothing.
 * - `account`: the amount moved from the old account to a new one, left blank for the person; the
 *   VAT stays as declared (onto the private account: accountCorrectionCode).
 * - `storno`: the entry the other way round, bank side included.
 */
export function correctionOf(e: Corrected, kind: CorrectionKind, date: string, description: string, isBank: (account: string) => boolean, receiptRate?: number): Draft {
  const own = ownSide(e, isBank);
  const account = e[own];
  if (kind === 'storno' || (kind === 'vat' && (!e.accountDebit || !e.accountCredit))) return reversalOf(e, date, description);
  const claim = kind === 'vat' ? claimCode(e, account, receiptRate) : undefined;
  if (claim) return { date, accountDebit: account, accountCredit: account, amount: e.amount, vatCode: claim, description };
  if (kind === 'vat') {
    const vatCode = turned(e.vatCode);
    return { date, accountDebit: account, accountCredit: account, amount: e.amount, ...(vatCode && { vatCode }), description };
  }
  return own === 'accountDebit'
    ? { date, accountDebit: '', accountCredit: account, amount: e.amount, description }
    : { date, accountDebit: account, accountCredit: '', amount: e.amount, description };
}

/**
 * The filed period a payment's bookings correct, or undefined: a private outlay (a manual payment,
 * «Privat oder bar bezahlt») for a receipt dated in a filed period was paid on the receipt's day,
 * so its booking in the open period is a correction of that period, declared on its correction return (golden
 * rule 1, r8k-10). A bank payment never is: an invoice of March paid in July is a July booking
 * (cash basis). The earliest filed receipt date names the period.
 */
export function correctsFor(tx: Pick<BankTransaction, 'source'>, receipts: ReadonlyArray<Pick<Receipt, 'date'>>, isClosed: (date: string) => boolean, length: FilingLength): string | undefined {
  if (tx.source !== 'manual') return undefined;
  const filed = receipts.map((r) => r.date).filter((d): d is string => !!d && isClosed(d)).sort()[0];
  return filed ? filingKeyOf(filed, length) : undefined;
}

/** The bank accounts an entry typed without its payment would move: money no statement shows. */
export const banksMoved = (e: Pick<JournalEntry, 'accountDebit' | 'accountCredit'>, isBank: (account: string) => boolean): string[] =>
  e.accountDebit === e.accountCredit ? [] : [e.accountDebit, e.accountCredit].filter((a) => !!a && isBank(a));

const line = (e: Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'amount' | 'vatCode'>) => `${e.accountDebit || '–'} / ${e.accountCredit || '–'}${e.vatCode ? ` ${e.vatCode}` : ''} ${e.amount.toFixed(2)}`;
const day = (iso: string) => iso.split('-').reverse().join('.');

const KIND_TITLE: Record<CorrectionKind, string> = { vat: 'Steuercode korrigiert', account: 'Konto korrigiert', storno: 'Buchung storniert' };
const KIND_WRONG: Record<CorrectionKind, string> = { vat: 'der Steuercode war falsch', account: 'das Konto war falsch', storno: 'die Buchung gehörte nicht in die Bücher' };

/**
 * The case a correction booked by hand writes into config.correctionCases (r8c-6): what was filed,
 * what fixes it, both entries by id. The correction return then explains the correction instead of listing an
 * orphan. Written in the books' language, as the cases of the demo books are.
 */
export function correctionCaseFor(original: JournalEntry, correction: JournalEntry, kind: CorrectionKind, period: string): CorrectionCase {
  return {
    id: `${period}-${correction.id}`,
    period: period as CorrectionCase['period'],
    title: `${KIND_TITLE[kind]}: ${original.description || original.transactionRef}`,
    wrong: `Buchung ${original.id} vom ${day(original.date)} (${line(original)}) wie eingereicht: ${KIND_WRONG[kind]}.`,
    fix: `Korrekturbuchung ${correction.id} vom ${day(correction.date)} (${line(correction)}) mit corrects ${period}; die eingereichte Buchung bleibt, wie sie ist.`,
    originalEntryIds: [original.id],
    correctionEntryIds: [correction.id],
  };
}
