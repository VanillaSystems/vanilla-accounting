/**
 * npm run extract
 *
 * Step 1 of the inbox processing (src/intake/read.ts): the text of every new PDF in beleg-import/
 * and receipts/, the bank statements under bank-statements/, invoice payments by reference.
 */
import 'dotenv/config';
import { runStepCli } from '../intake/run.js';
import { readStep } from '../intake/read.js';

runStepCli('read', readStep).catch((err) => { console.error(err); process.exit(1); });
