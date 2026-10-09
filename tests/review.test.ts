/**
 * The Treuhänder's review end to end on a git copy of demo-consulting (Q1 filed and sealed,
 * Q2 and Q3 open): corrections planned as the review package plans them, golden rule 1 in the
 * browser's code, the import as a branch, the plan against today's books, and the merge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks, mutateJournal, sealsOf, type Books } from '../src/books/store.js';
import { ClosedPeriodError } from '../src/books/lock.js';
import { git, history, setWriter } from '../src/books/history.js';
import { applyChange } from '../src/books/changes.js';
import { IntentError, quartersOf, seededIds, vatEffect, type Intent } from '../src/review/corrections.js';
import { comment, record, replay, reviewFile, signOff, startReview, undo, type ReviewState } from '../src/review/session.js';
import { decideReview, importReview, listReviews, viewReview } from '../src/review/git.js';
import { decidedReviews } from '../src/review/package.js';
import { figuresFromBooks } from '../src/accounting/return-figures.js';
import { parseReviewFile, type ReviewFile } from '../src/review/types.js';
import { DEMO_ROOTS, tempWorkspace } from './support/workspace.js';

const DEMO = DEMO_ROOTS.find((r) => r.endsWith('demo-consulting'))!;
const AT = '2026-10-12T09:00:00.000Z';

const E = {
  fixdeskQ3: 'fe35aade6ffcb9c4',     // 6000/1020 450 I81, 2026-07-01
  telecomQ3: '738c01da7cc7001c',     // 6510/1020 90.95 I81
  bankFeeQ3: '7d7f179e367ed078',     // 6940/1020 12
  fixdeskAug: 'a0252c5543ee84ca',    // 6000/1020 450 I81
  telecomQ1: 'd9ca56afa980744c',     // 6510/1020 101.55 I81, filed
  coworkQ1: '3c5d5f06b3dd3400',      // filed
};

function repoWorkspace() {
  const ws = tempWorkspace('review-', DEMO);
  for (const f of ['books.json', 'accounts.json']) copyFileSync(join(DEMO, f), join(ws.paths.root, f));
  cpSync(join(DEMO, 'filings'), ws.paths.filings, { recursive: true });
  writeFileSync(join(ws.paths.root, '.gitignore'), 'data/\n');
  git(ws.paths.root, ['init', '-q', '-b', 'main']);
  git(ws.paths.root, ['add', '-A']);
  git(ws.paths.root, ['-c', 'user.name=Lukas Beispiel', '-c', 'user.email=', 'commit', '-q', '-m', 'Bücher']);
  return ws;
}

/** A review of every v1 kind, made the way the review package makes it. */
function makeReview(base: Books, commit: string): { state: ReviewState; books: Books } {
  let state = startReview({ name: 'Anna Muster', email: 'anna@example.ch' }, { manifestSha256: 'a'.repeat(64), commit, createdAt: AT, closedThrough: base.config.closedThrough, period: '2026-Q3' }, 'rev-test-1');
  const ids = seededIds('test');
  const intents: Array<[Intent, string]> = [
    [{ kind: 'editEntry', id: E.fixdeskQ3, patch: { accountDebit: '6500' } }, 'Fixdesk ist Raumaufwand, nicht Büromaterial'],
    [{ kind: 'editEntry', id: E.telecomQ3, patch: { vatCode: 'I0', description: 'Mobile-Abo Juli, Beleg ohne MWST' } }, 'Beleg zeigt keine MWST'],
    [{ kind: 'editEntry', id: E.telecomQ1, patch: { vatCode: 'I0' } }, 'Q1: Beleg ohne MWST'],
    [{ kind: 'splitEntry', id: E.fixdeskAug, lines: [{ accountDebit: '6000', accountCredit: '1020', amount: 400, vatCode: 'I81' }, { accountDebit: '2451', accountCredit: '1020', amount: 50, description: 'Privatanteil Fixdesk' }] }, 'Teil privat'],
    [{ kind: 'reverseEntry', id: E.bankFeeQ3 }, 'doppelt gebucht'],
    [{ kind: 'reverseEntry', id: E.coworkQ1 }, 'Q1 doppelt'],
    [{ kind: 'addEntry', date: '2026-09-30', lines: [{ accountDebit: '2451', accountCredit: '6510', amount: 43.24, vatCode: 'K81-B', description: 'Privatanteil Mobile Q3' }] }, 'Privatanteil 40%'],
    [{ kind: 'addEntry', date: '2026-09-30', lines: [{ accountDebit: '6800', accountCredit: '1520', amount: 600, description: 'Abschreibung Laptop' }] }, 'Abschreibung'],
    [{ kind: 'editTransaction', ref: '90000000053', patch: { noReceiptNeeded: true } }, 'BVG-Beiträge brauchen keinen Beleg'],
  ];
  let books = base;
  for (const [intent, reason] of intents) {
    state = record(state, books, intent, reason, AT, ids);
    books = replay(base, state.corrections).books;
  }
  const mapped = base.mappings.find((m) => base.transactions.find((t) => t.ref === m.transactionRef)!.date > '2026-07-01')!;
  state = record(state, books, { kind: 'unlinkReceipt', ref: mapped.transactionRef, receiptId: mapped.receiptId }, 'falscher Beleg', AT, ids);
  books = replay(base, state.corrections).books;
  state = record(state, books, { kind: 'linkReceipt', ref: '90000000074', receiptId: mapped.receiptId }, 'richtiger Beleg', AT, ids);
  books = replay(base, state.corrections).books;
  state = comment(state, { kind: 'entry', id: E.fixdeskQ3 }, 'Vertrag nachreichen', AT);
  state = signOff(state, '2026-Q3', 'Q3 geprüft', AT);
  return { state, books };
}

