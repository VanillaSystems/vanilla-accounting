/**
 * Bezugsteuer (processes/booking.guide.yaml#purchase_vat pv-bezugsteuer, MWSTG Art. 45): a firm
 * registered for VAT owes the tax on a service from a supplier abroad that charged none, from the
 * first franc, and on the effective method deducts it again. Not on goods (import VAT instead), not
 * on a service the law exempts (Art. 21 and 45a: payment processing, banking, insurance), not when
 * the supplier is registered here. Whether a line buys a service and where its supplier sits needs
 * reading, so the model states both (ClassifyEntry.supply, supplierCountry); the receipts' VAT
 * facts, the firm's setup and the code follow in code (issue #28: the model booked I0).
 */
import { chart, invoicing, vat } from '../engines/index.js';
import { wordsIn } from '../export/texts.js';
import type { ClassifyEntry } from '../llm/prompts.js';
import type { JournalEntry, Receipt, Supply } from '../types/index.js';
import type { VatSetup } from '../workspace/vat-setup.js';
import { normalRate } from './sales-without-vat.js';
import { codeForRate, codeOnAccount } from './vat-codes.js';

export type AcquisitionDocument = Pick<Receipt, 'hasSwissVat' | 'vatId' | 'vatSummary'>;

/** Why code set the line's code: a service from abroad (`foreignService`), or why the model's acquisition code is none. */
export type AcquisitionWhy = 'foreignService' | 'swissVat' | 'swissUid' | 'goods' | 'exempt' | 'domestic';
export interface AcquisitionCode { code: string | undefined; why: AcquisitionWhy; country?: string }

/** `abroad`: the supplier sits outside the territory, its country not known here (the app booked Bezugsteuer on the payment before, src/booking/national-vat.ts). */
type Line = Pick<ClassifyEntry, 'vatCode' | 'supply' | 'supplierCountry' | 'accountDebit' | 'accountCredit'> & { abroad?: true };

const SUPPLIES: readonly string[] = ['goods', 'service', 'exempt'] satisfies Supply[];

/** The model's supply and supplier country of a line, kept only when they are what rule 7h asks: a known supply, a two-letter country (upper case). */
export function readSupplier(line: Pick<ClassifyEntry, 'supply' | 'supplierCountry'>): Pick<JournalEntry, 'supply' | 'supplierCountry'> {
  const supply = SUPPLIES.includes(line.supply ?? '') ? line.supply : undefined;
  const country = /^[A-Za-z]{2}$/.test(line.supplierCountry ?? '') ? line.supplierCountry!.toUpperCase() : undefined;
  return { ...(supply && { supply }), ...(country && { supplierCountry: country }) };
}
const SWISS_UID = /^CHE/i;

/** The one positive rate the receipt shows, else the normal rate (a receipt with Swiss VAT whose rate was not read). */
function rateShown(d: AcquisitionDocument): number {
  const rates = [...new Set((d.vatSummary ?? []).map((g) => g.ratePercent).filter((r) => r > 0))];
  return rates.length === 1 ? rates[0] : normalRate();
}

/**
 * The code of the model's purchase line `line` (bank side filled in) on a payment with the linked
 * receipts `documents`, or undefined when the model's code stands. Only on an expense line (its
 * credit: a refund, which takes the minus) of a registered firm with a receipt (pv-no-receipt):
 * - a service from a supplier outside the VAT territory, every receipt read and none showing Swiss
 *   VAT or a Swiss UID: the acquisition code at the normal rate on the net amount (B81-1), on the
 *   net tax rate method too, whose form owes it without the deduction;
 * - an acquisition code the model wrote although the receipts show Swiss VAT: the input-tax code at
 *   their rate (none on the net tax rate method); although they show a Swiss UID, or
 *   the line buys goods or an exempt service, or the supplier sits in the territory: the zero code
 *   of the account.
 * Without the facts, or with receipts that disagree, the model's code stands: code decides only on
 * what it was told.
 */
export function acquisitionCodeOf(line: Line, documents: readonly AcquisitionDocument[], setup: VatSetup): AcquisitionCode | undefined {
  if (!setup.registered || !documents.length) return undefined;
  const expense = (a: string) => !!a && chart().typeOf(a) === 'expense';
  const refund = expense(line.accountCredit) && !expense(line.accountDebit);
  if (!refund && !(expense(line.accountDebit) && !expense(line.accountCredit))) return undefined;
  const { supply, supplierCountry: country } = readSupplier(line);
  // A line cannot be told apart from its payment's other receipts: receipts that disagree (one with Swiss VAT, one without, or one not read) decide nothing.
  const shown = documents.every((d) => d.hasSwissVat === true) ? documents[0] : undefined;
  if (!shown && !documents.every((d) => d.hasSwissVat === false)) return undefined;
  const uids = documents.filter((d) => SWISS_UID.test(d.vatId ?? '')).length;
  if (!shown && uids && uids < documents.length) return undefined;
  const domestic = country ? invoicing().territory.includes(country) : line.abroad ? false : undefined;
  const against: AcquisitionWhy | undefined = shown ? 'swissVat'
    : uids ? 'swissUid'
    : supply === 'goods' || supply === 'exempt' ? supply
    : domestic ? 'domestic'
    : undefined;
  const neg = vat().codes.negativePrefix;
  if (!against) {
    if (supply !== 'service' || domestic !== false) return undefined;
    const code = vat().codes.acquisitionAt(normalRate());
    return code ? { code: refund ? neg + code : code, why: 'foreignService', country } : undefined;
  }
  if (!vat().codes.parse(line.vatCode ?? '')?.acquisitionZiffer) return undefined;
  const code = shown
    ? codeForRate(rateShown(shown), line.accountDebit, line.accountCredit) ?? undefined
    : codeOnAccount(`${refund ? neg : ''}I0`, line.accountDebit, line.accountCredit);
  return { code, why: against, ...(country && { country }) };
}

/** The booking's reason when code set the code (booking texts stay German, docs/i18n.md). */
export const acquisitionReason = ({ code, why, country }: AcquisitionCode): string =>
  wordsIn('de').t(`rules.say.acquisition.${why}`, { code: code ?? '–', country: country ?? '' });
