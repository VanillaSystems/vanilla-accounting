/**
 * One sentence to the AI sidebar never rebooks the books without the person seeing it (persona
 * round 5, x02: «alles wo karte 5412 steht ist geschäftlich material, immer auf 4000» moved seven
 * bookings of four kinds at once). On the real API server with the claude stub answering the x02
 * block, on the persona's payments (tests/fixtures/x02-index.json): the answer is held as one card,
 * booking by booking, until «Übernehmen»; the rule card it drafted judges its width against the
 * bookings as they were before; the AI is recorded as the author; small fixes still apply at once.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { loadBooks, saveBooks, type Books } from '../src/books/store.js';
import { setEntry } from '../src/server/edits.js';
import { parseBookedBy } from '../src/books/booked-by.js';
import { DEMO_ROOT } from './support/workspace.js';
import type { AssistantEvent, HeldChanges, MadeChange, Turn } from '../src/types/assistant.js';
import type { Index, JournalEntry } from '../src/types/index.js';

const REPO = process.cwd();
const fixture = JSON.parse(readFileSync('tests/fixtures/x02-index.json', 'utf8')) as Required<Pick<Index, 'receipts' | 'transactions' | 'mappings'>> & { journalEntries: JournalEntry[] };
const RULES = 'knowledge/rules/booking.guide.yaml';
const RULE = `process: booking\nsteps:\n  classify:\n    rules:\n      - { id: karte-5412-material, when: { text: "Karte 5412", direction: out }, then: { account: "4000", vat: M81 }, source: wish 2026-10-16, why: "Karte 5412 ist geschäftlich Material" }\n`;

/** The x02 answer's block, as the round-5 books diff shows it (x02a). */
const X02 = [
  { kind: 'account', number: '4000', name: 'Materialaufwand' },
  { kind: 'entry', id: 'ceff9000e3272a36', set: { accountDebit: '4000', vatCode: 'M81' } },
  { kind: 'entry', id: '53c21b50cd7a2f93', set: { accountDebit: '4000', vatCode: 'M81' } },
  { kind: 'entry', id: '84c5e166ef208d7e', set: { accountDebit: '4000', vatCode: 'M81' } },
  { kind: 'entry', id: 'e7a8aa7bc784fea9', set: { accountDebit: '4000', vatCode: 'M0' } },
  { kind: 'entry', id: '881b7f3645e66a68', set: { accountDebit: '4000', vatCode: 'M81' } },
  { kind: 'entry', id: '8cf320dcaef01a0a', set: { accountDebit: '4000', vatCode: 'M81' } },
  { kind: 'entry', id: 'c66961564d906314', set: { accountDebit: '4000', vatCode: 'M81' } },
];

let api: ApiServer;
let dir: string;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wish-safety-'));
  api = await startApi('demo/vanilla-accounting', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: join(dir, 'changes.json') });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  const chart = JSON.parse(readFileSync(api.ws.paths.accounts, 'utf8')) as Array<{ number: string; name: string }>;
  chart.push({ number: '1510', name: 'Werkzeuge' }, { number: '4400', name: 'Materialeinkauf' }, { number: '6641', name: 'Kundenbewirtung' });
  writeFileSync(api.ws.paths.accounts, JSON.stringify(chart, null, 2));
  // The rules read the chart from the prior-year export the test server writes (src/booking/classify.ts chartOf).
  appendFileSync(join(api.ws.paths.history, 'prior-year.Konten.txt'), ['1510\tWerkzeuge', '4000\tMaterialaufwand', '4400\tMaterialeinkauf', '6100\tUnterhalt', '6200\tFahrzeugaufwand', '6641\tKundenbewirtung', ''].join('\n'));
  const b = loadBooks(api.ws);
  b.receipts.push(...fixture.receipts);
  b.transactions.push(...fixture.transactions);
  b.mappings.push(...fixture.mappings);
  b.journalEntries.push(...fixture.journalEntries);
  saveBooks(api.ws, b);
  const draft = join(api.ws.paths.data, 'draft', RULES);
  mkdirSync(dirname(draft), { recursive: true });
  writeFileSync(draft, RULE);
});
after(() => { api?.stop(); rmSync(dir, { recursive: true, force: true }); });

const ids = new Set(fixture.journalEntries.map((e) => e.id));
const persona = () => loadBooks(api.ws).journalEntries.filter((e) => ids.has(e.id)).sort((a, b) => a.id.localeCompare(b.id));
const accountName = (n: string) => (JSON.parse(readFileSync(api.ws.paths.accounts, 'utf8')) as Array<{ number: string; name: string }>).find((a) => a.number === n)?.name;