test('the review package refuses what the owner refuses, and turns a filed entry edit into correction entries', () => {
  const ws = repoWorkspace();
  const base = loadBooks(ws);
  const { state, books } = makeReview(base, 'HEAD');
  assert.equal(state.corrections.length, 11);

  const split = state.corrections.find((c) => c.kind === 'splitEntry')!;
  assert.deepEqual(split.changes.map((c) => (c.after as { vatCode?: string }).vatCode), ['I81', undefined], 'a split line has its own VAT code, not the original one');

  const q1 = state.corrections.find((c) => c.reason === 'Q1: Beleg ohne MWST')!;
  assert.equal(q1.corrects, '2026-Q1');
  const [storno, fixed] = q1.changes.map((c) => c.after as { date: string; corrects: string; vatCode: string; description: string; accountDebit: string });
  assert.deepEqual([storno.date, storno.corrects, storno.vatCode, storno.accountDebit], ['2026-04-01', '2026-Q1', '-I81', '1020']);
  assert.deepEqual([fixed.date, fixed.corrects, fixed.vatCode], ['2026-04-01', '2026-Q1', 'I0']);
  assert.match(storno.description, new RegExp(`^Korrektur zu ${E.telecomQ1}`));

  const copy = structuredClone(base);
  mutateJournal(copy, (b) => { for (const c of state.corrections.flatMap((x) => x.changes)) assert.equal(applyChange(b, c), 'applied'); });
  assert.equal(books.journalEntries.filter((e) => e.date <= '2026-03-31').length, base.journalEntries.filter((e) => e.date <= '2026-03-31').length, 'Q1 has the entries it was filed with');

  const closedTx = base.transactions.find((t) => t.date < '2026-03-31')!;
  assert.throws(() => record(state, books, { kind: 'linkReceipt', ref: closedTx.ref, receiptId: base.receipts[0].id }, 'x', AT), ClosedPeriodError);
  assert.throws(() => record(state, books, { kind: 'editEntry', id: E.fixdeskQ3, patch: { date: '2026-03-15' } }, 'x', AT), ClosedPeriodError);
  assert.throws(() => record(state, books, { kind: 'addEntry', date: '2026-02-01', lines: [{ accountDebit: '6500', accountCredit: '1020', amount: 1 }] }, 'x', AT), ClosedPeriodError);
  assert.throws(() => record(state, books, { kind: 'splitEntry', id: E.telecomQ3, lines: [{ accountDebit: '6510', accountCredit: '1020', amount: 50 }, { accountDebit: '2850', accountCredit: '1020', amount: 40 }] }, 'x', AT), IntentError);

  const afterUndo = replay(base, undo(state, 'k1').corrections);
  assert.deepEqual(afterUndo.broken, []);
  assert.equal(afterUndo.books.journalEntries.find((e) => e.id === E.fixdeskQ3)!.accountDebit, '6000');
});

