/**
 * The desktop app's secret store: each secret encrypted by the system (Electron's `safeStorage`,
 * whose key lives in the macOS keychain) into one file of the app's user data folder, kept per
 * books. Nothing of it lies in the workspace, so books shared or committed carry no password.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isMachineSecret, MACHINE, type SecretName, type SecretStore } from './secrets.js';

/** What `safeStorage` offers; a test passes its own. */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(sealed: Buffer): string;
}

/** The file: books folder (or MACHINE for the secrets of this computer) → secret name → the sealed value in base64. */
type Sealed = Record<string, Partial<Record<SecretName, string>>>;

export function sealedStore({ file, cipher, books }: {
  file: string;
  cipher: Cipher;
  /** The folder of the books open now; a secret belongs to them. */
  books: () => string | undefined;
}): Required<SecretStore> {
  const read = (): Sealed => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const key = (name: SecretName): string => {
    if (isMachineSecret(name)) return MACHINE;
    const root = books();
    if (!root) throw new Error('No books are open.');
    return realpathSync(root);
  };
  return {
    async get(name) {
      const value = read()[key(name)]?.[name];
      return value ? cipher.decryptString(Buffer.from(value, 'base64')) : undefined;
    },
    where: () => 'Firma › E-Mail-Versand',
    async set(name, value) {
      const all = read();
      const own = { ...all[key(name)] };
      if (value) {
        if (!cipher.isEncryptionAvailable()) throw new Error('The system keychain is not available.');
        own[name] = cipher.encryptString(value).toString('base64');
      } else delete own[name];
      all[key(name)] = own;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
  };
}
