/**
 * Proposals an AI in the terminal wrote (issue #146; its instructions: src/workspace/terminal-agents.ts):
 * one JSON file each in data/terminal/, `{ title, summary, changes }`, the changes in the sidebar's
 * own format (src/assistant/changes.ts). The app takes each into the AI sidebar as a conversation
 * whose answer holds the changes for the person's «Übernehmen», whatever they change: tried on a
 * copy of the books for the card, made only by that click, through the same door as the sidebar's
 * (src/server/routes/assistant.ts apply: the period lock, the seals, the person as author).
 *
 * The conversation's id is derived from the file's name and content, so taking a file in twice
 * (two requests at once, a crash before the file was removed) makes one conversation.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { PROPOSALS_DIR } from '../workspace/terminal-agents.js';
import type { Change, Conversation, Turn } from '../types/assistant.js';
import { ChangesError, changesOf } from './changes.js';
import { RefusedChanges, readConversation, storeConversation, type ApplyChanges } from './conversations.js';

export interface Proposal { title: string; summary: string; changes: Change[] }

/** A proposal file as the app takes it; throws a ChangesError naming what is wrong. */
export function parseProposal(text: string): Proposal {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ChangesError('kein gültiges JSON'); }
  const p = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const words = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const changes = changesOf(p.changes);
  if (!changes.length) throw new ChangesError('changes ist leer');
  return { title: words(p.title).slice(0, 80), summary: words(p.summary), changes };
}

/** A UUID-shaped id from the file's name and content: the same file is the same conversation. */
export function proposalId(name: string, text: string): string {
  const h = createHash('sha256').update(name).update('\0').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const dir = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.root, PROPOSALS_DIR);

/**
 * Takes every proposal waiting in data/terminal/ into the sidebar and removes its file: the ids of
 * the conversations made. A file the app cannot read becomes a conversation that says why, so the
 * person (and the terminal AI they ask) sees it rather than a file that silently stays.
 */
export async function takeInProposals(ws: Pick<Workspace, 'paths'>, apply: ApplyChanges, now = () => new Date()): Promise<string[]> {
  if (!existsSync(dir(ws))) return [];
  const made: string[] = [];
  for (const name of readdirSync(dir(ws)).filter((f) => f.endsWith('.json')).sort()) {
    const file = join(dir(ws), name);
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const id = proposalId(name, text);
    if (!readConversation(ws, id)) {
      storeConversation(ws, await conversationOf(id, name, text, apply, now().toISOString()));
      made.push(id);
    }
    rmSync(file, { force: true });
  }
  return made;
}

async function conversationOf(id: string, name: string, text: string, apply: ApplyChanges, at: string): Promise<Conversation> {
  const fallback = name.replace(/\.json$/, '');
  const ai: Extract<Turn, { role: 'ai' }> = { role: 'ai', text: '', at, tools: [], done: true };
  let title = fallback;
  try {
    const p = parseProposal(text);
    title = p.title || fallback;
    ai.text = p.summary;
    const applied = await apply(p.changes, [], 'de', { conversation: id, hold: 'always' });
    if ('held' in applied) ai.held = { changes: p.changes, ...applied.held, status: 'held' };
  } catch (e) {
    ai.refused = (e as Error).message;
    if ((e instanceof RefusedChanges || e instanceof ChangesError) && e.refusal) ai.refusal = e.refusal;
  }
  return { id, title, at, turns: [{ role: 'me', text: title, at, context: [] }, ai] };
}
