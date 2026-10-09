/**
 * The Treuhänder's review, on the owner's side (docs/accountant-review.md):
 *
 *   npm run review -- <period> --for "<name>" [--email <address>] <out-dir>
 *       the review package: the audit export of the books in review mode, for <name> to correct
 *       in a browser. <period> is what you ask him to review: 2026-Q3, 2026-H2, 2026.
 *   npm run review:import -- <review-file.json>
 *       the file he sends back becomes the git branch review/<name>-<period>-<date>, one commit
 *       per correction, and prints it as a pull request against today's books
 *   npm run review:merge -- <branch> [--accept all|k1,k2] [--reject k3="reason" ...]
 *       merges the accepted corrections into the books (a merge commit) and records the decisions
 *
 * Add --workspace <dir|demo|demo-consulting> to work on another workspace than .env's.
 */
import { readFileSync } from 'node:fs';
import { buildAuditExport, ExportError } from '../audit/build.js';
import { manifestHash } from '../audit/manifest.js';
import { derivePeriod } from '../accounting/periods.js';
import { git, repoOf } from '../books/history.js';
import { decideReview, importReview, ReviewGitError, viewReview, type ReviewView } from '../review/git.js';
import { ReviewFileError } from '../review/types.js';
import type { RecordChange } from '../books/changes.js';
import { openWorkspace } from '../workspace/workspace.js';

const args = process.argv.slice(2);
const mode = args.shift();
const take = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const workspaceFlag = take('--workspace');
if (workspaceFlag !== undefined) process.env.VANILLA_WORKSPACE = workspaceFlag;

const USAGE = {
  package: 'npm run review -- <period> --for "<name>" [--email <address>] <out-dir>',
  import: 'npm run review:import -- <review-file.json>',
  merge: 'npm run review:merge -- <branch> [--accept all|k1,k2] [--reject k3="reason" ...]',
} as const;

function usage(): never {
  console.error(`Usage:\n  ${Object.values(USAGE).join('\n  ')}`);
  process.exit(2);
}

const chf = (n: number) => n.toFixed(2);

/** One record change as a line a person reads. */
function describe(c: RecordChange): string {
  const entry = (e: NonNullable<Extract<RecordChange, { collection: 'entries' }>['after']>) =>
    `${e.date} ${e.accountDebit || '–'} / ${e.accountCredit || '–'} ${e.exchangeCurrency ?? 'CHF'} ${chf(e.amount)} ${e.vatCode ?? ''}${e.corrects ? ` corrects ${e.corrects}` : ''} "${e.description ?? ''}"`;
  switch (c.collection) {
    case 'entries':
      if (!c.before) return `+ Buchung ${entry(c.after!)}`;
      if (!c.after) return `- Buchung ${entry(c.before)}`;
      return `~ Buchung ${c.key}: ${Object.keys({ ...c.before, ...c.after })
        .filter((k) => JSON.stringify(c.before![k as keyof typeof c.before]) !== JSON.stringify(c.after![k as keyof typeof c.after]) && k !== 'origin')
        .map((k) => `${k} ${c.before![k as keyof typeof c.before] ?? '–'} → ${c.after![k as keyof typeof c.after] ?? '–'}`).join(', ')}`;
    case 'mappings':
      return `${c.after ? '+' : '-'} Zuordnung ${c.key}`;
    case 'transactions':
      return `~ Transaktion ${c.key}`;
    default:
      return `~ ${c.collection} ${c.key}`;
  }
}

const STATUS: Record<string, string> = {
  applicable: 'anwendbar',
  alreadySo: 'schon so',
  conflict: 'Konflikt',
  closedPeriod: 'eingereichte Periode → Korrekturbuchung',
  refused: 'nicht möglich',
};

