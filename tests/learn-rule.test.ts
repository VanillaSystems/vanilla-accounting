/**
 * «Ins Wissen übernehmen?» (issue #40): a person's correction of a booking no rule made offers a
 * knowledge entry. The AI (the stub `claude` here) drafts it; code checks it before anything reaches
 * the card: a rule only for a partner with at least two payments it books as the person did, never
 * one that books the corrected payment otherwise, never one the app cannot carry out. A one-off gets
 * a note or nothing. The card shows the rule's payments and warns against national VAT rules (#75);
 * keeping writes the company's file through the card's path.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { draftDir } from '../src/saving/changes.js';
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { draftRules, keepDraft } from '../src/saving/rules.js';
import { learnOffer, proposeFromCorrection, parseLearnAnswer } from '../src/saving/learn-rule.js';
import type { BookingFields, JournalEntry, Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';
process.env.GIT_COMMITTER_NAME = 'Erika Beispiel';
process.env.GIT_COMMITTER_EMAIL = 'erika@example.com';

const GUIDE = 'knowledge/rules/booking.guide.yaml';
const PERSON_AT = '2026-10-20T10:00:00Z';
let prompts: string;
let args: string;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'learn-stub-'));
  prompts = join(dir, 'prompts');
  args = join(dir, 'args');
  // ask() writes its ledger into the process's workspace: a copy, so the repo's demo gets no data/.
  process.env.VANILLA_WORKSPACE = join(dir, 'ledger-ws');
  cpSync(DEMO_ROOT, process.env.VANILLA_WORKSPACE, { recursive: true });
  process.env.CLAUDE_BIN = join(process.cwd(), 'tests/support/stub-bin/claude');
  process.env.CLAUDE_STUB_PROMPTS = prompts;
  process.env.CLAUDE_STUB_ARGS = args;
});
beforeEach(() => { writeFileSync(prompts, ''); writeFileSync(args, ''); });

const answer = (a: unknown) => { process.env.CLAUDE_STUB_ANSWER = typeof a === 'string' ? a : JSON.stringify(a); };

async function company(): Promise<Workspace> {
  const repo = mkdtempSync(join(tmpdir(), 'learn-rule-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  const ws = workspaceAt(join(repo, APP_FOLDER));
  await initRepository(repo, 'Workspace set up');
  return ws;
}

interface Pay { ref: string; date: string; amount: number; text: string; entry: Partial<JournalEntry>; receipt?: Partial<Receipt> }

function payments(ws: Workspace, list: Pay[]): void {
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    for (const p of list) {
      b.transactions.push({ ref: p.ref, bank: 'Raiffeisen', date: p.date, amount: p.amount, currency: 'CHF', direction: 'DBIT', description: p.text });
      if (p.receipt) {
        b.receipts.push({ id: `${p.ref}-r`, filename: `${p.ref}.pdf`, originalFilename: `${p.ref}.pdf`, extractedText: p.text, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-10-10T00:00:00Z', location: 'archived', date: p.date, amount: p.amount, currency: 'CHF', ...p.receipt });
        b.mappings.push({ transactionRef: p.ref, receiptId: `${p.ref}-r`, by: 'human' });
      }
      b.journalEntries.push({ id: `${p.ref}-e`, transactionRef: p.ref, date: p.date, accountDebit: '6570', accountCredit: '1021', amount: p.amount, description: p.text, origin: 'classify', ...p.entry });
    }
  });
  saveBooks(ws, books);
}

const byPerson = (account: string, vat: string, was: BookingFields): Partial<JournalEntry> =>
  ({ accountDebit: account, vatCode: vat, origin: 'manual', by: { kind: 'person', at: PERSON_AT, was } });
const MIETWERK = 'Werkzeugmiete Beispiel Mietwerk AG';

/** Three past payments on 6513 I0, the newest booked on 6570 by the model and corrected to 6513 by the person. */
function mietwerk(ws: Workspace): void {
  payments(ws, [
    ...[1, 2, 3].map((i) => ({ ref: `MW-${i}`, date: `2026-0${i + 4}-05`, amount: 60 + i, text: MIETWERK, entry: { accountDebit: '6513', vatCode: 'I0', origin: 'manual' as const } })),
    { ref: 'MW-4', date: '2026-10-05', amount: 64.5, text: MIETWERK, entry: byPerson('6513', 'I0', { accountDebit: '6570' }) },
  ]);
}

