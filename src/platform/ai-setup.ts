/**
 * The AI setup on this Mac (docs/0.4.0/ai-setup.md): what detection found for each CLI, the card's
 * state machine the UI runs while a person installs or signs in, and what GET /api/ai/setup
 * answers. Shared by the server (src/server/ai-setup.ts, detection in src/platform/ai-cli.ts) and
 * the UI (src/app/ai/). Nothing here reads a login: the CLI itself says whether it is signed in.
 */
import type { TerminalCli } from './terminal.js';

/**
 * The CLIs the first run offers, both cards side by side (decision 7: Codex joined once #121 made
 * it a provider). A check in a fresh macOS VM on 25.10.2026 showed that the app's own `codex exec`
 * (src/llm/providers/codex-cli.ts, plugins off) raises no developer-tools dialog on a Mac without
 * Apple's Command Line Tools.
 */
export const FIRST_RUN_CLIS: readonly TerminalCli[] = ['claude', 'codex'];

/** While a card waits, the app looks this often (decision 8)… */
export const POLL_MS = 2000;
/** …and gives up after this long, with «nicht gefunden». */
export const WAIT_MS = 15 * 60_000;

/**
 * One CLI as detection found it, asked afresh each time: nothing (with the places looked in), a
 * program that does not answer `--version`, or one that answers, signed in or not. Of the sign-in
 * the app keeps only the method and the plan the CLI names (decision 3: no email, no organization).
 */
export type CliProbe =
  | { found: 'none'; looked: string[] }
  | { found: 'silent'; bin: string }
  | { found: 'signedOut'; bin: string; version: string }
  | { found: 'signedIn'; bin: string; version: string; method?: string; plan?: string };

/** The test call (decision 2): answered, or refused for the plan, a used-up limit or another reason, in the CLI's own words. */
export type Probation =
  | { ok: true; ms: number }
  | { ok: false; why: 'plan' | 'limit' | 'other'; said: string };

/**
 * The card of one CLI. `installing` and `signingIn` wait for the person in Terminal and look every
 * POLL_MS; after WAIT_MS they become `notFound`. `testing` runs the one test call; `refused` is a
 * sign-in whose test call was refused (a plan too small, a limit reached).
 */
export type CardState =
  | { kind: 'missing'; looked: string[] }
  | { kind: 'installing'; since: number; looked: string[] }
  | { kind: 'silent'; bin: string }
  | { kind: 'signedOut'; bin: string; version: string }
  | { kind: 'signingIn'; since: number; bin: string; version: string }
  | { kind: 'testing'; bin: string; version: string; plan?: string }
  | { kind: 'ready'; bin: string; version: string; plan?: string; ms?: number }
  | { kind: 'refused'; bin: string; version: string; plan?: string; why: 'plan' | 'limit' | 'other'; said: string }
  | { kind: 'notFound'; waited: 'install' | 'signIn'; looked: string[]; bin?: string; version?: string };

export type CardEvent =
  /** What a look found, at `at` (ms). */
  | { kind: 'probed'; probe: CliProbe; at: number }
  /** Terminal opened with the vendor's installer. */
  | { kind: 'install'; at: number }
  /** Terminal opened with the CLI's sign-in. */
  | { kind: 'signIn'; at: number }
  | { kind: 'tested'; result: Probation }
  /** «Nochmals prüfen». */
  | { kind: 'again'; at: number };

/** The card's first state, from the first look. */
export const cardOf = (probe: CliProbe): CardState => settle({ kind: 'missing', looked: [] }, probe);

/** What a look shows, wherever the card stood: signed in starts the test call. */
function settle(was: CardState, probe: CliProbe): CardState {
  switch (probe.found) {
    case 'none': return { kind: 'missing', looked: probe.looked };
    case 'silent': return { kind: 'silent', bin: probe.bin };
    case 'signedOut': return { kind: 'signedOut', bin: probe.bin, version: probe.version };
    case 'signedIn': {
      const { bin, version, plan } = probe;
      // A card that already tested keeps its answer; a fresh sign-in is tested once.
      if (was.kind === 'ready' || was.kind === 'refused' || was.kind === 'testing') return { ...was, bin, version, ...(plan ? { plan } : {}) };
      return { kind: 'testing', bin, version, ...(plan ? { plan } : {}) };
    }
  }
}

/**
 * The card's state machine. A waiting card keeps waiting until the look shows what it waits for
 * (the program for an install, the sign-in for a sign-in) or WAIT_MS have passed; every other card
 * follows what the look shows.
 */
