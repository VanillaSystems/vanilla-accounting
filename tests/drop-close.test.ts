/**
 * The drop window closed while its files upload (src/app/shell/drop-upload.ts `dropStore`, #195):
 * the closed session never comes back into the window, the files still uploading go on into it
 * («Im Hintergrund weiter») and are taken, the server closes it once the last is in, and the next
 * drop opens a session of its own.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';
import { SESSION } from './support/inbox-run.js';
import { textPdf } from './support/text-pdf.js';
import { dropStore, type DropServer } from '../src/app/shell/drop-upload.js';
import type { DropSession } from '../src/types/drop.js';

const invoice = async (i: number) => new File([new Uint8Array(await textPdf(['Farbenhaus Beispiel AG', `Rechnung F-${7000 + i}`, `Datum: ${(i % 28) + 1}.10.2026`, `Rolle ${100 + i * 7}.00`, `Total CHF ${(100 + i * 7) * 1.081}`]))], `f-${i}.pdf`);

test('closed during a drop of 30 files: the dead session never returns, every file is taken once, the next drop opens a new session', async () => {
  const api = await startApi('demo');
  const { rest, books } = SESSION(api);
  try {
    const call = async (method: string, path: string, body?: Uint8Array<ArrayBuffer>): Promise<DropSession> => {
      const r = await api.fetch(path, { method, body, headers: body ? { 'Content-Type': 'application/octet-stream' } : {} });
      const json = await r.json();
      if (!r.ok) throw new Error(`${r.status} ${json.error}`);
      return json as DropSession;
    };
    let closed!: () => void;
    const serverClosed = new Promise<void>((r) => { closed = r; });
    const closes: string[] = [];
    let added = 0;
    const server: DropServer = {
      open: () => call('POST', '/api/drop'),
      add: async (id, f) => {
        const s = await call('POST', `/api/drop/${id}/files?name=${encodeURIComponent(f.name)}`, new Uint8Array(await f.arrayBuffer()));
        if (++added === 5) store.close();
        return s;
      },
      close: async (id) => { closes.push(id); await call('DELETE', `/api/drop/${id}`); closed(); },
    };
    const store = dropStore(server, (e) => (e as Error).message, (f) => (f.length ? f.map((x) => `${x.name}: ${String(x.error)}`).join(', ') : undefined));
    const seen: Array<string | undefined> = [];
    store.subscribe(() => { seen.push(store.get().session?.id); });

    const first = await Promise.all(Array.from({ length: 30 }, (_, i) => invoice(i)));
    await store.drop(first);
    const dead = closes[0];
    await serverClosed;
    assert.equal(closes.length, 1, 'the closed session is closed on the server once, after its last file');
    assert.ok(dead, 'the first session was closed');
    const afterClose = seen.slice(seen.lastIndexOf(undefined));
    assert.ok(!afterClose.includes(dead), 'no late answer of the closed drop puts its session back into the window');
    assert.deepEqual(store.get(), { open: false, session: undefined, adding: 0, note: undefined, error: undefined }, 'the window stays closed and empty');

    const second = await Promise.all([30, 31].map(invoice));
    await store.drop(second);
    const now = store.get();
    assert.notEqual(now.session?.id, dead, 'the next drop opens a new session');
    assert.deepEqual(now.session?.rows.map((r) => [r.name, r.state]), [['f-30.pdf', 'taken'], ['f-31.pdf', 'taken']], 'the new session holds only its own files, taken');
    assert.equal(now.error, undefined, 'no file failed');
    store.close();
    await rest();

    const all = Array.from({ length: 32 }, (_, i) => `f-${i}.pdf`).sort();
    const ours = (names: string[]) => names.filter((n) => /^f-\d+/.test(n)).sort();
    assert.deepEqual(ours(readdirSync(join(api.root, 'beleg-import'))), all, 'every file went into the inbox, none twice');
    assert.deepEqual(ours((await books()).receipts.map((r) => r.filename)), all, 'the run took every file as one receipt');
    for (let i = 0; i < 50 && existsSync(join(api.root, 'data/drop')) && readdirSync(join(api.root, 'data/drop')).length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(existsSync(join(api.root, 'data/drop')) ? readdirSync(join(api.root, 'data/drop')) : [], [], 'no session is left open on the server');
  } finally {
    await rest().catch(() => {});
    await api.stop();
  }
});
