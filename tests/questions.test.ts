/**
 * Questions between the accountant and the owner (src/server/questions.ts) on the real API server
 * and a temp copy of tests/fixtures/questions-index.json: asked, listed for the right person,
 * answered; «privat» books the payment on the owner's account and becomes a precedent that answers
 * the next question about the same counterparty; undo, close, a filed quarter; and the questions
 * live in the books folder, read again by another process and by a copy of the folder.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startApi, type ApiServer } from './support/api-server.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { readQuestions } from '../src/questions/store.js';
import { askedByMe, fold, forMe, type Question, type QuestionLine } from '../src/questions/model.js';
import { isGenericText } from '../src/knowledge/payer.js';
import { GITATTRIBUTES } from '../src/workspace/scaffold.js';

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/questions-index.json');
  // The first look at the automation takes what the workspace runs today as switched on (the baseline).
  await api.send('GET', '/api/automation');
});
after(() => api?.stop());

const MONIKA = 'Monika Frei';
const OWNER = 'Anna Muster';
const ask = async (on: { kind: string; id: string }, choices: string[] = ['private', 'business'], text = 'Privat oder geschäftlich?') => {
  const r = await api.send('POST', '/api/questions', { on, by: MONIKA, text, choices });
  assert.equal(r.status, 200, String(r.json.error));
  return r.json as unknown as Question;
};
const entriesOf = (ref: string) => loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === ref);
const list = async () => (await api.send('GET', '/api/questions')).json as unknown as { questions: Question[]; people: string[]; owner: string };

test('asked: listed for the owner as a question to him, for the accountant as hers, stored in the year folder', async () => {
  const q = await ask({ kind: 'payment', id: 'P1' });
  assert.equal(q.status, 'open');
  const { questions, people, owner } = await list();
  assert.deepEqual(questions.map((x) => x.id), [q.id]);
  assert.deepEqual(people, [OWNER, MONIKA]);
  assert.match(owner, /^2451 /);
  assert.deepEqual(forMe(questions, OWNER).map((x) => x.id), [q.id], 'the owner sees it under «Fragen an dich»');
  assert.deepEqual(forMe(questions, MONIKA), [], 'not a question to the one who asked it');
  assert.deepEqual(askedByMe(questions, MONIKA).map((x) => x.id), [q.id]);
  assert.ok(existsSync(join(api.root, 'transactional-data/2026/questions.jsonl')));
  assert.equal(entriesOf('P1')[0].accountDebit, '6700', 'asking books nothing');
});

test('«privat» books the payment on the owner\'s account without VAT code and is kept as a precedent', async () => {
  const [q] = (await list()).questions;
  const r = await api.send('POST', `/api/questions/${q.id}/answer`, { by: OWNER, choice: 'private' });
  assert.equal(r.status, 200, String(r.json.error));
  const answered = r.json as unknown as Question;
  assert.equal(answered.status, 'answered');
  assert.deepEqual(answered.answer?.acted && 'booked' in answered.answer.acted ? answered.answer.acted.booked : [], ['e1']);
  const [e] = entriesOf('P1');
  assert.deepEqual([e.accountDebit, e.accountCredit, e.vatCode, e.origin], ['2451', '1021', undefined, 'manual']);
  const guide = parse(readFileSync(join(api.root, 'knowledge/rules/booking.guide.yaml'), 'utf8')) as { steps: { private: { precedents: Array<Record<string, unknown>> } } };
  const [p] = guide.steps.private.precedents;
  assert.deepEqual([p.choice, p.match, p.by, p.question], ['private', { tx: 'coopprontobern' }, OWNER, q.id]);
  const automation = (await api.send('GET', '/api/automation')).json as unknown as { pending: Array<{ workflow: string }> };
  assert.deepEqual(automation.pending, [], 'the precedent the answer kept leaves no workflow waiting to be switched on (r6h-24)');
  assert.deepEqual(forMe((await list()).questions, OWNER), [], 'answered: no longer waiting for the owner');
  assert.equal(askedByMe((await list()).questions, MONIKA)[0].status, 'answered', 'shown to the asker as answered');
  const again = await api.send('POST', `/api/questions/${q.id}/answer`, { by: OWNER, choice: 'business' });
  assert.deepEqual([again.status, again.json.code], [409, 'questionAnswered']);
});

test('the next question about the same counterparty is answered by the precedent: booked, nobody asked', async () => {
  const q = await ask({ kind: 'payment', id: 'P2' });
  assert.equal(q.status, 'answered');
  assert.deepEqual([q.answer?.by, q.answer?.from], [OWNER, `prec-${(await list()).questions[0].id}`]);
  const [e] = entriesOf('P2');
  assert.deepEqual([e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.origin], ['2451', '1021', 42.3, undefined, 'manual']);
});

test('undo takes the answer\'s booking back and opens the question again; the precedent it came from stays', async () => {
  const q = (await list()).questions.find((x) => x.on.id === 'P2')!;
  const r = await api.send('POST', `/api/questions/${q.id}/undo`, { by: MONIKA });
  assert.equal((r.json as unknown as Question).status, 'open');
  assert.deepEqual(entriesOf('P2'), []);
  assert.match(readFileSync(join(api.root, 'knowledge/rules/booking.guide.yaml'), 'utf8'), /coopprontobern/);
});

test('a generic card text is never a precedent: the next card payment is asked, not answered', async () => {
  const q = await ask({ kind: 'payment', id: 'G1' });
  const r = await api.send('POST', `/api/questions/${q.id}/answer`, { by: OWNER, choice: 'private' });
  const acted = (r.json as unknown as Question).answer?.acted;
  assert.ok(acted && 'booked' in acted && !acted.precedent, 'booked, but kept as no precedent');
  assert.equal(entriesOf('G1')[0].accountDebit, '2451');
  const next = await ask({ kind: 'payment', id: 'G2' });
  assert.equal(next.status, 'open', '«Karte 5412 Einkauf» names nobody: asked again');
  assert.deepEqual(entriesOf('G2'), []);
});

test('a specific vendor on the receipt answers the next question, whatever the bank text says', async () => {
  const q = await ask({ kind: 'payment', id: 'V1' });
  await api.send('POST', `/api/questions/${q.id}/answer`, { by: OWNER, choice: 'business' });
  const next = await ask({ kind: 'payment', id: 'V2' });
  assert.deepEqual([next.status, next.answer?.answer], ['answered', { choice: 'business' }], 'same vendor Digitec Galaxus AG behind «TWINT Zahlung»');
  assert.deepEqual(entriesOf('V2'), [], '«geschäftlich» books nothing itself');
});

test('isGenericText: a way to pay is no counterparty', () => {
  for (const g of ['Karte 5412 Einkauf', 'Einkauf', 'Kartenzahlung', 'Zahlung', 'Belastung', 'TWINT', 'TWINT Zahlung 0791234567', 'Card transaction of 39.00 EUR', 'Achat carte 12.09.2026']) assert.ok(isGenericText(g), g);
  for (const v of ['Coop Pronto Bern', 'Digitec Galaxus', 'Migros', 'SBB']) assert.ok(!isGenericText(v), v);
});

test('a text answer books nothing; the asker marks it done and it leaves her list', async () => {
  const q = await ask({ kind: 'payment', id: 'P3' }, [], 'Welches Projekt?');
  const r = await api.send('POST', `/api/questions/${q.id}/answer`, { by: OWNER, text: 'Küche Meier' });
  const answered = r.json as unknown as Question;
  assert.deepEqual([answered.status, answered.answer?.answer, answered.answer?.acted], ['answered', { text: 'Küche Meier' }, undefined]);
  assert.deepEqual(entriesOf('P3'), []);
  await api.send('POST', `/api/questions/${q.id}/close`, { by: MONIKA, how: 'done' });
  assert.ok(!askedByMe((await list()).questions, MONIKA).some((x) => x.id === q.id));
});

test('«privat» on a payment of a filed quarter: the answer is kept, the books are not touched', async () => {
  const q = await ask({ kind: 'entry', id: 'c1' });
  const r = await api.send('POST', `/api/questions/${q.id}/answer`, { by: OWNER, choice: 'private' });
  assert.deepEqual((r.json as unknown as Question).answer?.acted, { refused: 'closed', detail: '2026-06-30' });
  assert.deepEqual([entriesOf('C1')[0].accountDebit, entriesOf('C1')[0].vatCode], ['6700', 'I81']);
});

test('the questions travel with the books folder: another process and a copy of the folder read the same', async () => {
  const served = (await list()).questions;
  assert.deepEqual(readQuestions(workspaceAt(api.root)), served, 'read from the files alone');
  const copy = mkdtempSync(join(tmpdir(), 'questions-copy-'));
  try {
    cpSync(api.root, copy, { recursive: true });
    assert.deepEqual(readQuestions(workspaceAt(copy)), served);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('asking about something the books do not hold is refused', async () => {
  const r = await api.send('POST', '/api/questions', { on: { kind: 'payment', id: 'nope' }, by: MONIKA, text: 'x' });
  assert.equal(r.status, 404);
});

test('fold: lines in any order, a line for an unknown question skipped, a closed question stays closed', () => {
  const lines: QuestionLine[] = [
    { v: 1, event: 'answered', id: 'a', at: '2026-10-02T00:00:00Z', by: 'O', answer: { text: 'ja' } },
    { v: 1, event: 'asked', id: 'a', at: '2026-10-01T00:00:00Z', by: 'M', on: { kind: 'payment', id: 'P' }, text: '?', choices: [], origin: 'person' },
    { v: 1, event: 'closed', id: 'a', at: '2026-10-03T00:00:00Z', by: 'M', how: 'done' },
    { v: 1, event: 'undone', id: 'a', at: '2026-10-04T00:00:00Z', by: 'M' },
    { v: 1, event: 'answered', id: 'ghost', at: '2026-10-02T00:00:00Z', by: 'O', answer: { text: 'x' } },
  ];
  const [q, ...rest] = fold(lines);
  assert.deepEqual([q.status, q.answer?.answer, rest.length], ['closed', { text: 'ja' }, 0]);
});

test('the AI sidebar asks with a change «question»: to the owner, origin assistant, its undo withdraws it', async () => {
  const log = mkdtempSync(join(tmpdir(), 'questions-ai-'));
  const changes = join(log, 'changes.json');
  const ai = await startApi('tests/fixtures/questions-index.json', { PATH: `${join(process.cwd(), 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: changes });
  try {
    writeFileSync(changes, JSON.stringify([{ kind: 'question', on: { kind: 'payment', id: 'P3' }, text: 'Wofür war dieser Einkauf?', choices: ['private', 'business'] }]));
    const res = await ai.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Buch das', language: 'de', context: [{ kind: 'payment', id: 'P3', label: 'Digitec' }] }) });
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as { type: string; id?: string; changes?: Array<{ id: string; note?: { question?: { to?: string } } }> });
    const made = events.find((e) => e.type === 'changes')?.changes ?? [];
    assert.equal(made.length, 1, JSON.stringify(events));
    assert.equal(made[0].note?.question?.to, OWNER);
    const [q] = (await ai.send('GET', '/api/questions')).json.questions as Question[];
    assert.deepEqual([q.origin, q.to, q.status, q.on], ['assistant', OWNER, 'open', { kind: 'payment', id: 'P3' }]);
    assert.deepEqual(forMe([q], OWNER).map((x) => x.id), [q.id]);
    const conversation = events[0].id!;
    assert.equal((await ai.send('POST', `/api/assistant/${conversation}/changes/${made[0].id}/undo`)).status, 200);
    const [after] = (await ai.send('GET', '/api/questions')).json.questions as Question[];
    assert.deepEqual([after.status, after.closed?.how], ['closed', 'withdrawn']);
  } finally {
    await ai.stop();
    rmSync(log, { recursive: true, force: true });
  }
});

test('two clones that each asked merge without a conflict: the scaffolded .gitattributes unions questions.jsonl', () => {
  const repo = mkdtempSync(join(tmpdir(), 'questions-merge-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' });
  const file = join(repo, 'vanilla-accounting/transactional-data/2026/questions.jsonl');
  const line = (id: string, by: string) => `${JSON.stringify({ v: 1, event: 'asked', id, at: '2026-10-16T08:00:00Z', by, on: { kind: 'payment', id: 'P' }, text: '?', choices: [], origin: 'person' })}\n`;
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitattributes'), GITATTRIBUTES);
    mkdirSync(join(repo, 'vanilla-accounting/transactional-data/2026'), { recursive: true });
    writeFileSync(file, line('q-0', 'Anna'));
    git('add', '-A'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'treuhand'); appendFileSync(file, line('q-1', 'Monika')); git('commit', '-qam', 'Monika asks');
    git('checkout', '-q', 'main'); appendFileSync(file, line('q-2', 'Anna')); git('commit', '-qam', 'Anna asks');
    git('merge', '-q', '--no-edit', 'treuhand');
    assert.deepEqual(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id).sort(), ['q-0', 'q-1', 'q-2']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
