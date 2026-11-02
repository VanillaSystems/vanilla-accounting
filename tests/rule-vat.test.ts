/**
 * A wish that becomes a rule without a VAT rate (F05): code takes the rate from the receipts of the
 * rule's payments when they agree, and the card asks once, with the rates to choose from, when they
 * disagree or there are none. The card never shows the raw validation text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, APP_ROOT, openWorkspaceAt, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { draftDir } from '../src/saving/changes.js';
import { draftRules, keepDraft, setDraftVat } from '../src/saving/rules.js';
import { draftHandRule } from '../src/saving/hand-rule.js';
import { refusalKey } from '../src/app/areas/company/rules-model.js';
import { formatIn } from '../src/app/i18n/core.js';
import de from '../src/app/i18n/locales/de.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';
process.env.GIT_COMMITTER_NAME = 'Erika Beispiel';
process.env.GIT_COMMITTER_EMAIL = 'erika@example.com';

const GUIDE = 'knowledge/rules/booking.guide.yaml';
const HEAD = 'process: booking\nsteps:\n  classify:\n    rules:\n';
const rule = (id: string, text: string, account: string) => `      - id: ${id}\n        when: { text: "${text}" }\n        then: { account: "${account}" }\n        source: wish 2026-11-02\n`;

async function company(root = DEMO_ROOT, open = false): Promise<Workspace> {
  const repo = mkdtempSync(join(tmpdir(), 'rule-vat-'));
  cpSync(root, join(repo, APP_FOLDER), { recursive: true });
  const ws = (open ? openWorkspaceAt : workspaceAt)(join(repo, APP_FOLDER));
  await initRepository(repo, 'Workspace set up');
  return ws;
}

function draft(ws: Workspace, path: string, text: string): void {
  mkdirSync(dirname(join(draftDir(ws), path)), { recursive: true });
  writeFileSync(join(draftDir(ws), path), text);
}
const drafted = (ws: Workspace, path: string) => readFileSync(join(draftDir(ws), path), 'utf8');

test('receipts that all show 8.1 %: code writes the rate into the draft, and the card keeps it with one click', async () => {
  const ws = await company();
  draft(ws, GUIDE, HEAD + rule('coop-spesen', 'Coop Pronto', '6200'));
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.refused, d.vatAsks, d.keepable, d.added[0].rule?.then], [[], [], true, { kind: 'book', booking: { account: '6200', vat: 'I81' } }]);
  assert.match(drafted(ws, GUIDE), /then: \{ account: "6200", vat: 8\.1 \}/);
  assert.deepEqual(draftRules(ws, GUIDE)!.basis, d.basis, 'the same on every read');
  assert.equal((await keepDraft(ws, GUIDE, d.basis)).ok, true);
});

test('receipts read without Swiss VAT: the zero rate', async () => {
  const ws = await company();
  draft(ws, GUIDE, HEAD + rule('karte-eur', 'Card transaction of 39\\\\.00 EUR', '6570'));
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.vatAsks, d.added[0].rule?.then], [[], { kind: 'book', booking: { account: '6570', vat: 'I0' } }]);
});

test('a rule in a business\'s file: the receipts of that business decide', async () => {
  const ws = await company();
  const path = 'knowledge/suppliers/swiss-post.yaml';
  const text = readFileSync(join(ws.paths.root, path), 'utf8').replace('    precedents: []', '      - id: post-porto\n        then: { account: "6513" }\n        source: wish 2026-11-02\n    precedents: []');
  draft(ws, path, text);
  const d = draftRules(ws, path)!;
  assert.deepEqual([d.vatAsks, d.added.map((r) => r.rule?.then)], [[], [{ kind: 'book', booking: { account: '6513', vat: 'I81' } }]]);
});

test('no receipt yet: the card asks once with the rates, and the answer makes the rule keepable', async () => {
  const ws = await company();
  draft(ws, GUIDE, HEAD + rule('miete', 'Miete Ladenlokal', '6000'));
  const before = drafted(ws, GUIDE);
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual(d.vatAsks, [{ step: 'booking.guide.yaml#classify', id: 'miete', seen: [], choices: [8.1, 3.8, 2.6, 0] }]);
  assert.equal(d.keepable, false);
  assert.equal(drafted(ws, GUIDE), before, 'nothing written while the person has not answered');
  assert.equal(setDraftVat(ws, GUIDE, 'stale', 'booking.guide.yaml#classify', 'miete', 0).ok, false, 'only the draft as shown');
  assert.deepEqual(setDraftVat(ws, GUIDE, d.basis, 'booking.guide.yaml#classify', 'miete', 0), { ok: true, committed: false });
  const answered = draftRules(ws, GUIDE)!;
  assert.deepEqual([answered.vatAsks, answered.keepable, answered.added[0].rule?.then], [[], true, { kind: 'book', booking: { account: '6000', vat: 'I0' } }]);
});

test('receipts at different rates: the card names them and asks', async () => {
  const ws = await company();
  draft(ws, GUIDE, HEAD + rule('post-und-kaffee', 'Rechnung Post CH|Rechnung GK-2026', '6200'));
  const [ask] = draftRules(ws, GUIDE)!.vatAsks;
  assert.deepEqual(ask.seen.map((s) => s.rate).sort(), [2.6, 8.1]);
});

test('a rule made in the form of Firma › Regeln with the VAT field left empty: the receipts decide, as for a wish', async () => {
  const ws = await company();
  const made = draftHandRule(ws, { match: { kind: 'text', text: 'Coop Pronto' }, direction: 'out', account: '6200' }, '2026-11-02');
  assert.deepEqual(made, { ok: true, path: GUIDE });
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.vatAsks, d.keepable, d.added.map((r) => r.rule?.then)], [[], true, [{ kind: 'book', booking: { account: '6200', vat: 'I81' } }]]);
});

test('a firm not registered for VAT books such a rule without a code, without asking', async () => {
  const ws = await company(join(APP_ROOT, 'demo-coiffeur', APP_FOLDER), true);
  draft(ws, GUIDE, HEAD + rule('miete', 'Miete', '6000'));
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.vatAsks, d.added[0]?.rule?.then], [[], { kind: 'book', booking: { account: '6000', vat: null } }]);
});

test('a missing VAT reads in plain words, never as the validation text', () => {
  const k = refusalKey({ code: 'vatMissing' });
  const text = formatIn({ code: 'de', messages: de.messages }, k.key as never, k.vars);
  assert.doesNotMatch(text, /none|«»/);
});
