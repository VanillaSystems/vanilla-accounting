/**
 * The drop window's uploads (src/app/shell/drop-upload.ts, #194): one file the server refuses no
 * longer stops the files after it, and the window names how many failed and why; a new drop shows
 * its own note, never the one of the drop before it.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApi } from './support/api-server.js';
import { SESSION } from './support/inbox-run.js';
import { textPdf } from './support/text-pdf.js';
import { addEach, dropStart, failedLine } from '../src/app/shell/drop-upload.js';
import { formatIn } from '../src/app/i18n/core.js';
import de from '../src/app/i18n/locales/de.js';
import type { DropSession } from '../src/types/drop.js';

const invoice = (i: number) => textPdf(['Malerbedarf Muster AG', `Rechnung R-66${i}`, `Datum: 1${i}.11.2026`, `Pinsel ${100 + i}.00`, `Total CHF ${(108.1 + i).toFixed(2)}`]);

test('an empty file in the middle of a drop: every other file is uploaded, the empty one named with the server\'s reason', async () => {
  const api = await startApi('demo');
  const { post, rest } = SESSION(api);
  try {
    let session = await post('/api/drop');
    const files = [new File([new Uint8Array(await invoice(1))], 'a.pdf'), new File([], 'leer.pdf'), new File([new Uint8Array(await invoice(2))], 'b.pdf'), new File([new Uint8Array(await invoice(3))], 'c.pdf')];
    const add = async (f: File): Promise<DropSession> => {
      const r = await api.fetch(`/api/drop/${session.id}/files?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: new Uint8Array(await f.arrayBuffer()), headers: { 'Content-Type': 'application/octet-stream' } });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error);
      return json as DropSession;
    };
    const failed = await addEach(files, add, (s) => { session = s; });
    assert.deepEqual(session.rows.map((r) => r.name), ['a.pdf', 'b.pdf', 'c.pdf'], 'the files after the failed one went on');
    const line = failedLine(failed, (e) => (e as Error).message)!;
    assert.equal(formatIn({ code: 'de', ...de }, line.key, line.vars), '1 Datei nicht hochgeladen: leer.pdf (Keine Datei erhalten.)');
  } finally {
    await rest().catch(() => {});
    await api.stop();
  }
});

test('all files uploaded: no line', () => {
  assert.equal(failedLine([], String), undefined);
});

test('a new drop clears the note of the drop before it and keeps its own', () => {
  assert.equal(dropStart().note, undefined, 'a drop without a note shows none');
  assert.equal(dropStart('').note, undefined);
  assert.equal(dropStart('höchstens 2000 pro Ablage').note, 'höchstens 2000 pro Ablage');
  let state: { note?: string } = { note: 'old' };
  state = { ...state, ...dropStart() };
  assert.equal(state.note, undefined, 'the old note is overwritten, not kept by a missing key');
});
