/**
 * The CODEX_HOME the app runs `codex` in: its own folder, not the person's ~/.codex. Codex adds
 * `$CODEX_HOME/AGENTS.md` (the person's own instructions for every run) to each prompt, and no
 * flag turns that off (`--ignore-user-config` skips only config.toml). In the app's folder there is
 * no AGENTS.md, no config, no skills, no rules: only `auth.json`, a link to the person's, so the
 * run is signed in as they are. The app never opens that file; Codex writes a refreshed token
 * through the link into the person's own file (it opens it for writing, it does not replace it),
 * so their own `codex` stays signed in. Sessions of the KI column live here too.
 */
import { chmodSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** The person's own CODEX_HOME, where `codex login` keeps the sign-in; a test run links only one it names. */
export const personalCodexHome = (): string | undefined => process.env.CODEX_HOME || (process.env.NODE_TEST_CONTEXT ? undefined : join(homedir(), '.codex'));

/**
 * The app's CODEX_HOME, beside its per-Mac settings (~/.vanilla-accounting/, src/llm/settings.ts);
 * VANILLA_CODEX_HOME moves it, and a test run without it uses the temp folder, never the home.
 */
export const appCodexHome = (): string =>
  process.env.VANILLA_CODEX_HOME || (process.env.NODE_TEST_CONTEXT ? join(tmpdir(), 'vanilla-codex-home') : join(homedir(), '.vanilla-accounting', 'codex-home'));

const linkOf = (path: string): string | undefined => {
  try { return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : ''; } catch { return undefined; }
};

/**
 * Makes the app's CODEX_HOME and links the person's auth.json into it; returns its path. Without
 * an auth.json (signed out, or a sign-in kept in the keychain) nothing is linked and the run says
 * it is signed out. Instructions or a config put into the folder are removed; what Codex itself
 * keeps there (its sessions, caches) stays.
 */
export function codexHome(): string {
  const home = appCodexHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Sessions of the KI column hold company data: the folder is this user's alone, or it is not used.
  const folder = lstatSync(home);
  if (!folder.isDirectory() || (process.getuid && folder.uid !== process.getuid())) throw new Error(`${home} gehört nicht diesem Benutzer: Codex läuft nicht darin.`);
  chmodSync(home, 0o700);
  for (const own of ['AGENTS.md', 'AGENTS.override.md', 'config.toml']) rmSync(join(home, own), { force: true });
  const personal = personalCodexHome();
  const target = personal ? join(personal, 'auth.json') : '';
  const link = join(home, 'auth.json');
  const now = linkOf(link);
  const there = !!target && linkOf(target) !== undefined;
  if (now === target && there) return home;
  if (now !== undefined) rmSync(link, { force: true });
  if (there) symlinkSync(target, link);
  return home;
}
