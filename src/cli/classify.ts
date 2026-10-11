/**
 * npm run classify [-- --force]
 *
 * Step 4 of the inbox processing (src/intake/classify.ts): every unbooked open-period transaction
 * through the classifier. --force first removes the entries classify itself booked in the open
 * period (see entriesForceMayRemove) and books those transactions again. Ends with the VAT audit.
 */
import 'dotenv/config';
import { reconcileVat } from '../reconcile/vat-consistency.js';
import { runStepCli } from '../intake/run.js';
import { classifyStep } from '../intake/classify.js';

runStepCli('classify', classifyStep({ force: process.argv.includes('--force') }), (books) => reconcileVat(books.read()))
  .catch((err) => { console.error(err); process.exit(1); });