function print(view: ReviewView): void {
  const { file } = view;
  console.log(`\n${view.branch}: Prüfung ${file.base.period} von ${file.reviewer.name}, ${file.corrections.length} Korrekturen, Stand ${file.base.createdAt.slice(0, 10)}`);
  if (file.message) console.log(`Nachricht: ${file.message}`);
  const decided = new Map(view.decisions.map((d) => [d.correctionId, d]));
  const plans = new Map(view.plans.map((p) => [p.correction.id, p]));
  for (const c of file.corrections) {
    const d = decided.get(c.id);
    const p = plans.get(c.id);
    const state = d ? `${d.decision === 'merged' ? 'übernommen' : `abgelehnt: ${d.reason}`}` : STATUS[p!.status] + (p!.problem ? `: ${p!.problem}` : '');
    console.log(`\n  ${c.id}  ${(view.commits[c.id] ?? '').slice(0, 8)}  ${c.reason}  [${state}]`);
    for (const ch of p?.changes.length ? p.changes : c.changes) console.log(`      ${describe(ch)}`);
    for (const v of p?.vat ?? []) console.log(`      MWST ${v.quarter} Ziffer ${v.ziffer}: ${chf(v.before)} → ${chf(v.after)}`);
  }
  for (const k of file.comments) console.log(`\n  Kommentar (${k.target.kind}${'id' in k.target ? ` ${k.target.id}` : 'ref' in k.target ? ` ${k.target.ref}` : ''}): ${k.text}`);
  for (const s of file.signOffs) console.log(`\n  Freigabe ${s.scope}: ${s.statement} (${s.at.slice(0, 10)})`);
  console.log(`\nÜbernehmen: npm run review:merge -- ${view.branch} --accept all   (oder --accept k1,k2, --reject k3="Begründung")`);
}

const ws = openWorkspace();
try {
  if (mode === 'package') {
    const name = take('--for');
    const email = take('--email');
    const [period, out] = args;
    if (!name || !period || !out || args.length !== 2) usage();
    if (!derivePeriod(period)) {
      console.error(`${period} is no period: use 2026-Q3, 2026-H2 or 2026.`);
      process.exit(2);
    }
    const root = repoOf(ws);
    const commit = root ? git(root, ['rev-parse', 'HEAD']).trim() : undefined;
    if (root && git(root, ['status', '--porcelain', '--', ws.paths.books]).trim()) {
      console.error('books.json has changes that are not committed; the review is based on the last commit. Commit them first.');
      process.exit(1);
    }
    const m = await buildAuditExport(ws, out, undefined, { reviewer: { name, ...(email ? { email } : {}) }, period, ...(commit ? { commit } : {}) });
    console.log(`Review package of ${ws.company.name} for ${name}, period ${period}, written to ${out}: ${m.files.length} files.`);
    if (!commit) console.log('  The workspace is no git repository: npm run review:import needs one (git init, then commit the books).');
    console.log(`manifest.json sha256 ${manifestHash(out)}`);
    console.log(`Zip the folder and send it, or put it on web space behind a password. ${name} opens it with npx serve <folder>, corrects in the browser and sends back review-${period}-<name>.json.`);
  } else if (mode === 'import') {
    const [path] = args;
    if (!path || args.length !== 1) usage();
    const result = importReview(ws, JSON.parse(readFileSync(path, 'utf8')));
    console.log(result.created ? `Branch ${result.branch}: ${result.commits} commits on ${result.base.slice(0, 8)}.` : `Already imported as ${result.branch}; nothing changed.`);
    if (result.note) console.log(result.note);
    print(viewReview(ws, result.branch));
  } else if (mode === 'merge') {
    const accept = take('--accept') ?? 'all';
    const reject: Record<string, string> = {};
    for (let r = take('--reject'); r !== undefined; r = take('--reject')) {
      const [id, ...reason] = r.split('=');
      if (!reason.join('=').trim()) usage();
      reject[id] = reason.join('=').trim();
    }
    const [branch] = args;
    if (!branch || args.length !== 1) usage();
    const result = decideReview(ws, branch, { accept: accept === 'all' ? 'all' : accept.split(','), reject });
    if (!result.commit) console.log('Nothing new to decide.');
    else console.log(`${result.commit.slice(0, 8)}: ${result.merged.length} merged (${result.merged.join(', ') || '–'}), ${result.rejected.length} rejected (${result.rejected.join(', ') || '–'}).`);
    for (const s of result.skipped) console.log(`  ${s.id} not merged: ${STATUS[s.status]}`);
    print(viewReview(ws, branch));
  } else usage();
} catch (e) {
  if (!(e instanceof ExportError || e instanceof ReviewGitError || e instanceof ReviewFileError)) throw e;
  console.error(e.message);
  process.exit(1);
}
