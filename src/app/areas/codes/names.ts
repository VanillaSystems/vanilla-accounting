/**
 * A VAT code as a person reads it in the UI (issue #224): its plain name from the catalogue
 * (vatCodeName in src/accounting/vat-codes.ts) in the current language, the code beside it. Every
 * view that shows a code takes its words from here.
 */
import { vatCodeName, type VatCodeEntry } from '../../../accounting/vat-codes.js';
import { accountingName, t, tWith } from '../../i18n/index.js';
import { codeExplanation, type CodeExplanation, type Words } from './model.js';

export const kindName = (e: VatCodeEntry) => t(`vatCodes.kind.${e.kind}.name`);

/** The words of an explanation, rendered. */
export const words = (w: Words): string => tWith(w.key, w.vars ?? {});

/** The code's name for the firm: its own rate with its percent, else the catalogue's kind. */
export const explainedName = (x: CodeExplanation): string => (x.own ? `${accountingName(x.own.name)} ${x.own.rate} %` : words(x.name));

/** A code in plain words: the firm's own rate («1. Saldosteuersatz (Schreinerei) 4.5 %», r6f-25), else its catalogue name («Material 8.1 % (VAT included)»). */
export const codeText = (code: string): string => {
  const x = codeExplanation(code);
  if (x.own) return explainedName(x);
  return vatCodeName(code, tWith) ?? t('vatCodes.unknown');
};

/** A code in a line of text: its plain name, then the code («Material 8.1 % (VAT included) · M81»). */
export const codeLabel = (code: string): string => `${codeText(code)} · ${code}`;
