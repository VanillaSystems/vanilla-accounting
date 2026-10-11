/** GET /api/claude: the `claude` CLI the inbox job would use (src/llm/ask.ts claudeStatus). */
export type ClaudeStatus =
  /** `desktopApp`: Claude Desktop is installed, which brings no `claude` command. */
  | { state: 'missing'; desktopApp: boolean }
  | { state: 'signedOut'; version: string }
  | { state: 'ready'; version: string };

export type SetupPlatform = 'darwin' | 'win32';

/**
 * "Claude einrichten" by hand, where the app cannot open a window (the browser, `npm start`): the
 * official installer, then the sign-in. src/desktop/claude-setup.ts runs the same in a window.
 */
export const SETUP_COMMANDS: Record<SetupPlatform, readonly string[]> = {
  darwin: ['curl -fsSL https://claude.ai/install.sh | bash', 'claude auth login'],
  win32: ['irm https://claude.ai/install.ps1 | iex', 'claude auth login'],
};
