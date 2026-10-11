/**
 * The brand's names (brand.json, guidelines 16-voice and 21-accounting-devices): proper names in
 * English, never translated. The product noun is the short name where a launcher cuts labels.
 */
export const PRODUCT = 'Vanilla Accounting';
export const SHORT_NAME = 'Accounting';
export const ENDORSEMENT = 'by Vanilla Machines';
export const SEAL_NAME = 'Swiss engineering';

/** Window and tab title: the page first, so tabs stay readable. */
export const windowTitle = (...page: Array<string | undefined>): string => [...page.filter(Boolean), PRODUCT].join(' · ');
