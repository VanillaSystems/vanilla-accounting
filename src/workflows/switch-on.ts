/**
 * Switched on = approved (docs/0.4.0/workflows.md "Changing a workflow", decisions.md D6;
 * docs/0.4.0/ui/design.md). A workflow runs live only in a version a person switched on. What
 * needs switching on is the company's part of its behaviour: its overlay of the app's
 * declaration, and the rules and knowledge its AI steps read (for such a step they are part of the
 * prompt, G9). Labels, descriptions, cadence and triggers are not part of it: they apply at once.
 * An app workflow the company has no part in is switched on by definition.
 *
 * Approvals lie outside the workspace, on this computer (VANILLA_APPROVALS_DIR, else
 * ~/.vanilla-accounting/approvals/), so an AI editing the workspace cannot approve its own change.
 * The first time a workspace is seen, what it runs today is taken as switched on (the baseline).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { APP_FOLDER, appFolderIn } from '../workspace/workspace.js';
import { demoHome, resetDemoCopy } from '../workspace/demo-copy.js';
import { parse } from 'yaml';
import type { Workspace } from '../workspace/workspace.js';
import type { JournalEntry } from '../types/index.js';
import type { ChangeEffect } from '../saving/model.js';
import type { CaseCheck, Run, WorkflowDecl } from './model.js';

type Ws = Pick<Workspace, 'paths'>;

/** The workflow whose approval every booking by the firm's rules or the model honours, wherever it starts (#413). */
export const BOOKING_WORKFLOW = 'booking';

/** Fields that apply at once: changing them never needs switching on. */
const APPLIES_NOW: Record<'workflow' | 'step', readonly string[]> = {
  workflow: ['label', 'desc', 'cadence', 'triggers'],
  step: ['label'],
};


const files = (dir: string): string[] => (existsSync(dir) && statSync(dir).isDirectory()
  ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]))
  : existsSync(dir) ? [dir] : []);

/** A declaration file without the fields that apply at once, so only behaviour counts. */
function behaviour(path: string, text: string): string {
  const kind = path.endsWith('/workflow.yaml') ? 'workflow' : path.endsWith('/step.yaml') ? 'step' : undefined;
  if (!kind) return text;
  try {
    const raw = parse(text) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return text;
    for (const k of APPLIES_NOW[kind]) delete raw[k];
    return JSON.stringify(Object.fromEntries(Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))));
  } catch {
    return text;
  }
}

/** What a workflow's AI steps cite, as paths in the workspace whether or not they exist yet: guides and knowledge (a folder for `x/*`). */
export function citations(w: WorkflowDecl): string[] {
  const out = new Set<string>();
  for (const s of w.steps.filter((x) => x.kind === 'agent')) {
    const guide = (s.guide ?? w.guide)?.split('#')[0];
    if (guide) out.add(`knowledge/rules/${guide}`);
    for (const k of s.knowledge) out.add(`knowledge/${k.endsWith('/*') ? k.slice(0, -2) : k}`);
  }
  return [...out];
}

const within = (path: string, cited: string) => path === cited || path.startsWith(`${cited}/`);

/** The workspace files of a workflow's behaviour: its overlay, and the company guides and knowledge its AI steps cite. */
export function companyFiles(w: WorkflowDecl, root: string): string[] {
  return [join(root, 'workflows', w.id), ...citations(w).map((c) => join(root, c))].flatMap(files).map((f) => relative(root, f)).sort();
}

/** The hash of the company's part and of each of its files, or undefined when it has none. */
export function companyPart(w: WorkflowDecl, root: string): { hash: string; files: Record<string, string> } | undefined {
  // A file holding only what applies at once (a schedule) is no part of the behaviour.
  const parts = companyFiles(w, root).map((p) => [p, behaviour(p, readFileSync(join(root, p), 'utf8'))] as const).filter(([, b]) => b !== '{}');
  if (!parts.length) return undefined;
  const files = Object.fromEntries(parts.map(([p, b]) => [p, createHash('sha256').update(b).digest('hex').slice(0, 16)]));
  return { hash: createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16), files };
}

