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
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { draftShareRule, shareOffer } from '../src/saving/share-rule.js';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { BankTransaction } from '../src/types/index.js';
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
    // A rules file the AI (or a hand) changed waits to be switched on, and Firma › Regeln says so instead of showing its rules as live (r6h-24).
    assert.deepEqual(((await api.send('GET', '/api/rules')).json as unknown as RulesView).waiting, [], 'the baseline runs as switched on');
    writeFileSync(join(api.root, GUIDE), readFileSync(join(api.root, GUIDE), 'utf8') + '      - id: ai-edit\n        when: { text: "Garage" }\n        then: { account: "6200", vat: I81 }\n        source: wish 2026-10-16\n');
    const waiting = ((await api.send('GET', '/api/rules')).json as unknown as RulesView).waiting;
    assert.deepEqual(waiting.map((w) => [w.workflow, w.files]), [['booking', [GUIDE]]]);
    const off = await api.send('POST', '/api/rules', { kind: 'off', file: GUIDE, step: 'booking.guide.yaml#classify', id: 'fuel' });
    assert.equal(off.json.ok, true);
    assert.deepEqual(((await api.send('GET', '/api/rules')).json as unknown as RulesView).waiting.map((w) => w.workflow), ['booking'], 'a click on another rule is no review of the AI\'s edit: it keeps waiting');
  } finally {
    await api.stop();
  }
});

const RECHNUNG = `      - id: rechnung-it
        when: { text: "Rechnung" }
        then: { account: "6570", vat: I81 }
        source: wish 2026-10-16
`;

test('the card shows what a drafted rule would do: the payments of the open year it matches, newest first, each with its booking and today\'s (wishes3-2)', async () => {
  const { ws } = await company();
  draft(ws, GUIDE, BEFORE + RECHNUNG);
  const d = draftRules(ws, GUIDE)!;
  const books = loadBooks(ws);
  const expected = books.transactions.filter((t) => t.date.startsWith('2026') && /rechnung/i.test(`${t.description} ${t.counterparty ?? ''}`)).sort((a, b) => b.date.localeCompare(a.date));
  assert.ok(expected.length > 5, 'the demo has more such payments than the card names');
  const [p] = d.preview;
  assert.deepEqual([p.key, p.year, p.matches, p.examples.map((x) => x.ref)], ['booking.guide.yaml#classify#rechnung-it', '2026', expected.length, expected.slice(0, 5).map((t) => t.ref)]);
  const first = expected[0];
  const swiss = books.mappings.some((m) => m.transactionRef === first.ref && books.receipts.find((r) => r.id === m.receiptId)?.hasSwissVat);
  assert.deepEqual(p.examples[0].would, { kind: 'book', lines: [{ account: '6570', vat: `${first.direction === 'CRDT' ? '-' : ''}${swiss ? 'I81' : 'I0'}`, amount: first.amount }] });
  assert.deepEqual(p.examples[0].now.map((l) => l.account).sort(), books.journalEntries.filter((e) => e.transactionRef === first.ref).map((e) => (e.accountDebit === '1021' ? e.accountCredit : e.accountDebit)).sort());
});

test('a rule resting on a single word is kept only once the person confirms it on its card; «Speichern» refuses it (wishes3-2)', async () => {
  const { ws } = await company();
  draft(ws, GUIDE, BEFORE + RECHNUNG);
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.wide.map((r) => r.id), d.confirm, d.preview[0].loneWords], [['rechnung-it'], true, ['Rechnung']]);
  const refused = await keepDraft(ws, GUIDE, d.basis);
  assert.deepEqual([refused.ok, (refused as { refusal: string }).refusal], [false, 'wide']);
  assert.equal(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), BEFORE, 'nothing kept without the confirmation');
  assert.equal((await keepDraft(ws, GUIDE, d.basis, true)).ok, true);
  assert.equal(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), BEFORE + RECHNUNG);
});