test('a correction on a payer with three consistent past payments: the AI\'s rule reaches the card with its payments; keeping writes the company\'s file', async () => {
  const ws = await company();
  mietwerk(ws);
  const offer = learnOffer(ws, loadBooks(ws), 'MW-4');
  assert.ok(offer, 'the correction offers «Ins Wissen übernehmen?»');
  assert.deepEqual([offer.partner.kind, offer.was, offer.booked, offer.same, offer.of], ['payer', { account: '6570', vat: 'I0' }, { account: '6513', vat: 'I0' }, 4, 4]);

  answer({ kind: 'rule', then: { account: '6513', vat: 'I0' } });
  const proposal = await proposeFromCorrection(ws, 'MW-4', '2026-10-23');
  assert.deepEqual(proposal, { kind: 'rule', path: GUIDE });
  const prompt = readFileSync(prompts, 'utf8');
  assert.match(prompt, /Corrected to: account 6513/);
  assert.match(prompt, /Of its 4 payments this year, 4 are booked the corrected way/);
  assert.match(prompt, /2026-07-05 paid 63\.00 CHF .* → 6513/, 'the partner\'s past payments, as booked today');
  assert.deepEqual(JSON.parse(readFileSync(args, 'utf8').trim()).slice(1, 3), ['--model', 'haiku'], 'the cheapest model that works');
  assert.equal(existsSync(join(ws.paths.root, GUIDE)) ? parse(readFileSync(join(ws.paths.root, GUIDE), 'utf8'))?.steps?.classify?.rules?.length ?? 0 : 0, 0, 'nothing kept before «Behalten»');

  const d = draftRules(ws, GUIDE)!;
  assert.equal(d.added.length, 1);
  assert.deepEqual(d.added[0].rule?.when, { payer: 'werkzeugmietebeispielmietwerkag', direction: 'out' });
  assert.deepEqual(d.added[0].rule?.then, { kind: 'book', booking: { account: '6513', vat: 'I0' } });
  const [p] = d.preview;
  assert.deepEqual([p.matches, p.same, p.otherwise, p.examples.length], [4, 4, 0, 4], 'the card shows the payments it holds for');
  assert.deepEqual([d.overrides, d.spread, d.confirm], [[], [], false]);
  assert.deepEqual(await keepDraft(ws, GUIDE, d.basis), { ok: true, committed: true });
  const kept = parse(readFileSync(join(ws.paths.root, GUIDE), 'utf8')).steps.classify.rules as Array<{ then: unknown; source: string }>;
  assert.deepEqual(kept.map((r) => [r.then, r.source]), [[{ account: '6513', vat: 'I0' }, 'correction 2026-10-23']]);
  assert.equal(learnOffer(ws, loadBooks(ws), 'MW-4'), undefined, 'kept: the rule books it so, nothing more to teach');
});

test('a one-off gets no rule: the AI\'s rule is refused by code, nothing is drafted', async () => {
  const ws = await company();
  payments(ws, [{ ref: 'ONE-1', date: '2026-10-07', amount: 210, text: 'Einmalig Beispiel Messebau GmbH', entry: byPerson('6513', 'I0', { accountDebit: '6570' }) }]);
  const offer = learnOffer(ws, loadBooks(ws), 'ONE-1');
  assert.deepEqual([offer?.same, offer?.of], [1, 1]);
  answer({ kind: 'rule', then: { account: '6513', vat: 'I0' } });
  assert.deepEqual(await proposeFromCorrection(ws, 'ONE-1'), { kind: 'none', why: 'oneOff' });
  assert.equal(existsSync(join(draftDir(ws), GUIDE)), false, 'no draft');
});

