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
}

export const AI_CLIS: Record<TerminalCli, CliFacts> = {
  claude: {
    program: 'claude', vendor: 'Anthropic', install: 'curl -fsSL https://claude.ai/install.sh | bash',
    guide: 'https://code.claude.com/docs/en/setup', plans: 'https://claude.com/pricing',
    status: ['auth', 'status'], login: ['auth', 'login'], minPlan: 'Claude Pro',
  },
  codex: {
    program: 'codex', vendor: 'OpenAI', install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    guide: 'https://developers.openai.com/codex/cli', plans: 'https://chatgpt.com/pricing',
    status: ['login', 'status'], login: ['login'], minPlan: 'ChatGPT Plus',
  },
};

/**
 * One CLI as this computer has it. `signedIn` undefined: not known (Claude before the app's own
 * steps ran it); false only when the CLI itself said so (`codex login status`).
 */
export type CliState =
  | { cli: TerminalCli; installed: false }
  | { cli: TerminalCli; installed: true; signedIn: boolean | undefined };

/** GET /api/terminal: the CLIs, the one chosen in Firma › KI, whether this computer opens Terminal, and the books folder. */
export interface TerminalView {
  clis: CliState[];
  preferred?: TerminalCli;
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
 * The .command script Terminal runs: into the books folder, the request read from its file (never
 * part of the script's code), the script's folder removed, the CLI started with the request as one
 * argument. `bin` is the CLI's path as the login shell finds it.
 */
export function launchScript(folder: string, bin: string, requestFile: string, scriptDir: string): string {
  return [
    '#!/bin/sh',
    `cd ${shellQuote(folder)} || exit 1`,
    `request=$(cat ${shellQuote(requestFile)})`,
    `rm -rf ${shellQuote(scriptDir)}`,
    'clear',
    `if [ -n "$request" ]; then exec ${shellQuote(bin)} "$request"; else exec ${shellQuote(bin)}; fi`,
    '',
  ].join('\n');
}
