/**
 * npm run demo:reset [-- <demo>]
 *
 * Throws away the copy of a bundled demo that npm start works on (src/workspace/demo-copy.ts), so
 * the next start copies the demo afresh: after a play session, or after `npm run demo:generate`.
 * Default: demo. Stop npm start first.
 */
import { DEMO_NAME } from '../workspace/workspace.js';
import { resetDemoCopy } from '../workspace/demo-copy.js';

const name = process.argv[2] ?? 'demo';
if (!DEMO_NAME.test(name)) throw new Error(`"${name}" is no bundled demo (demo, demo-consulting, …)`);
console.log(`Removed ${resetDemoCopy(name)}; the next npm start copies ${name}/ afresh.`);
