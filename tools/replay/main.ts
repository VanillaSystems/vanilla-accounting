/**
 * npm run replay -- prepare --source <workspace> --period 2026-Q3 --arm cold|today --out <folder>
 * npm run replay -- run <folder> --stub        the whole replay with the model stubbed (no model is called)
 * npm run replay -- run <folder> --real        the whole replay on the `claude` CLI of this Mac (its subscription)
 * npm run replay -- score <folder>             a finished run judged again by today's comparison (no server, no model call)
 *
 * A replay benchmark (tools/replay/README.md): the books cut at a period's eve, the period's
 * statements and receipts dropped into the app as a person would, the app's runs, an oracle that
 * plays the person from the real books, and what it all cost in model tokens. The folder holds the
 * company's books and the result: keep it outside every repository.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARMS, MARKER, prepare, type Arm, type Marker } from './cut.js';
import { replay } from './drive.js';
import { rescore } from './rescore.js';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const has = (name: string) => rest.includes(`--${name}`);

function usage(): never {
  console.error(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].split('\n').filter((l) => l.startsWith(' * npm')).map((l) => l.slice(3)).join('\n'));
  process.exit(1);
}

if (command === 'prepare') {
  const source = flag('source');
  const period = flag('period');
  const arm = flag('arm') as Arm | undefined;
  const out = flag('out');
  if (!source || !period || !out || !arm || !ARMS.includes(arm)) usage();
  const { key } = prepare({ source: resolve(source), period, arm, out: resolve(out) });
  console.log(`${resolve(out)}: ${key.cases.length} payments, ${key.manual.length} hand movements, ${key.other.length} other refs, ${key.inputs.filter((i) => i.kind === 'statement').length} statement files, ${key.inputs.filter((i) => i.kind === 'receipt').length} receipts (${arm})`);
} else if (command === 'score') {
  const dir = rest.find((a) => !a.startsWith('--'));
  if (!dir || !existsSync(join(dir, 'result.json'))) {
    console.error(`${dir ?? '(no folder)'}: no finished run to score (no result.json).`);
    process.exit(1);
  }
  rescore(resolve(dir));
} else if (command === 'run') {
  const dir = rest.find((a) => !a.startsWith('--'));
  if (!dir || !existsSync(join(dir, MARKER))) {
    console.error(`${dir ?? '(no folder)'}: not a replay folder (no ${MARKER}); make one with «prepare».`);
    process.exit(1);
  }
  const model = has('stub') ? 'stub' : has('real') ? 'real' : undefined;
  if (!model) {
    console.error('Say --stub (no model call) or --real (the claude CLI of this Mac, on its subscription).');
    process.exit(1);
  }
  const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as Marker;
  await replay(resolve(dir), marker, { model });
} else usage();
