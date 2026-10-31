/**
 * Which CLI the first run's conversation follows (docs/0.4.0/ai-setup.md, design B). Both cards
 * stand in the first message; once the person picks one, or one is already on this Mac, the
 * conversation follows that one through install, sign-in, test call and ready, and offers the other
 * only as a quiet «Doch lieber …». Each card keeps its own state (src/platform/ai-setup.ts); this
 * decides only which card the conversation talks about.
 */
import { FIRST_RUN_CLIS, type CardState, type Cards } from '../../platform/ai-setup.js';
import type { TerminalCli } from '../../platform/terminal.js';

/** What the person answered, in order: install a CLI, switch to the other one, sign in, or go on without AI. */
export type Said =
  | { kind: 'install' | 'switch' | 'signIn'; cli: TerminalCli }
  | { kind: 'noAi' };

const signedIn = (c: CardState | undefined) => c?.kind === 'ready' || c?.kind === 'testing' || c?.kind === 'refused';
const installed = (c: CardState | undefined) => c?.kind === 'signedOut' || c?.kind === 'signingIn' || (c?.kind === 'notFound' && c.waited === 'signIn');

/** The CLI already on this Mac the conversation starts from: the first signed in, else the first installed; none, both cards. */
export function alreadyHere(cards: Cards): TerminalCli | undefined {
  return FIRST_RUN_CLIS.find((cli) => signedIn(cards[cli])) ?? FIRST_RUN_CLIS.find((cli) => installed(cards[cli]));
}

/**
 * The part of the conversation about one CLI: the CLI, how it was reached (already here, the
 * person's «… installieren», or «Doch lieber …»), where that answer stands in `said` (-1: already
 * here) and whether the person said «Anmelden» since.
 */
export interface Leg {
  cli: TerminalCli;
  by: 'already' | 'install' | 'switch';
  at: number;
  signIn: boolean;
}

/** The leg the conversation is in: from the person's last pick, else from the CLI already here; none, nothing picked and nothing here. */
export function legOf(said: readonly Said[], already: TerminalCli | undefined): Leg | undefined {
  let at = said.length - 1;
  while (at >= 0 && said[at].kind !== 'install' && said[at].kind !== 'switch') at--;
  const pick = said[at];
  const signIn = (cli: TerminalCli) => said.slice(at + 1).some((s) => s.kind === 'signIn' && s.cli === cli);
  if (pick && pick.kind !== 'noAi' && pick.kind !== 'signIn') return { cli: pick.cli, by: pick.kind, at, signIn: signIn(pick.cli) };
  return already ? { cli: already, by: 'already', at: -1, signIn: signIn(already) } : undefined;
}

/** The other CLI of the first run, offered quietly. */
export const otherOf = (cli: TerminalCli): TerminalCli | undefined => FIRST_RUN_CLIS.find((c) => c !== cli);
