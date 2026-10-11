/**
 * Run inside Electron by tests/secrets.test.ts: the desktop app's secret store on Electron's own
 * safeStorage, written and read back by a second store on the same file. One JSON line to stdout.
 */
import { app, safeStorage } from 'electron';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealedStore } from '../../src/secrets/sealed-store.js';

app.dock?.hide();
void app.whenReady().then(main);

async function main() {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'sealed-'));
    const file = join(dir, 'secrets.json');
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    mkdirSync(a);
    mkdirSync(b);
    let open = a;
    await sealedStore({ file, cipher: safeStorage, books: () => open }).set('smtp', 'geheim-123');
    const again = sealedStore({ file, cipher: safeStorage, books: () => open });
    const read = await again.get('smtp');
    open = b;
    const other = await again.get('smtp');
    process.stdout.write(JSON.stringify({ available: safeStorage.isEncryptionAvailable(), read, other: other ?? null, plainOnDisk: readFileSync(file, 'utf8').includes('geheim') }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String((e as Error).stack ?? e) }) + '\n');
  }
  app.exit(0);
}
