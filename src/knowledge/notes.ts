/**
 * The prose notes of the knowledge base (docs/0.4.0/knowledge.md "Files"): one Markdown file per
 * business partner, beside its file (knowledge/<role>/<id>.md), and one per topic of how the company
 * works (knowledge/company/<topic>.md). The notes are the source; a rule with a `then` map is what
 * the app carries out from them. A topic's front matter names its title and the steps whose rules
 * belong to it (`steps: [booking#private]`).
 *
 * Notes are the company's customizing, not its books: no period lock holds them. Every write answers
 * the file's text before and after, so «Rückgängig» puts it back, and refuses a text that changed
 * since the person opened it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import git from 'isomorphic-git';
import { parse, parseDocument } from 'yaml';
import type { Workspace } from '../workspace/workspace.js';
import { repositoryAt } from '../workspace/git.js';
import { KNOWLEDGE_DIR, ROLE_DIRS } from './layers.js';
import { ROLES, type Role } from './counterparties.js';
import { isTopicSlug, KNOWLEDGE_PAGES } from './topics.js';

type Ws = Pick<Workspace, 'paths'>;

export const TOPICS_DIR = `${KNOWLEDGE_DIR}/company`;

/** A partner's id is its file's (a slug) or an invoice customer's (cu_…); a topic's slug is lowercase. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const isPartnerId = (s: unknown): s is string => typeof s === 'string' && ID.test(s);
export { isTopicSlug };

/** Which notes a file holds: a partner's (in the folder of its main role) or a topic's. */
export type NoteRef = { kind: 'partner'; role: Role; id: string } | { kind: 'topic'; slug: string };

export const notePath = (ref: NoteRef): string =>
  ref.kind === 'partner' ? `${KNOWLEDGE_DIR}/${ROLE_DIRS[ref.role]}/${ref.id}.md` : `${TOPICS_DIR}/${ref.slug}.md`;

/** The last save that changed a notes file: who, when, and the save to open in Änderungen › Verlauf. */
export interface NoteChange { by: string; at: string; commit: string }

export interface Note {
  path: string;
  /** A topic's title, from its front matter. */
  title?: string;
  /** The steps whose rules belong to a topic, as `booking#private`. */
  steps: string[];
  /** The prose, without the front matter. */
  text: string;
  /** What the person saw: the hash of the whole file, `none` when there is none. A save names it. */
  basis: string;
  last?: NoteChange;
}

export const basisOf = (raw: string | null): string => (raw === null ? 'none' : createHash('sha256').update(raw).digest('hex').slice(0, 16));
const full = (ws: Ws, path: string) => join(ws.paths.root, path);
const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/**
 * Pure. A notes file split into its front matter (title, steps) and its prose. `head` is the front
 * matter's YAML as the author wrote it ('' when there is none), so a save writes it back unchanged.
 */
export function splitNote(raw: string): { title?: string; steps: string[]; text: string; head: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  let front: Record<string, unknown> = {};
  if (m) {
    try {
      const p = parse(m[1]) as unknown;
      if (p && typeof p === 'object' && !Array.isArray(p)) front = p as Record<string, unknown>;
    } catch { /* a front matter that does not parse is kept as prose */ }
  }
  const head = m && Object.keys(front).length ? m[1] : '';
  const text = (m && head ? raw.slice(m[0].length) : raw).replace(/^\n+/, '').replace(/\s+$/, '');
  const steps = Array.isArray(front.steps) ? front.steps.filter((s): s is string => typeof s === 'string') : [];
  return { ...(typeof front.title === 'string' ? { title: front.title } : {}), steps, text, head };
}

/** Pure. The front matter with a new title, every other line, comment and flow list as the author wrote it. */
function retitled(head: string, title: string): string {
  const doc = parseDocument(head);
  doc.set('title', title);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd();
}

/** Pure. The file's text: the front matter (YAML, '' for none) when it has any, then the prose. */
export function joinNote(head: string, text: string): string {
  const body = text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const yaml = head.replace(/\r\n/g, '\n').trimEnd();
  const top = yaml ? `---\n${yaml}\n---\n\n` : '';
  return body ? `${top}${body}\n` : top ? `${top.trimEnd()}\n` : '';
}

export function readNote(ws: Ws, ref: NoteRef): Note | undefined {
  const path = notePath(ref);
  const raw = read(full(ws, path));
  if (raw === null) return undefined;
  const { title, steps, text } = splitNote(raw);
  return { path, ...(title ? { title } : {}), steps, text, basis: basisOf(raw) };
}

/** The last save of the file, from git; undefined outside a repository or before its first save. */
export async function lastChange(ws: Ws, path: string): Promise<NoteChange | undefined> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return undefined;
  try {
    const [c] = await git.log({ fs, dir: repo, filepath: relative(repo, full(ws, path)), depth: 1 });
    return c ? { by: c.commit.author.name, at: new Date(c.commit.author.timestamp * 1000).toISOString(), commit: c.oid } : undefined;
  } catch {
    return undefined;
  }
}

/** A write: the file's text before (null: there was none) and after (null: it is gone). */
export interface NoteWrite { path: string; before: string | null; after: string | null }

export type NoteRefusal = 'changed' | 'title';

