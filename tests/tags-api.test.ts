/**
 * Reporting dimensions at the API (#127): Firma › Dimensionen declares them, a person sets and
 * clears a booking's tags (on a change, a new booking, each line of a payment booked by hand), a
 * filed booking's tags never change, a dimension bookings carry is not taken out, and a custom
 * report groups by one. Runs the real API server on a copy of tests/fixtures/period-lock-index.json
 * (closedThrough 2026-06-30: jc closed, jo open, OI an unbooked payment in).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json'); });
after(() => api?.stop());

const entryOf = (id: string) => loadBooks(api.ws).journalEntries.find((e) => e.id === id);
const DIMENSIONS = [
  { id: 'projekt', label: 'Projekt', values: [{ value: 'alpha', label: 'Website Alpha', active: true }] },
  { id: 'standort', label: 'Standort', values: [] },
];

test('a firm without dimensions takes no tags: a booking naming one is refused with the dimension', async () => {
  const r = await api.send('PATCH', '/api/journal-entries/jo', { tags: { projekt: 'alpha' } });
  assert.equal(r.status, 400);
  assert.deepEqual([r.json.code, r.json.params], ['tagDimension', { dimension: 'projekt' }]);
  assert.equal(entryOf('jo')?.tags, undefined);
});

test('Firma › Dimensionen declares the dimensions; /api/workspace answers them', async () => {
  const r = await api.send('PATCH', '/api/workspace', { dimensions: DIMENSIONS });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.dimensions, DIMENSIONS);
});

test('a person sets a booking\'s tags, a new value included; the booking is hers from then on; null clears them', async () => {
  const r = await api.send('PATCH', '/api/journal-entries/jo', { tags: { projekt: 'alpha', standort: 'Neu-Ort' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(entryOf('jo')?.tags, { projekt: 'alpha', standort: 'Neu-Ort' });
  assert.equal(entryOf('jo')?.origin, 'manual', 'classify --force keeps it, and the tags with it');
  assert.equal(entryOf('jo')?.vatCode, 'I81', 'no figure moved');
  assert.equal((await api.send('PATCH', '/api/journal-entries/jo', { tags: { kunde: 'x' } })).json.code, 'tagDimension');
  assert.equal((await api.send('PATCH', '/api/journal-entries/jo', { tags: null })).status, 200);
  assert.equal(entryOf('jo')?.tags, undefined);
  assert.equal((await api.send('PATCH', '/api/journal-entries/jo', { tags: { projekt: 'alpha' } })).status, 200);
});

test('a filed booking\'s tags are part of the sealed record: a change is refused as any change of it', async () => {
  const r = await api.send('PATCH', '/api/journal-entries/jc', { tags: { projekt: 'alpha' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'periodClosed');
  assert.equal(entryOf('jc')?.tags, undefined);
});

test('a new booking and each line of a payment booked by hand carry their own tags', async () => {
  const made = await api.send('POST', '/api/journal-entries', { date: '2026-08-12', accountDebit: '6500', accountCredit: '1021', amount: 12, description: 'Druck', tags: { projekt: 'alpha' } });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.deepEqual(entryOf((made.json.entry as { id: string }).id)?.tags, { projekt: 'alpha' });
  const lines = [
    { accountDebit: '1021', accountCredit: '3200', amount: 100, description: 'Teil Alpha', tags: { projekt: 'alpha' } },
    { accountDebit: '1021', accountCredit: '3200', amount: 8.1, description: 'Teil ohne' },
  ];
  const booked = await api.send('POST', '/api/transactions/OI/entries', { lines });
  assert.equal(booked.status, 200, JSON.stringify(booked.json));
  const ids = (booked.json.entries as Array<{ id: string }>).map((e) => e.id);
  assert.deepEqual(ids.map((id) => entryOf(id)?.tags), [{ projekt: 'alpha' }, undefined]);
});

test('a dimension bookings carry is not taken out; one no booking carries is', async () => {
  const r = await api.send('PATCH', '/api/workspace', { dimensions: [DIMENSIONS[1]] });
  assert.equal(r.status, 400);
  assert.deepEqual([r.json.code, (r.json.params as { entries: number }).entries], ['dimensionInUse', 3]);
  const ok = await api.send('PATCH', '/api/workspace', { dimensions: [DIMENSIONS[0]] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('a custom report groups the bookings by a dimension, the value\'s label as its heading', async () => {
  const spec = { title: 'Projekte', period: '2026-08', sections: [{ source: 'entries', filter: { accounts: ['3000-6999'] }, group: 'tag:projekt' }] };
  const r = await api.send('POST', '/api/reports/run', { spec });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const groups = (r.json.result as { sections: Array<{ groups: Array<{ key: string; label: string; totals: Array<{ amount: number }> }> }> }).sections[0].groups;
  assert.deepEqual(groups.map((g) => [g.key, g.label]), [['alpha', 'Website Alpha'], ['', '']]);
  const refused = await api.send('POST', '/api/reports/run', { spec: { ...spec, sections: [{ ...spec.sections[0], group: 'tag:kunde' }] } });
  assert.equal(refused.status, 400);
});
