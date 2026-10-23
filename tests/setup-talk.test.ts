/**
 * Words typed in the setup before the books exist (#145, src/onboarding/draft-talk.ts), with the
 * model stubbed: one message fills several answers, code refuses what createWorkspace would refuse
 * or what the person never wrote (a UID, an IBAN) and says why, a question gets an answer and
 * changes nothing, a model that answers no JSON or fails changes nothing. Each test names the
 * wrong behaviour it catches.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import git from 'isomorphic-git';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';
import { draftSteps, newDraft, withPatch } from '../src/onboarding/draft.js';
import { draftFile, readDraft, writeDraft } from '../src/onboarding/draft-store.js';
import { applyTalk, parseTalk, type Ask } from '../src/onboarding/draft-talk.js';
import type { AskOptions } from '../src/llm/ask.js';
import { APP_FOLDER, MANIFEST_FILE } from '../src/workspace/workspace.js';
import { testIban } from './support/iban.js';

const NOW = '2026-10-23T09:00:00.000Z';
const UID = 'CHE-153.004.184';
const IBAN = testIban('00762011623852957');
const IBAN_SPACED = IBAN.replace(/(.{4})(?!$)/g, '$1 ');
const SCHREINEREI = 'Wir sind die Muster Schreinerei GmbH in Bern, Inhaberin Anna Muster, zwei Angestellte, MWST-pflichtig mit Saldosteuersatz 4.5 %, Konto bei der Raiffeisen.';

const home = mkdtempSync(join(tmpdir(), 'vanilla-talk-'));
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

/** The model's answers in turn, and what each call was asked. */
let answers: Array<string | Error> = [];
const asked: Array<{ prompt: string; opts: AskOptions }> = [];
const stub: Ask = async (prompt, opts) => {
  asked.push({ prompt, opts });
  const next = answers.shift();
  if (next instanceof Error) throw next;
  return next ?? '';
};

async function start() {
  const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: home, dist, aiAvailable: async () => true, ask: stub });
  const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  desktop.allowHost(`127.0.0.1:${port}`);
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => undefined) };
  };
}

async function folder(name: string) {
  const call = await start();
  const root = join(home, name);
  await call('POST', '/api/desktop/setup', { root, language: 'de' });
  const talk = (text: string, model: string | Error, history: unknown[] = []) => {
    answers = [model];
    return call('POST', '/api/desktop/setup/talk', { root, text, history });
  };
  return { call, root, talk };
}

