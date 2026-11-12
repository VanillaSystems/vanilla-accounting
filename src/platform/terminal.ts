/**
 * «Im Terminal öffnen» (issue #146): a request the sidebar cannot do (it has no shell) goes to
 * Claude Code or Codex in a terminal in the books folder. This module is the part the UI shares:
 * which CLI opens, the command a person copies, the script Terminal runs. Detecting and opening
 * are src/platform/terminal-open.ts. The app never checks a plan or a subscription and never
 * reads a CLI's login: it starts the program, which uses whatever account it is signed into.
 */

export const TERMINAL_CLIS = ['claude', 'codex'] as const;
export type TerminalCli = (typeof TERMINAL_CLIS)[number];
export const isTerminalCli = (v: unknown): v is TerminalCli => TERMINAL_CLIS.includes(v as TerminalCli);

/**
 * The one table of facts about each CLI (docs/0.4.0/ai-setup.md, «Installers» and «Plans», checked
 * 25.10.2026): the program, its vendor's official native installer (needs only curl and a shell,
 * which macOS has: no Homebrew, no npm), the vendor's guide and plans page, the commands that say
 * whether it is signed in and that sign in, and the smallest plan that includes the CLI.
 */
export interface CliFacts {
  program: string;
  vendor: string;
  install: string;
  guide: string;
  plans: string;
  status: readonly string[];
  login: readonly string[];
  /** The vendor's name of the smallest plan with the CLI. */
  minPlan: string;
  /** About what that plan costs a month, in USD (docs/0.4.0/ai-setup.md «Plans»): said as «etwa», never as an exact price. */
  minPlanUsd: number;
  /**
   * Variables the installer runs with, so it asks nothing of its own: the app's Terminal screen
   * asks the sign-in in the person's language. OpenAI's installer otherwise asks «Start Codex
   * now? [y/N]» on the terminal, in English (seen in a fresh macOS VM, 25.10.2026).
   */
  installEnv?: Readonly<Record<string, string>>;
}

export const AI_CLIS: Record<TerminalCli, CliFacts> = {
  claude: {
    program: 'claude', vendor: 'Anthropic', install: 'curl -fsSL https://claude.ai/install.sh | bash',
    guide: 'https://code.claude.com/docs/en/setup', plans: 'https://claude.com/pricing',
    status: ['auth', 'status'], login: ['auth', 'login'], minPlan: 'Claude Pro', minPlanUsd: 20,
  },
  codex: {
    program: 'codex', vendor: 'OpenAI', install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    guide: 'https://developers.openai.com/codex/cli', plans: 'https://chatgpt.com/pricing',
    status: ['login', 'status'], login: ['login'], minPlan: 'ChatGPT Plus', minPlanUsd: 20,
    installEnv: { CODEX_NON_INTERACTIVE: '1' },
  },
};

/**
 * One CLI as this computer has it. `signedIn` undefined: not known (Claude before the app's own
 * steps ran it); false only when the CLI itself said so (`codex login status`).
 */
export type CliState =
  | { cli: TerminalCli; installed: false }
  | { cli: TerminalCli; installed: true; signedIn: boolean | undefined };

/**
 * The terminal apps the button opens (issue #210): macOS has no default terminal to read, so the
 * person chooses among those installed. The one table of them: the app's name for `open -a`, and
 * how it runs the .command script. `file`: the app opens the script as a document and runs it
 * (Terminal; iTerm2 declares .command files and executables as its documents). `exec`: a new
 * instance started with `-e <script>` (Ghostty's documented way on macOS:
 * `open -na Ghostty.app --args -e …`). No AppleScript, so none of them asks for a permission.
 */
export const TERMINAL_APPS = ['terminal', 'iterm', 'ghostty', 'warp'] as const;
export type TerminalApp = (typeof TERMINAL_APPS)[number];
export const isTerminalApp = (v: unknown): v is TerminalApp => TERMINAL_APPS.includes(v as TerminalApp);

export interface TerminalAppFacts {
  /** The product's name, as a person reads it. */
  name: string;
  /** The bundle's name in an Applications folder (without .app), which `open -a` takes. */
  bundle: string;
  run: 'file' | 'exec';
}

