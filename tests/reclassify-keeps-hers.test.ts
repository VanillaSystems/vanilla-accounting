/**
 * A person's booking (by hand, or by a wish in the AI sidebar: origin manual) is never replaced by
 * the classifier without her say. The UI's «Neu klassifizieren» asks first: the route refuses
 * without `overwrite`, and the batch paths (classify, classify --force, a receipt linked later)
 * leave such a payment alone. Persona test «misreads» 2026-10-15, findings 10, 11 and 19.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, saveBooks, update, PERSON, moduleActor, type Books } from '../src/books/store.js';
import { classifyStep } from '../src/intake/classify.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { AssistantEvent } from '../src/types/assistant.js';
import { startApi } from './support/api-server.js';
import { DEMO_ROOT, booksOnDisk } from './support/workspace.js';
import './support/jurisdiction.js';

const REPO = process.cwd();
const stubPath = `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`;
const entriesOf = (books: Books, ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref);

test('«Neu klassifizieren» keeps a booking set by hand unless the person says to overwrite it', async () => {
  const api = await startApi('tests/fixtures/classify-index.json', { PATH: stubPath });
  try {
    const patched = await api.send('PATCH', '/api/journal-entries/jw', { vatCode: 'I81' });
    assert.equal(patched.status, 200, String(patched.json.error));
    const before = JSON.stringify(booksOnDisk(api.ws));

    const asked = await api.send('POST', '/api/journal-entries/classify/W1');
    assert.equal(asked.status, 409);
    assert.deepEqual([asked.json.code, asked.json.params], ['personsBooking', { entries: 1 }]);
    assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'without overwrite: books byte-identical');

    const kept = await api.send('POST', '/api/journal-entries/classify/W1', { overwrite: false });
    assert.equal(kept.status, 409);

    const anew = await api.send('POST', '/api/journal-entries/classify/W1', { overwrite: true });
    assert.equal(anew.status, 200, String(anew.json.error));
    const now = entriesOf(loadBooks(workspaceAt(api.ws.paths.root)) as Books, 'W1');
    assert.deepEqual(now.map((e) => [e.origin, e.vatCode]), [['classify', 'I81']]);
  } finally {
    api.stop();
  }
});

test('a change made by a wish in the AI sidebar is hers too: «Neu klassifizieren» asks before replacing it', async () => {
  const changes = join(mkdtempSync(join(tmpdir(), 'reclassify-wish-')), 'changes.json');
  const api = await startApi('tests/fixtures/classify-index.json', { PATH: stubPath, CLAUDE_STUB_CHANGES: changes });
  try {
    writeFileSync(changes, JSON.stringify([{ kind: 'entry', id: 'jw', set: { vatCode: 'I81' } }]));
    const res = await fetch(`http://127.0.0.1:${api.port}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'bitte mit Vorsteuer', language: 'de', context: [] }) });
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
    assert.ok(events.some((e) => e.type === 'changes'), JSON.stringify(events.at(-1)));
    const wished = entriesOf(loadBooks(workspaceAt(api.ws.paths.root)) as Books, 'W1');
    assert.deepEqual(wished.map((e) => [e.vatCode, e.origin]), [['I81', 'manual']]);

    const asked = await api.send('POST', '/api/journal-entries/classify/W1');
    assert.equal(asked.status, 409);
    assert.deepEqual(entriesOf(loadBooks(workspaceAt(api.ws.paths.root)) as Books, 'W1'), wished);
  } finally {
    api.stop();
  }
});

test('«Neu klassifizieren» books the Skonto answer balanced, and refuses an answer that does not add up', async () => {
  const skonto = { W1: { entries: [
    { accountDebit: '4400', accountCredit: '', amount: 51.02, vatCode: 'M81', description: 'Shop EU, Material' },
    { accountDebit: '', accountCredit: '4400', amount: 1.02, vatCode: '-M81', description: 'Shop EU, Skonto 2 %' },
  ] } };
  const api = await startApi('tests/fixtures/classify-index.json', { PATH: stubPath, CLAUDE_STUB_CLASSIFY: JSON.stringify(skonto) });
  try {
    const { status, json } = await api.send('POST', '/api/journal-entries/classify/W1');
    assert.equal(status, 200, String(json.error));
    const booked = entriesOf(loadBooks(workspaceAt(api.ws.paths.root)) as Books, 'W1');
    assert.deepEqual(booked.map((e) => [e.accountDebit, e.accountCredit, e.amount]).sort(), [['1023', '4400', 1.02], ['4400', '1023', 51.02]]);
  } finally {
    api.stop();
  }

  const short = { W1: { entries: [{ accountDebit: '4400', accountCredit: '', amount: 51.02, vatCode: 'M81', description: 'Shop EU, Material' }] } };
  const api2 = await startApi('tests/fixtures/classify-index.json', { PATH: stubPath, CLAUDE_STUB_CLASSIFY: JSON.stringify(short) });
  try {
    const before = JSON.stringify(booksOnDisk(api2.ws));
    const { status, json } = await api2.send('POST', '/api/journal-entries/classify/W1');
    assert.equal(status, 422);
    assert.deepEqual([json.code, json.params], ['classifyBalance', { date: '2026-08-14', currency: 'EUR', paid: 50, booked: 51.02 }]);
    assert.ok(JSON.stringify(booksOnDisk(api2.ws)) === before, 'a refused answer: books byte-identical');
  } finally {
    api2.stop();
  }
});

/**
 * A copy of the demo with two open payments booked by the classifier before a receipt came (so a
 * batch run books them again), one of them since corrected by hand.
 */
