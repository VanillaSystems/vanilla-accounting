/**
 * npm run extract-vat [-- --force]
 *
 * Step 2 of the inbox processing (src/intake/vat.ts): the VAT facts of each receipt, read off its
 * text. Skips receipts that have them unless --force.
 */
import 'dotenv/config';
import { runStepCli } from '../intake/run.js';
import { vatStep } from '../intake/vat.js';

runStepCli('vat', vatStep({ force: process.argv.includes('--force') })).catch((err) => { console.error(err); process.exit(1); });
