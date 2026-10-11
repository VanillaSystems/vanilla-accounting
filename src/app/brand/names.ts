/**
 * The brand's names (brand.json, guidelines 16-voice and 21-accounting-devices): proper names in
 * English, never translated. The product noun is the short name where a launcher cuts labels.
 */
export const PRODUCT = 'Vanilla Accounting';
export const SHORT_NAME = 'Accounting';
export const ENDORSEMENT = 'by Vanilla Machines';
export const SEAL_NAME = 'Swiss engineering';

/**
 * The demo's "App herunterladen". A page of the brand's website that forwards to the latest GitHub
 * release, so the target can change without a new demo, and the repository's owner is named there,
 * not in the app (the leak guard refuses it here). The releases are private until the repository is public.
 */
export const DOWNLOAD_URL = 'https://vanillamachines.com/accounting/download/';

/** Window and tab title: the page first, so tabs stay readable. */
export const windowTitle = (...page: Array<string | undefined>): string => [...page.filter(Boolean), PRODUCT].join(' · ');
