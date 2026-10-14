/**
 * npm run pull -- <source> [--dry] [--feed <id>]   pulls a source now (ADR 0014): its due feeds,
 * or the one named; --dry fetches and counts but delivers nothing. The workflow «Belege und Daten
 * holen» does the same every day; this is the hand version, and its proof.
 */
import { parseArgs } from 'node:util';
import { APP_ROOT, openWorkspace } from '../workspace/workspace.js';
import { useKeychain } from '../secrets/keychain-store.js';
import { pull } from '../platform/sources/host.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { dry: { type: 'boolean' }, feed: { type: 'string', multiple: true } } });
const [source] = positionals;
if (!source) { console.error('Usage: npm run pull -- <source> [--dry] [--feed <id>]   (the sources: Firma › Quellen)'); process.exit(2); }
const ws = openWorkspace();
useKeychain(() => ws.paths.root);
const r = await pull({ ws, appRoot: APP_ROOT, source, run: `cli-${new Date().toISOString()}`, mode: values.dry ? 'dry' : 'live', ...(values.feed ? { feeds: values.feed } : {}) });
for (const f of r.feeds) console.log(`${f.feed}: ${f.documents} new, ${f.duplicates} already there${f.complete ? '' : ' (stopped)'}`);
if (r.outcome === 'ok') console.log(r.feeds.length ? (values.dry ? 'Dry run: nothing delivered.' : 'Delivered into the inbox; «Eingang verarbeiten» reads them.') : 'Nothing is due.');
else if (r.outcome === 'missing-secret') { console.error(r.refused ? `⛔ The ${r.channel} login was refused (${r.refused}): npm run secret -- source:${source}:${r.channel}` : `⛔ No password: npm run secret -- source:${source}:${r.channel}`); process.exit(1); }
else if (r.outcome === 'changed') { console.error(`⛔ ${r.feed}: ${r.message}`); process.exit(1); }
else { console.error(`⛔ ${r.feed}: ${r.attempted} is outside the source's reach (${r.channel})`); process.exit(1); }
