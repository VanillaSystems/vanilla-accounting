/**
 * The model reads facts, code decides the code (issue #64). The model states per line what the
 * receipt shows: Swiss VAT charged or not, the rate, Bezugsteuer, a tax amount (rule 7 of
 * src/llm/prompts.ts). The code follows from those facts and the line's accounts
 * (src/accounting/vat-codes.ts codeOfFacts): the letter from the account (pv-prefix-from-account),
 * the minus from the money's direction, the suffix from the booking pattern. A code the model still
 * writes is read back to the facts it states, so its letter and sign count for nothing either.
 * The checks after it (Bezugsteuer, sales, credit notes, the receipt rules) then work on that code.
 */
import { codeOfFacts, factsOfCode, rateOf, type VatLineFacts } from '../accounting/vat-codes.js';
import type { ClassifyEntry } from '../llm/prompts.js';
import type { BankTransaction } from '../types/index.js';

const CHARGES: readonly string[] = ['charged', 'none', 'acquisition'] satisfies VatLineFacts['charge'][];
const SUPPLIES: readonly string[] = ['goods', 'service', 'exempt'] satisfies NonNullable<VatLineFacts['supply']>[];

/**
 * A line's accounts with the side it left empty filled: the bank on the side the payment's
 * direction gives it, else (a Skonto line the bank received back) the other one; a tax amount
 * keeps its one empty leg, which its code supplies.
 */
export function sidesOf(e: Pick<ClassifyEntry, 'accountDebit' | 'accountCredit'>, direction: BankTransaction['direction'], bankAccount: string, taxAmount: boolean): { accountDebit: string; accountCredit: string } {
  let accountDebit = e.accountDebit || (direction === 'CRDT' ? bankAccount : '');
  let accountCredit = e.accountCredit || (direction === 'DBIT' ? bankAccount : '');
  if (!taxAmount) {
    accountDebit ||= e.accountCredit && bankAccount;
    accountCredit ||= e.accountDebit && bankAccount;
  }
  return { accountDebit, accountCredit };
}

/** The facts the model stated for `e`; a rate that is no Swiss rate (a foreign 19 %) is no Swiss VAT. Undefined: it stated none. */
function factsOf(e: ClassifyEntry): VatLineFacts | undefined {
  if (!CHARGES.includes(e.vat ?? '')) return undefined;
  const supply = SUPPLIES.includes(e.supply ?? '') ? { supply: e.supply } : {};
  const rate = e.vatRate === undefined ? undefined : rateOf(e.vatRate);
  if (e.vat === 'charged' && e.vatRate !== undefined && !rate) return { charge: 'none', ...supply };
  return { charge: e.vat!, ...(rate ? { rate } : {}), ...(e.amountIs === 'tax' ? { amountIs: 'tax' } : {}), ...supply };
}

/**
 * The model's lines of a payment with the code derived in code: from the facts it stated, else from
 * the facts of a code it wrote (the code as written where the accounts take none). A line with
 * neither carries no code.
 */
export function withDerivedCodes(lines: readonly ClassifyEntry[], direction: BankTransaction['direction'], bankAccount: string): ClassifyEntry[] {
  return lines.map((e) => {
    const stated = factsOf(e);
    const facts = stated ?? factsOfCode(e.vatCode);
    if (!facts) return e;
    const { accountDebit, accountCredit } = sidesOf(e, direction, bankAccount, facts.amountIs === 'tax');
    const code = codeOfFacts(facts, accountDebit, accountCredit) ?? (stated ? '' : e.vatCode);
    return { ...e, vatCode: code };
  });
}
