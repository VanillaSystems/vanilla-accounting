/**
 * Passwords the app needs and the workspace never holds (it is a folder of files a person may
 * share or commit). `npm start` and the CLI read them from the environment (.env); the desktop app
 * sets its own store at start, the macOS keychain (ADR 0006), through `useSecretStore`.
 */
export type SecretName = 'smtp';

export interface SecretStore {
  get(name: SecretName): Promise<string | undefined>;
  /** Where a person puts the secret, for a message that it is missing (`VANILLA_SMTP_PASSWORD in .env`). */
  where(name: SecretName): string;
  /** Present when the app keeps the secret itself (the desktop keychain); `.env` is edited by hand. null removes it. */
  set?(name: SecretName, value: string | null): Promise<void>;
}

const ENV: Record<SecretName, string> = { smtp: 'VANILLA_SMTP_PASSWORD' };

export const envSecrets: SecretStore = {
  get: async (name) => process.env[ENV[name]] || undefined,
  where: (name) => `${ENV[name]} in .env`,
};

let store: SecretStore = envSecrets;

export const secrets = {
  get: (name: SecretName) => store.get(name),
  where: (name: SecretName) => store.where(name),
  /** Whether the person can save the secret in the app (the desktop app) or puts it into .env. */
  inApp: () => !!store.set,
  /** Only where `inApp()`; elsewhere it rejects. */
  set: async (name: SecretName, value: string | null): Promise<void> => {
    if (!store.set) throw new Error(`The app does not keep this secret: ${store.where(name)}.`);
    await store.set(name, value);
  },
};

/** The desktop app's seam: its keychain store replaces the environment for the whole process. */
export function useSecretStore(next: SecretStore): void {
  store = next;
}
