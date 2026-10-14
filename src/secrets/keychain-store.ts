/**
 * The secret store of the CLI and `npm start` on a Mac: the login keychain, through the system's
 * `security` program (ADR 0014: no source and no file of the workspace holds a password). A value
 * goes to `security` on its standard input, never as an argument a process list would show. Each
 * secret belongs to the books it was set for, as in the desktop app's store.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { envSecrets, layered, useSecretStore, type SecretName, type SecretStore } from './secrets.js';

const SERVICE = 'Vanilla Accounting';

/** `security -i` reads its commands like a shell line: a quoted argument with \\ and " escaped. */
// `security -w` prints a password with a byte outside ASCII as hex, which a real password can look like too:
// every value is kept as base64 behind a prefix, so what comes back is always what went in.
const PREFIX = 'b64:';
const encode = (value: string) => PREFIX + Buffer.from(value, 'utf8').toString('base64');
const decode = (kept: string) => (kept.startsWith(PREFIX) ? Buffer.from(kept.slice(PREFIX.length), 'base64').toString('utf8') : kept);
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function keychainStore({ books }: { books: () => string }): Required<SecretStore> {
  const account = (name: SecretName) => `${realpathSync(books())} · ${name}`;
  return {
    async get(name) {
      const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', account(name), '-w'], { encoding: 'utf8', timeout: 15_000 });
      return r.status === 0 ? decode(r.stdout.replace(/\n$/, '')) || undefined : undefined;
    },
    where: (name) => `the keychain (npm run secret -- ${name})`,
    async set(name, value) {
      const r = value === null
        ? spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account(name)], { encoding: 'utf8', timeout: 15_000 })
        : spawnSync('security', ['-i'], { input: `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(account(name))} -w ${quote(encode(value))}\n`, encoding: 'utf8', timeout: 15_000 });
      // 44: there was nothing to delete.
      if (r.status !== 0 && !(value === null && r.status === 44)) throw new Error(`The keychain refused ${name}: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
    },
  };
}

/** Whether this computer has the keychain program. */
export const hasKeychain = (): boolean => process.platform === 'darwin' && spawnSync('security', ['help'], { timeout: 5_000 }).error === undefined;

/** The CLI's and `npm start`'s store: the keychain first, then .env (the sending password of before). VANILLA_KEYCHAIN=off keeps .env alone (the tests' servers). */
export function useKeychain(books: () => string): void {
  if (process.env.VANILLA_SECRETS_FILE || process.env.VANILLA_KEYCHAIN === 'off' || !hasKeychain()) return;
  useSecretStore(layered(keychainStore({ books }), envSecrets));
}
