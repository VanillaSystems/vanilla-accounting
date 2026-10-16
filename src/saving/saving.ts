/**
 * Änderungen, write (docs/0.4.0/saving.md, the mockup's screen 7). Workflows and the AI write;
 * they do not save. The AI prepares saves from everything that changed since the last save (the
 * books as the runs and edits wrote them, the draft, edits outside the app), the person talks to
 * it, and «Speichern» commits each prepared save exactly. Each of prepare, talk and refresh is one
 * model call. A proposal remembers the hash of everything it covers; when something moved since,
 * the proposal is stale and is never saved.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import fs from 'node:fs';
import git from 'isomorphic-git';
import { loadBooks, PERSON, saveBooks, update, ClosedPeriodError, type Books } from '../books/store.js';
import type { JournalEntry } from '../types/index.js';
import { commitExactly, repositoryAt } from '../workspace/git.js';
import type { Workspace } from '../workspace/workspace.js';
import { holdsRules } from '../booking/rule-book.js';
import { ruleDiff, rulesRefusal, withPreview } from './rules.js';
import { booksBasis, changesView, customizingNames, draftDir, fileDiff, lastSaveAt, recordsPaths, saveDetail, unreversedOf } from './changes.js';
import { BOOKS, diffLines, hunks, type ChangeSource, type ChangesView, type CoveredFile, type FileChange, type PreparedSave, type Proposal, type ProposalView, type RunWrote, type SavingCommand, type SavingResult, type SyncState } from './model.js';

type Ws = Pick<Workspace, 'paths'>;
export type Ask = (prompt: string, opts: { step: string; system?: string }) => Promise<string>;

const proposalPath = (ws: Ws) => join(ws.paths.data, 'saving', 'proposal.json');
const run = promisify(execFile);

export function readProposal(ws: Ws): Proposal | undefined {
  try { return JSON.parse(readFileSync(proposalPath(ws), 'utf8')) as Proposal; } catch { return undefined; }
}
function writeProposal(ws: Ws, p: Proposal | undefined): void {
  if (!p || !p.saves.length) { rmSync(proposalPath(ws), { force: true }); return; }
  mkdirSync(dirname(proposalPath(ws)), { recursive: true });
  writeFileSync(proposalPath(ws), JSON.stringify(p, null, 2) + '\n');
}

/** Where a changed file's current content lies: the draft's copy, or the file in the books folder. */
const fileOf = (ws: Ws, source: ChangeSource, path: string) => (source === 'draft' ? join(draftDir(ws), path) : join(ws.paths.root, path));
export const basisOf = (ws: Ws, source: ChangeSource, path: string): string => {
  if (source === 'books') return booksBasis(ws);
  const p = fileOf(ws, source, path);
  return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) : 'gone';
};

type Changed = Pick<ChangesView, 'draft' | 'outside' | 'books'>;

/** Everything that waits, the books as one item counted by the entries their runs booked. */
const changedFiles = (view: Changed): Array<FileChange & { source: ChangeSource }> => [
  ...(view.books.files ? [{ path: BOOKS, state: 'modified' as const, added: view.books.runs.reduce((n, r) => n + r.entries, 0), removed: 0, source: 'books' as const }] : []),
  ...view.draft.map((f) => ({ ...f, source: 'draft' as const })),
  ...view.outside.map((f) => ({ ...f, source: 'outside' as const })),
];
const keyOf = (f: { source: ChangeSource; path: string }) => `${f.source}:${f.path}`;

/** The proposal against the files as they are now: which saves moved, which changes no save covers. */
export function proposalView(ws: Ws, p: Proposal, view: Changed): ProposalView {
  const now = new Map(changedFiles(view).map((f) => [keyOf(f), f]));
  const covered = new Set(p.saves.flatMap((s) => s.files.map(keyOf)));
  const stale = p.saves.filter((s) => s.files.some((f) => !now.has(keyOf(f)) || basisOf(ws, f.source, f.path) !== f.basis)).map((s) => s.id);
  const uncovered = [...now.values()].filter((f) => !covered.has(keyOf(f))).map((f) => f.path);
  return { ...p, stale, uncovered, ready: !stale.length && !uncovered.length };
}

export interface Saving {
  view(): Promise<ChangesView>;
  command(c: SavingCommand): Promise<SavingResult>;
}

const refuse = (refusal: Extract<SavingResult, { ok: false }>['refusal'], message: string): SavingResult => ({ ok: false, refusal, message });

const SYSTEM = 'You prepare saves (commits) of a small company\'s changes: its books as the app\'s runs wrote them, and how its bookkeeping app works (rules, workflows, knowledge, settings). You write for the owner, in German, without git words. Answer with JSON only.';

