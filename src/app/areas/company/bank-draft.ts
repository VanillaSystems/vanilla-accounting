/**
 * The account a refused statement belongs to (the drop dialog's «Bankkonto hinzufügen»): Firma ›
 * Bankkonten opens its «hinzufügen» form with the IBAN and currency filled in.
 */
export interface BankDraft { iban: string; currency: string }

let draft: BankDraft | undefined;

export const setBankDraft = (d: BankDraft): void => { draft = d; };
export const peekBankDraft = (): BankDraft | undefined => draft;
export const clearBankDraft = (): void => { draft = undefined; };
