/** For a test that computes VAT without opening a workspace: the engines use the shipped modules/ch. */
import { APP_ROOT } from '../../src/workspace/workspace.js';
import { loadJurisdiction } from '../../src/core/modules/load.js';
import { setJurisdiction } from '../../src/engines/index.js';

setJurisdiction(loadJurisdiction(APP_ROOT, 'ch').jurisdiction);