test('import makes a branch with one commit per correction by the Treuhänder; again changes nothing', () => {
  const ws = repoWorkspace();
  const head = git(ws.paths.root, ['rev-parse', 'HEAD']).trim();
  const { state } = makeReview(loadBooks(ws), head);
  const file = JSON.parse(JSON.stringify(reviewFile(state, [], AT))) as ReviewFile;
  assert.equal(parseReviewFile(file), file);

  const first = importReview(ws, file);
  assert.equal(first.created, true);
  assert.equal(first.branch, 'review/anna-muster-2026-Q3-2026-10-12');
  assert.equal(git(ws.paths.root, ['rev-parse', 'HEAD']).trim(), head, 'the owner stays on his branch');
  assert.equal(git(ws.paths.root, ['status', '--porcelain']).trim(), '', 'the working tree is untouched');
  const log = git(ws.paths.root, ['log', '--format=%an|%s', `${head}..${first.branch}`]).trim().split('\n').reverse();
  assert.equal(log.length, 12);
  assert.deepEqual(log.slice(0, 2), ['Anna Muster|Fixdesk ist Raumaufwand, nicht Büromaterial', 'Anna Muster|Beleg zeigt keine MWST']);
  const branchBooks = JSON.parse(git(ws.paths.root, ['show', `${first.branch}:books.json`]));
  assert.deepEqual(branchBooks, replay(loadBooks(ws), file.corrections).books, 'the branch tip holds the books the Treuhänder saw');

  const refs = git(ws.paths.root, ['for-each-ref']);
  assert.deepEqual(importReview(ws, file), { branch: first.branch, created: false, commits: 0, base: head });
  assert.equal(git(ws.paths.root, ['for-each-ref']), refs);
  assert.equal(listReviews(ws).length, 1);
});

test('the plan against today: applicable, and a conflict when the owner changed the record since', () => {
  const ws = repoWorkspace();
  const head = git(ws.paths.root, ['rev-parse', 'HEAD']).trim();
  const { state } = makeReview(loadBooks(ws), head);
  const { branch } = importReview(ws, reviewFile(state, [], AT));
  assert.deepEqual(new Set(viewReview(ws, branch).plans.map((p) => p.status)), new Set(['applicable']));

  const raw = JSON.parse(readFileSync(ws.paths.books, 'utf8'));
  raw.journalEntries.find((e: { id: string }) => e.id === E.telecomQ3).description = 'vom Inhaber geändert';
  writeFileSync(ws.paths.books, JSON.stringify(raw, null, 2));
  const plans = viewReview(ws, branch).plans;
  assert.equal(plans.find((p) => p.correction.id === 'k2')!.status, 'conflict');
  assert.equal(plans.find((p) => p.correction.id === 'k1')!.status, 'applicable');
});

