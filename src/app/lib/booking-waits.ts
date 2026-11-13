/**
 * The words of «Buchen» waiting for «Einschalten» (#413), one source for every place that says it
 * (src/app/automation/booking-waits.tsx, the API's refusal `bookingWaits`, the run's note).
 */
import { t } from '../i18n/index.js';

/** The changed files of a waiting version, as the switch-on page lists them: the first four, then how many more. */
export const changedFiles = (files: readonly string[]): string => files.slice(0, 4).join(', ') + (files.length > 4 ? ` +${files.length - 4}` : '');

/** What changed, why the app waits, and what ends it, in one sentence. */
export const bookingWaitsText = (files: readonly string[], broken = false): string =>
  broken ? t('bookingWaits.broken', { file: files[0] ?? '' }) : t('bookingWaits.text', { n: Math.max(1, files.length), files: changedFiles(files) });