test('a one-off of a known business may become a note for its notes, never a rule', async () => {
  const ws = await company();
  payments(ws, [{ ref: 'POST-1', date: '2026-10-08', amount: 88.4, text: 'Rechnung Post CH Oktober 2026', entry: byPerson('6513', 'I0', { accountDebit: '6570' }) }]);
  const offer = learnOffer(ws, loadBooks(ws), 'POST-1');
  assert.deepEqual(offer?.partner, { kind: 'business', id: 'swiss-post', name: offer?.partner.name });
  answer({ kind: 'note', sentence: 'Zuschläge für Sperrgut buchen wir auch auf 6513.' });
  assert.deepEqual(await proposeFromCorrection(ws, 'POST-1'), { kind: 'note', partner: 'swiss-post', name: offer!.partner.name, sentence: 'Zuschläge für Sperrgut buchen wir auch auf 6513.' });
});

test('a proposal against Bezugsteuer reaches the card with the national-rule warning; «Behalten» alone does not keep it', async () => {
  const ws = await company();
  const foreign: Partial<Receipt> = { hasSwissVat: false, vatSummary: [] };
  payments(ws, [
    ...[1, 2].map((i) => ({ ref: `ADP-${i}`, date: `2026-0${i + 6}-03`, amount: 100 + i, text: 'Adplatform Ltd, Kampagne', receipt: foreign, entry: byPerson('6570', 'I0', { vatCode: 'B81-1' }) })),
    { ref: 'ADP-3', date: '2026-10-03', amount: 120, text: 'Adplatform Ltd, Kampagne', receipt: foreign, entry: byPerson('6570', 'I0', { vatCode: 'B81-1' }) },
  ]);
  assert.equal(learnOffer(ws, loadBooks(ws), 'ADP-3')?.same, 3);
  answer({ kind: 'rule', then: { account: '6570', vat: 'I0' } });
  assert.deepEqual(await proposeFromCorrection(ws, 'ADP-3'), { kind: 'rule', path: GUIDE });
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual(d.preview[0].overrides?.map((o) => [o.kind, o.count]), [['withoutAcquisition', 3]]);
  assert.equal(d.confirm, true);
  const refused = await keepDraft(ws, GUIDE, d.basis);
  assert.equal(refused.ok, false, 'kept only with «Trotzdem behalten»');
});

test('the AI\'s invalid rule is refused by code and nothing is shown: an account off the chart, a field the prompt does not name, no JSON, or a rule that books the payment otherwise', async () => {
  const ws = await company();
  mietwerk(ws);
  for (const [raw, why] of [
    [{ kind: 'rule', then: { account: '9999', vat: 'I0' } }, 'invalid'],
    [{ kind: 'rule', then: { account: '6513', vat: 'I0', fees: { account: '6840', vat: 'I0' } } }, 'invalid'],
    [{ kind: 'rule', then: { account: '6513', vat: 'X99' } }, 'invalid'],
    ['Ich würde eine Regel vorschlagen.', 'invalid'],
    [{ kind: 'rule', then: { account: '6570', vat: 'I0' } }, 'contradicts'],
    [{ kind: 'none' }, 'model'],
  ] as const) {
    answer(raw);
    assert.deepEqual(await proposeFromCorrection(ws, 'MW-4'), { kind: 'none', why }, JSON.stringify(raw));
  }
  assert.equal(existsSync(join(draftDir(ws), GUIDE)), false, 'no draft for the card');
});

test('honest: a rule that holds for most of the partner\'s payments says on its card how many it books otherwise, and shows them', async () => {
  const ws = await company();
  mietwerk(ws);
  payments(ws, [{ ref: 'MW-0', date: '2026-04-05', amount: 59, text: MIETWERK, entry: { accountDebit: '6000', vatCode: 'I0', origin: 'manual' } }]);
  assert.deepEqual([learnOffer(ws, loadBooks(ws), 'MW-4')?.same, learnOffer(ws, loadBooks(ws), 'MW-4')?.of], [4, 5]);
  answer({ kind: 'rule', then: { account: '6513', vat: 'I0' } });
  await proposeFromCorrection(ws, 'MW-4');
  const [p] = draftRules(ws, GUIDE)!.preview;
  assert.deepEqual([p.matches, p.same, p.otherwise], [5, 4, 1]);
  assert.deepEqual(p.examples.find((x) => x.ref === 'MW-0')?.now.map((l) => l.account), ['6000'], 'the other one, with its booking today');
  assert.equal(p.spread, undefined, 'one other account: no «Trotzdem behalten», the person decides on the card');
});

