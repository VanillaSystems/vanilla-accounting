/**
 * Why a workflow step refused, for the person who reads the run: a code the screens have words
 * for in every language (`runWhy.<code>` in src/app/i18n/locales/), and the words' parameters. The
 * English message beside it is the log's and the CLI's. A step throws `Refused`; the engine keeps
 * `why` on the step record and on the stuck run (src/workflows/engine.ts), and the screens show
 * the words, never the message (persona round 6: «2026-H2 closes with the year …»,
 * «company.vat.rates[].activityId» reached the owner).
 */
export const REFUSAL_CODES = [
  // The VAT filing (src/workflows/filing.ts).
  'periodRunning', 'periodFiled', 'notFilingKey', 'nextToClose', 'activityIdMissing', 'figuresChanged', 'questionsOpen', 'filedNotSealed', 'invoiceEventsMissing',
  // The year close (src/books/year-close.ts, src/workflows/year-end.ts).
  'notYear', 'yearClosedAlready', 'rateNotPublished', 'yearEndEntryUnknown', 'yearChecklistClosed', 'receivablesBooked', 'yearItemsOpen', 'yearNotClosed', 'openingUnbalanced', 'accountNotInChart', 'paymentsUnlinked', 'noProfitAllocation', 'entryNotStale', 'yearEndAccountUnknown', 'yearEndDocumentType', 'yearEndBalanceStated',
  // The inbox (src/workflows/actions.ts): a statement of no bank account, a receipt in two years, an error.
  'statementsUnmatched', 'receiptsTwice', 'stepFailed',
  // The engine's own (src/workflows/engine.ts).
  'workflowGone', 'stepGone', 'notBuilt', 'ownCodeStep', 'transactionGone', 'leadsNowhere', 'tooManySteps', 'cannotRunYet', 'emitsExtra', 'noMoreAnswers',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Refusal {
  code: RefusalCode;
  params: Record<string, string>;
}

/** A refusal a step throws: `why` for the person, the message for the log. */
export class Refused extends Error {
  constructor(readonly why: Refusal, message: string) {
    super(message);
  }
}

export const refusalOf = (e: unknown): Refusal | undefined => (e instanceof Refused ? e.why : undefined);

/** A refusal and its log line in one: `refuse('periodFiled', { period }, '2026-Q2 is filed already')`. */
export const refuse = (code: RefusalCode, params: Record<string, string>, message: string): Refused => new Refused({ code, params }, message);
