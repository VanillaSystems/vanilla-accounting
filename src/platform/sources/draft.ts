/**
 * A source the AI wrote with the person (ADR 0015: the long tail grows in the workspace). The AI
 * writes `data/draft/sources/<id>/` with its file tools (source.yaml, and its own code when the
 * app's code does not fit); its answer names the id, and the app takes the draft into the
 * workspace's `sources/<id>/`, where it waits to be switched on like any source (index.ts): an AI
 * cannot approve its own source, because the switch lies outside the workspace. Taken in only when
 * the loader accepts it and no file of it holds a secret (R13, R17); the undo puts back what the
 * folder held before, or takes it away.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import type { Workspace } from '../../workspace/workspace.js';
import { readDecl } from './load.js';
import { withdrawApproval } from './index.js';
import type { Problem, Text } from './model.js';

type Ws = Pick<Workspace, 'paths'>;

const ID = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_BYTES = 256 * 1024;

/** A key that names a secret, in settings or as a name a literal is given to in code. */
const SECRET_NAME = /^(pass(word|wort)?|passwd|pwd|secret|client[-_]?secret|token|access[-_]?token|api[-_]?key|apikey|bearer|credentials?|otp)$/i;
const SECRET_LITERAL = /\b(pass(word|wort)?|passwd|secret|token|api[-_]?key|apikey|bearer|credentials?)\b["']?\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/i;

export type DraftRefusal =
  | { code: 'sourceDraftMissing'; params: { id: string } }
  | { code: 'sourceInvalid'; params: { id: string; problems: string[] } }
  | { code: 'sourceSecret'; params: { id: string; file: string } }
  | { code: 'sourceAppId'; params: { id: string } };

export class SourceDraftError extends Error {
  constructor(message: string, readonly refusal: DraftRefusal) { super(message); }
}

export const draftFolder = (ws: Ws, id: string): string => join(ws.paths.data, 'draft', 'sources', id);
const liveFolder = (ws: Ws, id: string): string => join(ws.paths.root, 'sources', id);

/** Every regular file under `dir`, relative, with its text. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** The first file that holds a secret: a settings key that names one, or a literal handed to such a name in code. */
export function secretIn(files: Record<string, string>): string | undefined {
  for (const [file, text] of Object.entries(files)) {
    if (file === 'source.yaml') {
      let settings: unknown;
      try { settings = (parse(text) as { settings?: unknown } | null)?.settings; } catch { settings = undefined; }
      const named = (v: unknown): boolean => !!v && typeof v === 'object' && Object.entries(v as Record<string, unknown>).some(([k, x]) => SECRET_NAME.test(k) || named(x));
      if (named(settings)) return file;
    }
    if (SECRET_LITERAL.test(text)) return file;
  }
  return undefined;
}

const problemText = (p: Problem) => `${p.file}${p.line ? `:${p.line}` : ''} ${p.message}`;

/**
 * Takes the draft of source `id` into the workspace, pending. Returns its label, and what the folder
 * held before (for the undo) unless it is new.
 */
export function takeSourceDraft(ws: Ws, id: string, appRoot: string): { previous?: Record<string, string>; label: Text } {
  if (!ID.test(id)) throw new SourceDraftError(`${id}: lower case letters, digits and dashes`, { code: 'sourceInvalid', params: { id, problems: ['a source id is lower case letters, digits and dashes'] } });
  if (existsSync(join(appRoot, 'sources', id))) throw new SourceDraftError(`${id} is the name of the app's own code`, { code: 'sourceAppId', params: { id } });
  const draft = draftFolder(ws, id);
  if (!existsSync(join(draft, 'source.yaml'))) throw new SourceDraftError(`no draft of sources/${id}`, { code: 'sourceDraftMissing', params: { id } });
  const links: string[] = [];
  const walkLinks = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); const s = lstatSync(p); if (s.isSymbolicLink()) links.push(relative(draft, p)); else if (s.isDirectory()) walkLinks(p); } };
  walkLinks(draft);
  if (links.length) throw new SourceDraftError(`links in the draft: ${links.join(', ')}`, { code: 'sourceInvalid', params: { id, problems: links.map((l) => `${l}: a link, not a file`) } });
  const files = filesOf(draft);
  const size = Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0);
  if (size > MAX_BYTES) throw new SourceDraftError(`the draft is ${size} bytes`, { code: 'sourceInvalid', params: { id, problems: [`a source is at most ${MAX_BYTES / 1024} KB of text`] } });
  const secret = secretIn(files);
  if (secret) throw new SourceDraftError(`sources/${id}/${secret} holds a secret`, { code: 'sourceSecret', params: { id, file: secret } });
  const checked = readDecl(draft, 'company', join(appRoot, 'sources'));
  if ('problems' in checked) {
    const problems = checked.problems.map((p) => problemText({ ...p, file: p.file.replace(`sources/${id}/`, '') }));
    throw new SourceDraftError(`sources/${id}: ${problems.join('; ')}`, { code: 'sourceInvalid', params: { id, problems } });
  }
  const live = liveFolder(ws, id);
  const before = filesOf(live);
  writeFolder(live, files);
  rmSync(draft, { recursive: true, force: true });
  return { label: checked.decl.label, ...(Object.keys(before).length ? { previous: before } : {}) };
}

function writeFolder(dir: string, files: Record<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

/** The undo: the folder as it was before the draft came in, or gone with its switch when it was new. */
export function restoreSource(ws: Ws, id: string, previous?: Record<string, string>): void {
  if (previous && Object.keys(previous).length) { writeFolder(liveFolder(ws, id), previous); return; }
  rmSync(liveFolder(ws, id), { recursive: true, force: true });
  withdrawApproval(ws, id);
}