export const TERMINAL_APP_FACTS: Record<TerminalApp, TerminalAppFacts> = {
  terminal: { name: 'Terminal', bundle: 'Terminal', run: 'file' },
  iterm: { name: 'iTerm2', bundle: 'iTerm', run: 'file' },
  ghostty: { name: 'Ghostty', bundle: 'Ghostty', run: 'exec' },
  warp: { name: 'Warp', bundle: 'Warp', run: 'file' },
};

/** The arguments to `open` that let `app` run `script`. */
export function openArgs(app: TerminalApp, script: string): string[] {
  const { bundle, run } = TERMINAL_APP_FACTS[app];
  return run === 'file' ? ['-a', bundle, script] : ['-na', bundle, '--args', '-e', script];
}

/** Which terminal opens: the one chosen while it is installed, the only one, or a question among those found. */
export type TerminalAppPlan = { kind: 'open'; app: TerminalApp } | { kind: 'ask'; apps: TerminalApp[] };

export function chooseTerminalApp(installed: readonly TerminalApp[], preferred: TerminalApp | undefined): TerminalAppPlan {
  if (preferred && installed.includes(preferred)) return { kind: 'open', app: preferred };
  if (installed.length > 1) return { kind: 'ask', apps: [...installed] };
  return { kind: 'open', app: installed[0] ?? 'terminal' };
}

/** GET /api/terminal: the CLIs and the one chosen in Firma › KI, the terminal apps and the one chosen, whether this computer opens a terminal, and the books folder. */
export interface TerminalView {
  clis: CliState[];
  preferred?: TerminalCli;
  /** The terminal apps installed on this Mac, Terminal first. */
  apps: TerminalApp[];
  /** The terminal app chosen on this Mac; absent: not chosen yet. */
  app?: TerminalApp;
  /** macOS: the app opens Terminal; elsewhere only the command to copy. */
  opens: boolean;
  folder: string;
}

/**
 * What the button does: open `cli` (`signIn`: it will ask to sign in first, say so before), with
 * `other` offered as «oder mit …»; or, with none installed, the install guide.
 */
export type TerminalPlan =
  | { kind: 'open'; cli: TerminalCli; signIn: boolean; other?: TerminalCli }
  | { kind: 'install' };

/** Both installed: the one chosen (Claude when none is), the other offered. One: that one. None: the guide. */
export function chooseCli(states: readonly CliState[], preferred: TerminalCli | undefined): TerminalPlan {
  const installed = TERMINAL_CLIS.filter((cli) => states.some((s) => s.cli === cli && s.installed));
  if (!installed.length) return { kind: 'install' };
  const cli = preferred && installed.includes(preferred) ? preferred : installed[0];
  const state = states.find((s) => s.cli === cli);
  const other = installed.find((c) => c !== cli);
  return { kind: 'open', cli, signIn: state?.installed === true && state.signedIn === false, ...(other ? { other } : {}) };
}

/** `s` as one word of POSIX shell: single-quoted, each ' written as '\''. Nothing inside is expanded. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The longest request the app hands on; a longer one is cut (an argument, not a document). */
export const REQUEST_MAX = 20_000;

/** The command a person copies into their own terminal: into the books folder, the CLI started with the request as its first prompt. */
export function copyCommand(folder: string, cli: TerminalCli, request: string): string {
  const r = request.trim().slice(0, REQUEST_MAX);
  return `cd ${shellQuote(folder)} && ${AI_CLIS[cli].program}${r ? ` ${shellQuote(r)}` : ''}`;
}

/**
 * The .command script the terminal runs: into the books folder, the script's folder removed, the
 * CLI started. With `requestFile`, the request is read from it (never part of the script's code)
 * and handed to the CLI as one argument; without, the CLI starts with no prompt and the person
 * types their own (issue #210: neither Claude Code nor Codex has an option to prefill its input).
 * `bin` is the CLI's path as the login shell finds it.
 */
export function launchScript(folder: string, bin: string, scriptDir: string, requestFile?: string): string {
  return [
    '#!/bin/sh',
    `cd ${shellQuote(folder)} || exit 1`,
    ...(requestFile ? [`request=$(cat ${shellQuote(requestFile)})`] : []),
    `rm -rf ${shellQuote(scriptDir)}`,
    'clear',
    requestFile ? `if [ -n "$request" ]; then exec ${shellQuote(bin)} "$request"; else exec ${shellQuote(bin)}; fi` : `exec ${shellQuote(bin)}`,
    '',
  ].join('\n');
}