/** What the model sees of one changed file: its path and its changed lines, cut to a few thousand characters. */
function shown(ws: Ws, f: FileChange & { source: ChangeSource }, before: string, runs: RunWrote[]): string {
  if (f.source === 'books') {
    const lines = runs.map((r) => `- ${r.label} (${r.at.slice(0, 16).replace('T', ' ')}): ${r.entries} Buchungen, ${r.links} Zuordnungen, ${r.receipts} Belege`);
    return `### ${BOOKS} (die Bücher, wie die Läufe sie geschrieben haben)\n${lines.length ? lines.join('\n') : '- direkt in der App geändert'}`;
  }
  const after = existsSync(fileOf(ws, f.source, f.path)) ? readFileSync(fileOf(ws, f.source, f.path), 'utf8') : '';
  const body = hunks(diffLines(before, after), 2).map((l) => (l ? `${l.kind}${l.text}` : '…')).join('\n');
  return `### ${f.path} (${f.source === 'draft' ? 'von der KI vorbereitet' : 'ausserhalb der App geändert'}, ${f.state})\n${body.length > 3000 ? body.slice(0, 3000) + '\n… (gekürzt)' : body}`;
}

interface Answer { reply?: string; saves?: Array<{ message?: string; why?: string; files?: string[]; held?: boolean }> }

function parseAnswer(text: string): Answer {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(json) as Answer;
}

