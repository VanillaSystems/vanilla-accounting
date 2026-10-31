/**
 * npm run demo:reset [-- <demo>]
 *
 * Throws away the copy of a bundled demo that npm start works on (src/workspace/demo-copy.ts), so
 * the next start copies the demo afresh: after a play session, or after `npm run demo:generate`.
 * Its record of what was switched on goes too: kept, it would flag the fresh copy's files as changed.
 * Default: demo. Stop npm start first.
 */
import { DEMO_NAME } from '../workspace/workspace.js';
import { resetDemo } from '../workflows/switch-on.js';

const name = process.argv[2] ?? 'demo';
if (!DEMO_NAME.test(name)) throw new Error(`"${name}" is no bundled demo (demo, demo-consulting, …)`);
console.log(`Removed ${resetDemo(name)}; the next npm start copies ${name}/ afresh.`);
