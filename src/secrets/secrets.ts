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
}

const ENV: Record<SecretName, string> = { smtp: 'VANILLA_SMTP_PASSWORD' };

export const envSecrets: SecretStore = {
  get: async (name) => process.env[ENV[name]] || undefined,
  where: (name) => `${ENV[name]} in .env`,
};

let store: SecretStore = envSecrets;

export const secrets: SecretStore = {
  get: (name) => store.get(name),
  where: (name) => store.where(name),
};

/** The desktop app's seam: its keychain store replaces the environment for the whole process. */
export function useSecretStore(next: SecretStore): void {
  store = next;
}
