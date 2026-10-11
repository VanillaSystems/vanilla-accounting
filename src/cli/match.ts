/**
 * npm run match
 *
 * Step 3 of the inbox processing (src/intake/match.ts): every staged receipt named, moved into
 * receipts/ and, when the model is sure, linked to its payment.
 */
import 'dotenv/config';
import { runStepCli } from '../intake/run.js';
import { matchStep } from '../intake/match.js';

runStepCli('match', matchStep).catch((err) => { console.error(err); process.exit(1); });