/**
 * `cited`: the paths the company part covered when it was switched on (its overlay and what its AI
 * steps cite). A file under a path cited since (the app's update widened what a workflow reads,
 * #413) was no part of what she switched on: met the first time, it is taken as switched on, as the
 * baseline takes a workspace's files, never as a change that waits.
 */
interface Approved { part: string; files?: Record<string, string>; at: string; baseline?: boolean; cited?: string[] }
type Approvals = Record<string, Approved>;

export function approvalsPath(ws: { paths: { root: string } }): string {
  let root = ws.paths.root;
  try { root = realpathSync(root); } catch { /* as given */ }
  const dir = process.env.VANILLA_APPROVALS_DIR ?? join(homedir(), '.vanilla-accounting', 'approvals');
  return join(dir, `${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`);
}

/** Throws a demo's copy away with its switch-on record: kept, the record would flag the fresh copy's files as changed. */
export function resetDemo(name: string): string {
  const dir = join(demoHome(), name);
  rmSync(approvalsPath({ paths: { root: appFolderIn(dir) ?? join(dir, APP_FOLDER) } }), { force: true });
  return resetDemoCopy(name);
}

/** What a workflow's company part covers: its overlay and what its AI steps cite. */
const coverOf = (w: WorkflowDecl): string[] => [`workflows/${w.id}`, ...citations(w)];

/**
 * What a record written before `cited` existed covered (before #413 the booking cited its guide and
 * the suppliers' files only; it reads the customers', the authorities' and evidence.guide.yaml since).
 * Every other workflow's coverage is as it was.
 */
const COVERED_BEFORE: Record<string, string[]> = {
  [BOOKING_WORKFLOW]: [`workflows/${BOOKING_WORKFLOW}`, 'knowledge/rules/booking.guide.yaml', 'knowledge/suppliers'],
};

function read(ws: Ws): Approvals | undefined {
  try { return JSON.parse(readFileSync(approvalsPath(ws), 'utf8')) as Approvals; } catch { return undefined; }
}
function write(ws: Ws, a: Approvals): void {
  mkdirSync(dirname(approvalsPath(ws)), { recursive: true });
  writeFileSync(approvalsPath(ws), JSON.stringify(a, null, 2) + '\n');
}

export interface Switch {
  isApproved(w: WorkflowDecl): boolean;
  /** What changed in the company part since it was switched on, or undefined when the workflow runs as switched on. */
  pending(w: WorkflowDecl): { hash: string; files: string[] } | undefined;
  approve(w: WorkflowDecl): void;
}

export function openSwitch(ws: Ws, now = () => new Date()): Switch {
  const pending = (w: WorkflowDecl) => {
    const part = companyPart(w, ws.paths.root);
    const all = read(ws);
    const on = all?.[w.id];
    if (!part || on?.part === part.hash) return undefined;
    const was = { ...on?.files };
    // A file under a path the record did not cover is met for the first time: taken as switched on.
    const covered = on?.cited ?? (on ? COVERED_BEFORE[w.id] : undefined);
    if (covered) for (const [p, h] of Object.entries(part.files)) if (!(p in was) && !covered.some((c) => within(p, c))) was[p] = h;
    const changed = [...new Set([...Object.keys(part.files), ...Object.keys(was)])].filter((p) => part.files[p] !== was[p]).sort();
    if (!changed.length) {
      // Nothing she has not switched on: the record learns the wider coverage, once.
      write(ws, { ...all, [w.id]: { ...on!, part: part.hash, files: part.files, cited: coverOf(w) } });
      return undefined;
    }
    return { hash: part.hash, files: changed };
  };
  return {
    pending,
    isApproved: (w) => !pending(w),
    approve(w) {
      const part = companyPart(w, ws.paths.root);
      if (!part) return;
      write(ws, { ...read(ws), [w.id]: { part: part.hash, files: part.files, at: now().toISOString(), cited: coverOf(w) } });
    },
  };
}

