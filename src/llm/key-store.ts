/**
 * Keeping an API key (issue #48): checked against the provider's model list first (free), kept in
 * the secret store of this computer, never in the workspace and never sent back. Firma › KI
 * (src/server/routes/ai.ts) and the setup before any books exist (src/server/ai-setup.ts) keep it so.
 */
import { secrets } from '../secrets/secrets.js';
import { HttpRefused } from './providers/http.js';
import { forgetKey, keyName } from './providers/index.js';
import { KEYED, type KeyedId } from './providers/keyed.js';

/** Why a key was not kept: the provider refused it, it belongs into .env here, or the secret store did not answer. */
export class KeyNotKept extends Error {
  constructor(readonly reason: 'refused' | 'where' | 'store', message: string, readonly where?: string) {
    super(message);
  }
}

/** Keeps `key` (null removes it). A key the provider refuses (401, 403) is not kept; one it cannot be asked about now is. */
export async function keepKey(id: KeyedId, key: string | null): Promise<void> {
  if (!secrets.inApp()) {
    const where = secrets.where(keyName(id));
    throw new KeyNotKept('where', `Der Schlüssel gehört nach ${where}.`, where);
  }
  if (key !== null) {
    try {
      await KEYED.find((s) => s.id === id)!.check(key);
    } catch (e) {
      if (e instanceof HttpRefused && (e.status === 401 || e.status === 403)) throw new KeyNotKept('refused', 'Der Anbieter lehnt den Schlüssel ab.');
      // Not reachable now: the key is kept, the view says the list failed.
    }
  }
  try {
    await secrets.set(keyName(id), key);
  } catch (e) {
    throw new KeyNotKept('store', `Der Passwortspeicher ist nicht erreichbar: ${(e as Error).message}`);
  }
  forgetKey(id);
}