test('merge: the accepted corrections through mutateJournal, a merge commit keeping the Treuhänder commits, VAT as previewed, idempotent', () => {
  const ws = repoWorkspace();
  const head = git(ws.paths.root, ['rev-parse', 'HEAD']).trim();
  const before = loadBooks(ws);
  const { state } = makeReview(before, head);
  const { branch } = importReview(ws, reviewFile(state, [], AT));
  const view = viewReview(ws, branch);
  const predicted = vatEffect(before, replay(before, state.corrections).books, quartersOf(state.corrections.flatMap((c) => c.changes)));

  setWriter({ name: 'Lukas Beispiel', email: '' });
  try {
    const result = decideReview(ws, branch, { accept: 'all', reject: { k5: 'Die Spesen sind nicht doppelt.' } });
    assert.deepEqual(result.rejected, ['k5']);
    assert.equal(result.merged.length, 10);
    const parents = git(ws.paths.root, ['log', '-1', '--format=%P|%an|%s']).trim();
    assert.equal(parents, `${head} ${git(ws.paths.root, ['rev-parse', branch]).trim()}|Lukas Beispiel|Merged ${branch} by Lukas Beispiel (10 übernommen, 1 abgelehnt)`);
    assert.match(git(ws.paths.root, ['log', '--format=%an|%s']), /Anna Muster\|Beleg zeigt keine MWST/);
    const [merge] = history(ws, { limit: 1 });
    assert.equal(merge.parents.length, 2, 'the Protokoll shows the merge commit');
    assert.ok(merge.changes.length >= 10);
    assert.equal(git(ws.paths.root, ['status', '--porcelain']).trim(), '');

    const after = loadBooks(ws);
    assert.ok(sealsOf(after).checks.every((c) => c.status === 'intact'), 'the Q1 seal holds');
    assert.ok(after.journalEntries.some((e) => e.accountDebit === '6800'));
    assert.equal(after.journalEntries.find((e) => e.id === E.bankFeeQ3)?.amount, 12, 'the rejected reversal is not applied');
    const accounts = JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as Array<{ number: string }>;
    assert.ok(accounts.some((a) => a.number === '6800'), 'a chart account the entries use is added');

    const withoutK5 = replay(before, state.corrections.filter((c) => c.id !== 'k5')).books;
    for (const q of ['2026-Q1', '2026-Q2', '2026-Q3'] as const) {
      const fig = (b: Books) => figuresFromBooks(b.journalEntries, q, b.config.vatAdjustments ?? []).ziffern;
      assert.deepEqual(fig(after), fig(withoutK5), `${q} as the review package showed it`);
    }
    assert.ok(predicted.some((d) => d.quarter === '2026-Q1' && d.ziffer === '405'), 'the Q1 correction moves Q1 input tax (0535)');
    assert.equal(view.plans.length, 11);

    const decisions = JSON.parse(readFileSync(join(ws.paths.root, 'review/anna-muster-2026-Q3-2026-10-12/decisions.json'), 'utf8'));
    assert.equal(decisions.decisions.find((d: { correctionId: string }) => d.correctionId === 'k5').reason, 'Die Spesen sind nicht doppelt.');
    const [earlier] = decidedReviews(ws);
    assert.deepEqual(earlier.corrections.find((c) => c.id === 'k5'), { id: 'k5', kind: 'reverseEntry', reason: 'doppelt gebucht', decision: 'rejected', status: 'applicable', ownerReason: 'Die Spesen sind nicht doppelt.', by: 'Lukas Beispiel', at: earlier.corrections.find((c) => c.id === 'k5')!.at }, 'the next review package shows the decision and its reason');

    const tip = git(ws.paths.root, ['rev-parse', 'HEAD']).trim();
    assert.deepEqual(decideReview(ws, branch, { accept: 'all' }), { merged: [], rejected: [], skipped: [] });
    assert.deepEqual(importReview(ws, reviewFile(state, [], AT)).created, false);
    assert.equal(git(ws.paths.root, ['rev-parse', 'HEAD']).trim(), tip, 'deciding and importing again commits nothing');
  } finally {
    setWriter(undefined);
  }
});