test('one message fills every answer it states, through the click\'s checks, each marked as taken from the words', async () => {
  const { call, root, talk } = await folder('Schreinerei');
  const model = '```json\n' + JSON.stringify({
    say: 'Wie lautet die UID der Firma?',
    firm: { name: 'Muster Schreinerei GmbH', owner: 'Anna Muster' },
    preset: 'trades',
    answers: { legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'net-rate', employees: 'staff' },
    netRates: [{ rate: 4.5, label: 'Schreinerei' }],
    banks: [{ bank: 'Raiffeisen' }],
  }) + '\n```';
  const res = await talk(SCHREINEREI, model);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const { reply, view } = res.json;
  assert.equal(reply.kind, 'read');
  assert.deepEqual(reply.filled, ['preset', 'legalForm', 'vatRegistered', 'vatMethod', 'employees', 'netRates', 'banks'], 'every stated answer is saved and marked, those the preset it names gives too');
  assert.deepEqual(reply.firm, { name: 'Muster Schreinerei GmbH', owner: 'Anna Muster' }, 'a firm short of its UID is not saved; its card starts with what was said');
  assert.equal(view.draft.firm, undefined);
  assert.deepEqual(view.draft.banks, [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020' }], 'a bank without a currency gets the jurisdiction\'s, its account as a click would');
  assert.equal(view.draft.answers.period, undefined, 'what the words do not say stays open');
  const disk = readDraft(root)!;
  assert.deepEqual(disk.fromText, reply.filled, 'the marks are saved with the draft');
  assert.equal(disk.netRates?.[0].rate, 4.5);

  const [call1] = asked.slice(-1);
  assert.equal(call1.opts.step, 'setup-conversation', 'the call names its step, so the resolver picks the configured provider');
  assert.equal(call1.opts.ledger, join(root, APP_FOLDER, 'data', 'llm-ledger.jsonl'), 'it is ledgered in the folder that becomes the books');
  assert.ok(call1.prompt.includes(SCHREINEREI) && call1.prompt.includes('The step waiting now: firm'), 'the model reads the words with the step waiting');
  assert.ok(call1.prompt.includes('"net-rate" (Saldosteuersatz') && call1.prompt.includes('"agreed" (vereinbart (invoice); not supported'), 'and every value code accepts');

  const history = [{ who: 'me', text: SCHREINEREI }, { who: 'ai', text: reply.say }];
  const uid = await talk(`Die UID ist ${UID}.`, JSON.stringify({ say: '', firm: { name: 'Muster Schreinerei GmbH', uid: UID, owner: 'Anna Muster' } }), history);
  assert.deepEqual(uid.json.reply.filled, ['firm'], 'the next message completes the firm from the turns before');
  assert.equal(uid.json.view.draft.firm.uid, UID);
  const open = draftSteps(uid.json.view.draft).at(-1)!;
  assert.ok(open.id === 'question' && open.key === 'basis', 'the conversation stands at the first answer still open');

  const changed = await call('PUT', '/api/desktop/setup', { root, patch: { step: 'question', key: 'vatMethod', value: 'effective' } });
  assert.ok(!changed.json.draft.fromText.includes('vatMethod'), 'an answer the person changes is theirs, no longer marked');
  assert.ok(changed.json.draft.fromText.includes('firm'), 'the other marks stay');
});

test('code refuses what createWorkspace would refuse or the person never wrote, says why, and saves none of it', async () => {
  const { root, talk } = await folder('Abgelehnt');
  const before = readFileSync(draftFile(root), 'utf8');
  const res = await talk('Muster AG, UID CHE-123.456.789, Inhaber Max Muster. Wir rechnen pauschal ab und vereinbart. Bank UBS.', JSON.stringify({
    say: 'Danke, die UID habe ich übernommen.',
    firm: { name: 'Muster AG', uid: 'CHE-123.456.789', owner: 'Max Muster' },
    answers: { vatMethod: 'pauschal', basis: 'agreed' },
    banks: [{ bank: 'UBS', currency: 'CHF', iban: IBAN }],
  }));
  const { reply, view } = res.json;
  assert.deepEqual(reply.refused.map((r: { step: string; refusal: { reason: string } }) => [r.step, r.refusal.reason]), [
    ['firm', 'uid'], ['vatMethod', 'notAnOption'], ['basis', 'unsupported'], ['banks', 'notStated'],
  ], 'a UID failing its check digit, a value the question does not offer, one not supported yet, an IBAN not in the words');
  assert.equal(view.draft.firm, undefined, 'the refused firm is not saved');
  assert.equal(reply.say, '', 'the model\'s words, written before the check, never claim what code refused');
  assert.equal(view.draft.answers.vatMethod, undefined);
  assert.equal(view.draft.answers.basis, undefined);
  assert.deepEqual(view.draft.banks, [{ bank: 'UBS', currency: 'CHF', account: '1020' }], 'the bank is saved without the IBAN the model made up');
  assert.deepEqual(reply.firm, { name: 'Muster AG', uid: 'CHE-123.456.789', owner: 'Max Muster' }, 'the firm\'s card shows what was said, to correct');
  assert.notEqual(readFileSync(draftFile(root), 'utf8'), before);

  const invented = await talk('Wir sind die Muster AG, Inhaber Max Muster.', JSON.stringify({ say: '', firm: { name: 'Muster AG', uid: UID, owner: 'Max Muster' } }));
  assert.deepEqual(invented.json.reply.refused[0].refusal, { reason: 'notStated', field: 'uid', detail: UID }, 'a valid UID the person never wrote is refused all the same');
  assert.equal(invented.json.view.draft.firm, undefined);
  assert.deepEqual(invented.json.reply.firm, { name: 'Muster AG', owner: 'Max Muster' });
});

test('a question gets an answer and changes nothing', async () => {
  const { root, talk } = await folder('Frage');
  const before = readFileSync(draftFile(root), 'utf8');
  const say = 'Beim Saldosteuersatz zahlst du einen festen Prozentsatz auf deinem Umsatz und ziehst keine Vorsteuer ab. Hast du einen bewilligten Satz?';
  const res = await talk('Was ist der Saldosteuersatz?', JSON.stringify({ say }));
  assert.deepEqual(res.json.reply, { kind: 'read', say, filled: [], refused: [] });
  assert.equal(readFileSync(draftFile(root), 'utf8'), before, 'the draft on disk is untouched');
});

test('a model that answers no JSON, or does not answer, changes nothing and says so', async () => {
  const { root, talk } = await folder('Kaputt');
  const before = readFileSync(draftFile(root), 'utf8');
  assert.deepEqual((await talk('GmbH, zwei Angestellte', 'Gern! Ihr seid eine GmbH mit zwei Angestellten.')).json.reply, { kind: 'unreadable' });
  assert.deepEqual((await talk('GmbH', '{"say": ')).json.reply, { kind: 'unreadable' }, 'cut-off JSON');
  assert.deepEqual((await talk('GmbH', '[1, 2]')).json.reply, { kind: 'unreadable' }, 'JSON that is not the object asked for');
  assert.deepEqual((await talk('GmbH', new Error('timed out'))).json.reply, { kind: 'failed', detail: 'timed out' });
  assert.equal(readFileSync(draftFile(root), 'utf8'), before);
  const empty = await talk('   ', '{}');
  assert.equal(empty.status, 400, 'no words, no call');
});

test('answers outside a preset make the preset «custom», so a later preset cannot replace them; a preset the words name comes first', () => {
  const d = newDraft('de', NOW);
  const custom = applyTalk(d, parseTalk(JSON.stringify({ say: '', answers: { employees: 'staff', imports: 'yes' } }))!, ['x'], 'CHF');
  assert.equal(custom.draft.preset, 'custom');
  assert.deepEqual([custom.draft.answers.employees, custom.draft.answers.imports], ['staff', 'yes']);
  const preset = applyTalk(d, parseTalk(JSON.stringify({ say: '', preset: 'consultant', answers: { employees: 'staff' } }))!, ['x'], 'CHF');
  assert.deepEqual([preset.draft.preset, preset.draft.answers.employees], ['consultant', 'staff'], 'the preset is applied before the answers, which win over it');
  const vatOnly = applyTalk(d, parseTalk(JSON.stringify({ say: '', answers: { vatRegistered: 'no' } }))!, ['x'], 'CHF');
  assert.equal(vatOnly.draft.preset, undefined, 'a VAT answer survives any preset, so it does not decide one');
  const picked = withPatch(preset.draft, { step: 'preset', value: 'webshop' });
  assert.ok(!picked.fromText?.includes('employees'), 'a preset the person picks replaces the marks of the answers it gives');
});

test('books created from a talked draft carry no marks and no draft; the folder\'s ledger stays out of git', async () => {
  const { call, root, talk } = await folder('Angelegt');
  await talk(`Muster GmbH, ${UID}, Inhaberin Anna Muster; Beratung, nicht MWST-pflichtig, Konto bei der UBS IBAN ${IBAN_SPACED}.`, JSON.stringify({
    say: '', firm: { name: 'Muster GmbH', uid: UID, owner: 'Anna Muster' }, preset: 'consultant',
    answers: { vatRegistered: 'no' }, banks: [{ bank: 'UBS', currency: 'CHF', iban: IBAN_SPACED }],
  }));
  const d = readDraft(root)!;
  assert.equal(draftSteps(d).at(-1)!.id, 'review', 'one message took the setup to its summary');
  assert.equal(d.banks?.[0].iban, IBAN, 'an IBAN the person wrote is taken, in its compact form');
  mkdirSync(join(root, APP_FOLDER, 'data'), { recursive: true });
  writeFileSync(join(root, APP_FOLDER, 'data', 'llm-ledger.jsonl'), '{"step":"setup.conversation"}\n');
  writeDraft(root, d);
  const created = await call('POST', '/api/desktop/setup/create', { root });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.ok(existsSync(join(root, APP_FOLDER, MANIFEST_FILE)) && !existsSync(draftFile(root)));
  assert.ok(!readFileSync(join(root, APP_FOLDER, MANIFEST_FILE), 'utf8').includes('fromText'));
  const tracked = await git.listFiles({ fs, dir: root });
  assert.ok(!tracked.some((f) => f.includes('llm-ledger')), 'the setup\'s ledger is the books\' own data/, never committed');
});