async function answer(asked: unknown, conversation?: string) {
  writeFileSync(join(dir, 'changes.json'), JSON.stringify(asked));
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ text: 'alles wo karte 5412 steht ist geschäftlich material, immer auf 4000', language: 'de', context: [], ...(conversation ? { conversation } : {}) }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  return {
    conversation: (events[0] as { id: string }).id,
    held: (events.find((e) => e.type === 'held') as Extract<AssistantEvent, { type: 'held' }> | undefined)?.held,
    made: (events.find((e) => e.type === 'changes') as Extract<AssistantEvent, { type: 'changes' }> | undefined)?.changes,
    refused: events.find((e) => e.type === 'refused'),
  };
}
const settle = async (conversation: string, take: boolean) => api.send('POST', `/api/assistant/${conversation}/held/1`, { take, language: 'de' });
const draft = async () => (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(RULES)}`)).json as unknown as { confirm: boolean; spread: unknown[]; preview: Array<{ examples: Array<{ ref: string; now: Array<{ account: string }>; beforeAi?: Array<{ account: string }> }> }> };
const undoAll = async (conversation: string, made: MadeChange[]) => {
  for (const m of [...made].reverse()) {
    const r = await api.send('POST', `/api/assistant/${conversation}/changes/${m.id}/undo`);
    assert.equal(r.status, 200, String(r.json.error));
  }
};

test('the x02 answer is held: nothing changes, the card lists each booking before → after and why', async () => {
  const start = persona();
  const a = await answer(X02);
  assert.equal(a.refused, undefined);
  assert.equal(a.made, undefined, 'no change was made');
  assert.ok(a.held, 'the answer is held');
  assert.deepEqual(a.held.why, ['payments']);
  assert.equal(a.held.status, 'held');
  assert.deepEqual(persona(), start, 'the bookings are as they were');
  assert.equal(accountName('4000'), 'Rohkaffee', 'nor the chart');
  const rows = new Map(a.held.rows.map((r) => [r.entry, r]));
  assert.equal(rows.size, 7);
  assert.deepEqual([rows.get('881b7f3645e66a68')!.before, rows.get('881b7f3645e66a68')!.after], [
    { accountDebit: '6641', accountCredit: '1021', vatCode: 'I81', amount: 45.5 },
    { accountDebit: '4000', accountCredit: '1021', vatCode: 'M81', amount: 45.5 },
  ], 'the restaurant meal, as it is and as it would be');
  assert.equal(rows.get('53c21b50cd7a2f93')!.before!.accountDebit, '1510', 'the ladder booked as an asset');
  assert.deepEqual([...rows.values()].filter((r) => r.noReceipt).map((r) => r.entry), ['8cf320dcaef01a0a'], 'the Baucenter entry without a receipt says M81 without proof');
  const turn = (await api.send('GET', `/api/assistant/${a.conversation}`)).json as unknown as { turns: Turn[] };
  assert.equal((turn.turns[1] as Extract<Turn, { role: 'ai' }>).held?.status, 'held', 'stored with the conversation');
});

test('the rule card judges its width on the bookings as they were before the answer, before and after «Übernehmen»', async () => {
  const held = await draft();
  assert.equal(held.confirm, true, '«Trotzdem behalten», not «Behalten»');
  assert.equal(held.spread.length, 1);

  const a = await answer(X02);
  const taken = await settle(a.conversation, true);
  assert.equal(taken.status, 200, String(taken.json.error));
  const turn = taken.json as unknown as Extract<Turn, { role: 'ai' }> & { held: HeldChanges };
  assert.equal(turn.held.status, 'taken');
  assert.equal(turn.changes?.length, 8);
  assert.ok(persona().every((e) => e.accountDebit === '4000'), 'made on «Übernehmen»');
  const ladder = persona().find((e) => e.id === '53c21b50cd7a2f93')!;
  assert.deepEqual(ladder.by && { ...ladder.by, at: '' }, { kind: 'assistant', at: '', conversation: a.conversation, was: { accountDebit: '1510', vatCode: 'I81' } });

  const after = await draft();
  assert.equal(after.confirm, true, 'the moved bookings do not make the rule look narrow');
  const tank = after.preview[0].examples.find((x) => x.ref === 'RB-2026-0011')!;
  assert.deepEqual([tank.now.map((l) => l.account), tank.beforeAi?.map((l) => l.account)], [['4000'], ['6200']]);

  await undoAll(a.conversation, turn.changes!);
  assert.equal(accountName('4000'), 'Rohkaffee');
  assert.deepEqual(persona().map((e) => [e.accountDebit, e.vatCode, e.by?.kind]), fixture.journalEntries.sort((x, y) => x.id.localeCompare(y.id)).map((e) => [e.accountDebit, e.vatCode, e.by?.kind]), 'every booking back as it was');
});

test('«Verwerfen» changes nothing, and a settled card stays settled', async () => {
  const start = persona();
  const a = await answer(X02);
  const dropped = await settle(a.conversation, false);
  assert.equal((dropped.json as unknown as { held: HeldChanges }).held.status, 'dropped');
  const again = await settle(a.conversation, true);
  assert.equal((again.json as unknown as { held: HeldChanges }).held.status, 'dropped');
  assert.deepEqual(persona(), start);
});

test('a fix of one booking, or of two payments on the same account, is made at once, as the AI\'s', async () => {
  const one = await answer([{ kind: 'entry', id: 'ceff9000e3272a36', set: { description: 'Tankstelle Wil Ost, Diesel Lieferwagen' } }]);
  assert.equal(one.held, undefined);
  assert.equal(one.made?.length, 1);
  await undoAll(one.conversation, one.made!);

  const two = await answer([{ kind: 'entry', id: 'ceff9000e3272a36', set: { accountDebit: '6100' } }, { kind: 'entry', id: 'e7a8aa7bc784fea9', set: { accountDebit: '6100' } }]);
  assert.equal(two.held, undefined, 'both fuel payments were on 6200');
  assert.equal(two.made?.length, 2);
  assert.ok(persona().filter((e) => e.accountDebit === '6100').every((e) => e.by?.kind === 'assistant'));
  await undoAll(two.conversation, two.made!);
});

test('deleting more than one booking is held', async () => {
  const a = await answer([{ kind: 'deleteEntry', id: '53c21b50cd7a2f93' }, { kind: 'deleteEntry', id: '84c5e166ef208d7e' }, { kind: 'newEntry', entry: { transactionRef: 'RB-2026-0004', date: '2026-07-08', accountDebit: '4400', accountCredit: '1021', amount: 312.9, vatCode: 'M81', description: 'Baucenter neu' } }]);
  assert.equal(a.made, undefined);
  assert.deepEqual(a.held?.why, ['deletes']);
  assert.deepEqual(a.held?.rows.map((r) => [!!r.before, !!r.after]).sort(), [[false, true], [true, false], [true, false]]);
});

test('a rate code set on a payment without a receipt that shows Swiss VAT is held and says so', async () => {
  const a = await answer([{ kind: 'entry', id: 'e7a8aa7bc784fea9', set: { vatCode: 'I81' } }]);
  assert.equal(a.made, undefined);
  assert.deepEqual(a.held?.why, ['rateWithoutReceipt']);
  assert.equal(a.held?.rows[0].noReceipt, true);
});

test('a direct change that leaves a rate code without proof says so on its card', async () => {
  const a = await answer([{ kind: 'entry', id: '8cf320dcaef01a0a', set: { description: 'Abdeckfolie, Pinsel' } }]);
  assert.equal(a.held, undefined);
  assert.equal(a.made?.[0].note?.noReceipt, true);
  await undoAll(a.conversation, a.made!);
});

test('the AI changing what it changed before keeps the fields as first decided; a code set to what it was names no change; the books read the author back', () => {
  const books = { ...JSON.parse(JSON.stringify(fixture)), bankStatements: [] } as Books;
  const ai = { kind: 'assistant', conversation: 'c1' } as const;
  setEntry(books, 'ceff9000e3272a36', { accountDebit: '4000' }, ai);
  setEntry(books, 'ceff9000e3272a36', { accountDebit: '4400', vatCode: 'M81' }, ai);
  const e = books.journalEntries.find((x) => x.id === 'ceff9000e3272a36')!;
  assert.deepEqual(e.by && { ...e.by, at: '' }, { kind: 'assistant', at: '', conversation: 'c1', was: { accountDebit: '6200', vatCode: 'I81' } });
  assert.deepEqual(parseBookedBy(JSON.parse(JSON.stringify(e.by))), e.by);
  setEntry(books, 'e7a8aa7bc784fea9', { vatCode: 'I0' });
  const same = books.journalEntries.find((x) => x.id === 'e7a8aa7bc784fea9')!;
  assert.deepEqual([same.by?.kind, same.by && 'was' in same.by ? same.by.was : undefined], ['person', undefined], '«MWST I0 → I0» is no change');
});