/** `runs` names the runs that wrote into the books since a moment (the engine's): the books' item says whose they are. */
export function openSaving(ws: Workspace, deps: { ask: Ask; now?: () => Date; runs?: (since: string | undefined) => RunWrote[] }): Saving {
  const now = deps.now ?? (() => new Date());

  /** The view with the runs that wrote the waiting books. */
  async function changes(): Promise<ChangesView> {
    const v = await changesView(ws);
    return v.books.files && deps.runs ? { ...v, books: { ...v.books, runs: deps.runs(await lastSaveAt(ws)) } } : v;
  }

  async function view(): Promise<ChangesView> {
    const v = await changes();
    const p = readProposal(ws);
    const proposal = p ? proposalView(ws, p, v) : undefined;
    const sync = await syncState(ws);
    const rev = createHash('sha256').update(JSON.stringify([v.rev, proposal, sync])).digest('hex').slice(0, 16);
    return { ...v, rev, proposal, sync };
  }

  /**
   * One model call: the files to group (all, or only those of stale saves and uncovered ones), the
   * saves to keep as they are, the conversation so far, and what the person said. The saves it
   * answers replace the regrouped part; any file it leaves out lands in a save of its own, so no
   * change is ever dropped silently.
   */
  async function prepare(v: ChangesView, keep: PreparedSave[], talk: Proposal['talk'], said?: string): Promise<SavingResult> {
    const kept = new Set(keep.flatMap((s) => s.files.map(keyOf)));
    const files = changedFiles(v).filter((f) => !kept.has(keyOf(f)));
    if (!files.length && !said) return refuse('nothing', 'Nichts zu speichern.');
    const before = await Promise.all(files.map(async (f) => (f.source === 'books' ? '' : (await fileDiff(ws, f.source, f.path))?.before ?? '')));
    const prompt = [
      `Group these changes into saves. Keep together what belongs together (a template and the logo it points to). «${BOOKS}» is the books as the runs wrote them: one item, in a save of its own unless a change of how the app works produced it. Write each save\'s message (one line, German, what changes for the company) and why (one sentence). A save that changes figures in the books says so in why.`,
      said ? 'The owner may hold a save back ("noch nicht": held true), take it back in ("doch": held false), merge saves or rename them. Do what they say with the saves; you cannot edit files here.' : '',
      'Answer: {"reply": "<one or two sentences to the owner>", "saves": [{"message": "...", "why": "...", "files": ["<path>", ...], "held": false}]}. Every path below must be in exactly one save.',
      keep.length ? `Saves that stay as they are (do not repeat them): ${keep.map((s) => `«${s.message}»`).join(', ')}` : '',
      talk.length ? `Conversation so far:\n${talk.map((t) => `Owner: ${t.me}\nYou: ${t.ai}`).join('\n')}` : '',
      said ? `Current saves:\n${JSON.stringify((readProposal(ws)?.saves ?? []).filter((s) => !keep.includes(s)).map((s) => ({ message: s.message, why: s.why, files: s.files.map((f) => f.path), held: !!s.held })))}\nThe owner says: ${said}` : '',
      `Changed files:\n\n${files.map((f, i) => shown(ws, f, before[i], v.books.runs)).join('\n\n')}`,
    ].filter(Boolean).join('\n\n');
    let answer: Answer;
    try {
      answer = parseAnswer(await deps.ask(prompt, { step: `saving#${said ? 'talk' : 'prepare'}`, system: SYSTEM }));
    } catch (e) {
      return refuse('model', e instanceof Error ? e.message : String(e));
    }
    const byPath = new Map(files.map((f) => [f.path, f]));
    const taken = new Set<string>();
    const cover = (f: FileChange & { source: ChangeSource }): CoveredFile => ({ source: f.source, path: f.path, basis: basisOf(ws, f.source, f.path) });
    const saves: PreparedSave[] = (answer.saves ?? []).flatMap((s): PreparedSave[] => {
      const own = (s.files ?? []).filter((p) => byPath.has(p) && !taken.has(p));
      own.forEach((p) => taken.add(p));
      return own.length ? [{ id: randomUUID().slice(0, 8), message: (s.message ?? own[0]).slice(0, 200), why: (s.why ?? '').slice(0, 400), files: own.map((p) => cover(byPath.get(p)!)), ...(s.held ? { held: true } : {}) }] : [];
    });
    for (const f of files.filter((f) => !taken.has(f.path))) saves.push({ id: randomUUID().slice(0, 8), message: f.path, why: '', files: [cover(f)] });
    const reply = answer.reply ?? '';
    writeProposal(ws, { at: now().toISOString(), saves: [...keep, ...saves], talk: said ? [...talk, { me: said, ai: reply }] : talk });
    return { ok: true, reply };
  }

  async function save(sync: boolean): Promise<SavingResult> {
    const repo = await repositoryAt(ws.paths.repository);
    if (!repo) return refuse('no-repository', 'Der Workspace ist kein Git-Repository.');
    const p = readProposal(ws);
    if (!p) return refuse('no-proposal', 'Erst Speichern vorbereiten.');
    const v = await changes();
    const pv = proposalView(ws, p, v);
    if (!pv.ready) return refuse('stale', `Seit dem Vorschlag geändert: ${[...pv.uncovered, ...p.saves.filter((s) => pv.stale.includes(s.id)).flatMap((s) => s.files.map((f) => f.path))].join(', ')}`);
    const customizing = customizingNames();
    const go = p.saves.filter((s) => !s.held);
    const outsideCustomizing = go.flatMap((s) => s.files).filter((f) => f.source !== 'books' && !customizing.some((n) => f.path === n || f.path.startsWith(`${n}/`)));
    if (outsideCustomizing.length) return refuse('not-customizing', `Nicht über Änderungen zu speichern: ${outsideCustomizing.map((f) => f.path).join(', ')}`);
    // A rule is kept only when the app carries it out (src/saving/rules.ts): never as sentences nothing acts on.
    const ruleFiles = go.flatMap((s) => s.files).filter((f) => f.source !== 'books' && holdsRules(f.path));
    const diffs = await Promise.all(ruleFiles.map(async (f) => { const d = await fileDiff(ws, f.source, f.path); return withPreview(ws, ruleDiff(ws, f.path, d?.before ?? '', d?.after ?? ''), d?.after ?? '').diff; }));
    const unkept = rulesRefusal(diffs);
    if (unkept) return refuse('rules', unkept);
    let saved = 0;
    for (const s of go) {
      for (const f of s.files.filter((f) => f.source === 'draft')) {
        const from = join(draftDir(ws), f.path), to = join(ws.paths.root, f.path);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        rmSync(from);
      }
      const books = s.files.some((f) => f.source === 'books');
      const paths = [
        ...s.files.filter((f) => f.source !== 'books').map((f) => relative(repo, join(ws.paths.root, f.path))),
        ...(books ? recordsPaths(ws).map((p) => relative(repo, p)) : []),
      ];
      const trailers = books
        ? ['Vanilla-Kind: books', ...v.books.runs.map((r) => `Vanilla-Run: ${r.run}`), "Vanilla-Person: the app's user"]
        : ['Vanilla-Kind: customizing', "Vanilla-Person: the app's user"];
      if (await commitExactly(repo, `${s.message}\n\n${s.why ? `${s.why}\n\n` : ''}${trailers.join('\n')}`, paths)) saved++;
    }
    writeProposal(ws, { ...p, saves: p.saves.filter((s) => s.held) });
    if (sync) {
      const r = await syncNow(ws);
      if (!r.ok) return r;
    }
    return { ok: true, saved };
  }

  async function undo(oid: string): Promise<SavingResult> {
    const detail = await saveDetail(ws, oid);
    if (detail?.undoBlocked === 'closed') {
      const closed = loadBooks(ws as Workspace).config.closedThrough;
      return refuse('closed', `Die Buchungen dieses Laufs liegen in einer eingereichten Periode (bis ${closed}). Eine Korrektur bucht der Ablauf «Korrektur» in der offenen Periode.`);
    }
    if (!detail?.undo) return refuse('cannot-undo', 'Dieser Speicherstand lässt sich nicht rückgängig machen.');
    if (detail.undo === 'draft') {
      // The files as they were before the save go into the draft, and are saved like any change.
      const repo = (await repositoryAt(ws.paths.repository))!;
      const parent = (await git.log({ fs, dir: repo, ref: oid, depth: 1 }))[0]?.commit.parent[0];
      for (const f of detail.files) {
        const path = relative(relative(repo, ws.paths.root), f.path);
        const before = parent ? await git.readBlob({ fs, dir: repo, oid: parent, filepath: f.path }).then((b) => Buffer.from(b.blob), () => undefined) : undefined;
        const to = join(draftDir(ws), path);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, before ?? '');
      }
      return { ok: true, reversed: detail.files.length };
    }
    const books = loadBooks(ws as Workspace);
    try {
      const reversed = update(books, PERSON, (b) => reverseRun(b, detail.run!));
      if (!reversed) return refuse('cannot-undo', `Lauf ${detail.run} hat keine Buchungen mehr, die sich stornieren lassen.`);
      // The reversal waits in Änderungen like any change of the books.
      saveBooks(ws as Workspace, books);
      return { ok: true, reversed };
    } catch (e) {
      if (e instanceof ClosedPeriodError) return refuse('closed', `${e.message} Eine Korrektur bucht der Ablauf «Korrektur» in der offenen Periode.`);
      throw e;
    }
  }

  return {
    view,
    async command(c) {
      const v = await changes();
      const p = readProposal(ws);
      switch (c.kind) {
        case 'prepare': return prepare(v, [], []);
        case 'refresh': {
          if (!p) return prepare(v, [], []);
          const pv = proposalView(ws, p, v);
          return prepare(v, p.saves.filter((s) => !pv.stale.includes(s.id)), p.talk);
        }
        case 'talk': {
          if (!p) return refuse('no-proposal', 'Erst Speichern vorbereiten.');
          return prepare(v, [], p.talk, c.text.slice(0, 2000));
        }
        case 'discard': writeProposal(ws, undefined); return { ok: true };
        case 'save': return save(!!c.sync);
        case 'sync': return syncNow(ws);
        case 'undo': return undo(c.oid);
      }
    },
  };
}

