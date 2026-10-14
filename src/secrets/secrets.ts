/**
 * Passwords the app needs and the workspace never holds (it is a folder of files a person may
 * share or commit). The desktop app sets its own store at start, sealed by the macOS keychain
 * (ADR 0006), through `useSecretStore`; `npm start` and the CLI use the login keychain on a Mac
 * (keychain-store.ts) and fall back to the environment (.env) for the mail sending password.
 * A test names a plain file with VANILLA_SECRETS_FILE, so it never touches a keychain.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** The sending password, and one per source channel: `source:<id>:mail` (ADR 0014; derived, never listed). */
export type SecretName = 'smtp' | `source:${string}:mail` | `source:${string}:api`;

/** The secret of a mailbox's login. */
export const mailSecret = (source: string): SecretName => `source:${source}:mail`;

export interface SecretStore {
  get(name: SecretName): Promise<string | undefined>;
  /** Where a person puts the secret, for a message that it is missing (`VANILLA_SMTP_PASSWORD in .env`). */
  where(name: SecretName): string;
  /** Present when the app keeps the secret itself (the desktop keychain); `.env` is edited by hand. null removes it. */
  set?(name: SecretName, value: string | null): Promise<void>;
}

const ENV: Partial<Record<SecretName, string>> = { smtp: 'VANILLA_SMTP_PASSWORD' };

export const envSecrets: SecretStore = {
  get: async (name) => (ENV[name] && process.env[ENV[name]!]) || undefined,
  where: (name) => (ENV[name] ? `${ENV[name]} in .env` : `npm run secret -- ${name}`),
};

/** A plain JSON file of secrets: for tests only (VANILLA_SECRETS_FILE). */
export function fileSecrets(file: string): Required<SecretStore> {
  const read = (): Record<string, string> => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, string> : {});
  return {
    get: async (name) => read()[name],
    where: (name) => `${file} · ${name}`,
    async set(name, value) {
      const all = read();
      if (value === null) delete all[name]; else all[name] = value;
      writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
    },
  };
}

/** A store that asks `first`, then `then`; it keeps new secrets in `first`. */
export const layered = (first: Required<SecretStore>, then: SecretStore): Required<SecretStore> => ({
  get: async (name) => (await first.get(name)) ?? then.get(name),
  where: first.where,
  set: first.set,
});

let chosen: SecretStore | undefined;
/** The store in use: the one set at start, else a secrets file (tests), else the environment. Chosen at the first use, not at import. */
const store = (): SecretStore => (chosen ??= process.env.VANILLA_SECRETS_FILE ? fileSecrets(process.env.VANILLA_SECRETS_FILE) : envSecrets);

export const secrets = {
  get: (name: SecretName) => store().get(name),
  where: (name: SecretName) => store().where(name),
  /** Whether the person can save the secret in the app (the desktop app) or puts it into .env. */
  inApp: () => !!store().set,
  /** Only where `inApp()`; elsewhere it rejects. */
  set: async (name: SecretName, value: string | null): Promise<void> => {
    const s = store();
    if (!s.set) throw new Error(`The app does not keep this secret: ${s.where(name)}.`);
    await s.set(name, value);
  },
};

/** The desktop app's seam: its keychain store replaces the environment for the whole process. */
export function useSecretStore(next: SecretStore): void {
  chosen = next;
}
