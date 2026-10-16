/**
 * Keeping a rule with one click (src/saving/rules.ts): «Behalten» saves exactly the one draft, as
 * one save, without the AI; a rule the app cannot carry out is refused when it is kept, by
 * «Behalten» and by «Speichern» alike; Firma › Regeln lists every rule with its plain words and how
 * often it applied, and switching off or deleting one is undone by putting the file back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { draftDir } from '../src/saving/changes.js';
import { draftRules, keepDraft, ruleCommand } from '../src/saving/rules.js';
import { openSaving, type Ask } from '../src/saving/saving.js';
import type { RulesView } from '../src/saving/rules.js';
import { ruleLines } from '../src/app/areas/company/rules-model.js';
import { formatIn } from '../src/app/i18n/core.js';
import de from '../src/app/i18n/locales/de.js';
import { startApi } from './support/api-server.js';
import { DEMO_ROOT } from './support/workspace.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';
process.env.GIT_COMMITTER_NAME = 'Erika Beispiel';
process.env.GIT_COMMITTER_EMAIL = 'erika@example.com';

const GUIDE = 'knowledge/rules/booking.guide.yaml';
const BEFORE = `# Our booking rules.
process: booking
steps:
  classify:
    rules:
      - id: fuel
        when: { text: "Tankstelle" }
        then: { account: "6200", vat: I81 }
        source: wish 2026-10-14
`;
const CASH = `      - id: cash-ask
        when: { text: "Bargeldbezug", direction: out, amount: { over: 500 } }
        then: { ask: "Wofür war der Barbezug?", account: "2451", vat: none }
        source: wish 2026-10-15
`;
const PROSE = `      - id: cash-prose
        when: someone withdraws more than 500 in cash
        then: do not book it on your own; ask the owner
        source: wish 2026-10-15
`;

async function company(): Promise<{ ws: Workspace; git: (...a: string[]) => string }> {
  const repo = mkdtempSync(join(tmpdir(), 'rules-keep-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  const ws = workspaceAt(join(repo, APP_FOLDER));
  mkdirSync(join(ws.paths.root, 'knowledge/rules'), { recursive: true });
  writeFileSync(join(ws.paths.root, GUIDE), BEFORE);
  await initRepository(repo, 'Workspace set up');
  return { ws, git: (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim() };
}

function draft(ws: Workspace, path: string, text: string): void {
  mkdirSync(dirname(join(draftDir(ws), path)), { recursive: true });
  writeFileSync(join(draftDir(ws), path), text);
}

test('«Behalten» saves exactly that draft as one save, without the AI; another draft keeps waiting', async () => {
  const { ws, git } = await company();
  draft(ws, GUIDE, BEFORE + CASH);
  draft(ws, 'workflows/booking/classify/step.yaml', 'label: { en: Ours }\n');
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.added.map((r) => r.id), d.changed, d.removed, d.refused, d.keepable], [['cash-ask'], [], [], [], true]);
  assert.deepEqual(await keepDraft(ws, GUIDE, d.basis), { ok: true, committed: true });
  assert.equal(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), BEFORE + CASH);
  assert.ok(!existsSync(join(draftDir(ws), GUIDE)), 'the kept draft is gone');
  assert.ok(existsSync(join(draftDir(ws), 'workflows/booking/classify/step.yaml')), 'the other draft still waits');
  assert.equal(git('show', '--name-only', '--format=%s', 'HEAD'), `Neue Regel: Text enthält «Bargeldbezug», Ausgang, über CHF 500 → frag mich: «Wofür war der Barbezug?» (Vorschlag: Konto 2451 Kontokorrent Gesellschafterin, ohne MWST)\n\n${APP_FOLDER}/${GUIDE}`);
});

test('«Behalten» keeps only what was shown: a draft changed since is refused', async () => {
  const { ws } = await company();
  draft(ws, GUIDE, BEFORE + CASH);
  const { basis } = draftRules(ws, GUIDE)!;
  draft(ws, GUIDE, BEFORE + CASH.replace('500', '50'));
  assert.equal((await keepDraft(ws, GUIDE, basis) as { refusal: string }).refusal, 'stale');
  assert.equal(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), BEFORE);
});

test('a rule the app cannot carry out is refused when it is kept: by «Behalten» and by «Speichern»; the file stays as it was', async () => {
  const { ws, git } = await company();
  draft(ws, GUIDE, BEFORE + PROSE);
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.refused.map((r) => [r.id, r.kind]), d.keepable], [[['cash-prose', 'note']], false]);
  const kept = await keepDraft(ws, GUIDE, d.basis);
  assert.equal(kept.ok, false);
  assert.match((kept as { message: string }).message, /cash-prose.*in Sätzen geschrieben/);
  assert.equal(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), BEFORE);

  const ask: Ask = async (prompt) => JSON.stringify({ reply: 'Vorbereitet.', saves: [...prompt.matchAll(/^### (\S+) \(/gm)].map((m) => ({ message: 'Regel', why: '', files: [m[1]] })) });
  const saving = openSaving(ws, { ask });
  assert.equal((await saving.command({ kind: 'prepare' })).ok, true);
  const saved = await saving.command({ kind: 'save' });
  assert.deepEqual([saved.ok, (saved as { refusal: string }).refusal], [false, 'rules']);
  assert.equal(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), BEFORE);
  assert.equal(git('log', '--format=%s').split('\n').length, 1, 'nothing saved');
});

test('a removal is kept with one click like any rule', async () => {
  const { ws } = await company();
  draft(ws, GUIDE, BEFORE.replace(/      - id: fuel[\s\S]*$/, '      []\n').replace('    rules:\n      []', '    rules: []'));
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.added, d.removed.map((r) => r.id), d.keepable], [[], ['fuel'], true]);
  assert.equal((await keepDraft(ws, GUIDE, d.basis)).ok, true);
  assert.doesNotMatch(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), /fuel/);
});

test('switching a rule off and deleting it change the file in place, comments kept; the undo puts it back', async () => {
  const { ws, git } = await company();
  const off = await ruleCommand(ws, { kind: 'off', file: GUIDE, step: 'booking.guide.yaml#classify', id: 'fuel' });
  assert.ok(off.ok);
  const text = readFileSync(join(ws.paths.root, GUIDE), 'utf8');
  assert.match(text, /^# Our booking rules\./);
  assert.match(text, /off: true/);
  assert.equal(git('log', '-1', '--format=%s'), 'Regel ausgeschaltet: fuel');
  const gone = await ruleCommand(ws, { kind: 'delete', file: GUIDE, step: 'booking.guide.yaml#classify', id: 'fuel' });
  assert.ok(gone.ok && gone.undo);
  assert.doesNotMatch(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), /id: fuel/);
  assert.ok((await ruleCommand(ws, { kind: 'restore', ...gone.undo })).ok);
  assert.equal(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), text, 'back as before the delete');
  const stale = await ruleCommand(ws, { kind: 'restore', ...gone.undo });
  assert.deepEqual([stale.ok, (stale as { refusal: string }).refusal], [false, 'changed'], 'an undo never writes over a later change');
});

test('Firma › Regeln over the API: every rule of the workspace in plain words, the ones the app carries out first, how often each applied', async () => {
  const api = await startApi('demo');
  mkdirSync(join(api.root, 'knowledge/rules'), { recursive: true });
  cpSync(join(DEMO_ROOT, 'knowledge'), join(api.root, 'knowledge'), { recursive: true });
  writeFileSync(join(api.root, GUIDE), BEFORE.replace('"6200"', '"6570"') + CASH.replace('"2451"', '"1021"') + PROSE);
  try {
    const { json } = await api.send('GET', '/api/rules');
    const view = json as unknown as RulesView;
    const words = (k: string, v: Record<string, string>) => formatIn({ code: 'de', messages: de.messages }, k as never, v);
    const lines = ruleLines(view, words as never, (n) => String(n));
    assert.deepEqual(lines.map((l) => [l.row.id, l.acts, l.line, l.applied]), [
      ['fuel', true, 'Text enthält «Tankstelle» → Konto 6570 Informatikaufwand, MWST I81', 0],
      ['cash-ask', true, 'Text enthält «Bargeldbezug», Ausgang, über CHF 500 → frag mich: «Wofür war der Barbezug?» (Vorschlag: Konto 1021 Bank, ohne MWST)', 0],
      ['cash-prose', false, 'someone withdraws more than 500 in cash → do not book it on your own; ask the owner', 0],
      ['demo-gruenkaffee-green-coffee', false, lines[3].line, 0],
      ['demo-post-parcels', false, lines[4].line, 0],
    ]);
    assert.match(lines[4].line, /^Post CH: /, 'a business\'s note names its business');
    const del = await api.send('POST', '/api/rules', { kind: 'delete', file: GUIDE, step: 'booking.guide.yaml#classify', id: 'cash-prose' });
    assert.equal(del.json.ok, true);
    assert.deepEqual(((await api.send('GET', '/api/rules')).json as unknown as RulesView).rules.map((r) => r.id).includes('cash-prose'), false);
    assert.equal((await api.send('POST', '/api/rules', { kind: 'restore', ...(del.json.undo as object) })).json.ok, true);
    assert.equal(((await api.send('GET', '/api/rules')).json as unknown as RulesView).rules.filter((r) => r.id === 'cash-prose').length, 1);
  } finally {
    await api.stop();
  }
});
