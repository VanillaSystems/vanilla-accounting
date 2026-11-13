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
import { addEach, booksMoved, dropStart, dropStore, failedLine } from '../src/app/shell/drop-upload.js';
import { formatIn } from '../src/app/i18n/core.js';
import de from '../src/app/i18n/locales/de.js';
import type { DropRow, DropSession } from '../src/types/drop.js';

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

// #424: the window's answers that wrote the books make every page load them again.
const row = (key: string, extra: Partial<DropRow> = {}): DropRow => ({ key, id: key, name: `${key}.csv`, size: 1, state: 'take', ...extra });
const session = (...rows: DropRow[]): DropSession => ({ id: 's1', rows });
const report = { provider: 'Shopify' } as unknown as DropRow['report'];

test('booksMoved: a report booked, payouts booked by an answer, a statement read or kept, a taken row taken back; not a receipt handed to the inbox or a question', () => {
  const asks = row('orders', { state: 'unclear', reason: 'provider-account' });
  assert.equal(booksMoved(undefined, session(asks)), false, 'a question writes nothing');
  assert.equal(booksMoved(session(asks), session({ ...asks, payouts: { provider: 'Shopify', booked: 40, of: 40 } })), true, 'her answer booked the payouts');
  const booked = row('orders', { state: 'taken', report });
  assert.equal(booksMoved(session(asks), session(booked)), true, 'the report booked');
  assert.equal(booksMoved(session(booked), session(booked)), false, 'the same answer again');
  assert.equal(booksMoved(session(booked), session(booked, row('b', { state: 'taken', inbox: 'b.pdf', run: 'r1' }))), false, 'a receipt into the inbox: its run says when it wrote');
  assert.equal(booksMoved(session(), session(row('pdf', { state: 'taken', keep: { month: '2026-09' }, statement: { file: 'LUKB/a.pdf', refs: [], account: '1020' } }))), true, 'a statement kept');
  assert.equal(booksMoved(session(booked), session({ ...booked, state: 'refused', report: undefined })), true, 'taken back');
});

test('booksMoved: a statement PDF kept with its question (#254) that leaves the books, by «Ist ein Beleg» or ×, and a provider\'s question answered', () => {
  const kept = row('pdf', { state: 'asks', reason: 'check-read', account: '1020', asked: { file: 'LUKB/Kontoauszug 01.07.2026 - 30.09.2026.pdf', month: '2026-09' } });
  assert.equal(booksMoved(session(kept), session({ ...kept, state: 'take', reason: undefined, asked: undefined })), true, '«Ist ein Beleg»: the statement and its question left the books');
  assert.equal(booksMoved(session(kept), session()), true, '×: the row is gone with them');
  const clearing = row('orders', { state: 'unclear', reason: 'provider-account', askProvider: { provider: 'shopify', name: 'Shopify', missing: 'clearing' } as DropRow['askProvider'] });
  const fees = row('fees', { state: 'unclear', reason: 'provider-account', askProvider: { provider: 'shopify', name: 'Shopify', missing: 'clearing' } as DropRow['askProvider'] });
  assert.equal(booksMoved(undefined, session(clearing, fees)), false, 'a question asked writes nothing');
  assert.equal(booksMoved(session(clearing, fees), session({ ...clearing, state: 'refused', askProvider: undefined }, { ...fees, askProvider: { ...fees.askProvider!, missing: 'fees' } })), true, 'her answer kept the clearing account in the chart and the provider\'s file');
});

test('dropStore tells `moved` for an add, a row\'s answer and the close that wrote the books, also for a closed window\'s files going on', async () => {
  let n = 0;
  let next: DropSession = session();
  const server = { open: async () => session(), add: async () => next, close: async () => ({ ok: true }) };
  const store = dropStore(server, String, () => undefined, () => { n++; });
  next = session(row('a', { state: 'unclear', reason: 'provider-account' }));
  await store.drop([new File(['x'], 'a.csv')]);
  assert.equal(n, 0, 'a question: nothing written');
  store.answered(session(row('a', { state: 'taken', report })));
  assert.equal(n, 1, 'her answer booked the report');
  // Closed while a file still uploads: its answer still counts, and so does the close that takes what waits.
  next = session(row('a', { state: 'taken', report }), row('s', { state: 'taken', statement: { file: 'LUKB/s.xml', refs: ['r'], account: '1020' } }));
  const going = store.drop([new File(['y'], 's.xml')]);
  store.close();
  await going;
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(n, 3, 'the statement read in the background, then the close');
});