/**
 * A person's change to the company's rules or knowledge is their switching on (docs/0.4.0/workflows.md
 * "Changing a workflow"): a rule kept on its card, an answer to the app's question, a correction,
 * an undo of one of these. Returns the step to take after the change: every workflow that ran as
 * switched on before it runs switched on after it; one that waited already keeps waiting. The AI's
 * own edits never come this way (r6h-24: an answer wrote a rule, and «Buchen» waited for «Einschalten»).
 */
export function keepSwitchedOn(ws: Ws, workflows: () => WorkflowDecl[]): () => void {
  const sw = openSwitch(ws);
  const on = new Set(workflows().filter((w) => sw.isApproved(w)).map((w) => w.id));
  return () => { for (const w of workflows()) if (on.has(w.id) && !sw.isApproved(w)) sw.approve(w); };
}

/** The first time: what the workspace runs today counts as switched on. Never again after that. */
export function baseline(ws: Ws, workflows: WorkflowDecl[], now = () => new Date()): boolean {
  if (existsSync(approvalsPath(ws))) return false;
  const a: Approvals = {};
  for (const w of workflows) {
    // Also a workflow without a company part yet: its record says what it covers, so a file added later waits.
    const part = companyPart(w, ws.paths.root);
    a[w.id] = { part: part?.hash ?? '', files: part?.files ?? {}, at: now().toISOString(), baseline: true, cited: coverOf(w) };
  }
  write(ws, a);
  return true;
}

/**
 * How a changed file of the workspace takes effect (the structure decides, never the AI): code
 * goes to whoever maintains it; a change to a workflow's behaviour, or to a guide or knowledge an
 * AI step reads, waits to be switched on; the rest (labels, schedules, settings, layouts) applies
 * at once. `before` and `after` are the file's contents.
 */
export function classifyChange(path: string, before: string, after: string, workflows: WorkflowDecl[]): ChangeEffect {
  // A source's code is the company's own and expected (ADR 0014): it is switched on like a rule, not handed to a maintainer.
  if (path.startsWith('sources/')) return 'needs-switch-on';
  if (/\.(ts|tsx|js|mjs|cjs)$/.test(path)) return 'needs-maintainer';
  if (/^workflows\//.test(path)) return behaviour(path, before) === behaviour(path, after) ? 'applies-now' : 'needs-switch-on';
  return workflows.some((w) => citations(w).some((c) => within(path, c))) ? 'needs-switch-on' : 'applies-now';
}

type Booked = Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'amount' | 'vatCode'>;
const key = (e: Booked) => `${e.accountDebit}/${e.accountCredit} ${Number(e.amount).toFixed(2)} ${e.vatCode ?? '-'}`;

/**
 * Whether a dry run on the waiting version went the way its case went: the same steps with the
 * same outcomes, and the same bookings (accounts, amount, VAT code). The case's bookings are the
 * entries that carry its run id; the dry run's are what it would have booked.
 */
export function caseCheck(original: Run, dry: Run, entries: JournalEntry[]): CaseCheck {
  const base = { of: original.id, run: dry.id, item: dry.item };
  if (dry.state.status === 'stuck') return { ...base, status: 'stuck', detail: dry.state.reason };
  if (dry.state.status !== 'done') return { ...base, status: 'running' };
  const path = (r: Run) => r.steps.map((s) => `${s.step}:${s.outcome ?? '?'}`);
  const [a, b] = [path(original), path(dry)];
  if (a.join() !== b.join()) {
    const i = a.findIndex((x, j) => x !== b[j]);
    return { ...base, status: 'different', detail: `${a[i] ?? '–'} → ${b[i] ?? '–'}` };
  }
  const before = entries.filter((e) => e.run === original.id).map(key).sort();
  const after = dry.steps.flatMap((s) => s.effects.flatMap((e) => (Array.isArray(e.would) ? (e.would as Booked[]).map(key) : []))).sort();
  if (before.join('|') !== after.join('|')) return { ...base, status: 'different', detail: `${before.join(', ') || '–'} → ${after.join(', ') || '–'}` };
  return { ...base, status: 'same' };
}