test('a rule anchored by an amount or a business asks no confirmation', async () => {
  const { ws } = await company();
  draft(ws, GUIDE, BEFORE + CASH);
  assert.deepEqual([draftRules(ws, GUIDE)!.wide, draftRules(ws, GUIDE)!.confirm], [[], false]);
});

test('a draft that changes another rule shows it as it was and as it would be, and names the rules it meets on the same payments (wishes3-4)', async () => {
  const { ws } = await company();
  draft(ws, GUIDE, BEFORE.replace('"Tankstelle"', '"Pronto"') + `      - id: coop
        when: { text: "Coop", direction: out }
        then: { account: "4210", vat: I81 }
        source: wish 2026-10-16
`);
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.added.map((r) => r.id), d.changed.map((r) => r.rule?.when.text), d.before.map((r) => r.rule?.when.text)], [['coop'], ['Pronto'], ['Tankstelle']]);
  const coop = d.preview.find((p) => p.key.endsWith('#coop'))!;
  const n = loadBooks(ws).transactions.filter((t) => t.date.startsWith('2026') && t.direction === 'DBIT' && /coop/i.test(t.description)).length;
  assert.ok(n > 0);
  assert.deepEqual(coop.overlaps.map((o) => [o.row.id, o.shared, o.theirs]), [['fuel', n, n]], 'the earlier rule of the file decides those payments');
  assert.ok(coop.examples.every((x) => x.decidedBy === 'fuel'));
});

const POST = 'knowledge/suppliers/swiss-post.yaml';

/** The Post CH bill of August split by a person: 74.85 on 6513 with I81, 74.85 private on 2451. */
function splitPostBill(ws: Workspace, vatCode = 'I81'): string {
  const books = loadBooks(ws);
  const ref = books.transactions.find((t) => t.description === 'Rechnung Post CH August 2026')!.ref;
  update(books, PERSON, (b) => {
    const e = b.journalEntries.find((x) => x.transactionRef === ref)!;
    e.amount = 74.85;
    e.vatCode = vatCode;
    e.origin = 'manual';
    b.journalEntries.push({ id: 'split-private', transactionRef: ref, date: e.date, accountDebit: '2451', accountCredit: '1021', amount: 74.85, description: 'privat', origin: 'manual' });
  });
  saveBooks(ws, books);
  return ref;
}

