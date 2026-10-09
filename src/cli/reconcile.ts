/**
 * npm run reconcile
 *
 * Runs the VAT consistency audit over the current index without re-classifying.
 * Reports journal-entry VAT codes that disagree with the receipt-level VAT facts.
 */

import 'dotenv/config';
import { reconcileVat } from '../reconcile/vat-consistency.js';
import { loadBooks } from '../books/store.js';
import { openWorkspace } from '../workspace/workspace.js';

reconcileVat(loadBooks(openWorkspace()));
