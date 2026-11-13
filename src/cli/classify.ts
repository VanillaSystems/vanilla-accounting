/**
 * npm run classify [-- --force]
 *
 * Step 4 of the inbox processing (src/intake/classify.ts): every unbooked open-period transaction
 * through the classifier. --force first removes the entries classify itself booked in the open
 * period (see entriesForceMayRemove) and books those transactions again. Ends with the VAT audit.
 * While «Buchen» waits for «Einschalten» (#413) it books nothing and exits 1 with the sentence: the
 * firm's rules changed since a person switched them on, and nothing books with rules she has not seen.
 */
import 'dotenv/config';
import { reconcileVat } from '../reconcile/vat-consistency.js';
import { runStepCli } from '../intake/run.js';
import { classifyStep } from '../intake/classify.js';
import { openWorkspace } from '../workspace/workspace.js';
import { bookingWaitsIn } from '../workflows/booking-waits.js';
import { wordsIn } from '../export/texts.js';

const files = bookingWaitsIn(openWorkspace(), { firstSeen: true });
if (files) {
  console.error(`⛔ Nothing booked: «Buchen» waits for «Einschalten» since ${files.join(', ')} changed (Automatisierung › Buchen).`);
  console.error(wordsIn('de').t('bookingWaits.text', { n: Math.max(1, files.length), files: files.join(', ') }));
  process.exit(1);
}
runStepCli('classify', classifyStep({ force: process.argv.includes('--force') }), (books) => reconcileVat(books.read()))
  .catch((err) => { console.error(err); process.exit(1); });