/** A notes file as a request names it: the server finds a partner's folder from its role; a topic without a slug is a new page, named from its title. */
export type NoteTarget = { kind: 'partner'; id: string } | { kind: 'topic'; slug?: string };
/** POST /api/notes. */
export type NoteCommand =
  | { kind: 'save'; ref: NoteTarget; text: string; basis: string; title?: string }
  | { kind: 'restore'; ref: NoteTarget; text: string | null; now: string | null };
/** What POST /api/notes answers: the write, the file it names, and whether it was saved in git at once. */
export type NoteResult = NoteWrite & { ref: NoteRef; committed: boolean };
export type NoteSaved = { ok: true; write: NoteWrite } | { ok: false; refusal: NoteRefusal };

/**
 * «Speichern»: the notes as the person wrote them, when the file is still as they opened it
 * (`basis`). A partner's empty notes remove its file; a topic keeps its title, and a new topic
 * needs one. The front matter stays as it was, a new title replaces the old.
 */
export function saveNote(ws: Ws, ref: NoteRef, text: string, basis: string, title?: string): NoteSaved {
  const p = full(ws, notePath(ref));
  const before = read(p);
  if (basisOf(before) !== basis) return { ok: false, refusal: 'changed' };
  const old = before === null ? { head: '', title: undefined } : splitNote(before);
  const next = title?.trim();
  if (ref.kind === 'topic' && !next && old.title === undefined) return { ok: false, refusal: 'title' };
  const head = next && next !== old.title ? retitled(old.head, next) : old.head;
  const after = ref.kind === 'partner' && !text.trim() ? null : joinNote(head, text);
  if (after === null) rmSync(p, { force: true });
  else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, after); }
  return { ok: true, write: { path: notePath(ref), before, after } };
}

/** «Rückgängig»: the file as it was (`text`), or gone when there was none; undefined when it changed since (`now` is what the write left). */
export function restoreNote(ws: Ws, ref: NoteRef, text: string | null, now: string | null): NoteWrite | undefined {
  const p = full(ws, notePath(ref));
  const before = read(p);
  if (before !== now) return undefined;
  if (text === null) rmSync(p, { force: true });
  else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
  return { path: notePath(ref), before, after: text };
}

/** A page of Arbeitsweise as Wissen lists it. */
export interface TopicRow { slug: string; title: string; steps: string[]; path: string }

export function listTopics(ws: Ws): TopicRow[] {
  const dir = full(ws, TOPICS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md')).filter(isTopicSlug).map((slug) => {
    const n = readNote(ws, { kind: 'topic', slug })!;
    return { slug, title: n.title ?? slug, steps: n.steps, path: n.path };
  }).sort((a, b) => a.title.localeCompare(b.title, 'de'));
}

/** Pure. A topic's slug from its title, not taken yet and never one of Wissen's own pages. */
export function topicSlugOf(title: string, taken: (slug: string) => boolean): string {
  const base = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'seite';
  let s = isTopicSlug(base) ? base : `${base}-seite`;
  for (let n = 2; taken(s); n++) s = `${base}-${n}`;
  return s;
}

export const topicTaken = (ws: Ws) => (slug: string): boolean => existsSync(full(ws, notePath({ kind: 'topic', slug })));

/** The partner notes files of the workspace: where each lies and whose it is. */
export function partnerNoteFiles(ws: Ws): Array<{ role: Role; id: string; path: string }> {
  return ROLES.flatMap((role) => {
    const dir = full(ws, `${KNOWLEDGE_DIR}/${ROLE_DIRS[role]}`);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => ({ role, id: basename(f, '.md'), path: `${KNOWLEDGE_DIR}/${ROLE_DIRS[role]}/${f}` })) : [];
  });
}

/**
 * What the lint says about the notes (knowledge.md "Files" 3): each partner notes file belongs to a
 * partner the workspace knows, in the folder of its main role; each topic has a title and names
 * only steps that exist. It never checks what the prose means.
 */
export function notesProblems(ws: Ws, partners: ReadonlyMap<string, Role>, stepExists: (ref: string) => boolean): string[] {
  const out: string[] = [];
  for (const f of partnerNoteFiles(ws)) {
    const role = partners.get(f.id);
    if (!role) out.push(`${f.path}: no partner "${f.id}" — notes sit beside a partner's file (${KNOWLEDGE_DIR}/<role>/${f.id}.yaml) or belong to an invoice customer`);
    else if (role !== f.role) out.push(`${f.path}: ${f.id} is filed under ${ROLE_DIRS[role]} — move it to ${notePath({ kind: 'partner', role, id: f.id })}`);
  }
  const dir = full(ws, TOPICS_DIR);
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.md')) : []) {
    const slug = basename(f, '.md');
    const path = `${TOPICS_DIR}/${f}`;
    if (!isTopicSlug(slug)) { out.push(`${path}: the name must be lowercase letters, digits and dashes, and not ${KNOWLEDGE_PAGES.join(' or ')}`); continue; }
    const n = readNote(ws, { kind: 'topic', slug })!;
    if (!n.title) out.push(`${path}: needs a title in its front matter (---\\ntitle: …\\n---)`);
    for (const s of n.steps) if (!stepExists(s)) out.push(`${path}: steps: "${s}" is no step of a flow — write <process>#<step>, e.g. booking#classify`);
  }
  return out;
}