export function nextCard(state: CardState, event: CardEvent): CardState {
  switch (event.kind) {
    case 'install': return { kind: 'installing', since: event.at, looked: 'looked' in state ? state.looked : [] };
    case 'signIn': {
      const known = 'bin' in state && state.bin && 'version' in state && state.version ? { bin: state.bin, version: state.version } : undefined;
      return known ? { kind: 'signingIn', since: event.at, ...known } : state;
    }
    case 'tested':
      if (state.kind !== 'testing') return state;
      return event.result.ok
        ? { kind: 'ready', bin: state.bin, version: state.version, ...(state.plan ? { plan: state.plan } : {}), ms: event.result.ms }
        : { kind: 'refused', bin: state.bin, version: state.version, ...(state.plan ? { plan: state.plan } : {}), why: event.result.why, said: event.result.said };
    case 'again':
      if (state.kind === 'ready' || state.kind === 'refused') return { kind: 'testing', bin: state.bin, version: state.version, ...(state.plan ? { plan: state.plan } : {}) };
      if (state.kind === 'notFound') {
        return state.waited === 'install' || !state.bin || !state.version
          ? { kind: 'installing', since: event.at, looked: state.looked }
          : { kind: 'signingIn', since: event.at, bin: state.bin, version: state.version };
      }
      return state;
    case 'probed': {
      const { probe, at } = event;
      if (state.kind === 'installing') {
        if (probe.found === 'signedOut' || probe.found === 'signedIn') return settle(state, probe);
        const looked = probe.found === 'none' ? probe.looked : [probe.bin];
        return at - state.since >= WAIT_MS ? { kind: 'notFound', waited: 'install', looked } : { ...state, looked };
      }
      if (state.kind === 'signingIn') {
        if (probe.found === 'signedOut') return at - state.since >= WAIT_MS ? { kind: 'notFound', waited: 'signIn', looked: [state.bin], bin: state.bin, version: state.version } : state;
        return settle(state, probe);
      }
      // «nicht gefunden» stays while the look shows the same nothing; anything new is shown.
      if (state.kind === 'notFound' && (state.waited === 'install' ? probe.found === 'none' || probe.found === 'silent' : probe.found === 'signedOut')) return state;
      return settle(state, probe);
    }
  }
}

/** One card per CLI. Each CLI's events move only its own card. */
export type Cards = Partial<Record<TerminalCli, CardState>>;

/** `event` for `cli`: its card moves (or appears with its first look); every other card stays as it was. */
export function stepCards(cards: Cards, cli: TerminalCli, event: CardEvent): Cards {
  const was = cards[cli];
  const now = was ? nextCard(was, event) : event.kind === 'probed' ? cardOf(event.probe) : undefined;
  return now ? { ...cards, [cli]: now } : cards;
}

/** A card that waits for the person in Terminal: the app looks every POLL_MS. */
export const waits = (s: CardState): boolean => s.kind === 'installing' || s.kind === 'signingIn';

/** A card through which the app's steps can be answered now. */
export const answers = (s: CardState): boolean => s.kind === 'ready';

/** An API key the app takes before any books exist (src/llm/providers/keyed.ts; Jev answers typed questions only and is not offered here). */
export const SETUP_KEYS = ['anthropic', 'openai'] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];
export const isSetupKey = (v: unknown): v is SetupKey => SETUP_KEYS.includes(v as SetupKey);

/** Where each provider's keys are made. */
export const KEY_PAGES: Record<SetupKey, string> = {
  anthropic: 'https://platform.claude.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};

/** GET /api/ai/setup: this Mac's AI, also before any books exist. */
export interface AiSetupView {
  clis: Array<{ cli: TerminalCli; probe: CliProbe }>;
  keys: Array<{ id: SetupKey; set: boolean }>;
  /** The app keeps keys itself (the keychain); with `npm start` they belong into .env. */
  keysInApp: boolean;
  /** «Ohne KI weitermachen», remembered on this Mac (decision 6). */
  noAi: boolean;
  /** When the CLI the app asks cannot answer, ask the other one by itself (decision 4; off by default). */
  askOther: boolean;
  /** The CLI the app asks (and «Im Terminal» opens) when two are ready. */
  preferred?: TerminalCli;
  /** The CLI the KI column runs on now (src/llm/ask.ts sidebarAgent): the preferred one when found, else the one found. */
  sidebar: TerminalCli;
  /** macOS: the app opens Terminal; elsewhere the command is copied. */
  opens: boolean;
  /** An AI answers the app's steps now (the rule of src/llm/ask.ts modelReady, #175). */
  available: boolean;
}

/** PUT /api/ai/setup/keys/:provider: the view, and the test call made with a key that was saved. */
export interface KeySaved { view: AiSetupView; test?: Probation }

/** The plan as `claude auth status` names it (`subscriptionType`), as the vendor writes it; another name is shown as the CLI gave it. */
const PLAN_NAMES: Record<string, string> = { free: 'Claude Free', pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise' };
export const planName = (plan: string): string => PLAN_NAMES[plan.toLowerCase()] ?? plan;