/**
 * Rückgängig of a run's bookings: each entry the run booked and that is not reversed yet gets its
 * reversal (Soll and Haben swapped, the VAT code's sign turned), dated like the entry, so a run in
 * a closed period is refused by the write door. Returns how many it reversed.
 */
export function reverseRun(books: Books, runId: string): number {
  const own = unreversedOf(books, runId);
  for (const e of own) {
    const r: JournalEntry = {
      id: `storno-${e.id}`, transactionRef: e.transactionRef, date: e.date,
      accountDebit: e.accountCredit, accountCredit: e.accountDebit, amount: e.amount,
      ...(e.vatCode ? { vatCode: e.vatCode.startsWith('-') ? e.vatCode.slice(1) : `-${e.vatCode}` } : {}),
      description: `Storno: ${e.description ?? e.id}`,
      ...(e.exchangeCurrency ? { exchangeCurrency: e.exchangeCurrency, exchangeRate: e.exchangeRate } : {}),
      origin: 'manual',
    };
    books.journalEntries.push(r);
  }
  return own.length;
}

const gitBin = (repo: string, ...a: string[]) => run('git', ['-C', repo, ...a], { timeout: 120_000 });

/** Whether the repository has an upstream, and how many commits it has not synced. Without the git program: no remote. */
export async function syncState(ws: Ws): Promise<SyncState> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return { remote: false, ahead: 0 };
  try {
    const { stdout } = await gitBin(repo, 'rev-list', '--count', '@{upstream}..HEAD');
    return { remote: true, ahead: Number(stdout.trim()) || 0 };
  } catch {
    return { remote: false, ahead: 0 };
  }
}

/**
 * Synchronisieren through the user's git program (its credential helper holds the login): pull
 * only when it fast-forwards, then push. Two diverged lines are refused as two versions; history
 * is never rewritten.
 */
export async function syncNow(ws: Ws): Promise<SavingResult> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return refuse('no-repository', 'Der Workspace ist kein Git-Repository.');
  if (!(await syncState(ws)).remote) return refuse('no-remote', 'Kein Ort zum Synchronisieren eingerichtet.');
  try {
    await gitBin(repo, 'pull', '--ff-only', '--quiet');
  } catch (e) {
    return refuse('two-versions', `Zwei Versionen: hier und dort wurde gespeichert. ${e instanceof Error ? e.message.split('\n').slice(-2).join(' ') : ''}`.trim());
  }
  await gitBin(repo, 'push', '--quiet');
  return { ok: true };
}
