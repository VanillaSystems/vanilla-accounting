/**
 * Which receipts no model reads (docs/specs/payroll.md §11, §22 decision 108), decided per document, whatever path asks
 * (the kind question, the VAT reading, the titles, the match, the pair chain, the booking's prompt, a vision read again):
 * - a payslip, and a fund's or insurer's document, filed as one or suggested as one (src/payroll/setup-documents.ts);
 * - a text that carries a social security number (payroll.yaml `socialSecurityNumber`) or a person's label with its
 *   colon («Versicherte Person: …», `setupDocuments.personLabels`);
 * - a text that names a person of payroll.json (`setPayrollPeople`, set where books are opened) beside a word of a birth
 *   date or of an insured wage or retirement savings (`setupDocuments.birth`, `insuredWage`).
 * Ordinary receipts (a telecom's «Guthaben», a temp agency's «Lohn», a French «Avoir», a firm named after its owner) are
 * none of these and go on as before. Such a receipt is still paired and booked by code, and by the person.
 */
import type { Receipt } from '../types/index.js';
import { payroll } from '../engines/index.js';
import { isSetupDocument, isSetupSuggested } from './payslip.js';

let people: () => readonly string[] = () => [];
/** Where the full names of the open books' payroll.json come from. */
export function setPayrollPeople(source: () => readonly string[]): void { people = source; }

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsRe = (list: readonly string[] | undefined, after = '') => (list?.length ? new RegExp(`(?<![\\p{L}\\d])(?:${[...list].sort((a, b) => b.length - a.length).map(escape).join('|')})${after}(?![\\p{L}\\d])`, 'iu') : undefined);

let cache: { of: unknown; ssn?: RegExp; label?: RegExp; detail?: RegExp } | undefined;
function words(): typeof cache {
  let p;
  try { p = payroll(); } catch { return undefined; }
  if (!p) return undefined;
  if (cache?.of !== p) {
    const sd = p.setupDocuments;
    cache = {
      of: p,
      ...(p.socialSecurityNumber?.pattern ? { ssn: new RegExp(p.socialSecurityNumber.pattern) } : {}),
      label: sd?.personLabels?.length ? new RegExp(`(?<![\\p{L}\\d])(?:${sd.personLabels.map(escape).join('|')})\\s*:`, 'iu') : undefined,
      detail: wordsRe([...(sd?.birth ?? []), ...(sd?.insuredWage ?? [])]),
    };
  }
  return cache;
}

const nameRe = (full: string): RegExp | undefined => {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  const [first, ...rest] = parts.map(escape);
  return new RegExp(`(?<![\\p{L}])(?:${first}\\s+${rest.join('\\s+')}|${rest.join('\\s+')},?\\s+${first})(?![\\p{L}])`, 'iu');
};

/** Whether a text is one no model reads (above), by its content alone. */
export function textKeptFromModels(text: string): boolean {
  const w = words();
  if (!w || !text) return false;
  if (w.ssn?.test(text) || w.label?.test(text)) return true;
  if (!w.detail?.test(text)) return false;
  let list: readonly string[] = [];
  try { list = people(); } catch { list = []; }
  return list.some((n) => nameRe(n)?.test(text));
}

/** Whether no model reads this receipt: by its kind (a payslip, a fund's document filed or suggested), else by its text. */
export function keptFromModels(r: Pick<Receipt, 'kind' | 'kindRule' | 'extractedText'>): boolean {
  return r.kind === 'payslip' || isSetupDocument(r) || isSetupSuggested(r) || textKeptFromModels(r.extractedText ?? '');
}
