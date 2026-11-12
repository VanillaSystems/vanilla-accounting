/**
 * What became of every proposal the conversation's earlier answers made, read by code when a
 * message is sent (#362): each rule an answer drafted (recorded rule by rule when the answer ended,
 * since rules without a business share one file), the changes the app held for «Übernehmen», the
 * changes a person took back. The model's session holds only what it said then; this note, at the
 * head of the message, says what is true now, so it never tells the person the opposite of the card.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { Conversation, Turn } from '../types/assistant.js';
import { draftDir } from '../saving/changes.js';
import { ruleChanges, ruleKey, rulesOf, settledDrafts } from '../saving/settled-drafts.js';
import { wordsIn } from '../export/texts.js';

type AiTurn = Extract<Turn, { role: 'ai' }>;
type Drafted = NonNullable<AiTurn['drafted']>[number];
type T = ReturnType<typeof wordsIn>['t'];

/** At most this many proposals are told one by one, the newest; the rest as a count. */
export const PROPOSALS_TOLD = 12;

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/** The rules files an answer drafted (data/draft/knowledge/…yaml), relative to the app's folder: the files whose card it showed. */
export const ruleDraftsOf = (turn: AiTurn): string[] =>
  [...new Set(turn.tools.filter((u) => !u.denied && /^(Edit|Write)$/.test(u.name) && u.detail.startsWith('data/draft/knowledge/') && u.detail.endsWith('.yaml'))
    .map((u) => u.detail.slice('data/draft/'.length)))];

/** The rules an answer's drafts add, change or remove against the files as they stand: recorded on the turn when it ends. */
export function draftedBy(ws: Pick<Workspace, 'paths'>, turn: AiTurn): Drafted[] {
  return ruleDraftsOf(turn).flatMap((path) => {
    const draft = join(draftDir(ws), path);
    return existsSync(draft) ? ruleChanges(read(join(ws.paths.root, path)), read(draft)).map((c) => ({ path, ...c })) : [];
  });
}

export type RuleState = 'open' | 'kept' | 'keptOff' | 'keptRemoved' | 'removedKept' | 'standsAgain' | 'discarded' | 'redrafted' | 'unknown';

/**
 * The state of one drafted rule now: its change still waits in the draft; kept on its card (the
 * record) and then on, switched off or removed in the file as it stands; its removal kept; discarded;
 * drafted again by a later answer; or unknown when the app has no record of it.
 */
export function ruleState(ws: Pick<Workspace, 'paths'>, d: Drafted, at: string, later: boolean, settled = settledDrafts(ws)): RuleState {
  if (later) return 'redrafted';
  const key = `${d.section}#${d.id}`;
  const draft = join(draftDir(ws), d.path);
  const live = rulesOf(read(join(ws.paths.root, d.path)));
  if (existsSync(draft) && ruleChanges(read(join(ws.paths.root, d.path)), read(draft)).some((c) => c.section === d.section && c.id === d.id && c.change === d.change)) return 'open';
  // The outcome of the card that held this answer's change: the first after the answer for that change, never a later card's of another change.
  const s = (settled[ruleKey(d.path, d.section, d.id)] ?? []).find((o) => o.at >= at && (!o.change || o.change === d.change));
  if (!s) return 'unknown';
  if (s.state === 'discarded') return 'discarded';
  const now = live.get(key);
  if (d.change === 'removed') return now ? 'standsAgain' : 'removedKept';
  return !now ? 'keptRemoved' : now.off ? 'keptOff' : 'kept';
}

const stateWords = (t: T, path: string): Record<RuleState, string> => ({
  open: `still a draft: the person has not pressed «${t('rules.draft.keep')}» or «${t('rules.draft.discard')}» on its card yet, so nothing of it applies. Do not bring it up unless the person asks about it.`,
  kept: `KEPT and in effect: the person pressed «${t('rules.draft.keep')}»; it applies to the next matching payments. Never say it is not kept or that a click is missing.`,
  keptOff: `KEPT, but switched off since (${t('area.company')} › ${t('company.rules')}): it does not apply now.`,
  keptRemoved: `KEPT, but no longer in the file under this id (removed or renamed since, ${t('area.company')} › ${t('company.rules')}): read the file before you say anything about it.`,
  removedKept: 'removal KEPT: the rule is gone, as proposed.',
  standsAgain: 'removal KEPT, but a rule with this id stands in the file again.',
  discarded: `DISCARDED: the person pressed «${t('rules.draft.discard')}»; it was never kept by that card.`,
  redrafted: 'drafted again by a later answer of yours: see that answer below.',
  unknown: `UNKNOWN: the app has no record of what became of it; read ${path} before you say anything about it.`,
});

const heldWords = (t: T) => ({
  held: `proposed and not decided yet: nothing of it is in the books until the person presses «${t('assistant.held.take')}» on its card. Do not bring it up unless the person asks about it.`,
  taken: `TAKEN: the person pressed «${t('assistant.held.take')}»; the changes are made, each with its «${t('assistant.undo')}».`,
  dropped: `DISCARDED: the person pressed «${t('assistant.held.drop')}»; nothing of it was made.`,
});

const CHANGE = { added: 'adds', changed: 'changes', removed: 'removes' } as const;

/** The note, or '' when no earlier answer proposed anything. */
export function proposalsNote(ws: Pick<Workspace, 'paths'>, c: Pick<Conversation, 'turns'>, language = 'de'): string {
  const { t } = wordsIn(language);
  const held = heldWords(t);
  const settled = settledDrafts(ws);
  const answers = c.turns.flatMap((turn, i) => (turn.role === 'ai' ? [{ turn, i }] : []));
  const lines: string[] = [];
  answers.forEach(({ turn }, k) => {
    const n = k + 1;
    const drafted = turn.drafted;
    if (drafted) {
      for (const d of drafted) {
        const later = answers.slice(k + 1).some((x) => x.turn.drafted?.some((y) => y.path === d.path && y.section === d.section && y.id === d.id));
        lines.push(`- Your answer ${n}: the rule ${d.id} (it ${CHANGE[d.change]} it in ${d.path}) is ${stateWords(t, d.path)[ruleState(ws, d, turn.at, later, settled)]}`);
      }
    } else {
      // An answer from before the app recorded its rules: only its files are known.
      for (const path of ruleDraftsOf(turn)) lines.push(`- Your answer ${n}: the rules you drafted in ${path} are UNKNOWN to the app now: read ${path} before you say anything about them.`);
    }
    if (turn.held) lines.push(`- Your answer ${n}: its changes to the books were ${held[turn.held.status]}`);
    const undone = (turn.changes ?? []).filter((m) => m.undone).length;
    if (undone) lines.push(`- Your answer ${n}: the person took back ${undone} of the changes it made («${t('assistant.undo')}»); they are not in the books.`);
  });
  if (!lines.length) return '';
  const told = lines.slice(-PROPOSALS_TOLD);
  return [
    'What became of the proposals of your earlier answers in this conversation, read by the app from the books and files when this message was sent. Where an earlier answer of yours said otherwise (that a rule is not kept yet, that it applies only after a click), that answer is out of date. Never contradict a state this list names; where it says UNKNOWN, read the file first, and never tell the person to press a button for a proposal it calls kept, taken or discarded.',
    ...(lines.length > told.length ? [`- ${lines.length - told.length} older proposals are not listed: read their files before you say anything about them.`] : []),
    ...told,
  ].join('\n');
}