test('a person\'s split into a business part and a private part offers «immer so?»: the rule with the share, kept on its card, books the next bill in two lines (wishes3-6)', async () => {
  const { ws } = await company();
  const ref = splitPostBill(ws);
  const offer = shareOffer(ws, loadBooks(ws), ref)!;
  assert.deepEqual([offer.percent, offer.booking, offer.business, offer.path], [50, { account: '6513', vat: 'I81', private: 50 }, { id: 'swiss-post', name: 'Post CH' }, POST]);
  assert.equal(draftShareRule(ws, ref, '2026-10-16'), POST);
  const d = draftRules(ws, POST)!;
  assert.deepEqual([d.added.map((r) => [r.id, r.rule?.then, r.source]), d.changed, d.confirm, d.keepable],
    [[['swiss-post-privatanteil', { kind: 'book', booking: { account: '6513', vat: 'I81', private: 50 } }, 'correction 2026-10-16']], [], false, true]);
  assert.equal(d.preview[0].examples.find((x) => x.ref === ref)?.would.lines.map((l) => [l.account, l.amount]).join(), '6513,74.85,2451,74.85');
  assert.equal((await keepDraft(ws, POST, d.basis)).ok, true);
  assert.equal(shareOffer(ws, loadBooks(ws), ref), undefined, 'kept: nothing more to offer');

  const books = loadBooks(ws);
  const next: BankTransaction = { ref: 'POST-NOV', bank: 'Raiffeisen', date: '2026-11-20', amount: 151.3, currency: 'CHF', direction: 'DBIT', description: 'Rechnung November', counterparty: 'Post CH AG' };
  books.transactions.push(next);
  await classifyTransactions(books, [next], { fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual(books.journalEntries.filter((e) => e.transactionRef === 'POST-NOV').map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']),
    [['6513', '1021', 75.65, 'I0'], ['2451', '1021', 75.65, '']]);
});

test('a split booked with the zero code (no receipt that time) offers the rate code: the rule falls back to the zero code without a receipt', async () => {
  const { ws } = await company();
  const ref = splitPostBill(ws, 'I0');
  assert.deepEqual(shareOffer(ws, loadBooks(ws), ref)?.booking, { account: '6513', vat: 'I81', private: 50 });
});

test('an uneven half with the odd cent on the business side still offers the half', async () => {
  const { ws } = await company();
  const books = loadBooks(ws);
  const ref = books.transactions.find((t) => t.description === 'Rechnung Post CH September 2026')!.ref;
  update(books, PERSON, (b) => {
    const e = b.journalEntries.find((x) => x.transactionRef === ref)!;
    e.amount = 108.88;
    b.journalEntries.push({ id: 'p', transactionRef: ref, date: e.date, accountDebit: '2451', accountCredit: '1021', amount: 108.87, origin: 'manual' });
  });
  saveBooks(ws, books);
  assert.equal(shareOffer(ws, loadBooks(ws), ref)?.percent, 50);
});

test('a payment booked in one piece offers no share rule', async () => {
  const { ws } = await company();
  const books = loadBooks(ws);
  assert.equal(shareOffer(ws, books, books.transactions.find((t) => t.description === 'Rechnung Post CH August 2026')!.ref), undefined);
});

/** Card payments of the open quarter booked on four accounts today, one privately: what «alles mit Karte 5412» would hit (x02). */
function cardPayments(ws: Workspace, accounts: string[]): void {
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    accounts.forEach((account, i) => {
      const ref = `CARD-5412-${i}`;
      const date = `2026-10-0${i + 1}`;
      b.transactions.push({ ref, bank: 'Raiffeisen', date, amount: 40 + i, currency: 'CHF', direction: 'DBIT', description: `Karte 5412 Einkauf ${i}` });
      b.journalEntries.push({ id: `card-${i}`, transactionRef: ref, date, accountDebit: account, accountCredit: '1021', amount: 40 + i, description: 'Karte', origin: 'manual' });
    });
  });
  saveBooks(ws, books);
}
const CARD = `      - id: karte-material
        when: { text: "Karte 5412", direction: out }
        then: { account: "4000", vat: M81 }
        source: wish 2026-10-16
`;

test('a rule whose payments are booked today on several other accounts, or privately, is kept only with «Trotzdem behalten», those payments shown (x02)', async () => {
  const { ws } = await company();
  cardPayments(ws, ['4000', '2451', '6641', '6200']);
  draft(ws, GUIDE, BEFORE + CARD);
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual(d.wide, [], 'not a lone word: «Karte 5412» alone did not warn before');
  const [p] = d.preview;
  assert.deepEqual([p.spread?.accounts.sort(), p.spread?.private, d.spread.map((r) => r.id), d.confirm], [['2451', '6200', '6641'], true, ['karte-material'], true]);
  const refused = await keepDraft(ws, GUIDE, d.basis);
  assert.deepEqual([refused.ok, (refused as { refusal: string }).refusal], [false, 'wide']);
  assert.match((refused as { message: string }).message, /karte-material.*verschiedenen Konten oder privat/);
  assert.equal(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), BEFORE, 'nothing kept without the confirmation');
  assert.equal((await keepDraft(ws, GUIDE, d.basis, true)).ok, true, '«Trotzdem behalten»');
});

test('a rule whose payments sit today on one other account, none private, keeps with one click: the usual correction', async () => {
  const { ws } = await company();
  cardPayments(ws, ['4000', '6200', '6200']);
  draft(ws, GUIDE, BEFORE + CARD);
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.preview[0].spread, d.confirm], [undefined, false]);
});