function demoWithHers() {
  const dir = mkdtempSync(join(tmpdir(), 'reclassify-batch-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const books = loadBooks(ws);
  const onlyClassify = (ref: string) => {
    const group = books.journalEntries.filter((e) => e.transactionRef === ref);
    return group.length > 0 && group.every((e) => (e.origin ?? 'classify') === 'classify');
  };
  const [hers, theirs] = books.transactions.filter((t) => t.date > (books.config.closedThrough ?? '') && onlyClassify(t.ref));
  update(books, PERSON, (b) => {
    for (const x of b.journalEntries.filter((y) => y.transactionRef === hers.ref || y.transactionRef === theirs.ref)) Object.assign(x, { origin: 'classify', receipts: ['not-linked'] });
    const mine = b.journalEntries.find((x) => x.transactionRef === hers.ref)!;
    Object.assign(mine, { description: 'von Hand korrigiert', origin: 'manual' });
  });
  saveBooks(ws, books);
  return { ws, hers: hers.ref, theirs: theirs.ref };
}

/** The model books every payment it is asked for anew: out on 6570, in on 3200. */
const ask: Ask = async (prompt) => {
  const asked = [...prompt.matchAll(/^### Transaction \d+: (\S+)\n {2}Date: \S+ \| Amount: (-?[\d.]+) \S+ \| Direction: (\w+)/gm)];
  return JSON.stringify(Object.fromEntries(asked.map(([, ref, amount, direction]) => [ref, { entries: [
    direction === 'DBIT'
      ? { accountDebit: '6570', accountCredit: '', amount: Number(amount), vatCode: 'I0', description: 'Stub, neu' }
      : { accountDebit: '', accountCredit: '3200', amount: Number(amount), vatCode: 'V0', description: 'Stub, neu' },
  ] }])));
};

for (const force of [false, true]) {
  test(`the intake book step ${force ? 'with --force ' : ''}leaves a payment holding a person's booking as it is`, async () => {
    const { ws, hers, theirs } = demoWithHers();
    const before = entriesOf(loadBooks(ws), hers);
    await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask, steps: [['classify', classifyStep({ force })]] });
    const after = loadBooks(ws);
    assert.deepEqual(entriesOf(after, hers), before, 'her payment untouched');
    assert.deepEqual(entriesOf(after, theirs).map((e) => e.description), ['Stub, neu'], 'classify\'s own payment booked again');
  });
}
