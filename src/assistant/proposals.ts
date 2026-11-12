/**
 * What became of every proposal the conversation's earlier answers made, read by code when a
 * message is sent (#362): the rules each drafted (a card's «Behalten» or «Verwerfen», or still a
 * draft), the changes the app held for «Übernehmen», the changes a person took back. The model's
 * session holds only what it said then; this note, at the head of the message, says what is true
 * now, so it never tells the person the opposite of the card.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { Conversation, Turn } from '../types/assistant.js';
import { draftDir } from '../saving/changes.js';
import { settledDrafts } from '../saving/settled-drafts.js';
import { wordsIn } from '../export/texts.js';

type AiTurn = Extract<Turn, { role: 'ai' }>;
type T = ReturnType<typeof wordsIn>['t'];

/** The rules files an answer drafted (data/draft/knowledge/…yaml), relative to the app's folder: the files whose card it showed. */
export const ruleDraftsOf = (turn: AiTurn): string[] =>
  [...new Set(turn.tools.filter((u) => !u.denied && /^(Edit|Write)$/.test(u.name) && u.detail.startsWith('data/draft/knowledge/') && u.detail.endsWith('.yaml'))
    .map((u) => u.detail.slice('data/draft/'.length)))];

export type DraftState = 'open' | 'kept' | 'discarded' | 'redrafted';

/**
 * The state of each rules draft of the conversation, by answer: still a draft (its file waits in
 * data/draft/), kept or discarded on its card (data/draft-settled.json, recorded after that answer),
 * drafted anew by a later answer; a draft gone without a record counts as kept when its file stands.
 */
export function draftStates(ws: Pick<Workspace, 'paths'>, c: Pick<Conversation, 'turns'>): Array<{ turn: number; path: string; state: DraftState }> {
  const settled = settledDrafts(ws);
  const turns = c.turns.flatMap((t, i) => (t.role === 'ai' ? [{ t, i }] : []));
  return turns.flatMap(({ t, i }) => ruleDraftsOf(t).map((path) => {
    if (turns.some((x) => x.i > i && ruleDraftsOf(x.t).includes(path))) return { turn: i, path, state: 'redrafted' as const };
    if (existsSync(join(draftDir(ws), path))) return { turn: i, path, state: 'open' as const };
    const s = settled[path];
    if (s && s.at >= t.at) return { turn: i, path, state: s.state };
    return { turn: i, path, state: existsSync(join(ws.paths.root, path)) ? 'kept' as const : 'discarded' as const };
  }));
}

const draftWords = (t: T): Record<DraftState, string> => ({
  open: `still a draft: the person has not pressed «${t('rules.draft.keep')}» or «${t('rules.draft.discard')}» on its card yet, so nothing of it applies. Do not bring it up unless the person asks about it.`,
  kept: `KEPT: the person pressed «${t('rules.draft.keep')}» on its card; the rule stands in the company's knowledge and applies to the next matching payments. Never say it is not kept or that a click is still missing.`,
  discarded: `DISCARDED: the person pressed «${t('rules.draft.discard')}» on its card; nothing of it applies. Never offer it again unless the person asks.`,
  redrafted: 'replaced by your later draft of the same file (see below).',
});

const heldWords = (t: T) => ({
  held: `proposed and not decided yet: nothing of it is in the books until the person presses «${t('assistant.held.take')}» on its card. Do not bring it up unless the person asks about it.`,
  taken: `TAKEN: the person pressed «${t('assistant.held.take')}»; the changes are made, each with its «${t('assistant.undo')}».`,
  dropped: `DISCARDED: the person pressed «${t('assistant.held.drop')}»; nothing of it was made.`,
});

/** The note, or '' when no earlier answer proposed anything. */
export function proposalsNote(ws: Pick<Workspace, 'paths'>, c: Pick<Conversation, 'turns'>, language = 'de'): string {
  const { t } = wordsIn(language);
  const draft = draftWords(t);
  const held = heldWords(t);
  const drafts = draftStates(ws, c);
  const lines: string[] = [];
  let n = 0;
  c.turns.forEach((turn, i) => {
    if (turn.role !== 'ai') return;
    n += 1;
    for (const d of drafts.filter((x) => x.turn === i)) lines.push(`- Your answer ${n}: the rule you drafted in ${d.path} is ${draft[d.state]}`);
    if (turn.held) lines.push(`- Your answer ${n}: its changes to the books were ${held[turn.held.status]}`);
    const undone = (turn.changes ?? []).filter((m) => m.undone).length;
    if (undone) lines.push(`- Your answer ${n}: the person took back ${undone} of the changes it made («${t('assistant.undo')}»); they are not in the books.`);
  });
  if (!lines.length) return '';
  return [
    'What became of the proposals of your earlier answers in this conversation, read by the app from the books and files when this message was sent. This is the state now: where an earlier answer of yours said otherwise (that a rule is not kept yet, that it applies only after a click), that answer is out of date. Never contradict this list, and never tell the person to press a button for a proposal it calls kept, taken or discarded.',
    ...lines,
  ].join('\n');
}