test('nothing to teach: a changed amount (a fix, not a practice), or a booking a rule made (that goes to «Regel anpassen?»)', async () => {
  const ws = await company();
  payments(ws, [{ ref: 'FIX-1', date: '2026-10-09', amount: 12, text: MIETWERK, entry: { origin: 'manual', vatCode: 'I0', by: { kind: 'person', at: PERSON_AT, was: { amount: 24 } } } }]);
  assert.equal(learnOffer(ws, loadBooks(ws), 'FIX-1'), undefined);
  mkdirSync(join(ws.paths.root, 'knowledge/rules'), { recursive: true });
  writeFileSync(join(ws.paths.root, GUIDE), 'process: booking\nsteps:\n  classify:\n    rules:\n      - id: mietwerk\n        when: { text: "Mietwerk" }\n        then: { account: "6570", vat: I0 }\n        source: hand 2026-10-01\n');
  payments(ws, [{ ref: 'RULED-1', date: '2026-10-10', amount: 30, text: MIETWERK, entry: byPerson('6513', 'I0', { accountDebit: '6570' }) }]);
  assert.equal(learnOffer(ws, loadBooks(workspaceAt(ws.paths.root)), 'RULED-1'), undefined);
});

test('over HTTP: GET offers, POST asks the model and drafts the rule for the card', async () => {
  const { startApi } = await import('./support/api-server.js');
  const api = await startApi('demo', { CLAUDE_BIN: process.env.CLAUDE_BIN!, CLAUDE_STUB_ANSWER: JSON.stringify({ kind: 'rule', then: { account: '6513', vat: 'I0' } }) });
  try {
    // The test server's chart holds only the history stub's accounts: the firm's chart gets both first (Firma › Kontenplan).
    for (const [number, name] of [['6570', 'Informatikaufwand'], ['6513', 'Werkzeuge und Geräte']]) assert.equal((await api.send('PUT', `/api/accounts/${number}`, { name })).status, 200);
    mietwerk(api.ws);
    const offer = (await api.send('GET', '/api/rules/learn?ref=MW-4')).json.offer as { same: number } | null;
    assert.equal(offer?.same, 4);
    const proposed = await api.send('POST', '/api/rules/learn', { ref: 'MW-4' });
    assert.deepEqual([proposed.status, proposed.json], [200, { kind: 'rule', path: GUIDE }]);
    assert.equal(((await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(GUIDE)}`)).json as unknown as { added: unknown[] }).added.length, 1);
    assert.equal((await api.send('POST', '/api/rules/learn', { ref: 'MW-1' })).status, 404, 'a booking nobody corrected teaches nothing');
  } finally {
    await api.stop();
  }
});

test('payments another rule decides count for no learned rule: it would never book them', async () => {
  const ws = await company();
  mietwerk(ws);
  mkdirSync(join(ws.paths.root, 'knowledge/rules'), { recursive: true });
  writeFileSync(join(ws.paths.root, GUIDE), 'process: booking\nsteps:\n  classify:\n    rules:\n      - id: mietwerk-gross\n        when: { text: "Mietwerk", amount: { over: 61.5, under: 63.5 } }\n        then: { account: "6513", vat: I0 }\n        source: hand 2026-10-01\n');
  const offer = learnOffer(workspaceAt(ws.paths.root), loadBooks(ws), 'MW-4');
  assert.deepEqual([offer?.same, offer?.of], [2, 2], 'MW-2 and MW-3 are the narrow rule\'s');
});

test('parseLearnAnswer takes exactly the three shapes', () => {
  assert.deepEqual(parseLearnAnswer('```json\n{"kind":"rule","then":{"account":"6513","vat":"none"}}\n```'), { kind: 'rule', then: { account: '6513', vat: null } });
  assert.equal(parseLearnAnswer('{"kind":"rule","then":{"account":"6513"}}'), undefined);
  assert.equal(parseLearnAnswer('{"kind":"note","sentence":"Zwei\\nZeilen"}'), undefined);
  assert.equal(parseLearnAnswer('{"kind":"maybe"}'), undefined);
});
