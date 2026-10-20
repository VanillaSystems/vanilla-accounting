/**
 * The mailbox Belege › «Weg hinzufügen» chose (an address, the server its MX records suggest):
 * Firma › Quellen opens its «Postfach verbinden» form filled in from it, once.
 */
export interface MailDraft { address: string; host: string }

let draft: MailDraft | undefined;

export const setMailDraft = (d: MailDraft): void => { draft = d; };

export const peekMailDraft = (): MailDraft | undefined => draft;
/** Once the form has it: a later visit of Quellen opens the list as usual. */
export const clearMailDraft = (): void => { draft = undefined; };
