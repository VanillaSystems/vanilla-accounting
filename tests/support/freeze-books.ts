/** npm run test:freeze | test:books:freeze: the workspace's current books become its golden master's input. */
import { openWorkspace } from '../../src/workspace/workspace.js';
import { freezeBooks } from './golden.js';

console.log(`Froze the books into ${freezeBooks(openWorkspace())}. Now run the update script and review the diff.`);
