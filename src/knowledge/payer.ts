/**
 * Who the other party of a payment is, as one key code can match again: for a precedent
 * (src/knowledge/precedents.ts) and for a rule keyed by the payer (src/booking/rules.ts `when.payer`).
 * A wrong match is worse than a question, so a key must name one counterparty for certain; a bank
 * text such as «Karte 5412 Einkauf» names none. Browser-safe and pure.
 */
import type { BankTransaction } from '../types/index.js';
import { merchantOf } from './counterparties.js';

/**
 * Words of a bank text that name a way to pay or the bank's wrapper, never a counterparty: a text
 * of these alone («Karte 5412 Einkauf», «Kartenzahlung», «TWINT», «Card transaction of …») is
 * generic. Lower case, in the app's four languages.
 */
const GENERIC = new Set([
  'karte', 'kartenzahlung', 'einkauf', 'zahlung', 'zahlungen', 'belastung', 'gutschrift', 'lastschrift', 'dauerauftrag', 'überweisung', 'bezug', 'barbezug', 'bargeld',
  'twint', 'maestro', 'visa', 'mastercard', 'debit', 'debitkarte', 'kreditkarte', 'pos', 'ec', 'bancomat', 'postomat', 'atm', 'e-banking', 'ebanking', 'online',
  'card', 'transaction', 'payment', 'purchase', 'issued', 'by', 'of', 'sent', 'money', 'to', 'from', 'received', 'paid', 'transfer', 'withdrawal', 'cash',
  'carte', 'achat', 'paiement', 'retrait', 'virement', 'carta', 'acquisto', 'pagamento', 'prelievo', 'bonifico',
  'chf', 'eur', 'usd', 'gbp', 'nr', 'no', 'ref', 'referenz', 'am', 'vom', 'bei', 'in', 'und', 'mit',
]);

const words = (s: string) => s.toLowerCase().replace(/\d+([.,]\d+)*/g, ' ').replace(/[^\p{L}&\s-]/gu, ' ').split(/\s+/).filter(Boolean);
const normalized = (s: string | undefined) => s?.toLowerCase().replace(/[^a-z0-9äöü]/g, '') || undefined;

/** A bank text that names no counterparty: nothing but generic words and numbers. */
export const isGenericText = (text: string): boolean => !words(text).some((w) => w.length >= 3 && !GENERIC.has(w));

/** The bank's counterparty text as a key («Muster AG» → «musterag»), or none when it is generic. */
export function textKey(tx: Pick<BankTransaction, 'description' | 'counterparty'>): string | undefined {
  const text = tx.counterparty || merchantOf(tx.description);
  if (isGenericText(text)) return undefined;
  const key = normalized(words(text).join(' '));
  return key && key.length >= 3 ? key : undefined;
}

/** An IBAN as the books compare it: no spaces, upper case. */
export const ibanKey = (iban: string | undefined): string | undefined => {
  const k = iban?.replace(/\s+/g, '').toUpperCase();
  return k && /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(k) ? k : undefined;
};

/** The payer's key for a rule: its IBAN when the bank names one, else its counterparty text when that is not generic. */
export const payerKey = (tx: Pick<BankTransaction, 'description' | 'counterparty' | 'counterpartyIban'>): string | undefined =>
  ibanKey(tx.counterpartyIban) ?? textKey(tx);

/** Whether a rule's `when.payer` names this payment's payer: its IBAN or its counterparty text. */
export const isPayer = (key: string, tx: Pick<BankTransaction, 'description' | 'counterparty' | 'counterpartyIban'>): boolean => {
  const k = key.replace(/\s+/g, '');
  return (!!ibanKey(tx.counterpartyIban) && ibanKey(tx.counterpartyIban) === ibanKey(k)) || textKey(tx) === k.toLowerCase();
};