test('merge never touches a sealed quarter: a stale edit of a filed entry becomes a correction entry, a filed link is refused', () => {
  const ws = repoWorkspace();
  const head = git(ws.paths.root, ['rev-parse', 'HEAD']).trim();
  const books = loadBooks(ws);
  const filed = books.journalEntries.find((e) => e.id === E.telecomQ1)!;
  const closedMapping = books.mappings.find((m) => books.transactions.find((t) => t.ref === m.transactionRef)!.date < '2026-03-31')!;
  const file: ReviewFile = {
    ...reviewFile(startReview({ name: 'Anna Muster' }, { manifestSha256: 'b'.repeat(64), commit: head, createdAt: AT, period: '2026-Q1' }, 'rev-stale-1'), [], AT),
    corrections: [
      { id: 'k1', kind: 'editEntry', reason: 'direkt geändert', at: AT, changes: [{ collection: 'entries', key: filed.id, before: filed, after: { ...filed, vatCode: 'I0' } }] },
      { id: 'k2', kind: 'unlinkReceipt', reason: 'falscher Beleg', at: AT, changes: [{ collection: 'mappings', key: `${closedMapping.transactionRef} ↔ ${closedMapping.receiptId}`, before: closedMapping }] },
    ],
  };
  const { branch } = importReview(ws, file);
  const plans = viewReview(ws, branch).plans;
  assert.deepEqual(plans.map((p) => p.status), ['closedPeriod', 'refused']);
  assert.ok(plans[0].changes.every((c) => c.collection === 'entries' && !c.before && c.after!.corrects === '2026-Q1' && c.after!.date > '2026-03-31'));

  const result = decideReview(ws, branch, { accept: ['k1', 'k2'] });
  assert.deepEqual(result.merged, ['k1']);
  assert.deepEqual(result.skipped, [{ id: 'k2', status: 'refused' }]);
  const after = loadBooks(ws);
  assert.deepEqual(after.journalEntries.find((e) => e.id === E.telecomQ1), filed, 'the filed entry is as filed');
  assert.ok(sealsOf(after).checks.every((c) => c.status === 'intact'));
});

test('a correction of a quarter the owner filed after the snapshot becomes a Storno and the corrected entry with corrects', () => {
  const ws = repoWorkspace();
  const head = git(ws.paths.root, ['rev-parse', 'HEAD']).trim();
  const books = loadBooks(ws);
  const may = books.journalEntries.find((e) => e.date.startsWith('2026-05') && e.vatCode === 'I81')!;
  const state = record(startReview({ name: 'Anna Muster' }, { manifestSha256: 'c'.repeat(64), commit: head, createdAt: AT, period: '2026-Q2' }, 'rev-q2-1'), books, { kind: 'editEntry', id: may.id, patch: { vatCode: 'I0' } }, 'Beleg ohne MWST', AT);
  assert.equal(state.corrections[0].corrects, undefined, 'Q2 was open in the snapshot');
  const { branch } = importReview(ws, reviewFile(state, [], AT));

  const raw = JSON.parse(readFileSync(ws.paths.books, 'utf8'));
  raw.config.closedThrough = '2026-06-30';
  writeFileSync(ws.paths.books, JSON.stringify(raw, null, 2));
  git(ws.paths.root, ['-c', 'user.name=Lukas Beispiel', '-c', 'user.email=', 'commit', '-q', '-am', 'Q2 eingereicht']);

  const [plan] = viewReview(ws, branch).plans;
  assert.equal(plan.status, 'closedPeriod');
  const entries = plan.changes.map((c) => c.after as { date: string; corrects?: string; vatCode?: string });
  assert.deepEqual(entries.map((e) => [e.date, e.corrects, e.vatCode]), [['2026-07-01', '2026-Q2', '-I81'], ['2026-07-01', '2026-Q2', 'I0']]);
  assert.ok(plan.vat.some((d) => d.quarter === '2026-Q2' && d.ziffer === '405' && d.after < d.before));
  assert.deepEqual(decideReview(ws, branch, { accept: 'all' }).merged, ['k1']);
  assert.deepEqual(loadBooks(ws).journalEntries.find((e) => e.id === may.id), may, 'the now filed entry is unchanged');
});
